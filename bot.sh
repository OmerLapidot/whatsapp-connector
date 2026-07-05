#!/usr/bin/env bash
# Control the whatsapp-connector daemon (WhatsApp session + `wa` CLI socket).
#
#   ./bot.sh status     show running state
#   ./bot.sh start      start now and at login (macOS launchd; elsewhere nohup)
#   ./bot.sh stop       stop the daemon
#   ./bot.sh restart    stop then start
#   ./bot.sh logs       follow the daemon log (Ctrl+C to stop watching)
#
# First login: run `node index.js` in the FOREGROUND instead — the QR code
# renders to stdout. Scan it (WhatsApp > Settings > Linked Devices), wait for
# "ready", Ctrl+C, then `./bot.sh start`.

set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
LABEL="com.whatsapp-connector.daemon"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PIDFILE="$DIR/daemon.pid"

ensure_plist() {
  local node_bin
  node_bin="$(command -v node)" || { echo "node not found on PATH" >&2; exit 1; }
  mkdir -p "$(dirname "$PLIST")"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$node_bin</string>
    <string>$DIR/index.js</string>
  </array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$DIR/bot.out.log</string>
  <key>StandardErrorPath</key><string>$DIR/bot.err.log</string>
</dict>
</plist>
EOF
  echo "wrote $PLIST"
}

is_mac() { [ "$(uname -s)" = "Darwin" ]; }
DOMAIN="gui/$(id -u)"

pid_running() { [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; }

case "${1:-}" in
  status)
    if is_mac; then
      launchctl print "$DOMAIN/$LABEL" 2>/dev/null | grep -E 'state =|pid =' || echo "not loaded"
    else
      pid_running && echo "running (pid $(cat "$PIDFILE"))" || echo "not running"
    fi
    ;;
  start)
    if is_mac; then
      ensure_plist
      launchctl bootstrap "$DOMAIN" "$PLIST" && echo "started"
    else
      pid_running && { echo "already running (pid $(cat "$PIDFILE"))"; exit 0; }
      nohup node "$DIR/index.js" >> "$DIR/bot.out.log" 2>> "$DIR/bot.err.log" &
      echo $! > "$PIDFILE"
      echo "started (pid $!)"
    fi
    ;;
  stop)
    if is_mac; then
      launchctl bootout "$DOMAIN/$LABEL" && echo "stopped"
    else
      if ! pid_running; then
        rm -f "$PIDFILE"   # clean up any stale pidfile
        echo "not running"
      elif kill "$(cat "$PIDFILE")"; then
        rm -f "$PIDFILE"
        echo "stopped"
      else
        echo "failed to stop pid $(cat "$PIDFILE")" >&2
        exit 1
      fi
    fi
    ;;
  restart)
    "$0" stop 2>/dev/null || true
    sleep 1
    "$0" start
    ;;
  logs)
    tail -f "$DIR/bot.log"
    ;;
  *)
    echo "usage: $0 {status|start|stop|restart|logs}"
    ;;
esac
