---
name: whatsapp
description: Read, search, and send WhatsApp messages through the local whatsapp-connector daemon. Use when the user asks to check WhatsApp, read or search a chat/group, summarize messages, reply, or send on WhatsApp. Reads any chat freely; sends ONLY to allow-listed chats and ONLY after the user confirms.
---

# WhatsApp connector

Drive the user's WhatsApp via the `wa` CLI, which talks to an always-on local daemon.

**Always call it by absolute path:** `{{WA_DIR}}/bin/wa`

## Reading (allowed freely)

- `wa chats` — list chats/groups
- `wa read "<chat>" [--limit 30 | --all]` — recent messages (each has an `id` for reactions). `--all` reads the WHOLE chat (every synced message), bypassing the 200 cap — use sparingly: a busy chat can be thousands of messages (large payload + heavy on your context)
- `wa search "<query>" [--chat "<chat>"]` — find messages
- `wa members "<group>"` — who is in a group
- `wa contacts "<query>"` — resolve a name/number
- `wa media "<chat>" "<message-id>"` — download an image/file; prints a path you can then open

Chats are addressed by name (fuzzy) or exact id. If `wa` reports the name is ambiguous, show the candidates and ask which one.

## Response shapes (verified against a live account)

Everything prints as JSON (or a plain string). Shapes you can rely on:

- **`wa chats`** → array of `{ id, name, unread }`, **ordered most-recently-active first**.
  The `id` suffix is the chat type:
  - `…@g.us` — a group
  - `…@lid` — an individual person (WhatsApp's current per-contact id). The older
    `…@c.us` form can also appear; treat BOTH as 1:1 people. To filter to real
    people, exclude `@g.us` — do NOT match on `@c.us` alone (modern accounts return
    `@lid` and you'll get zero results).
- **`wa read`** → `{ chat, id, messages: [ … ] }`, oldest→newest. Each message is
  `{ id, sender, ts, text, hasMedia }`:
  - `sender` is the literal string `"me"` for the user's own messages, otherwise the
    counterparty's chat id — so message direction is just `sender === "me"`.
  - `ts` is a UNIX timestamp in **seconds** (multiply by 1000 for a JS `Date`).
  - `--limit` is capped at **200** (MAX_LIMIT); a busier chat returns only its most
    recent 200, so a chat sitting at exactly 200 means "≥200", not exactly 200.
    Pass **`--all`** to bypass the cap and fetch every message — but "every" means
    every message **synced** into the Web session, NOT the full lifetime history
    (a freshly linked device backfills older messages over time), and a big chat
    can return thousands of messages at once.
- **`wa status`** → `{ state, ready, syncPercent }`; `state` ∈
  `starting | needs-login | syncing | ready | auth-failure | disconnected`.
- **Errors** come back as `{ ok:false, error, code }` with codes like
  `NOT_ALLOWED` (chat not on the allow-list), `NOT_APPROVED` (human denied or the
  dialog timed out), `AMBIGUOUS` (name matched >1 chat), `NOT_FOUND`.

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

If `wa` prints "daemon is not running", start it yourself:

    {{WA_DIR}}/bot.sh start

On macOS this registers a launchd agent (`com.whatsapp-connector.daemon`) with
`KeepAlive` + `RunAtLoad`, so the daemon stays up for as long as the Mac is on —
it relaunches automatically after a crash and at every login. On Linux `bot.sh`
falls back to a `nohup` background process with a pidfile. Then poll `wa status`
until `ready: true` (see "Still syncing").

Do NOT run `node index.js` yourself as the long-term daemon — that process dies
with its terminal. `bot.sh start` is what makes it persistent.

**One exception — a fresh, never-linked machine needs a human for the QR.** If
after starting, `wa status` reports `state: "needs-login"` (no WhatsApp session
on disk yet), the login QR renders only to a foreground terminal, which you
cannot scan. Ask the user to run `node index.js` in a terminal from `{{WA_DIR}}`,
scan it via WhatsApp → Settings → Linked Devices, wait for `ready`, then Ctrl+C
and run `{{WA_DIR}}/bot.sh start` for the persistent daemon.

## Still syncing (just after a restart)

`wa status` returns `{ state, ready, syncPercent }`. Right after a (re)start the
daemon reports `state: "syncing"` while it finishes delivering messages that
queued while it was off, and commands fail with "not ready (state: syncing)".
This is normal and self-clears within a few seconds (up to ~60s if a lot
queued). Poll `wa status` until `ready: true`, then proceed — don't tell the
user the daemon is down.
