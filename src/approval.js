// Native on-screen approval dialogs — the human gate for allow-list changes.
// Everything that is not an explicit Approve click resolves to a denial:
// Deny/cancel → 'denied', dialog gave up → 'timeout', no dialog possible
// (headless, missing binary, exec error) → 'unavailable'. Never rejects.
const { execFile } = require('child_process');

// Title/message/timeout arrive via `on run argv` — NEVER interpolated into
// the script source: chat names are attacker-controlled text.
const OSA_SCRIPT = [
  'on run argv',
  '  set dialogTitle to item 1 of argv',
  '  set dialogMessage to item 2 of argv',
  '  set timeoutSec to (item 3 of argv) as number',
  '  set r to display dialog dialogMessage with title dialogTitle buttons {"Deny", "Approve"} default button "Deny" cancel button "Deny" with icon caution giving up after timeoutSec',
  '  if gave up of r then return "timeout"',
  '  if button returned of r is "Approve" then return "approved"',
  '  return "denied"',
  'end run',
].join('\n');

function createApprover({ platform = process.platform, execFileImpl = execFile, timeoutSec = 60, log = () => {} } = {}) {
  return function approve({ title, message }) {
    log('approval requested: ' + title);
    return new Promise((resolve) => {
      const done = (approved, reason) => {
        log('approval outcome: ' + reason);
        resolve({ approved, reason });
      };
      if (platform === 'darwin') {
        execFileImpl('osascript', ['-e', OSA_SCRIPT, title, message, String(timeoutSec)], (err, stdout, stderr) => {
          if (err) {
            if (err.code === 'ENOENT') return done(false, 'unavailable');
            if (/user canceled/i.test(String(stderr))) return done(false, 'denied');
            return done(false, 'unavailable');
          }
          const out = String(stdout).trim();
          if (out === 'approved') return done(true, 'approved');
          if (out === 'timeout') return done(false, 'timeout');
          done(false, 'denied');
        });
      } else if (platform === 'linux') {
        execFileImpl('zenity', ['--question', '--title', title, '--text', message, '--timeout', String(timeoutSec)], (err) => {
          if (!err) return done(true, 'approved');
          if (err.code === 'ENOENT') return done(false, 'unavailable');
          if (err.code === 5) return done(false, 'timeout');
          if (err.code === 1) return done(false, 'denied');
          done(false, 'unavailable');
        });
      } else {
        done(false, 'unavailable');
      }
    });
  };
}

module.exports = { createApprover };
