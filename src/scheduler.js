// Tick engine that fires due scheduled jobs through the WhatsApp session.
// Never sends late: a fire not executed within graceMs of its slot is skipped.
const { addJob, updateJob, cancelJob, listJobs } = require('./schedule-store');
const { nextFireAt, describe } = require('./schedule-spec');
const { loadAllowlist, isAllowed } = require('./allowlist');

function createScheduler({ storePath, session, allowlistPath, tickMs = 30000, graceMs = 120000, now = () => Date.now(), log = () => {} }) {
  let timer = null;

  async function fireJob(job) {
    if (!isAllowed(loadAllowlist(allowlistPath), job.chatId)) {
      const e = new Error('chat "' + job.chatName + '" (' + job.chatId + ') is no longer on the send allow-list');
      e.code = 'NOT_ALLOWED';
      throw e;
    }
    if (job.kind === 'sendMedia') return session.sendMedia(job.chatId, job.path, job.caption);
    return session.send(job.chatId, job.text);
  }

  function settle(job, ok, error, t) {
    const patch = { lastResult: { at: t, ok, error: error || null } };
    if (job.spec.type === 'once') {
      patch.status = ok ? 'done' : 'failed';
      patch.nextFireAt = null;
    } else {
      patch.nextFireAt = nextFireAt(job.spec, t);
    }
    updateJob(storePath, job.id, patch);
  }

  let running = false;

  async function tick() {
    if (running) return;          // never overlap: a slow send must not let the next
    running = true;               // interval re-read the still-unsettled job and re-fire it
    try {
      for (const job of listJobs(storePath)) {
        try {
          // Quarantine a corrupt/hand-edited entry BEFORE any fire attempt, so it can't
          // send-then-fail-to-settle (which would re-send every tick).
          if (!job.spec || (job.spec.type !== 'once' && job.spec.type !== 'recurring')) {
            log('scheduler: quarantining malformed job ' + job.id + ' (unrecognized spec)');
            updateJob(storePath, job.id, { status: 'failed', lastResult: { at: now(), ok: false, error: 'malformed job spec' } });
            continue;
          }
          const t = now();        // per-job wall clock: correct even if an earlier job's send stalled this tick
          if (job.nextFireAt == null || job.nextFireAt > t) continue;
          if (t - job.nextFireAt > graceMs) {
            log('scheduler: job ' + job.id + ' missed its window (' + describe(job.spec) + ')');
            const patch = { lastResult: { at: t, ok: false, error: 'missed (daemon or session unavailable past grace window)' } };
            if (job.spec.type === 'once') { patch.status = 'missed'; patch.nextFireAt = null; }
            else patch.nextFireAt = nextFireAt(job.spec, t);
            updateJob(storePath, job.id, patch);
            continue;
          }
          try {
            const res = await fireJob(job);
            log('scheduler: job ' + job.id + ' sent to ' + job.chatName + ' (' + (res && res.id) + ')');
            settle(job, true, null, now());   // re-read after the await: recurring nextFireAt strictly after send
          } catch (e) {
            if (e.code === 'NOT_READY') {
              log('scheduler: job ' + job.id + ' deferred (session not ready)');
              continue; // stays due; retried next tick until grace expires
            }
            log('scheduler: job ' + job.id + ' failed: ' + e.message);
            settle(job, false, e.message, now());
          }
        } catch (entryErr) {
          // Defense in depth: any unexpected throw on one entry must not abort the whole
          // tick and starve the jobs listed after it.
          log('scheduler: skipping job ' + (job && job.id) + ' after error: ' + entryErr.message);
        }
      }
    } finally {
      running = false;
    }
  }

  function safeTick() { tick().catch((e) => log('scheduler tick error: ' + e.message)); }

  return {
    start() {
      if (timer) return;
      safeTick(); // catch up (and mark misses) right at boot
      timer = setInterval(safeTick, tickMs);
      if (timer.unref) timer.unref();
    },
    stop() { if (timer) { clearInterval(timer); timer = null; } },
    tick,
    add(job) { return addJob(storePath, job); },
    cancel(id) { return cancelJob(storePath, id); },
    list(opts) { return listJobs(storePath, opts).map((j) => ({ ...j, when: describe(j.spec) })); },
  };
}

module.exports = { createScheduler };
