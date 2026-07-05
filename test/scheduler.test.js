const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createScheduler } = require('../src/scheduler');
const { loadJobs } = require('../src/schedule-store');

const T0 = new Date(2026, 6, 6, 10, 0).getTime(); // Mon 2026-07-06 10:00 local
const GRACE = 120000;

function setup({ allowed = ['1@g.us'] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-sched-'));
  const storePath = path.join(dir, 'schedules.json');
  const allowlistPath = path.join(dir, 'allowlist.json');
  fs.writeFileSync(allowlistPath, JSON.stringify(allowed));
  const state = { clock: T0 };
  const session = {
    ready: true,
    sendCalls: [],
    sendMediaCalls: [],
    failWith: null,
    async send(chatId, text) {
      if (!session.ready) { const e = new Error('not ready'); e.code = 'NOT_READY'; throw e; }
      if (session.failWith) throw session.failWith;
      session.sendCalls.push({ chatId, text });
      return { id: 'sent-1' };
    },
    async sendMedia(chatId, filePath, caption) {
      if (!session.ready) { const e = new Error('not ready'); e.code = 'NOT_READY'; throw e; }
      session.sendMediaCalls.push({ chatId, filePath, caption });
      return { id: 'sent-m' };
    },
  };
  const scheduler = createScheduler({
    storePath, session, allowlistPath,
    graceMs: GRACE, now: () => state.clock, log: () => {},
  });
  return { scheduler, session, storePath, state };
}

function onceJob(at, extra = {}) {
  return { kind: 'send', chatId: '1@g.us', chatName: 'notes', text: 'hi', spec: { type: 'once', at }, nextFireAt: at, createdAt: T0, ...extra };
}

test('job not yet due does not fire', async () => {
  const { scheduler, session } = setup();
  scheduler.add(onceJob(T0 + 60000));
  await scheduler.tick();
  assert.strictEqual(session.sendCalls.length, 0);
});

test('due one-shot within grace fires once and goes done', async () => {
  const { scheduler, session, storePath, state } = setup();
  const job = scheduler.add(onceJob(T0 + 60000));
  state.clock = T0 + 60000 + 5000; // 5s late: inside grace
  await scheduler.tick();
  assert.deepStrictEqual(session.sendCalls, [{ chatId: '1@g.us', text: 'hi' }]);
  const stored = loadJobs(storePath).find((j) => j.id === job.id);
  assert.strictEqual(stored.status, 'done');
  assert.strictEqual(stored.lastResult.ok, true);
  assert.strictEqual(stored.nextFireAt, null);
  // a second tick does not re-fire
  await scheduler.tick();
  assert.strictEqual(session.sendCalls.length, 1);
});

test('one-shot past grace is marked missed and never sent', async () => {
  const { scheduler, session, storePath, state } = setup();
  const job = scheduler.add(onceJob(T0 + 60000));
  state.clock = T0 + 60000 + GRACE + 1;
  await scheduler.tick();
  assert.strictEqual(session.sendCalls.length, 0);
  const stored = loadJobs(storePath).find((j) => j.id === job.id);
  assert.strictEqual(stored.status, 'missed');
  assert.strictEqual(stored.lastResult.ok, false);
});

test('recurring job fires and advances to the next occurrence', async () => {
  const { scheduler, session, storePath, state } = setup();
  const spec = { type: 'recurring', every: 'day', hour: 9, minute: 0 };
  const first = new Date(2026, 6, 7, 9, 0).getTime();
  const job = scheduler.add({ kind: 'send', chatId: '1@g.us', chatName: 'notes', text: 'boker tov', spec, nextFireAt: first, createdAt: T0 });
  state.clock = first + 1000;
  await scheduler.tick();
  assert.strictEqual(session.sendCalls.length, 1);
  const stored = loadJobs(storePath).find((j) => j.id === job.id);
  assert.strictEqual(stored.status, 'active');
  assert.strictEqual(stored.nextFireAt, new Date(2026, 6, 8, 9, 0).getTime());
});

test('recurring job missed past grace advances without sending', async () => {
  const { scheduler, session, storePath, state } = setup();
  const spec = { type: 'recurring', every: 'day', hour: 9, minute: 0 };
  const first = new Date(2026, 6, 7, 9, 0).getTime();
  const job = scheduler.add({ kind: 'send', chatId: '1@g.us', chatName: 'notes', text: 'boker tov', spec, nextFireAt: first, createdAt: T0 });
  state.clock = first + GRACE + 60000; // way past grace (daemon was down)
  await scheduler.tick();
  assert.strictEqual(session.sendCalls.length, 0);
  const stored = loadJobs(storePath).find((j) => j.id === job.id);
  assert.strictEqual(stored.status, 'active');
  assert.strictEqual(stored.lastResult.ok, false);
  assert.strictEqual(stored.nextFireAt, new Date(2026, 6, 8, 9, 0).getTime());
});

test('NOT_READY defers the job, then fires when ready (still in grace)', async () => {
  const { scheduler, session, storePath, state } = setup();
  const job = scheduler.add(onceJob(T0 + 60000));
  session.ready = false;
  state.clock = T0 + 60000 + 1000;
  await scheduler.tick();
  assert.strictEqual(loadJobs(storePath)[0].status, 'active', 'still active after deferred tick');
  session.ready = true;
  state.clock = T0 + 60000 + 40000; // next tick, still inside grace
  await scheduler.tick();
  assert.strictEqual(session.sendCalls.length, 1);
  assert.strictEqual(loadJobs(storePath).find((j) => j.id === job.id).status, 'done');
});

test('NOT_READY through the whole grace window ends missed', async () => {
  const { scheduler, session, storePath, state } = setup();
  scheduler.add(onceJob(T0 + 60000));
  session.ready = false;
  state.clock = T0 + 60000 + 1000;
  await scheduler.tick();
  state.clock = T0 + 60000 + GRACE + 1;
  await scheduler.tick();
  assert.strictEqual(loadJobs(storePath)[0].status, 'missed');
  assert.strictEqual(session.sendCalls.length, 0);
});

test('allowlist revoked between scheduling and fire blocks the send', async () => {
  const { scheduler, session, storePath, state } = setup({ allowed: [] });
  scheduler.add(onceJob(T0 + 60000));
  state.clock = T0 + 60000 + 1000;
  await scheduler.tick();
  assert.strictEqual(session.sendCalls.length, 0);
  const stored = loadJobs(storePath)[0];
  assert.strictEqual(stored.status, 'failed');
  assert.match(stored.lastResult.error, /allow-list/);
});

test('non-transient send error fails immediately (single attempt)', async () => {
  const { scheduler, session, storePath, state } = setup();
  scheduler.add(onceJob(T0 + 60000));
  session.failWith = new Error('boom');
  state.clock = T0 + 60000 + 1000;
  await scheduler.tick();
  const stored = loadJobs(storePath)[0];
  assert.strictEqual(stored.status, 'failed');
  assert.strictEqual(stored.lastResult.error, 'boom');
  session.failWith = null;
  await scheduler.tick();
  assert.strictEqual(session.sendCalls.length, 0, 'failed one-shot is not retried');
});

test('recurring job records a failure and advances, staying active', async () => {
  const { scheduler, session, storePath, state } = setup();
  const spec = { type: 'recurring', every: 'day', hour: 9, minute: 0 };
  const first = new Date(2026, 6, 7, 9, 0).getTime();
  scheduler.add({ kind: 'send', chatId: '1@g.us', chatName: 'notes', text: 'x', spec, nextFireAt: first, createdAt: T0 });
  session.failWith = new Error('boom');
  state.clock = first + 1000;
  await scheduler.tick();
  const stored = loadJobs(storePath)[0];
  assert.strictEqual(stored.status, 'active');
  assert.strictEqual(stored.lastResult.error, 'boom');
  assert.strictEqual(stored.nextFireAt, new Date(2026, 6, 8, 9, 0).getTime());
});

test('media job fires through session.sendMedia', async () => {
  const { scheduler, session, state } = setup();
  scheduler.add({ kind: 'sendMedia', chatId: '1@g.us', chatName: 'notes', path: '/tmp/pic.jpg', caption: 'c', spec: { type: 'once', at: T0 + 60000 }, nextFireAt: T0 + 60000, createdAt: T0 });
  state.clock = T0 + 60000 + 1000;
  await scheduler.tick();
  assert.deepStrictEqual(session.sendMediaCalls, [{ chatId: '1@g.us', filePath: '/tmp/pic.jpg', caption: 'c' }]);
});

test('cancelled job never fires; list decorates with when', async () => {
  const { scheduler, session, state } = setup();
  const job = scheduler.add(onceJob(T0 + 60000));
  scheduler.cancel(job.id);
  state.clock = T0 + 60000 + 1000;
  await scheduler.tick();
  assert.strictEqual(session.sendCalls.length, 0);
  assert.strictEqual(scheduler.list().length, 0, 'default list hides cancelled');
  const all = scheduler.list({ all: true });
  assert.strictEqual(all.length, 1);
  assert.strictEqual(all[0].status, 'cancelled');
  assert.match(all[0].when, /^once at 2026-07-06 10:01$/);
});

test('start() ticks immediately and stop() halts the interval', async () => {
  const { scheduler, session, state } = setup();
  scheduler.add(onceJob(T0 + 60000));
  state.clock = T0 + 60000 + 1000;
  scheduler.start();
  await new Promise((r) => setTimeout(r, 20)); // let the immediate tick's async work settle
  scheduler.stop();
  assert.strictEqual(session.sendCalls.length, 1);
});

test('re-entrant tick does not double-fire while a send is in flight (#1)', async () => {
  const { scheduler, session, storePath, state } = setup();
  const job = scheduler.add(onceJob(T0 + 60000));
  state.clock = T0 + 60000 + 5000; // due, within grace
  let release;
  const gate = new Promise((r) => { release = r; });
  const sent = [];
  session.send = async (chatId, text) => { await gate; sent.push(text); return { id: 'sent-1' }; };
  const p1 = scheduler.tick();   // enters, running=true, suspends on the hung send
  const p2 = scheduler.tick();   // must early-return via the running guard
  await p2;
  assert.strictEqual(sent.length, 0, 'second overlapping tick fired nothing');
  release();
  await p1;
  assert.strictEqual(sent.length, 1, 'exactly one send despite overlapping ticks');
  assert.strictEqual(loadJobs(storePath).find((j) => j.id === job.id).status, 'done');
});

test('a co-due job is grace-checked against real time, not the tick start (#2 never-send-late)', async () => {
  const { scheduler, session, storePath, state } = setup();
  const a = scheduler.add({ ...onceJob(T0 + 60000), text: 'A' });
  const b = scheduler.add({ ...onceJob(T0 + 60000), text: 'B' });
  state.clock = T0 + 60000 + 1000; // both due & within grace at tick start
  const sent = [];
  session.send = async (chatId, text) => {
    sent.push(text);
    if (text === 'A') state.clock = T0 + 60000 + GRACE + 60000; // A's send stalls past grace
    return { id: 'sent-' + text };
  };
  await scheduler.tick();
  assert.deepStrictEqual(sent, ['A'], 'B skipped: by the time it is processed it is past grace');
  assert.strictEqual(loadJobs(storePath).find((j) => j.id === b.id).status, 'missed');
  assert.strictEqual(loadJobs(storePath).find((j) => j.id === a.id).status, 'done');
});

test('a malformed job (null spec) is quarantined and does not abort the tick (#4)', async () => {
  const { scheduler, session, storePath, state } = setup();
  scheduler.add({ kind: 'send', chatId: '1@g.us', chatName: 'notes', text: 'bad', spec: null, nextFireAt: T0 + 60000, createdAt: T0 });
  const good = scheduler.add(onceJob(T0 + 60000)); // text 'hi'
  state.clock = T0 + 60000 + 5000;
  await scheduler.tick();
  assert.strictEqual(session.sendCalls.length, 1, 'only the valid job fired');
  assert.strictEqual(session.sendCalls[0].text, 'hi');
  const bad = loadJobs(storePath).find((j) => j.text === 'bad');
  assert.strictEqual(bad.status, 'failed', 'malformed job quarantined, never sent');
  assert.strictEqual(loadJobs(storePath).find((j) => j.id === good.id).status, 'done');
});

test('a job exactly at the grace boundary is still sent, not missed (#6)', async () => {
  const { scheduler, session, storePath, state } = setup();
  const job = scheduler.add(onceJob(T0 + 60000));
  state.clock = T0 + 60000 + GRACE; // t - nextFireAt === graceMs, which is NOT > graceMs
  await scheduler.tick();
  assert.strictEqual(session.sendCalls.length, 1, 'exactly-at-grace fires');
  assert.strictEqual(loadJobs(storePath).find((j) => j.id === job.id).status, 'done');
});

test('a job due exactly at now fires this tick (#7 due-check boundary)', async () => {
  const { scheduler, session, storePath, state } = setup();
  const job = scheduler.add(onceJob(T0 + 60000));
  state.clock = T0 + 60000; // exactly nextFireAt
  await scheduler.tick();
  assert.strictEqual(session.sendCalls.length, 1, 'nextFireAt === now is due');
  assert.strictEqual(loadJobs(storePath).find((j) => j.id === job.id).status, 'done');
});
