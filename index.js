// Entry point: starts the WhatsApp connector daemon.
// It owns the WhatsApp session and serves the `wa` CLI over a local socket.
require('./src/daemon');
