const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { handle, createControlServer } = require('../src/control-server');
const { loadAllowlist, saveAllowlist } = require('../src/allowlist');
const { createPendingStore } = require('../src/pending');

const defaults = { DEFAULT_READ_LIMIT: 30, MAX_LIMIT: 200 };

function fakeSession() {
  const s = {
    lastReadLimit: undefined,
    sendCalls: [],
    sendMediaCalls: [],
    status: async () => ({ ready: true, state: 'ready' }),
    listChats: async () => ([
      { id: '1@g.us', name: 'poker', unread: 0 },
      { id: '2@g.us', name: 'notes', unread: 1 },
    ]),
    readMessages: async (id, limit) => { s.lastReadLimit = limit; return [{ id: 'm1', sender: 'x', ts: 1, text: 'hi', hasMedia: false }]; },
    send: async (id, text) => { s.sendCalls.push({ id, text }); return { id: 'sent-' + text }; },
    sendMedia: async (id, filePath, caption) => { s.sendMediaCalls.push({ id, filePath, caption }); return { id: 'media-' + id }; },
    react: async (id, messageId, emoji) => ({ ok: true }),
    markRead: async (id) => ({ ok: true }),
  };
  return s;
}

// Build a fresh ctx; every handle() call needs a `pending` store now.
function ctx(overrides = {}) {
  return { session: fakeSession(), allowlistPath: tmpAllow(), defaults, pending: createPendingStore(), ...overrides };
}

function tmpAllow() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wa-')), 'allowlist.json');
}

test('chats returns the list', async () => {
  const data = await handle({ cmd: 'chats' }, ctx());
  assert.strictEqual(data.length, 2);
});

test('read resolves the chat name', async () => {
  const data = await handle({ cmd: 'read', args: { chat: 'poker' } }, ctx());
  assert.strictEqual(data.chat, 'poker');
  assert.strictEqual(data.messages.length, 1);
});

test('send to non-allowlisted chat is refused (no token issued)', async () => {
  const c = ctx();
  await assert.rejects(
    () => handle({ cmd: 'send', args: { chat: 'notes', text: 'hey' } }, c),
    /not on the send allow-list/,
  );
  assert.strictEqual(c.pending.size(), 0);
  assert.strictEqual(c.session.sendCalls.length, 0);
});

test('send to an allow-listed chat returns a pending token and does NOT transmit', async () => {
  const allow = tmpAllow();
  const session = fakeSession();
  const pending = createPendingStore();
  saveAllowlist(allow, ['2@g.us']);
  const data = await handle({ cmd: 'send', args: { chat: 'notes', text: 'hey' } }, { session, allowlistPath: allow, defaults, pending });

  assert.strictEqual(data.pending, true);
  assert.ok(data.token, 'a token is returned');
  assert.strictEqual(data.chat, 'notes');
  assert.strictEqual(data.preview, 'hey');
  assert.strictEqual(session.sendCalls.length, 0, 'session.send must NOT be called at create time');
  assert.strictEqual(pending.size(), 1);
});

test('send succeeds after allow add (two-step: create then confirm)', async () => {
  const allow = tmpAllow();
  const session = fakeSession();
  const pending = createPendingStore();
  saveAllowlist(allow, ['2@g.us']);

  const created = await handle({ cmd: 'send', args: { chat: 'notes', text: 'hey' } }, { session, allowlistPath: allow, defaults, pending });
  assert.strictEqual(created.pending, true);
  assert.strictEqual(session.sendCalls.length, 0);

  const confirmed = await handle({ cmd: 'sendConfirm', args: { token: created.token } }, { session, allowlistPath: allow, defaults, pending });
  assert.strictEqual(confirmed.id, 'sent-hey');
  assert.strictEqual(session.sendCalls.length, 1);
  assert.strictEqual(session.sendCalls[0].id, '2@g.us');
  assert.deepStrictEqual(loadAllowlist(allow), ['2@g.us']);

  // a second confirm with the same token throws NO_PENDING (single-use)
  await assert.rejects(
    () => handle({ cmd: 'sendConfirm', args: { token: created.token } }, { session, allowlistPath: allow, defaults, pending }),
    (e) => e.code === 'NO_PENDING',
  );
});

test('sendConfirm with an unknown token throws NO_PENDING', async () => {
  await assert.rejects(
    () => handle({ cmd: 'sendConfirm', args: { token: 'nope' } }, ctx()),
    (e) => e.code === 'NO_PENDING',
  );
});

test('sendConfirm re-checks the allow-list at confirm time', async () => {
  const allow = tmpAllow();
  const session = fakeSession();
  const pending = createPendingStore();
  saveAllowlist(allow, ['2@g.us']);
  const created = await handle({ cmd: 'send', args: { chat: 'notes', text: 'hey' } }, { session, allowlistPath: allow, defaults, pending });

  // chat removed from allow-list between create and confirm
  saveAllowlist(allow, []);

  await assert.rejects(
    () => handle({ cmd: 'sendConfirm', args: { token: created.token } }, { session, allowlistPath: allow, defaults, pending }),
    /not on the send allow-list/,
  );
  assert.strictEqual(session.sendCalls.length, 0, 'nothing transmitted when gate refuses at confirm');
});

test('sendMedia to an allow-listed chat returns a pending token; confirm transmits', async () => {
  const allow = tmpAllow();
  const session = fakeSession();
  const pending = createPendingStore();
  saveAllowlist(allow, ['2@g.us']);

  const created = await handle({ cmd: 'sendMedia', args: { chat: 'notes', path: '/tmp/x.png', caption: 'cap' } }, { session, allowlistPath: allow, defaults, pending });
  assert.strictEqual(created.pending, true);
  assert.ok(created.token);
  assert.match(created.preview, /\[media\] \/tmp\/x\.png/);
  assert.strictEqual(session.sendMediaCalls.length, 0);

  const confirmed = await handle({ cmd: 'sendConfirm', args: { token: created.token } }, { session, allowlistPath: allow, defaults, pending });
  assert.strictEqual(confirmed.id, 'media-2@g.us');
  assert.strictEqual(session.sendMediaCalls.length, 1);
  assert.strictEqual(session.sendMediaCalls[0].filePath, '/tmp/x.png');
  assert.strictEqual(session.sendMediaCalls[0].caption, 'cap');
});

test('sendMedia to a non-allowlisted chat is refused (no token)', async () => {
  const c = ctx();
  await assert.rejects(
    () => handle({ cmd: 'sendMedia', args: { chat: 'notes', path: '/tmp/x.png' } }, c),
    /not on the send allow-list/,
  );
  assert.strictEqual(c.pending.size(), 0);
});

test('ambiguous chat throws', async () => {
  const c = ctx();
  c.session.listChats = async () => ([{ id: 'a@g.us', name: 'Indie TLV' }, { id: 'b@g.us', name: 'Indie Berlin' }]);
  await assert.rejects(
    () => handle({ cmd: 'read', args: { chat: 'Indie' } }, c),
    /ambiguous/,
  );
});

test('unknown command throws', async () => {
  await assert.rejects(
    () => handle({ cmd: 'bogus' }, ctx()),
    /unknown command/,
  );
});

// FIX 7 — every outward-facing write command is gated by the allow-list, not
// just `send`. markRead is exempt: it only mutates our own read state and is
// invisible to the other party, so it is NOT gated (see below).
for (const cmd of ['send', 'sendMedia', 'react']) {
  const args = { chat: 'notes', text: 'hi', path: '/tmp/x', messageId: 'm1', emoji: '👍' };

  test(cmd + ' to non-allowlisted chat is refused', async () => {
    await assert.rejects(
      () => handle({ cmd, args }, ctx()),
      /not on the send allow-list/,
    );
  });

  test(cmd + ' succeeds after allow add', async () => {
    const allow = tmpAllow();
    const session = fakeSession();
    const pending = createPendingStore();
    saveAllowlist(allow, ['2@g.us']);
    const data = await handle({ cmd, args }, { session, allowlistPath: allow, defaults, pending });
    // content-bearing sends are two-step (pending token); react stays single-step.
    if (cmd === 'send' || cmd === 'sendMedia') {
      assert.strictEqual(data.pending, true, cmd + ' should return a pending token after allow add');
      assert.ok(data.token);
    } else {
      assert.ok(data && (data.id || data.ok), cmd + ' should return a result after allow add');
    }
  });
}

// markRead is NOT allow-list gated: it only changes our own read state (marks a
// chat seen), never sends anything visible to the other party.
test('markRead on a non-allowlisted chat succeeds (not gated)', async () => {
  const c = ctx();
  const data = await handle({ cmd: 'markRead', args: { chat: 'notes' } }, c);
  assert.ok(data && data.ok, 'markRead should return a result without allow-listing');
});

// FIX 8 — clampLimit reaches the session.
test('read clamps a huge limit to MAX_LIMIT', async () => {
  const c = ctx();
  await handle({ cmd: 'read', args: { chat: 'poker', limit: 9999 } }, c);
  assert.strictEqual(c.session.lastReadLimit, defaults.MAX_LIMIT);
});

test('read with no limit uses DEFAULT_READ_LIMIT', async () => {
  const c = ctx();
  await handle({ cmd: 'read', args: { chat: 'poker' } }, c);
  assert.strictEqual(c.session.lastReadLimit, defaults.DEFAULT_READ_LIMIT);
});

// FIX 8 — HTTP envelope behaviour over a real unix socket.
function rpcRaw(sockPath, { path: urlPath = '/rpc', method = 'POST', body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: sockPath, path: urlPath, method, headers: { 'content-type': 'application/json' } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { let parsed; try { parsed = JSON.parse(data); } catch { parsed = data; } resolve({ status: res.statusCode, body: parsed }); });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('HTTP envelope: unknown route, bad json, and gate error', async () => {
  const sockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-sock-'));
  const sockPath = path.join(sockDir, 'ctl.sock');
  const server = createControlServer({ session: fakeSession(), allowlistPath: tmpAllow(), defaults, pending: createPendingStore() });
  await new Promise((r) => server.listen(sockPath, r));
  try {
    const unknown = await rpcRaw(sockPath, { path: '/nope', method: 'GET' });
    assert.strictEqual(unknown.status, 404);
    assert.strictEqual(unknown.body.ok, false);

    const badJson = await rpcRaw(sockPath, { body: '{not json' });
    assert.strictEqual(badJson.body.ok, false);
    assert.strictEqual(badJson.body.code, 'BAD_JSON');

    const gated = await rpcRaw(sockPath, { body: JSON.stringify({ cmd: 'send', args: { chat: 'notes', text: 'hi' } }) });
    assert.strictEqual(gated.status, 200);
    assert.strictEqual(gated.body.ok, false);
    assert.strictEqual(gated.body.code, 'NOT_ALLOWED');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// ---- gated allow-list mutations (native-dialog approval) ----
const approveYes = async () => ({ approved: true, reason: 'approved' });
const approveNo = async () => ({ approved: false, reason: 'denied' });
function recordingApprover(result) {
  const calls = [];
  const fn = async (req) => { calls.push(req); return result; };
  return { fn, calls };
}

test('allowAdd batch: one approval, all written at once', async () => {
  const c = ctx();
  const { fn, calls } = recordingApprover({ approved: true, reason: 'approved' });
  c.approve = fn;
  const list = await handle({ cmd: 'allowAdd', args: { chats: ['poker', 'notes'] } }, c);
  assert.deepStrictEqual(list, ['1@g.us', '2@g.us']);
  assert.strictEqual(calls.length, 1, 'exactly one dialog for the whole batch');
  assert.match(calls[0].message, /poker/);
  assert.match(calls[0].message, /notes/);
});

test('allowAdd denied: list untouched, NOT_APPROVED', async () => {
  const c = ctx();
  c.approve = approveNo;
  await assert.rejects(
    () => handle({ cmd: 'allowAdd', args: { chats: ['poker'] } }, c),
    (e) => e.code === 'NOT_APPROVED' && /denied/.test(e.message),
  );
  assert.deepStrictEqual(loadAllowlist(c.allowlistPath), []);
});

test('allowAdd timeout and unavailable produce actionable messages', async () => {
  for (const [reason, pattern] of [['timeout', /timed out/], ['unavailable', /allowlist\.json/]]) {
    const c = ctx();
    c.approve = async () => ({ approved: false, reason });
    await assert.rejects(
      () => handle({ cmd: 'allowAdd', args: { chats: ['poker'] } }, c),
      (e) => e.code === 'NOT_APPROVED' && pattern.test(e.message),
    );
  }
});

test('allowAdd with nothing new skips the dialog entirely', async () => {
  const c = ctx();
  saveAllowlist(c.allowlistPath, ['1@g.us']);
  const { fn, calls } = recordingApprover({ approved: true, reason: 'approved' });
  c.approve = fn;
  const list = await handle({ cmd: 'allowAdd', args: { chats: ['poker', 'poker'] } }, c);
  assert.deepStrictEqual(list, ['1@g.us']);
  assert.strictEqual(calls.length, 0, 'no dialog when the delta is empty');
});

test('allowAdd with an ambiguous ref fails before any dialog', async () => {
  const c = ctx();
  c.session.listChats = async () => ([{ id: 'a@g.us', name: 'Indie TLV' }, { id: 'b@g.us', name: 'Indie Berlin' }]);
  const { fn, calls } = recordingApprover({ approved: true, reason: 'approved' });
  c.approve = fn;
  await assert.rejects(() => handle({ cmd: 'allowAdd', args: { chats: ['Indie'] } }, c), /ambiguous/);
  assert.strictEqual(calls.length, 0);
});

test('allowRemove accepts stale raw ids no longer resolvable as chats', async () => {
  const c = ctx();
  saveAllowlist(c.allowlistPath, ['gone@g.us', '1@g.us']);
  c.approve = approveYes;
  const list = await handle({ cmd: 'allowRemove', args: { chats: ['gone@g.us'] } }, c);
  assert.deepStrictEqual(list, ['1@g.us']);
});

test('allowRemove denied leaves the list intact', async () => {
  const c = ctx();
  saveAllowlist(c.allowlistPath, ['1@g.us']);
  c.approve = approveNo;
  await assert.rejects(
    () => handle({ cmd: 'allowRemove', args: { chats: ['poker'] } }, c),
    (e) => e.code === 'NOT_APPROVED',
  );
  assert.deepStrictEqual(loadAllowlist(c.allowlistPath), ['1@g.us']);
});

test('allowAll adds * behind an EVERYONE dialog; allowRemoveAll reverts it', async () => {
  const c = ctx();
  saveAllowlist(c.allowlistPath, ['1@g.us']);
  const { fn, calls } = recordingApprover({ approved: true, reason: 'approved' });
  c.approve = fn;
  const list = await handle({ cmd: 'allowAll', args: {} }, c);
  assert.deepStrictEqual(list, ['1@g.us', '*']);
  assert.match(calls[0].message, /EVERYONE/);

  const reverted = await handle({ cmd: 'allowRemoveAll', args: {} }, c);
  assert.deepStrictEqual(reverted, ['1@g.us']);
  assert.strictEqual(calls.length, 2, 'remove-all is gated too');
});

test('allowAll when * is already present skips the dialog', async () => {
  const c = ctx();
  saveAllowlist(c.allowlistPath, ['*']);
  const { fn, calls } = recordingApprover({ approved: true, reason: 'approved' });
  c.approve = fn;
  assert.deepStrictEqual(await handle({ cmd: 'allowAll', args: {} }, c), ['*']);
  assert.strictEqual(calls.length, 0);
});

// FIX 5 — deny-path coverage for the two highest-stakes mutations.
test('allowAll denied leaves the list unchanged (NOT_APPROVED)', async () => {
  const c = ctx();
  saveAllowlist(c.allowlistPath, ['1@g.us']);
  c.approve = approveNo;
  await assert.rejects(
    () => handle({ cmd: 'allowAll', args: {} }, c),
    (e) => e.code === 'NOT_APPROVED',
  );
  assert.deepStrictEqual(loadAllowlist(c.allowlistPath), ['1@g.us']);
});

test('allowRemoveAll denied keeps the * wildcard (NOT_APPROVED)', async () => {
  const c = ctx();
  saveAllowlist(c.allowlistPath, ['1@g.us', '*']);
  c.approve = approveNo;
  await assert.rejects(
    () => handle({ cmd: 'allowRemoveAll', args: {} }, c),
    (e) => e.code === 'NOT_APPROVED',
  );
  assert.deepStrictEqual(loadAllowlist(c.allowlistPath), ['1@g.us', '*']);
});

test('a * wildcard allows sends to any chat', async () => {
  const c = ctx();
  saveAllowlist(c.allowlistPath, ['*']);
  const data = await handle({ cmd: 'send', args: { chat: 'notes', text: 'hey' } }, c);
  assert.strictEqual(data.pending, true);
});

test('allow mutations without an approver in ctx are refused, not crashed', async () => {
  const c = ctx(); // no c.approve set
  await assert.rejects(
    () => handle({ cmd: 'allowAdd', args: { chats: ['poker'] } }, c),
    (e) => e.code === 'NOT_APPROVED',
  );
});

// FIX 1 — a crafted chat/group name must not forge extra dialog lines.
// Note: sanitizeName neutralizes control chars / line separators (the actual
// exploit primitive — a bare "•" glyph in a name is inert without a newline to
// place it on its own line), so a literal "•" glyph embedded in the name can
// still appear inline. What must never happen is the forged text landing on
// its own line, which is what the second assertion below guards.
test('bulletList sanitizes newlines and forged bullets in chat names', async () => {
  const c = ctx();
  c.session.listChats = async () => ([{ id: 'evil@g.us', name: 'Book Club\n• Book Club (spoof@g.us' }]);
  const { fn, calls } = recordingApprover({ approved: true, reason: 'approved' });
  c.approve = fn;
  await handle({ cmd: 'allowAdd', args: { chats: ['evil@g.us'] } }, c);
  const msg = calls[0].message;
  assert.strictEqual((msg.match(/\n•/g) || []).length, 1, 'exactly one bullet starts a new line — forged one flattened inline');
  assert.ok(!/\n• Book Club \(spoof@g\.us/.test(msg), 'forged bullet must not appear as its own line');
});

test('bulletList truncates an over-long chat name', async () => {
  const c = ctx();
  c.session.listChats = async () => ([{ id: 'long@g.us', name: 'x'.repeat(200) }]);
  const { fn, calls } = recordingApprover({ approved: true, reason: 'approved' });
  c.approve = fn;
  await handle({ cmd: 'allowAdd', args: { chats: ['long@g.us'] } }, c);
  assert.ok(calls[0].message.includes('…'), 'long name truncated with an ellipsis');
  assert.ok(!calls[0].message.includes('x'.repeat(70)), 'no 70-char run of the raw name survives');
});

// FIX 3 + 7 — a malformed approver result must fail closed, not crash or approve.
test('a malformed approver result (undefined) denies with NOT_APPROVED, not a crash', async () => {
  const c = ctx();
  c.approve = async () => undefined;
  await assert.rejects(
    () => handle({ cmd: 'allowAdd', args: { chats: ['poker'] } }, c),
    (e) => e.code === 'NOT_APPROVED',
  );
  assert.deepStrictEqual(loadAllowlist(c.allowlistPath), []);
});

test('a truthy non-boolean approved value is NOT treated as approval', async () => {
  const c = ctx();
  c.approve = async () => ({ approved: 'yes' });
  await assert.rejects(
    () => handle({ cmd: 'allowAdd', args: { chats: ['poker'] } }, c),
    (e) => e.code === 'NOT_APPROVED',
  );
  assert.deepStrictEqual(loadAllowlist(c.allowlistPath), []);
});

test('sanitizeName neutralizes bidi overrides, zero-width, and NBSP in dialog names', async () => {
  const c = ctx();
  const tricky = 'Safe‮evil​ (real@g.us';
  c.session.listChats = async () => ([{ id: 'x@g.us', name: tricky }]);
  const { fn, calls } = recordingApprover({ approved: true, reason: 'approved' });
  c.approve = fn;
  await handle({ cmd: 'allowAdd', args: { chats: ['x@g.us'] } }, c);
  const msg = calls[0].message;
  assert.ok(!/[‪-‮⁦-⁩​-‏﻿ ]/.test(msg), 'no bidi/zero-width/NBSP chars survive in the dialog');
  assert.ok(msg.includes('(x@g.us)'), 'the real chat id is still shown intact');
});
