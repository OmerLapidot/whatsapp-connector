const test = require('node:test');
const assert = require('node:assert');
const { createPendingStore } = require('../src/pending');

test('create returns a token and the entry is retrievable exactly once', () => {
  const store = createPendingStore();
  const token = store.create({ kind: 'send', chatId: '1@g.us', text: 'hi' });
  assert.strictEqual(typeof token, 'string');
  assert.ok(token.length > 0);
  assert.strictEqual(store.size(), 1);

  const p = store.consume(token);
  assert.strictEqual(p.kind, 'send');
  assert.strictEqual(p.chatId, '1@g.us');
  assert.strictEqual(p.text, 'hi');
});

test('consume returns the stored payload and removes it (size drops; second consume throws NO_PENDING)', () => {
  const store = createPendingStore();
  const token = store.create({ kind: 'send', chatId: '1@g.us', text: 'hi' });
  assert.strictEqual(store.size(), 1);

  store.consume(token);
  assert.strictEqual(store.size(), 0);

  assert.throws(() => store.consume(token), (e) => e.code === 'NO_PENDING');
});

test('consume of an unknown token throws NO_PENDING', () => {
  const store = createPendingStore();
  assert.throws(() => store.consume('deadbeef'), (e) => e.code === 'NO_PENDING');
});

test('consume after expiry throws CONFIRM_EXPIRED', () => {
  let clock = 1000;
  const store = createPendingStore({ ttlMs: 500, now: () => clock });
  const token = store.create({ kind: 'send', chatId: '1@g.us', text: 'hi' });

  clock = 1000 + 500 + 1; // advance past ttl
  assert.throws(() => store.consume(token), (e) => e.code === 'CONFIRM_EXPIRED');
  // the entry was removed even though it was expired
  assert.strictEqual(store.size(), 0);
});

test('injectable token generator is used', () => {
  let n = 0;
  const store = createPendingStore({ token: () => 'tok-' + (++n) });
  assert.strictEqual(store.create({ kind: 'send' }), 'tok-1');
  assert.strictEqual(store.create({ kind: 'send' }), 'tok-2');
});
