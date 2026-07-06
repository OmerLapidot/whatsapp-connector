// Watchdog + escalating recovery for the "authenticated but `ready` never
// fires" hang (whatsapp-web.js occasionally finishes auth but never emits its
// `ready` event, especially on large/freshly-linked accounts after a restart).
// The sync tracker's anti-hang cap only arms AFTER `ready`, so without this the
// daemon sits in `syncing` forever and launchd's KeepAlive can't help — the
// process is alive, just stuck.
//
// Recovery is done by RESTARTING THE PROCESS, not by recycling the browser
// in-process: a fresh process gets a fresh Chrome with no profile-lock fight,
// which is exactly why a manual `bot.sh restart` reliably clears the hang. Under
// launchd (KeepAlive) an exit is relaunched automatically. Because each attempt
// is a new process, the attempt count is persisted to `statePath` so the ladder
// still escalates across restarts:
//   soft ×maxSoft : bump the persisted count and exit → launchd relaunches,
//                   REUSING the on-disk session (no QR).
//   hard re-link  : move the session aside → exit → fresh boot shows a QR.
// A stale count (older than staleMs, e.g. from an unrelated incident hours ago)
// is ignored so a manual restart can't be pushed toward a spurious re-link.
const fs = require('fs');

function createRecovery({
  readyTimeoutMs = 90000,
  maxSoft = 3,
  staleMs = 600000,
  statePath,
  authDir,
  log = () => {},
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  now = () => Date.now(),
  exit = () => process.exit(1),
  fsImpl = fs,
} = {}) {
  let timer = null;
  let softAttempt = 0;
  let stopped = false;
  let phase = 'starting';   // starting | recovering | relinking | ready | waiting-human | stopped

  function readState() {
    try {
      const s = JSON.parse(fsImpl.readFileSync(statePath, 'utf8'));
      if (s && typeof s.attempts === 'number' && typeof s.at === 'number') return s;
    } catch (_) {}
    return { attempts: 0, at: 0 };
  }
  function writeState(attempts) {
    try { fsImpl.writeFileSync(statePath, JSON.stringify({ attempts, at: now() })); }
    catch (e) { log('recovery-state write failed: ' + (e && e.message)); }
  }
  function clearState() { try { fsImpl.unlinkSync(statePath); } catch (_) {} }

  function clear() { if (timer) { clearTimer(timer); timer = null; } }
  function arm() { if (stopped) return; clear(); timer = setTimer(onTimeout, readyTimeoutMs); }

  function onTimeout() {
    timer = null;
    if (softAttempt < maxSoft) {
      softAttempt++;
      phase = 'recovering';
      writeState(softAttempt);
      log("stuck: WhatsApp 'ready' never arrived — soft recovery " + softAttempt + '/' + maxSoft
        + ': restarting the daemon process (reusing the session, no QR). launchd will relaunch it.');
      exit();
    } else {
      phase = 'relinking';
      log('stuck: ' + maxSoft + ' soft recoveries failed — hard re-link: moving the session aside '
        + '(a NEW QR scan will be required) and restarting.');
      try {
        if (authDir && fsImpl.existsSync(authDir)) fsImpl.renameSync(authDir, authDir + '.stuck-' + now());
      } catch (e) { log('could not move session aside for re-link: ' + (e && e.message)); }
      clearState();
      exit();
    }
  }

  return {
    // Client initialization has begun. Load how many soft recoveries preceded
    // this boot (unless stale) and arm the watchdog.
    onInitStarted() {
      stopped = false;
      const s = readState();
      softAttempt = (now() - s.at) <= staleMs ? s.attempts : 0;
      phase = softAttempt > 0 ? 'recovering' : 'starting';
      arm();
    },
    // whatsapp-web.js `ready` fired: healthy. Cancel watchdog, clear the ladder.
    onReady() { clear(); softAttempt = 0; phase = 'ready'; clearState(); },
    // A login QR is on screen: waiting on a human, not a hang.
    onWaitingForHuman() { clear(); phase = 'waiting-human'; },
    stop() { stopped = true; clear(); phase = 'stopped'; },
    snapshot() { return { phase, softAttempt, maxSoft }; },
  };
}

module.exports = { createRecovery };
