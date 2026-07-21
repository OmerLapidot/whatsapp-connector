# whatsapp-connector

Drive your personal WhatsApp from the command line — and safely from an AI agent.

A small always-on daemon owns a WhatsApp Web session ([whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js)).
The `wa` CLI talks to it over a private unix socket. A bundled skill teaches
Claude Code (or any agent that can run shell commands) to use it. Reading is
unrestricted; **sending is limited to an allow-list that only a human can
change** — every change pops a native dialog on your screen.

```
agent / you ──▶ wa CLI ──▶ unix socket ──▶ daemon ──▶ WhatsApp Web
                                   │
                       allow-list + native approval dialog
```

## Quickstart

```bash
git clone <this-repo> && cd whatsapp-connector
npm install
node index.js        # first login: QR renders in the terminal — scan it via
                     # WhatsApp > Settings > Linked Devices, wait for "ready", Ctrl+C
./bot.sh start       # always-on from now on (macOS launchd; Linux background process)
./bin/wa status      # → { "ready": true, ... }
./install.sh         # optional: install the Claude Code skill
```

Add `bin/` to your PATH or call `./bin/wa` directly.

## Commands

| Command | Gated? | What it does |
|---|---|---|
| `wa status` | – | daemon state: `ready`, `syncing`, `starting`, `needs-login`, `auth-failure`, `disconnected` |
| `wa chats` | – | list chats and groups |
| `wa read "<chat>" [--limit N]` | – | recent messages (max 200) |
| `wa search "<q>" [--chat "<chat>"]` | – | find messages |
| `wa members "<group>"` | – | group participants |
| `wa contacts "<q>"` | – | resolve a name/number |
| `wa media "<chat>" "<msg-id>"` | – | download an attachment |
| `wa mark-read "<chat>"` | – | mark read (changes only your own state) |
| `wa send "<chat>" "<text>"` | allow-list | step 1: returns a preview + token, sends nothing |
| `wa send-confirm <token>` | allow-list | step 2: actually transmits (token lives ~2 min) |
| `wa send-media "<chat>" <path> [caption]` | allow-list | two-step, like `send` |
| `wa react "<chat>" <msg-id> <emoji>` | allow-list | single-step reaction |
| `wa schedule "<chat>" "<text>" --at/--in/--every ...` | allow-list | schedule a send (two-step confirm) |
| `wa schedule list` / `wa schedule cancel <id>` | – | manage scheduled jobs |
| `wa allow list` | – | show the allow-list (`*` = everyone) |
| `wa allow add "<chat>" ...` | **native dialog** | request send permission (bulk OK) |
| `wa allow remove "<chat>" ...` | **native dialog** | revoke permission (raw ids OK) |
| `wa allow all` / `wa allow remove all` | **native dialog** | the EVERYONE wildcard |

Chats are addressed by fuzzy name or exact id; ambiguous names return the candidates.

## The sending model

1. **Two-step sends.** `wa send` never transmits — it returns a token and a
   preview. Only `wa send-confirm <token>` sends. An agent is instructed (by
   the bundled skill) to show you the preview and get your yes in between.
2. **The allow-list bounds everything.** Every send, reaction, and scheduled
   fire is checked server-side against `allowlist.json` at execution time.
3. **Only a human can widen the list.** `wa allow add/remove/all` make the
   daemon show a native OS dialog (macOS `osascript`, Linux `zenity`) and
   apply the change only on an explicit **Approve** click. Deny, a 60-second
   timeout, a headless machine, or any dialog error all refuse the change.
   Every request and outcome is logged to `bot.log`.

## Security model — what is actually enforced

**Enforced by the daemon** (cannot be routed around via CLI/RPC arguments):
- allow-list check on send / send-media / send-confirm / react / schedule /
  schedule-confirm, re-checked when scheduled jobs fire;
- native-dialog approval for every allow-list mutation, deny by default;
- two-step tokens for content sends (single-use, ~2 min expiry).

**Enforced by your agent harness** (ships in `.claude/settings.json`):
- deny rules for agent file-edit tools on `allowlist.json`;
- your harness's own permission prompts for shell commands.

**Advisory** (the skill instructs the agent; nothing enforces it):
- previewing sends to you before confirming; treating a dialog denial as final.

**Residual risks — read this once:** everything runs under *your* user
account. A local process with your privileges could edit `allowlist.json`
directly, restart the daemon with `WA_ALLOWLIST` pointing elsewhere, or drive
the GUI if you grant an agent screen control. The dialog gate raises the bar
from "agent can silently widen its permissions" to "requires an on-screen
click or visible tampering" — it is not a sandbox. If you need a hard
boundary, run the daemon under a separate OS user and own `allowlist.json`
with it.

## For AI agents

If you are an agent reading this: use `./install.sh` output (or these rules)
as your operating contract.

- Call the CLI by absolute path; check `wa status` until `ready: true` after
  any restart (a `syncing` state self-clears, up to ~60s).
- Reading is free. Sending is two-step: `wa send` → show the human the exact
  preview → explicit yes → `wa send-confirm <token>`.
- `wa allow ...` mutations block up to 60s while a dialog only the human can
  see is on screen. A denial/timeout is **final**: do not retry, do not edit
  `allowlist.json`, report to the human.
- Errors are one-line strings with a code; `NOT_ALLOWED` means ask the human
  about `wa allow add`, `NOT_APPROVED` means the human said no.

## Configuration

Environment variables (defaults in `src/config.js`): `WA_SOCKET`,
`WA_ALLOWLIST`, `WA_SCHEDULES`, `WA_SYNC_QUIET_MS`, `WA_SYNC_MAX_MS`.

## Troubleshooting

- **"daemon is not running"** → `./bot.sh start` (or `node index.js` in the
  foreground to see why it dies).
- **"not ready (state: syncing)"** → normal after a restart; poll `wa status`.
- **QR again / session expired** → `./bot.sh stop`, delete `.wwebjs_auth*/`,
  log in again in the foreground.
- **Approval dialog never appears** → the daemon must run in your GUI session
  (`./bot.sh start` does this via launchd `gui/` domain on macOS; on a headless
  box there is no dialog and allow changes are denied by design).

## Development

`npm test` — pure-Node test suite (`node:test`), no WhatsApp connection needed.

## Why I built this

I wrote up how this was built and what it taught me:
[English](https://hopala.io/en/blog/whatsapp-into-claude.html) · [עברית](https://hopala.io/blog/whatsapp-into-claude.html)

## License

MIT
