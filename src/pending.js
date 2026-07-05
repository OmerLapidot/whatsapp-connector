const crypto = require('crypto');

// Store of pending (unconfirmed) sends. Tokens expire after ttlMs.
function createPendingStore({ ttlMs = 120000, now = () => Date.now(), token = () => crypto.randomBytes(6).toString('hex') } = {}) {
  const map = new Map();
  return {
    create(payload) {
      const t = token();
      map.set(t, { ...payload, expiresAt: now() + ttlMs });
      return t;
    },
    // Return and remove the pending entry; throw coded errors if missing/expired.
    consume(tok) {
      const p = map.get(tok);
      if (!p) { const e = new Error('no pending send for that token (invalid or already used)'); e.code = 'NO_PENDING'; throw e; }
      map.delete(tok);
      if (now() > p.expiresAt) { const e = new Error('confirmation expired — re-issue the send'); e.code = 'CONFIRM_EXPIRED'; throw e; }
      return p;
    },
    size() { return map.size; },
  };
}

module.exports = { createPendingStore };
