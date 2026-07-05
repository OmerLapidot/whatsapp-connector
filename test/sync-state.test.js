const test = require('node:test');
const assert = require('node:assert');
const { createSyncTracker } = require('../src/sync-state');

// A fake clock so tests never wait real time. Timers are keyed by their delay;
// fire(ms) elapses every live timer scheduled for exactly that delay. quietMs
// (4000) and maxMs (60000) differ, so we can target either one.
function makeClock() {
  let seq = 0;
  const timers = new Map(); // id -> { ms, fn }
  return {
    setTimer(fn, ms) { const id = ++seq; timers.set(id, { ms, fn }); return id; },
    clearTimer(id) { timers.delete(id); },
    fire(ms) { for (const [id, t] of [...timers]) if (t.ms === ms) { timers.delete(id); t.fn(); } },
    live() { return [...timers.values()].map((t) => t.ms); },
  };
}

const QUIET = 4000;
const MAX = 60000;
function tracker(clock) {
  return createSyncTracker({ quietMs: QUIET, maxMs: MAX, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
}

test('starts not ready, in the starting state', () => {
  const t = tracker(makeClock());
  assert.deepStrictEqual(t.snapshot(), { state: 'starting', ready: false, syncPercent: null });
});

test('ready with no offline events settles after the quiet window', () => {
  const c = makeClock();
  const t = tracker(c);
  t.onReady();
  assert.strictEqual(t.snapshot().state, 'syncing');
  assert.strictEqual(t.snapshot().ready, false);
  c.fire(QUIET);
  assert.strictEqual(t.snapshot().state, 'ready');
  assert.strictEqual(t.snapshot().ready, true);
});

test('offline progress reaching 100% settles immediately', () => {
  const c = makeClock();
  const t = tracker(c);
  t.onReady();
  t.onLoadingScreen(30);
  assert.strictEqual(t.snapshot().state, 'syncing');
  assert.strictEqual(t.snapshot().syncPercent, 30);
  t.onLoadingScreen(100);
  assert.strictEqual(t.snapshot().ready, true);
  assert.strictEqual(t.snapshot().syncPercent, 100);
});

test('progress below 100 does not settle until the quiet window elapses', () => {
  const c = makeClock();
  const t = tracker(c);
  t.onReady();
  t.onLoadingScreen(40);
  t.onLoadingScreen(80);
  assert.strictEqual(t.snapshot().ready, false);
  c.fire(QUIET);
  assert.strictEqual(t.snapshot().ready, true);
});

test('the hard cap settles even if progress stalls below 100%', () => {
  const c = makeClock();
  const t = tracker(c);
  t.onReady();
  t.onLoadingScreen(60);
  c.fire(MAX);                       // cap elapses; quiet never fired
  assert.strictEqual(t.snapshot().ready, true);
  assert.strictEqual(t.snapshot().syncPercent, 60);
});

test('progress arriving before ready is held until ready fires', () => {
  const c = makeClock();
  const t = tracker(c);
  t.onLoadingScreen(100);
  assert.strictEqual(t.snapshot().ready, false, 'no store yet, so not ready even at 100%');
  assert.strictEqual(t.snapshot().state, 'syncing');
  t.onReady();
  assert.strictEqual(t.snapshot().ready, true);
});

test('partial progress before ready then ready arms the settle timers', () => {
  const c = makeClock();
  const t = tracker(c);
  t.onLoadingScreen(50);
  t.onReady();
  assert.strictEqual(t.snapshot().ready, false);
  c.fire(QUIET);
  assert.strictEqual(t.snapshot().ready, true);
});

test('disconnect resets to not-ready and clears progress', () => {
  const c = makeClock();
  const t = tracker(c);
  t.onReady();
  c.fire(QUIET);
  assert.strictEqual(t.snapshot().ready, true);
  t.onDisconnected();
  assert.deepStrictEqual(t.snapshot(), { state: 'disconnected', ready: false, syncPercent: null });
});

test('qr sets needs-login and stays not ready', () => {
  const t = tracker(makeClock());
  t.onQr();
  assert.strictEqual(t.snapshot().state, 'needs-login');
  assert.strictEqual(t.snapshot().ready, false);
});

test('non-finite progress values are ignored', () => {
  const c = makeClock();
  const t = tracker(c);
  t.onReady();
  t.onLoadingScreen(undefined);
  t.onLoadingScreen('not-a-number');
  assert.strictEqual(t.snapshot().syncPercent, null);
  assert.strictEqual(t.snapshot().ready, false);
});

test('a late 100% after the cap settled is a harmless no-op', () => {
  const c = makeClock();
  const t = tracker(c);
  t.onReady();
  t.onLoadingScreen(60);
  c.fire(MAX);
  assert.strictEqual(t.snapshot().ready, true);
  t.onLoadingScreen(100);            // arrives after we already settled
  assert.strictEqual(t.snapshot().ready, true);
  assert.strictEqual(t.snapshot().syncPercent, 60, 'frozen at settle-time value');
});

test('no ready-before-store: quiet cannot settle while store is absent', () => {
  const c = makeClock();
  const t = tracker(c);
  t.onLoadingScreen(50);             // progress before ready must not arm a settle
  c.fire(QUIET);
  assert.strictEqual(t.snapshot().ready, false);
  assert.strictEqual(t.snapshot().state, 'syncing');
});
