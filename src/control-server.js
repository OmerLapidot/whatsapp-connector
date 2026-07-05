const http = require('http');
const fs = require('fs');
const path = require('path');
const { resolveChat } = require('./resolve');
const { loadAllowlist, isAllowed, addManyToAllowlist, removeManyFromAllowlist } = require('./allowlist');
const { parseWhen, nextFireAt, describe } = require('./schedule-spec');

// Chat/group names are attacker-controlled free text (a group subject can hold
// newlines and arbitrary unicode). Neutralize control characters and cap length
// before showing a name in the approval dialog or an error, so a crafted name
// cannot forge extra dialog lines or push the real id off-screen.
function sanitizeName(name) {
  const cleaned = String(name)
    // C0/C1 control chars + line/paragraph separators -> space
    .replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g, " ")
    // bidi controls (overrides/embeddings/isolates/marks) + zero-width chars ->
    // removed: no legitimate visible width, but can reverse or hide dialog text
    .replace(/[\u061C\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, "")
    // other unicode spaces (NBSP etc.) -> plain space, so they cannot fake alignment
    .replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, " ")
    .trim();
  return cleaned.length > 60 ? cleaned.slice(0, 60) + "\u2026" : cleaned;
}

function clampLimit(limit, defaults) {
  const n = Number.isInteger(limit) ? limit : defaults.DEFAULT_READ_LIMIT;
  return Math.max(1, Math.min(n, defaults.MAX_LIMIT));
}

async function resolveOrThrow(session, ref) {
  const chats = await session.listChats();
  const r = resolveChat(chats, ref);
  if (r.status === 'match') return r.chat;
  if (r.status === 'ambiguous') {
    const e = new Error('ambiguous chat "' + ref + '": ' + r.candidates.map((c) => c.name).join(', '));
    e.code = 'AMBIGUOUS';
    throw e;
  }
  const e = new Error('chat not found: ' + ref);
  e.code = 'NOT_FOUND';
  throw e;
}

function requireAllowed(allowlistPath, chat) {
  if (!isAllowed(loadAllowlist(allowlistPath), chat.id)) {
    const nm = sanitizeName(chat.name);
    const e = new Error('chat "' + nm + '" (' + chat.id + ') is not on the send allow-list. Add it with: wa allow add "' + nm + '"');
    e.code = 'NOT_ALLOWED';
    throw e;
  }
}

// The human gate. Missing approver (misconfigured ctx) counts as unavailable:
// deny, never crash, never silently allow.
async function approveOrThrow(approve, title, message) {
  const res = (approve && await approve({ title, message })) || { approved: false, reason: 'unavailable' };
  if (res.approved === true) return;
  const why = res.reason === 'timeout'
    ? 'the approval dialog timed out (60s)'
    : res.reason === 'unavailable'
      ? 'no approval dialog is available on this system — a human can edit allowlist.json directly'
      : 'denied on screen by the user';
  const e = new Error('allow-list change not approved: ' + why);
  e.code = 'NOT_APPROVED';
  throw e;
}

function bulletList(entries) {
  return entries.map((x) => '• ' + sanitizeName(x.name) + ' (' + x.id + ')').join('\n');
}

async function handle({ cmd, args = {} }, ctx) {
  const { session, allowlistPath, defaults, pending, scheduler } = ctx;
  const nowMs = () => (ctx.now ? ctx.now() : Date.now());
  switch (cmd) {
    case 'status': return session.status();
    case 'chats': return session.listChats();
    case 'read': {
      const chat = await resolveOrThrow(session, args.chat);
      // --all fetches every synced message (Infinity); otherwise clamp to MAX_LIMIT.
      const limit = args.all ? Infinity : clampLimit(args.limit, defaults);
      const messages = await session.readMessages(chat.id, limit);
      return { chat: chat.name, id: chat.id, messages };
    }
    case 'search': {
      let chatId;
      if (args.chat) chatId = (await resolveOrThrow(session, args.chat)).id;
      const limit = args.limit != null ? clampLimit(args.limit, defaults) : undefined;
      return session.search(args.query, { chatId, limit });
    }
    case 'members': {
      const chat = await resolveOrThrow(session, args.group);
      return session.members(chat.id);
    }
    case 'contacts': return session.contacts(args.query);
    case 'media': {
      const chat = await resolveOrThrow(session, args.chat);
      return session.downloadMedia(chat.id, args.messageId);
    }
    case 'send': {
      const chat = await resolveOrThrow(session, args.chat);
      requireAllowed(allowlistPath, chat);
      const token = pending.create({ kind: 'send', chatId: chat.id, chatName: chat.name, text: args.text });
      return { pending: true, token, chat: chat.name, id: chat.id, preview: args.text };
    }
    case 'sendMedia': {
      const chat = await resolveOrThrow(session, args.chat);
      requireAllowed(allowlistPath, chat);
      const token = pending.create({ kind: 'sendMedia', chatId: chat.id, chatName: chat.name, path: args.path, caption: args.caption || '' });
      return { pending: true, token, chat: chat.name, id: chat.id, preview: '[media] ' + args.path + (args.caption ? ' — ' + args.caption : '') };
    }
    case 'sendConfirm': {
      const p = pending.consume(args.token);
      if (p.kind !== 'send' && p.kind !== 'sendMedia') {
        const e = new Error('token is not a send confirmation'); e.code = 'WRONG_KIND'; throw e;
      }
      requireAllowed(allowlistPath, { id: p.chatId, name: p.chatName });
      if (p.kind === 'sendMedia') return session.sendMedia(p.chatId, p.path, p.caption);
      return session.send(p.chatId, p.text);
    }
    case 'react': {
      const chat = await resolveOrThrow(session, args.chat);
      requireAllowed(allowlistPath, chat);
      return session.react(chat.id, args.messageId, args.emoji);
    }
    case 'markRead': {
      // Not allow-list gated: marking a chat read only mutates our own read
      // state and is invisible to the other party. Unlike send/react, it sends
      // nothing outward, so it is safe on any chat.
      const chat = await resolveOrThrow(session, args.chat);
      return session.markRead(chat.id);
    }
    case 'allowList': return loadAllowlist(allowlistPath);
    case 'allowAdd': {
      const resolved = [];
      for (const ref of args.chats) resolved.push(await resolveOrThrow(session, ref));
      const current = loadAllowlist(allowlistPath);
      const toAdd = [];
      for (const c of resolved) {
        if (!current.includes(c.id) && !toAdd.some((x) => x.id === c.id)) toAdd.push(c);
      }
      if (!toAdd.length) return current;
      await approveOrThrow(ctx.approve, 'WhatsApp send permission',
        'Allow Claude to SEND messages to ' + toAdd.length + ' chat(s)?\n\n' + bulletList(toAdd)
        + '\n\nDeny if you did not just ask for this.');
      return addManyToAllowlist(allowlistPath, toAdd.map((c) => c.id));
    }
    case 'allowRemove': {
      const current = loadAllowlist(allowlistPath);
      const toRemove = [];
      for (const ref of args.chats) {
        let entry;
        if (current.includes(ref)) entry = { id: ref, name: ref };
        else {
          const c = await resolveOrThrow(session, ref);
          entry = { id: c.id, name: c.name };
        }
        if (current.includes(entry.id) && !toRemove.some((x) => x.id === entry.id)) toRemove.push(entry);
      }
      if (!toRemove.length) return current;
      await approveOrThrow(ctx.approve, 'WhatsApp send permission',
        'Remove ' + toRemove.length + ' chat(s) from the send allow-list?\n\n' + bulletList(toRemove));
      return removeManyFromAllowlist(allowlistPath, toRemove.map((x) => x.id));
    }
    case 'allowAll': {
      const current = loadAllowlist(allowlistPath);
      if (current.includes('*')) return current;
      await approveOrThrow(ctx.approve, 'WhatsApp send permission — EVERYONE',
        'Allow Claude to SEND to EVERYONE — every chat, group, and contact, current and future?\n\n'
        + 'Your existing allow-list entries are kept.\n\nDeny if you did not just ask for this.');
      return addManyToAllowlist(allowlistPath, ['*']);
    }
    case 'allowRemoveAll': {
      const current = loadAllowlist(allowlistPath);
      if (!current.includes('*')) return current;
      await approveOrThrow(ctx.approve, 'WhatsApp send permission',
        'Remove the EVERYONE (*) wildcard from the send allow-list?\n\nExplicit chat entries are kept.');
      return removeManyFromAllowlist(allowlistPath, ['*']);
    }
    case 'schedule': {
      const chat = await resolveOrThrow(session, args.chat);
      requireAllowed(allowlistPath, chat);
      const spec = parseWhen(args, nowMs());
      const job = { chatId: chat.id, chatName: chat.name, spec, createdAt: nowMs() };
      if (args.media != null) {
        const abs = path.resolve(args.media);
        if (!fs.existsSync(abs)) { const e = new Error('media file not found: ' + abs); e.code = 'NO_FILE'; throw e; }
        job.kind = 'sendMedia'; job.path = abs; job.caption = args.caption || '';
      } else {
        if (!args.text) { const e = new Error('nothing to send: provide message text or --media'); e.code = 'BAD_ARGS'; throw e; }
        job.kind = 'send'; job.text = args.text;
      }
      const token = pending.create({ kind: 'schedule', job });
      const content = job.kind === 'sendMedia'
        ? '[media] ' + job.path + (job.caption ? ' — ' + job.caption : '')
        : JSON.stringify(job.text);
      return { pending: true, token, chat: chat.name, id: chat.id, when: describe(spec), preview: describe(spec) + ' → ' + content + ' to ' + chat.name };
    }
    case 'scheduleConfirm': {
      const p = pending.consume(args.token);
      if (p.kind !== 'schedule') { const e = new Error('token is not a schedule confirmation'); e.code = 'WRONG_KIND'; throw e; }
      requireAllowed(allowlistPath, { id: p.job.chatId, name: p.job.chatName });
      const at = nextFireAt(p.job.spec, nowMs());
      if (at == null) { const e = new Error('scheduled time already passed — re-issue the schedule'); e.code = 'PAST_SCHEDULE'; throw e; }
      const job = scheduler.add({ ...p.job, nextFireAt: at });
      return { scheduled: true, job: { ...job, when: describe(job.spec) } };
    }
    case 'scheduleList': return scheduler.list({ all: !!args.all });
    case 'scheduleCancel': return scheduler.cancel(args.id);
    default: {
      const e = new Error('unknown command: ' + cmd);
      e.code = 'UNKNOWN_CMD';
      throw e;
    }
  }
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body);
}

function createControlServer(ctx) {
  return http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/rpc') {
      return sendJson(res, 404, { ok: false, error: 'not found' });
    }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      let parsed;
      try { parsed = JSON.parse(body || '{}'); }
      catch { return sendJson(res, 400, { ok: false, error: 'bad json', code: 'BAD_JSON' }); }
      try {
        const data = await handle(parsed, ctx);
        sendJson(res, 200, { ok: true, data });
      } catch (err) {
        sendJson(res, 200, { ok: false, error: err.message, code: err.code || 'ERR' });
      }
    });
  });
}

module.exports = { handle, createControlServer };
