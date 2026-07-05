const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { parseArgs } = require('../src/cli-parse');

test('read with limit', () => {
  assert.deepStrictEqual(parseArgs(['read', 'poker', '--limit', '5']), { cmd: 'read', args: { chat: 'poker', limit: 5 } });
});

test('read without limit', () => {
  assert.deepStrictEqual(parseArgs(['read', 'poker']), { cmd: 'read', args: { chat: 'poker' } });
});

test('send joins the remaining words into text', () => {
  assert.deepStrictEqual(parseArgs(['send', 'notes', 'hello', 'there']), { cmd: 'send', args: { chat: 'notes', text: 'hello there' } });
});

test('allow add is variadic', () => {
  assert.deepStrictEqual(parseArgs(['allow', 'add', 'poker', 'notes']), { cmd: 'allowAdd', args: { chats: ['poker', 'notes'] } });
  assert.deepStrictEqual(parseArgs(['allow', 'add', 'poker']), { cmd: 'allowAdd', args: { chats: ['poker'] } });
  assert.strictEqual(parseArgs(['allow', 'add']), null);
});

test('allow remove is variadic', () => {
  assert.deepStrictEqual(parseArgs(['allow', 'remove', 'a@g.us', 'b@g.us']), { cmd: 'allowRemove', args: { chats: ['a@g.us', 'b@g.us'] } });
});

test('allow all / remove all use the wildcard commands', () => {
  assert.deepStrictEqual(parseArgs(['allow', 'all']), { cmd: 'allowAll', args: {} });
  assert.deepStrictEqual(parseArgs(['allow', 'remove', 'all']), { cmd: 'allowRemoveAll', args: {} });
});

test('allow remove all plus more chats treats all as a chat ref', () => {
  // `remove all` alone is the wildcard form; with extra refs, "all" is a chat name.
  assert.deepStrictEqual(parseArgs(['allow', 'remove', 'all', 'poker']), { cmd: 'allowRemove', args: { chats: ['all', 'poker'] } });
});

test('chats takes no args', () => {
  assert.deepStrictEqual(parseArgs(['chats']), { cmd: 'chats', args: {} });
});

test('unknown verb returns null', () => {
  assert.strictEqual(parseArgs(['frobnicate']), null);
});

test('send without text returns null', () => {
  assert.strictEqual(parseArgs(['send', 'notes']), null);
});

test('send-confirm maps to sendConfirm with the token', () => {
  assert.deepStrictEqual(parseArgs(['send-confirm', 'abc123']), { cmd: 'sendConfirm', args: { token: 'abc123' } });
});

test('send-confirm without a token returns null', () => {
  assert.strictEqual(parseArgs(['send-confirm']), null);
});

// --- scheduled sends ---

test('schedule: one-shot absolute with text', () => {
  assert.deepStrictEqual(
    parseArgs(['schedule', 'notes', '--at', '2026-07-10 09:00', 'hello', 'world']),
    { cmd: 'schedule', args: { chat: 'notes', text: 'hello world', at: '2026-07-10 09:00' } },
  );
});

test('schedule: relative --in', () => {
  assert.deepStrictEqual(
    parseArgs(['schedule', 'notes', '--in', '2h', 'ping']),
    { cmd: 'schedule', args: { chat: 'notes', text: 'ping', in: '2h' } },
  );
});

test('schedule: recurring weekly and monthly', () => {
  assert.deepStrictEqual(
    parseArgs(['schedule', 'notes', '--every', 'friday', '--at', '09:00', 'shabbat shalom']),
    { cmd: 'schedule', args: { chat: 'notes', text: 'shabbat shalom', at: '09:00', every: 'friday' } },
  );
  assert.deepStrictEqual(
    parseArgs(['schedule', 'notes', '--every', 'month', '--on', '1', '--at', '08:00', 'rent']),
    { cmd: 'schedule', args: { chat: 'notes', text: 'rent', at: '08:00', every: 'month', on: 1 } },
  );
});

test('schedule: relative --media is resolved to an absolute path', () => {
  const r = parseArgs(['schedule', 'notes', '--media', './pic.jpg', '--caption', 'look', '--in', '1h']);
  assert.strictEqual(r.cmd, 'schedule');
  assert.strictEqual(r.args.chat, 'notes');
  assert.strictEqual(r.args.in, '1h');
  assert.strictEqual(r.args.caption, 'look');
  assert.strictEqual(r.args.text, undefined);
  assert.ok(path.isAbsolute(r.args.media), 'media resolved to absolute');
  assert.ok(r.args.media.endsWith('pic.jpg'));
});

test('schedule: absolute --media passes through unchanged', () => {
  const r = parseArgs(['schedule', 'notes', '--media', '/abs/pic.jpg', '--in', '1h']);
  assert.strictEqual(r.args.media, '/abs/pic.jpg');
});

test('schedule: bad usage returns null', () => {
  assert.strictEqual(parseArgs(['schedule']), null);
  assert.strictEqual(parseArgs(['schedule', 'notes', 'no', 'when', 'flags']), null);
  assert.strictEqual(parseArgs(['schedule', 'notes', '--in', '2h']), null); // no content
});

test('schedule list / cancel / confirm', () => {
  assert.deepStrictEqual(parseArgs(['schedule', 'list']), { cmd: 'scheduleList', args: {} });
  assert.deepStrictEqual(parseArgs(['schedule', 'list', '--all']), { cmd: 'scheduleList', args: { all: true } });
  assert.deepStrictEqual(parseArgs(['schedule', 'cancel', 'abc123']), { cmd: 'scheduleCancel', args: { id: 'abc123' } });
  assert.strictEqual(parseArgs(['schedule', 'cancel']), null);
  assert.deepStrictEqual(parseArgs(['schedule-confirm', 'tok1']), { cmd: 'scheduleConfirm', args: { token: 'tok1' } });
  assert.strictEqual(parseArgs(['schedule-confirm']), null);
});

test('read --all sets the all flag (unclamped full-chat read)', () => {
  assert.deepStrictEqual(parseArgs(['read', 'poker', '--all']), { cmd: 'read', args: { chat: 'poker', all: true } });
});
