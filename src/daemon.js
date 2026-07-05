const fs = require('fs');
const net = require('net');
const path = require('path');
const config = require('./config');
const { makeSession } = require('./whatsapp');
const { createControlServer } = require('./control-server');
const { createPendingStore } = require('./pending');
const { createScheduler } = require('./scheduler');
const { createApprover } = require('./approval');

const LOG_FILE = path.join(__dirname, '..', 'bot.log');
function log(...parts) {
  const line = '[' + new Date().toISOString() + '] ' + parts.join(' ');
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (_) {}
}

function cleanupSocket() { try { fs.unlinkSync(config.SOCKET_PATH); } catch (_) {} }

function probe(sockPath) {
  return new Promise((resolve) => {
    const c = net.connect(sockPath);
    c.on('connect', () => { c.destroy(); resolve(true); });
    c.on('error', () => resolve(false));
  });
}

async function main() {
  const session = makeSession({
    log,
    sync: { quietMs: config.SYNC_QUIET_MS, maxMs: config.SYNC_MAX_MS },
    recovery: { readyTimeoutMs: config.READY_TIMEOUT_MS, maxSoft: config.MAX_SOFT_RECOVERIES },
  });
  const pending = createPendingStore();
  const scheduler = createScheduler({
    storePath: config.SCHEDULES_PATH,
    session,
    allowlistPath: config.ALLOWLIST_PATH,
    tickMs: config.SCHEDULER_TICK_MS,
    graceMs: config.FIRE_GRACE_MS,
    log,
  });
  const approve = createApprover({ log });
  const server = createControlServer({ session, allowlistPath: config.ALLOWLIST_PATH, defaults: config, pending, scheduler, approve });

  if (await probe(config.SOCKET_PATH)) {
    log('another daemon is already listening at', config.SOCKET_PATH, '- exiting');
    process.exit(1);
  }
  cleanupSocket();                          // only reached when the socket is stale/absent
  server.on('error', (e) => { log('control server error:', e && e.message); process.exit(1); });
  server.listen(config.SOCKET_PATH, () => log('control socket listening at', config.SOCKET_PATH));
  scheduler.start();

  let shuttingDown = false;
  async function shutdown(code) {
    if (shuttingDown) return;
    shuttingDown = true;
    const force = setTimeout(() => process.exit(code), 5000);  // don't hang if destroy stalls
    scheduler.stop();
    try { await session.stop(); } catch (_) {}
    try { server.close(); } catch (_) {}
    clearTimeout(force);
    process.exit(code);
  }

  process.on('exit', cleanupSocket);
  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
  process.on('unhandledRejection', (e) => { log('unhandledRejection:', e && e.message); process.exit(1); });
  process.on('uncaughtException', (e) => { log('uncaughtException:', e && e.message); process.exit(1); });

  await session.start();
}

main();
