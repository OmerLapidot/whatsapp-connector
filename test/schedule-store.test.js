const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadJobs, addJob, updateJob, cancelJob, listJobs } = require('../src/schedule-store');

function tmpStore() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wa-store-')), 'schedules.json');
}

const JOB = { kind: 'send', chatId: '1@g.us', chatName: 'notes', text: 'hi', spec: { type: 'once', at: 1000 }, nextFireAt: 1000, createdAt: 1 };

test('loadJobs on a missing file returns []', () => {
  assert.deepStrictEqual(loadJobs(tmpStore()), []);
});

test('addJob assigns id/status/lastResult and persists', () => {
  const p = tmpStore();
  const job = addJob(p, JOB);
  assert.match(job.id, /^[0-9a-f]{12}$/);
  assert.strictEqual(job.status, 'active');
  assert.strictEqual(job.lastResult, null);
  const onDisk = loadJobs(p);
  assert.strictEqual(onDisk.length, 1);
  assert.deepStrictEqual(onDisk[0], job);
});

test('updateJob patches and persists; unknown id throws NOT_FOUND', () => {
  const p = tmpStore();
  const job = addJob(p, JOB);
  const upd = updateJob(p, job.id, { status: 'done', lastResult: { at: 2, ok: true, error: null } });
  assert.strictEqual(upd.status, 'done');
  assert.strictEqual(loadJobs(p)[0].status, 'done');
  assert.strictEqual(loadJobs(p)[0].text, 'hi', 'unpatched fields survive');
  assert.throws(() => updateJob(p, 'nope', {}), (e) => e.code === 'NOT_FOUND');
});

test('cancelJob cancels active; refuses terminal; unknown throws', () => {
  const p = tmpStore();
  const job = addJob(p, JOB);
  const c = cancelJob(p, job.id);
  assert.strictEqual(c.status, 'cancelled');
  assert.throws(() => cancelJob(p, job.id), (e) => e.code === 'NOT_ACTIVE');
  assert.throws(() => cancelJob(p, 'nope'), (e) => e.code === 'NOT_FOUND');
});

test('listJobs filters to active by default; all:true shows everything', () => {
  const p = tmpStore();
  const a = addJob(p, JOB);
  const b = addJob(p, JOB);
  cancelJob(p, b.id);
  assert.deepStrictEqual(listJobs(p).map((j) => j.id), [a.id]);
  assert.deepStrictEqual(listJobs(p, { all: true }).map((j) => j.id), [a.id, b.id]);
});

test('loadJobs tolerates a corrupt/non-array file shape', () => {
  const p = tmpStore();
  fs.writeFileSync(p, '{"not":"an array"}');
  assert.deepStrictEqual(loadJobs(p), []);
});

test('saveJobs writes atomically and leaves no temp file behind', () => {
  const p = tmpStore();
  addJob(p, JOB);
  addJob(p, JOB);
  assert.strictEqual(loadJobs(p).length, 2);
  assert.strictEqual(fs.existsSync(p + '.tmp'), false, 'no leftover temp file after a successful save');
});
