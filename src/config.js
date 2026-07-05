// Central config for the WhatsApp connector daemon + CLI.
const path = require('path');

module.exports = {
  // Private unix-domain socket the daemon listens on and the CLI dials.
  SOCKET_PATH: process.env.WA_SOCKET || path.join(__dirname, '..', 'control.sock'),
  // Ids of chats Claude may send to. Own file, gitignored, starts as [].
  ALLOWLIST_PATH: process.env.WA_ALLOWLIST || path.join(__dirname, '..', 'allowlist.json'),
  // Default number of recent messages returned by `read`.
  DEFAULT_READ_LIMIT: 30,
  // Hard ceiling on messages returned by a single read/search.
  MAX_LIMIT: 200,
  // Scheduled sends: job store, engine tick cadence, never-send-late grace.
  SCHEDULES_PATH: process.env.WA_SCHEDULES || path.join(__dirname, '..', 'schedules.json'),
  SCHEDULER_TICK_MS: 30000,
  FIRE_GRACE_MS: 120000,
  // Post-connect offline-message settle. After WhatsApp Web reports the chat
  // list synced (`ready`), queued messages still stream in; we keep reporting
  // `state: 'syncing'` until offline delivery hits 100%, goes quiet for
  // SYNC_QUIET_MS, or SYNC_MAX_MS elapses (a fallback so we never hang).
  SYNC_QUIET_MS: Number(process.env.WA_SYNC_QUIET_MS) || 4000,
  SYNC_MAX_MS: Number(process.env.WA_SYNC_MAX_MS) || 60000,
};
