// Watchdog + escalating recovery for the "authenticated but `ready` never
// fires" hang. whatsapp-web.js occasionally finishes auth but never emits its
// `ready` event (seen on large / freshly-linked accounts, especially right
// after a restart). The sync tracker's anti-hang cap only arms AFTER `ready`,
// so without this the daemon sits in `syncing` forever and launchd's KeepAlive
// can't help — the process is alive, just stuck.
//
// Escalation ladder, each step visible via `snapshot()` + `log`:
//   1. soft reset  ×maxSoft — destroy + re-init the client, REUSING the on-disk
//                             session (no QR). Cheap, non-destructive.
//   2. hard re-link ×1      — move the session aside and re-init → a fresh QR
//                             (a human must scan). Last resort.
//   3. exit                 — if even the re-link never reaches QR/ready, exit
//                             so launchd starts the whole daemon over.
// The watchdog is cancelled by onReady (success) and onWaitingForHuman (a QR is
// on screen — legitimately waiting for a human, not a hang).

function createRecovery({
  readyTimeoutMs = 90000,
  maxSoft = 3,
  softReset,
  hardReset,
  log = () => {},
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  exit = () => process.exit(1),
} = {}) {
  let timer = null;
  let softAttempt = 0;
  let stopped = false;
  let phase = 'starting';   // starting | recovering | relinking | ready | waiting-human | stopped

  function clear() { if (timer) { clearTimer(timer); timer = null; } }
  // `stopped` guard: an onTimeout already awaiting a reset must not re-arm after
  // a concurrent stop() (shutdown) has fired.
  function arm() { if (stopped) return; clear(); timer = setTimer(onTimeout, readyTimeoutMs); }

  async function onTimeout() {
    timer = null;
    if (softAttempt < maxSoft) {
      softAttempt++;
      phase = 'recovering';
      log("stuck: WhatsApp 'ready' never arrived — soft recovery " + softAttempt + '/' + maxSoft + ' (reusing session, no QR needed)');
      try { await softReset(); } catch (e) { log('soft-reset error: ' + (e && e.message)); }
      arm();
    } else if (phase !== 'relinking') {
      phase = 'relinking';
      log('stuck: ' + maxSoft + ' soft recoveries failed — hard re-link (a NEW QR scan is required; watch `wa status` for needs-login)');
      try { await hardReset(); } catch (e) { log('hard-reset error: ' + (e && e.message)); }
      arm();   // if even the re-link never reaches QR/ready, the next fire exits
    } else {
      log('still stuck after a hard re-link — exiting so launchd restarts the daemon');
      exit();
    }
  }

  return {
    // Client initialization has begun; start (or restart) the watchdog.
    onInitStarted() { stopped = false; phase = 'starting'; arm(); },
    // whatsapp-web.js `ready` fired: healthy. Cancel the watchdog, reset budget.
    onReady() { clear(); softAttempt = 0; phase = 'ready'; },
    // A login QR is on screen: waiting on a human, not a hang. Cancel watchdog.
    onWaitingForHuman() { clear(); phase = 'waiting-human'; },
    stop() { stopped = true; clear(); phase = 'stopped'; },
    snapshot() { return { phase, softAttempt, maxSoft }; },
  };
}

module.exports = { createRecovery };
