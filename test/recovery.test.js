const test = require('node:test');
const assert = require('node:assert');
const { createRecovery } = require('../src/recovery');

// Controllable fake timer: captures the pending callback so a test can fire it.
function fakeTimers() {
  let cb = null;
  let id = 0;
  return {
    setTimer: (fn) => { cb = fn; return ++id; },
    clearTimer: () => { cb = null; },
    pending: () => cb !== null,
    async fire() { const f = cb; cb = null; if (f) await f(); },
  };
}

function spy() {
  const calls = [];
  const fn = async (...a) => { calls.push(a); };
  fn.calls = calls;
  return fn;
}

function build(overrides = {}) {
  const t = fakeTimers();
  const softReset = spy();
  const hardReset = spy();
  const exit = spy();
  const r = createRecovery({
    readyTimeoutMs: 1000, maxSoft: 3,
    softReset, hardReset, exit, log: () => {},
    setTimer: t.setTimer, clearTimer: t.clearTimer,
    ...overrides,
  });
  return { r, t, softReset, hardReset, exit };
}

test('onInitStarted arms the watchdog', () => {
  const { r, t } = build();
  assert.strictEqual(t.pending(), false);
  r.onInitStarted();
  assert.strictEqual(t.pending(), true);
  assert.strictEqual(r.snapshot().phase, 'starting');
});

test('timeout triggers a soft reset (no QR), re-arms, and reports the attempt', async () => {
  const { r, t, softReset, hardReset } = build();
  r.onInitStarted();
  await t.fire();
  assert.strictEqual(softReset.calls.length, 1);
  assert.strictEqual(hardReset.calls.length, 0);
  assert.strictEqual(t.pending(), true, 're-armed for the next window');
  assert.deepStrictEqual(r.snapshot(), { phase: 'recovering', softAttempt: 1, maxSoft: 3 });
});

test('three soft resets, then the fourth timeout hard-relinks (QR)', async () => {
  const { r, t, softReset, hardReset } = build();
  r.onInitStarted();
  await t.fire(); await t.fire(); await t.fire();
  assert.strictEqual(softReset.calls.length, 3);
  assert.strictEqual(hardReset.calls.length, 0);
  await t.fire();
  assert.strictEqual(softReset.calls.length, 3, 'no more soft resets after the budget');
  assert.strictEqual(hardReset.calls.length, 1);
  assert.strictEqual(r.snapshot().phase, 'relinking');
});

test('if even the hard re-link hangs, exit for a launchd restart', async () => {
  const { r, t, hardReset, exit } = build();
  r.onInitStarted();
  await t.fire(); await t.fire(); await t.fire(); // 3 soft
  await t.fire();                                  // hard relink
  assert.strictEqual(hardReset.calls.length, 1);
  await t.fire();                                  // still stuck after relink
  assert.strictEqual(exit.calls.length, 1);
});

test('onReady clears the watchdog and resets the soft budget', async () => {
  const { r, t, softReset } = build();
  r.onInitStarted();
  await t.fire();                       // one soft reset
  assert.strictEqual(r.snapshot().softAttempt, 1);
  r.onReady();
  assert.strictEqual(t.pending(), false);
  assert.strictEqual(r.snapshot().phase, 'ready');
  assert.strictEqual(r.snapshot().softAttempt, 0);
  // a later stall starts the ladder over from soft #1
  r.onInitStarted();
  await t.fire();
  assert.strictEqual(softReset.calls.length, 2);
  assert.strictEqual(r.snapshot().softAttempt, 1);
});

test('onWaitingForHuman (QR shown) cancels the watchdog — not treated as a hang', () => {
  const { r, t } = build();
  r.onInitStarted();
  assert.strictEqual(t.pending(), true);
  r.onWaitingForHuman();
  assert.strictEqual(t.pending(), false);
  assert.strictEqual(r.snapshot().phase, 'waiting-human');
});

test('stop cancels the watchdog', () => {
  const { r, t } = build();
  r.onInitStarted();
  assert.strictEqual(t.pending(), true);
  r.stop();
  assert.strictEqual(t.pending(), false);
});

test('stop() during an in-flight recovery suppresses the re-arm', async () => {
  const t = fakeTimers();
  let r;
  const softReset = async () => { r.stop(); };   // stop lands mid-recovery
  r = createRecovery({
    readyTimeoutMs: 1000, maxSoft: 3, softReset, hardReset: spy(), exit: spy(),
    log: () => {}, setTimer: t.setTimer, clearTimer: t.clearTimer,
  });
  r.onInitStarted();
  await t.fire();
  assert.strictEqual(t.pending(), false, 'a stop during recovery must not re-arm the watchdog');
});
