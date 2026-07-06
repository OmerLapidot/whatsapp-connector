const test = require('node:test');
const assert = require('node:assert');
const { createRecovery } = require('../src/recovery');

const SP = '/tmp/rec-state.json';
const AUTH = '/tmp/.wwebjs_auth';

function fakeTimers() {
  let cb = null;
  return {
    setTimer: (fn) => { cb = fn; return 1; },
    clearTimer: () => { cb = null; },
    pending: () => cb !== null,
    fire() { const f = cb; cb = null; if (f) f(); },
  };
}

// In-memory fs: files map + dir set, enough for the recovery module's calls.
function fakeFs(files = {}, dirs = []) {
  const F = { ...files };
  const D = new Set(dirs);
  return {
    _F: F, _D: D,
    readFileSync: (p) => { if (!(p in F)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } return F[p]; },
    writeFileSync: (p, c) => { F[p] = String(c); },
    unlinkSync: (p) => { if (!(p in F)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } delete F[p]; },
    existsSync: (p) => (p in F) || D.has(p),
    renameSync: (a, b) => { if (D.has(a)) { D.delete(a); D.add(b); } if (a in F) { F[b] = F[a]; delete F[a]; } },
  };
}

function spy() { const c = []; const fn = (...a) => { c.push(a); }; fn.calls = c; return fn; }

function build({ fsImpl = fakeFs(), clock = { v: 1000 }, opts = {} } = {}) {
  const t = fakeTimers();
  const exit = spy();
  const r = createRecovery({
    readyTimeoutMs: 1000, maxSoft: 3, staleMs: 600000, statePath: SP, authDir: AUTH,
    log: () => {}, setTimer: t.setTimer, clearTimer: t.clearTimer, exit, fsImpl, now: () => clock.v,
    ...opts,
  });
  return { r, t, exit, fsImpl, clock };
}

test('onInitStarted arms the watchdog with a clean slate', () => {
  const { r, t } = build();
  r.onInitStarted();
  assert.strictEqual(t.pending(), true);
  assert.deepStrictEqual(r.snapshot(), { phase: 'starting', softAttempt: 0, maxSoft: 3 });
});

test('a stall persists the incremented attempt and exits for a launchd relaunch', () => {
  const { r, t, exit, fsImpl } = build();
  r.onInitStarted();
  t.fire();
  assert.strictEqual(exit.calls.length, 1, 'exited so launchd restarts the process');
  assert.deepStrictEqual(JSON.parse(fsImpl._F[SP]), { attempts: 1, at: 1000 });
  assert.strictEqual(r.snapshot().phase, 'recovering');
  assert.strictEqual(r.snapshot().softAttempt, 1);
});

test('a later boot resumes the persisted (recent) attempt count', () => {
  const fsImpl = fakeFs({ [SP]: JSON.stringify({ attempts: 2, at: 900 }) });
  const { r } = build({ fsImpl, clock: { v: 1000 } });   // 100ms old — fresh
  r.onInitStarted();
  assert.strictEqual(r.snapshot().softAttempt, 2);
  assert.strictEqual(r.snapshot().phase, 'recovering');
});

test('a stale attempt count is ignored (a manual restart is not pushed toward re-link)', () => {
  const fsImpl = fakeFs({ [SP]: JSON.stringify({ attempts: 2, at: 0 }) });
  const { r } = build({ fsImpl, clock: { v: 10_000_000 } });   // way past staleMs
  r.onInitStarted();
  assert.strictEqual(r.snapshot().softAttempt, 0);
  assert.strictEqual(r.snapshot().phase, 'starting');
});

test('once the soft budget is spent, a stall hard-relinks: moves the session, clears state, exits', () => {
  const fsImpl = fakeFs({ [SP]: JSON.stringify({ attempts: 3, at: 900 }) }, [AUTH]);
  const { r, t, exit } = build({ fsImpl, clock: { v: 1000 } });
  r.onInitStarted();
  assert.strictEqual(r.snapshot().softAttempt, 3);
  t.fire();
  assert.strictEqual(r.snapshot().phase, 'relinking');
  assert.strictEqual(fsImpl._D.has(AUTH), false, 'live session dir was moved aside');
  assert.strictEqual(fsImpl._D.has(AUTH + '.stuck-1000'), true, 'moved to a .stuck- dir (preserved, not deleted)');
  assert.strictEqual(SP in fsImpl._F, false, 'attempt state cleared for the fresh QR boot');
  assert.strictEqual(exit.calls.length, 1);
});

test('onReady cancels the watchdog and clears the persisted ladder', () => {
  const fsImpl = fakeFs({ [SP]: JSON.stringify({ attempts: 1, at: 900 }) });
  const { r, t } = build({ fsImpl, clock: { v: 1000 } });
  r.onInitStarted();
  assert.strictEqual(r.snapshot().softAttempt, 1);
  r.onReady();
  assert.strictEqual(t.pending(), false);
  assert.strictEqual(r.snapshot().phase, 'ready');
  assert.strictEqual(r.snapshot().softAttempt, 0);
  assert.strictEqual(SP in fsImpl._F, false, 'state file removed on healthy ready');
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
