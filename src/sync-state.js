// Tracks the daemon's post-connect "offline sync" so we only report `ready`
// once WhatsApp Web has finished delivering the messages that queued up while
// we were off — not merely once the chat list synced.
//
// whatsapp-web.js fires `ready` when the app STATE has synced (the chat list is
// present), but queued MESSAGES stream in afterwards and are reported via the
// `loading_screen` (offline-delivery %) event. We hold `ready` until that
// settles: it reaches 100%, goes quiet for `quietMs`, or a hard `maxMs` cap
// elapses (so we can never hang if the 100% signal never arrives). Until then
// `snapshot()` reports `state: 'syncing'` with the last `syncPercent`.

function createSyncTracker({
  quietMs = 4000,
  maxMs = 60000,
  log = () => {},
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let state = 'starting';   // starting | needs-login | syncing | ready | auth-failure | disconnected
  let wwebReady = false;    // whatsapp-web.js `ready` fired (store / app-state usable)
  let percent = null;       // last offline-delivery percent, or null if none seen
  let quietTimer = null;
  let capTimer = null;

  function clearTimers() {
    if (quietTimer) { clearTimer(quietTimer); quietTimer = null; }
    if (capTimer) { clearTimer(capTimer); capTimer = null; }
  }

  function settle(reason) {
    if (!wwebReady || state === 'ready') return;   // never ready before the store is usable
    clearTimers();
    state = 'ready';
    log('sync settled (' + reason + ')' + (percent != null ? ' at ' + percent + '%' : ''));
  }

  function armQuiet() {
    if (quietTimer) clearTimer(quietTimer);
    quietTimer = setTimer(() => settle('quiet'), quietMs);
  }

  return {
    onQr() { clearTimers(); state = 'needs-login'; wwebReady = false; percent = null; },
    onAuthFailure() { clearTimers(); state = 'auth-failure'; wwebReady = false; },
    onDisconnected() { clearTimers(); state = 'disconnected'; wwebReady = false; percent = null; },

    // whatsapp-web.js `ready`: chat list synced. Start waiting for offline messages.
    onReady() {
      wwebReady = true;
      if (state === 'ready') return;
      state = 'syncing';
      if (percent != null && percent >= 100) { settle('100%'); return; }
      clearTimers();
      armQuiet();
      capTimer = setTimer(() => settle('timeout'), maxMs);
    },

    // Offline-delivery progress (0..100). May arrive before or after `ready`.
    onLoadingScreen(p) {
      if (state === 'ready') return;              // already settled; ignore late ticks
      const n = Number(p);
      if (!Number.isFinite(n)) return;
      percent = n;
      log('offline sync ' + n + '%');
      state = 'syncing';
      if (!wwebReady) return;                     // wait for the store before settling
      if (n >= 100) { settle('100%'); return; }
      armQuiet();                                 // each tick resets the quiet debounce
      if (!capTimer) capTimer = setTimer(() => settle('timeout'), maxMs);
    },

    snapshot() { return { state, ready: state === 'ready', syncPercent: percent }; },
  };
}

module.exports = { createSyncTracker };
