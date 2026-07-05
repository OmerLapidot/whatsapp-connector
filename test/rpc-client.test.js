const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { rpc } = require('../src/rpc-client');

test('rpc posts the payload and returns the parsed reply', async () => {
  const sock = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wa-')), 's.sock');
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      const p = JSON.parse(b);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, data: { echoed: p.cmd } }));
    });
  });
  await new Promise((r) => server.listen(sock, r));
  try {
    const reply = await rpc(sock, { cmd: 'chats', args: {} });
    assert.deepStrictEqual(reply, { ok: true, data: { echoed: 'chats' } });
  } finally {
    server.close();
  }
});
