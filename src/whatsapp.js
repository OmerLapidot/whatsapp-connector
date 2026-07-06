const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSyncTracker } = require('./sync-state');
const { createRecovery } = require('./recovery');

function makeSession({ log, sync = {}, recovery: recoveryCfg = {} }) {
  // The tracker owns readiness: it holds `ready` until offline-message delivery
  // settles, not merely until the chat list syncs. See src/sync-state.js.
  const tracker = createSyncTracker({ quietMs: sync.quietMs, maxMs: sync.maxMs, log });

  // Session store on disk. Pinned to the repo (not cwd-relative) so the recovery
  // re-link move targets the exact directory LocalAuth actually uses.
  const AUTH_DIR = path.join(__dirname, '..', '.wwebjs_auth');

  // Watchdog: if auth succeeds but `ready` never fires, RECOVER BY RESTARTING THE
  // PROCESS (a fresh Chrome, no profile-lock fight) — soft ×N reusing the session
  // (no QR), then a hard re-link (fresh QR). launchd relaunches on exit. recovery.js.
  const recovery = createRecovery({
    readyTimeoutMs: recoveryCfg.readyTimeoutMs,
    maxSoft: recoveryCfg.maxSoft,
    staleMs: recoveryCfg.staleMs,
    statePath: recoveryCfg.statePath,
    authDir: AUTH_DIR,
    log,
  });

  const client = new Client({ authStrategy: new LocalAuth({ dataPath: AUTH_DIR }) });

  client.on('qr', (qr) => { tracker.onQr(); recovery.onWaitingForHuman(); log('Scan to log in (Linked Devices):'); qrcode.generate(qr, { small: true }); });
  client.on('loading_screen', (percent) => tracker.onLoadingScreen(percent));
  client.on('ready', () => { tracker.onReady(); recovery.onReady(); log('WhatsApp app-state synced; settling offline messages…'); });
  client.on('auth_failure', (m) => { tracker.onAuthFailure(); log('AUTH FAILURE:', m); });
  client.on('disconnected', (r) => {
    tracker.onDisconnected();
    recovery.stop();
    log('DISCONNECTED:', r, '-> exiting for launchd restart');
    setTimeout(() => process.exit(1), 1500);
  });

  function ensureReady() {
    const snap = tracker.snapshot();
    if (!snap.ready) { const e = new Error('WhatsApp session not ready (state: ' + snap.state + ')'); e.code = 'NOT_READY'; throw e; }
  }

  function fmt(m) {
    return {
      id: m.id._serialized,
      sender: m.fromMe ? 'me' : ((m._data && m._data.notifyName) || m.author || m.from),
      ts: m.timestamp,
      text: m.body || '',
      hasMedia: !!m.hasMedia,
    };
  }

  return {
    start() { recovery.onInitStarted(); return client.initialize(); },
    async status() {
      const snap = tracker.snapshot();
      const r = recovery.snapshot();
      // Surface recovery stages so `wa status` stays informative during a stall.
      if (r.phase === 'recovering' || r.phase === 'relinking') {
        return { ...snap, state: r.phase, recovery: { attempt: r.softAttempt, max: r.maxSoft } };
      }
      return snap;
    },

    async listChats() {
      ensureReady();
      const chats = await client.getChats();
      return chats.map((c) => ({ id: c.id._serialized, name: c.name || c.id.user, unread: c.unreadCount }));
    },

    async readMessages(chatId, limit) {
      ensureReady();
      const chat = await client.getChatById(chatId);
      const msgs = await chat.fetchMessages({ limit });
      return msgs.map(fmt);
    },

    async search(query, { chatId, limit } = {}) {
      ensureReady();
      const opts = {};
      if (chatId) opts.chatId = chatId;
      if (limit) opts.limit = limit;
      const msgs = await client.searchMessages(query, opts);
      return msgs.map((m) => ({ ...fmt(m), chatId: m.id && m.id.remote }));
    },

    async members(groupId) {
      ensureReady();
      const chat = await client.getChatById(groupId);
      if (!chat.isGroup) { const e = new Error('not a group'); e.code = 'NOT_GROUP'; throw e; }
      const out = [];
      for (const p of chat.participants) {
        const id = p.id._serialized;
        let name = id;
        try { const c = await client.getContactById(id); name = c.pushname || c.name || c.number || id; } catch (_) {}
        out.push({ id, number: p.id.user, name });
      }
      return out;
    },

    async contacts(query) {
      ensureReady();
      const q = String(query).toLowerCase();
      const all = await client.getContacts();
      return all
        .filter((c) => (c.name || c.pushname || '').toLowerCase().includes(q) || (c.number || '').includes(q))
        .slice(0, 50)
        .map((c) => ({ id: c.id._serialized, name: c.name || c.pushname || c.number, number: c.number }));
    },

    async downloadMedia(chatId, messageId) {
      ensureReady();
      const msg = await client.getMessageById(messageId);
      if (!msg || !msg.hasMedia) { const e = new Error('message has no media'); e.code = 'NO_MEDIA'; throw e; }
      const media = await msg.downloadMedia();
      if (!media) {
        const e = new Error('media unavailable (expired or not downloadable)');
        e.code = 'NO_MEDIA';
        throw e;
      }
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-media-'));
      const ext = ((media.mimetype || 'application/octet-stream').split('/')[1] || 'bin').split(';')[0];
      let base = media.filename ? path.basename(media.filename) : ('media.' + ext);
      if (!base || base === '.' || base === '..') base = 'media.' + ext;   // basename can yield these
      const file = path.join(dir, base);
      fs.writeFileSync(file, Buffer.from(media.data, 'base64'));
      return { path: file, mimetype: media.mimetype };
    },

    async send(chatId, text) {
      ensureReady();
      const msg = await client.sendMessage(chatId, text);
      return { id: msg.id._serialized };
    },

    async sendMedia(chatId, filePath, caption) {
      ensureReady();
      const media = MessageMedia.fromFilePath(filePath);
      const msg = await client.sendMessage(chatId, media, { caption: caption || undefined });
      return { id: msg.id._serialized };
    },

    async react(chatId, messageId, emoji) {
      ensureReady();
      const msg = await client.getMessageById(messageId);
      if (!msg) { const e = new Error('message not found: ' + messageId); e.code = 'NOT_FOUND'; throw e; }
      const owner = msg.id && msg.id.remote;
      if (owner && owner !== chatId) {
        const e = new Error('message ' + messageId + ' belongs to a different chat than "' + chatId + '"');
        e.code = 'WRONG_CHAT';
        throw e;
      }
      await msg.react(emoji);
      return { ok: true };
    },

    async markRead(chatId) {
      ensureReady();
      const chat = await client.getChatById(chatId);
      await chat.sendSeen();
      return { ok: true };
    },

    async stop() { recovery.stop(); try { await client.destroy(); } catch (_) {} },
  };
}

module.exports = { makeSession };
