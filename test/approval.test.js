const test = require('node:test');
const assert = require('node:assert');
const { createApprover } = require('../src/approval');

function fakeExec(result) {
  const calls = [];
  const impl = (cmd, args, cb) => {
    calls.push({ cmd, args });
    if (result.err !== undefined) cb(result.err, result.stdout || '', result.stderr || '');
    else cb(null, result.stdout || '', '');
  };
  return { impl, calls };
}

test('macOS: Approve click approves', async () => {
  const { impl } = fakeExec({ stdout: 'approved\n' });
  const approve = createApprover({ platform: 'darwin', execFileImpl: impl });
  assert.deepStrictEqual(await approve({ title: 't', message: 'm' }), { approved: true, reason: 'approved' });
});

test('macOS: dialog give-up is a timeout denial', async () => {
  const { impl } = fakeExec({ stdout: 'timeout\n' });
  const approve = createApprover({ platform: 'darwin', execFileImpl: impl });
  assert.deepStrictEqual(await approve({ title: 't', message: 'm' }), { approved: false, reason: 'timeout' });
});

test('macOS: Deny/cancel click denies (osascript exits non-zero)', async () => {
  const err = new Error('cmd failed'); err.code = 1;
  const { impl } = fakeExec({ err, stderr: 'execution error: User canceled. (-128)' });
  const approve = createApprover({ platform: 'darwin', execFileImpl: impl });
  assert.deepStrictEqual(await approve({ title: 't', message: 'm' }), { approved: false, reason: 'denied' });
});

test('macOS: osascript missing or broken is unavailable', async () => {
  const enoent = new Error('spawn osascript ENOENT'); enoent.code = 'ENOENT';
  const { impl } = fakeExec({ err: enoent });
  const approve = createApprover({ platform: 'darwin', execFileImpl: impl });
  assert.deepStrictEqual(await approve({ title: 't', message: 'm' }), { approved: false, reason: 'unavailable' });
});

test('macOS: chat names travel as argv, never inside the script source', async () => {
  const { impl, calls } = fakeExec({ stdout: 'approved\n' });
  const approve = createApprover({ platform: 'darwin', execFileImpl: impl });
  await approve({ title: 'T', message: 'Evil "name" with \'quotes\'' });
  const { cmd, args } = calls[0];
  assert.strictEqual(cmd, 'osascript');
  assert.strictEqual(args[0], '-e');
  assert.ok(!args[1].includes('Evil'), 'message must not be interpolated into script source');
  assert.strictEqual(args[2], 'T');
  assert.strictEqual(args[3], 'Evil "name" with \'quotes\'');
  assert.strictEqual(args[4], '60');
});

test('linux: zenity exit codes map to approve/deny/timeout/unavailable', async () => {
  const cases = [
    [{ stdout: '' }, { approved: true, reason: 'approved' }],
    [{ err: Object.assign(new Error('x'), { code: 1 }) }, { approved: false, reason: 'denied' }],
    [{ err: Object.assign(new Error('x'), { code: 5 }) }, { approved: false, reason: 'timeout' }],
    [{ err: Object.assign(new Error('x'), { code: 'ENOENT' }) }, { approved: false, reason: 'unavailable' }],
  ];
  for (const [result, expected] of cases) {
    const { impl } = fakeExec(result);
    const approve = createApprover({ platform: 'linux', execFileImpl: impl });
    assert.deepStrictEqual(await approve({ title: 't', message: 'm' }), expected);
  }
});

test('unknown platform is unavailable without exec', async () => {
  const { impl, calls } = fakeExec({ stdout: '' });
  const approve = createApprover({ platform: 'win32', execFileImpl: impl });
  assert.deepStrictEqual(await approve({ title: 't', message: 'm' }), { approved: false, reason: 'unavailable' });
  assert.strictEqual(calls.length, 0);
});
