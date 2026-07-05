const test = require('node:test');
const assert = require('node:assert');
const config = require('../src/config');

test('config exposes socket path and limits', () => {
  assert.ok(config.SOCKET_PATH.endsWith('control.sock'));
  assert.ok(config.ALLOWLIST_PATH.endsWith('allowlist.json'));
  assert.strictEqual(config.DEFAULT_READ_LIMIT, 30);
  assert.strictEqual(config.MAX_LIMIT, 200);
});
