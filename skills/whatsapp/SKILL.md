---
name: whatsapp
description: Read, search, and send WhatsApp messages through the local whatsapp-connector daemon. Use when the user asks to check WhatsApp, read or search a chat/group, summarize messages, reply, or send on WhatsApp. Reads any chat freely; sends ONLY to allow-listed chats and ONLY after the user confirms.
---

# WhatsApp connector

Drive the user's WhatsApp via the `wa` CLI, which talks to an always-on local daemon.

**Always call it by absolute path:** `{{WA_DIR}}/bin/wa`

## Reading (allowed freely)

- `wa chats` — list chats/groups
- `wa read "<chat>" --limit 30` — recent messages (each has an `id` for reactions)
- `wa search "<query>" [--chat "<chat>"]` — find messages
- `wa members "<group>"` — who is in a group
- `wa contacts "<query>"` — resolve a name/number
- `wa media "<chat>" "<message-id>"` — download an image/file; prints a path you can then open

Chats are addressed by name (fuzzy) or exact id. If `wa` reports the name is ambiguous, show the candidates and ask which one.

## Sending (two-step — read this every time)

`wa send` and `wa send-media` do NOT transmit. They return a `token` + a `preview`. To actually send:
1. Run `wa send "<chat>" "<text>"` (or `wa send-media ...`). It returns `{ pending: true, token, chat, preview }` and sends nothing.
2. Show the user the exact `chat` and `preview`, and get an explicit "yes".
3. Only then run `wa send-confirm <token>`. The token expires in ~2 minutes.

`react` is single-step but still restricted to allow-listed chats. `mark-read` is single-step and works on **any** chat — it only changes the user's own read state and sends nothing outward, so it is NOT allow-list gated.

## Allow-list (gated by a native dialog on the user's screen)

- `wa allow list` — chats sends are permitted to. The entry `*` means EVERYONE.
- `wa allow add "<chat>" ["<chat>" ...]` — request permission for one or more chats
- `wa allow remove "<chat>" ["<chat>" ...]` — request removal (raw ids accepted)
- `wa allow all` / `wa allow remove all` — the EVERYONE wildcard on / off

Every mutation above triggers a NATIVE DIALOG that only the human can click.
The command blocks up to 60 seconds while the dialog is on screen — this is
normal, wait for it. A denial, timeout, or "not approved" error is FINAL:
do not retry, do not edit allowlist.json, report the outcome to the user.
If a send fails with "not on the send allow-list", offer `wa allow add` —
run it only after the user agrees, and remind them to expect the dialog.

## Scheduled sends

- `wa schedule "<chat>" "<text>" --at "HH:MM"` (or `--at "YYYY-MM-DD HH:MM"`, `--in 30m`, `--every monday --at 09:00`, `--every month --on 1 --at 08:00`, `--media <path>`)
- It returns a pending token like `send`; confirm with the user, then `wa schedule-confirm <token>`.
- `wa schedule list` / `wa schedule cancel <id>` manage jobs. Fires re-check the allow-list.

## If the daemon is down

If `wa` prints "daemon is not running", tell the user to run `./bot.sh start`
from `{{WA_DIR}}`. Do not attempt to start WhatsApp yourself.

## Still syncing (just after a restart)

`wa status` returns `{ state, ready, syncPercent }`. Right after a (re)start the
daemon reports `state: "syncing"` while it finishes delivering messages that
queued while it was off, and commands fail with "not ready (state: syncing)".
This is normal and self-clears within a few seconds (up to ~60s if a lot
queued). Poll `wa status` until `ready: true`, then proceed — don't tell the
user the daemon is down.
