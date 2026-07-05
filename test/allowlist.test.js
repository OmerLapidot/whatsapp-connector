const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadAllowlist, saveAllowlist, isAllowed, addManyToAllowlist, removeManyFromAllowlist } = require('../src/allowlist');

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wa-')), 'allowlist.json');
}

test('missing file loads as empty list', () => {
  assert.deepStrictEqual(loadAllowlist(tmpFile()), []);
});

test('addMany is idempotent and persists', () => {
  const f = tmpFile();
  addManyToAllowlist(f, ['a@g.us', 'b@g.us']);
  addManyToAllowlist(f, ['a@g.us']);
  assert.deepStrictEqual(loadAllowlist(f), ['a@g.us', 'b@g.us']);
});

test('isAllowed reflects membership', () => {
  const f = tmpFile();
  addManyToAllowlist(f, ['a@g.us']);
  const ids = loadAllowlist(f);
  assert.strictEqual(isAllowed(ids, 'a@g.us'), true);
  assert.strictEqual(isAllowed(ids, 'b@g.us'), false);
});

test('the * wildcard allows every chat', () => {
  assert.strictEqual(isAllowed(['*'], 'anyone@c.us'), true);
  assert.strictEqual(isAllowed(['a@g.us', '*'], 'b@g.us'), true);
});

test('removeMany deletes only the named ids', () => {
  const f = tmpFile();
  addManyToAllowlist(f, ['a@g.us', 'b@g.us', 'c@g.us']);
  removeManyFromAllowlist(f, ['a@g.us', 'c@g.us']);
  assert.deepStrictEqual(loadAllowlist(f), ['b@g.us']);
});

test('adding and removing * keeps explicit entries intact', () => {
  const f = tmpFile();
  addManyToAllowlist(f, ['a@g.us']);
  addManyToAllowlist(f, ['*']);
  assert.deepStrictEqual(loadAllowlist(f), ['a@g.us', '*']);
  removeManyFromAllowlist(f, ['*']);
  assert.deepStrictEqual(loadAllowlist(f), ['a@g.us']);
});

// FIX 6 — saveAllowlist must write atomically (tmp + rename), leaving no
// leftover .tmp file, mirroring the pattern already used in schedule-store.js.
test('saveAllowlist writes atomically via a temp file + rename, leaving no .tmp behind', () => {
  const orig = fs.renameSync;
  const renames = [];
  fs.renameSync = (from, to) => { renames.push([from, to]); return orig(from, to); };
  try {
    const f = tmpFile();
    saveAllowlist(f, ['a@g.us']);
    assert.strictEqual(renames.length, 1, 'exactly one rename (the atomic swap)');
    assert.ok(renames[0][0].endsWith('.tmp'), 'renamed FROM a .tmp file');
    assert.strictEqual(renames[0][1], f, 'renamed TO the target path');
    assert.deepStrictEqual(loadAllowlist(f), ['a@g.us']);
    assert.strictEqual(fs.existsSync(f + '.tmp'), false, 'no .tmp left behind');
  } finally {
    fs.renameSync = orig;
  }
});
