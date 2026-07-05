const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { handle } = require('../src/control-server');
const { createPendingStore } = require('../src/pending');

const defaults = { DEFAULT_READ_LIMIT: 30, MAX_LIMIT: 200 };
const NOW = new Date(2026, 6, 6, 10, 0).getTime(); // Mon 2026-07-06 10:00 local

function fakeSession() {
  return {
    sendCalls: [],
    status: async () => ({ ready: true, state: 'ready' }),
    listChats: async () => ([{ id: '2@g.us', name: 'notes', unread: 0 }]),
    send: async (id, text) => ({ id: 'sent-' + text }),
  };
}

function fakeScheduler() {
  const s = {
    added: [], cancelledIds: [],
    add(job) { const j = { id: 'job-1', status: 'active', lastResult: null, ...job }; s.added.push(j); return j; },
    cancel(id) { s.cancelledIds.push(id); return { id, status: 'cancelled' }; },
    list(opts) { s.lastListOpts = opts; return [{ id: 'j1', status: 'active', when: 'every day at 09:00' }]; },
  };
  return s;
}

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'wa-cs-')); }

function ctx(overrides = {}) {
  const dir = tmpDir();
  const allowlistPath = path.join(dir, 'allowlist.json');
  fs.writeFileSync(allowlistPath, JSON.stringify(['2@g.us']));
  return {
    session: fakeSession(), allowlistPath, defaults,
    pending: createPendingStore(), scheduler: fakeScheduler(), now: () => NOW,
    _dir: dir,
    ...overrides,
  };
}

test('schedule to a non-allowlisted chat is refused, no token issued', async () => {
  const c = ctx();
  fs.writeFileSync(c.allowlistPath, '[]');
  await assert.rejects(
    () => handle({ cmd: 'schedule', args: { chat: 'notes', text: 'hi', in: '2h' } }, c),
    (e) => e.code === 'NOT_ALLOWED',
  );
  assert.strictEqual(c.pending.size(), 0);
});

test('schedule returns a pending token and arms NOTHING', async () => {
  const c = ctx();
  const data = await handle({ cmd: 'schedule', args: { chat: 'notes', text: 'hey', every: 'friday', at: '09:00' } }, c);
  assert.strictEqual(data.pending, true);
  assert.ok(data.token);
  assert.strictEqual(data.chat, 'notes');
  assert.strictEqual(data.when, 'every friday at 09:00');
  assert.match(data.preview, /every friday at 09:00/);
  assert.match(data.preview, /hey/);
  assert.strictEqual(c.scheduler.added.length, 0, 'nothing persisted before confirm');
});

test('scheduleConfirm persists the job with a recomputed nextFireAt', async () => {
  const c = ctx();
  const created = await handle({ cmd: 'schedule', args: { chat: 'notes', text: 'hey', every: 'friday', at: '09:00' } }, c);
  const confirmed = await handle({ cmd: 'scheduleConfirm', args: { token: created.token } }, c);
  assert.strictEqual(confirmed.scheduled, true);
  assert.strictEqual(confirmed.job.id, 'job-1');
  assert.strictEqual(confirmed.job.when, 'every friday at 09:00');
  assert.strictEqual(c.scheduler.added.length, 1);
  const job = c.scheduler.added[0];
  assert.strictEqual(job.kind, 'send');
  assert.strictEqual(job.chatId, '2@g.us');
  assert.strictEqual(job.text, 'hey');
  assert.strictEqual(job.nextFireAt, new Date(2026, 6, 10, 9, 0).getTime());
});

test('scheduleConfirm rejects a one-shot whose time passed while unconfirmed', async () => {
  const c = ctx();
  const created = await handle({ cmd: 'schedule', args: { chat: 'notes', text: 'hey', in: '1m' } }, c);
  c.now = () => NOW + 2 * 60000; // 2 minutes later
  await assert.rejects(
    () => handle({ cmd: 'scheduleConfirm', args: { token: created.token } }, c),
    (e) => e.code === 'PAST_SCHEDULE',
  );
  assert.strictEqual(c.scheduler.added.length, 0);
});

test('scheduleConfirm re-checks the allow-list at confirm time', async () => {
  const c = ctx();
  const created = await handle({ cmd: 'schedule', args: { chat: 'notes', text: 'hey', in: '2h' } }, c);
  fs.writeFileSync(c.allowlistPath, '[]');
  await assert.rejects(
    () => handle({ cmd: 'scheduleConfirm', args: { token: created.token } }, c),
    (e) => e.code === 'NOT_ALLOWED',
  );
  assert.strictEqual(c.scheduler.added.length, 0);
});

test('token kinds are not interchangeable (send vs schedule)', async () => {
  const c = ctx();
  const sched = await handle({ cmd: 'schedule', args: { chat: 'notes', text: 'hey', in: '2h' } }, c);
  await assert.rejects(
    () => handle({ cmd: 'sendConfirm', args: { token: sched.token } }, c),
    (e) => e.code === 'WRONG_KIND',
  );
  const send = await handle({ cmd: 'send', args: { chat: 'notes', text: 'now' } }, c);
  await assert.rejects(
    () => handle({ cmd: 'scheduleConfirm', args: { token: send.token } }, c),
    (e) => e.code === 'WRONG_KIND',
  );
});

test('schedule validates the when-flags (BAD_SCHEDULE / PAST_SCHEDULE)', async () => {
  const c = ctx();
  await assert.rejects(
    () => handle({ cmd: 'schedule', args: { chat: 'notes', text: 'x' } }, c),
    (e) => e.code === 'BAD_SCHEDULE',
  );
  await assert.rejects(
    () => handle({ cmd: 'schedule', args: { chat: 'notes', text: 'x', at: '2026-01-01 09:00' } }, c),
    (e) => e.code === 'PAST_SCHEDULE',
  );
});

test('schedule requires content (text or media)', async () => {
  const c = ctx();
  await assert.rejects(
    () => handle({ cmd: 'schedule', args: { chat: 'notes', in: '2h' } }, c),
    (e) => e.code === 'BAD_ARGS',
  );
});

test('schedule media: missing file rejected; existing file stored as absolute path', async () => {
  const c = ctx();
  await assert.rejects(
    () => handle({ cmd: 'schedule', args: { chat: 'notes', media: path.join(c._dir, 'nope.png'), in: '2h' } }, c),
    (e) => e.code === 'NO_FILE',
  );
  const file = path.join(c._dir, 'pic.png');
  fs.writeFileSync(file, 'x');
  const created = await handle({ cmd: 'schedule', args: { chat: 'notes', media: file, caption: 'cap', in: '2h' } }, c);
  const confirmed = await handle({ cmd: 'scheduleConfirm', args: { token: created.token } }, c);
  assert.strictEqual(confirmed.job.kind, 'sendMedia');
  assert.ok(path.isAbsolute(confirmed.job.path));
  assert.strictEqual(confirmed.job.caption, 'cap');
});

test('scheduleList and scheduleCancel delegate to the scheduler', async () => {
  const c = ctx();
  const list = await handle({ cmd: 'scheduleList', args: { all: true } }, c);
  assert.deepStrictEqual(c.scheduler.lastListOpts, { all: true });
  assert.strictEqual(list[0].id, 'j1');
  const cancelled = await handle({ cmd: 'scheduleCancel', args: { id: 'j1' } }, c);
  assert.strictEqual(cancelled.status, 'cancelled');
  assert.deepStrictEqual(c.scheduler.cancelledIds, ['j1']);
});
