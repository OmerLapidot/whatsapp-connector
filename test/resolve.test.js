const test = require('node:test');
const assert = require('node:assert');
const { resolveChat } = require('../src/resolve');

const chats = [
  { id: '1@g.us', name: 'מועדון ספרים' },
  { id: '2@g.us', name: 'שכנים בבניין' },
  { id: '3@g.us', name: 'Indie TLV' },
  { id: '4@g.us', name: 'Indie Berlin' },
];

test('exact id matches', () => {
  const r = resolveChat(chats, '2@g.us');
  assert.strictEqual(r.status, 'match');
  assert.strictEqual(r.chat.id, '2@g.us');
});

test('unique partial name matches', () => {
  const r = resolveChat(chats, 'ספרים');
  assert.strictEqual(r.status, 'match');
  assert.strictEqual(r.chat.id, '1@g.us');
});

test('ambiguous partial returns candidates', () => {
  const r = resolveChat(chats, 'Indie');
  assert.strictEqual(r.status, 'ambiguous');
  assert.strictEqual(r.candidates.length, 2);
});

test('no match returns notFound', () => {
  const r = resolveChat(chats, 'zzz');
  assert.strictEqual(r.status, 'notFound');
});
