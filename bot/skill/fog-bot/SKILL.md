---
name: fog-bot
description: Set up and program bots and AI agents on Fog, the end-to-end encrypted messenger, with fog-bot and its local HTTP API. Use when someone wants to run a Fog account as a bot, connect an agent or script to Fog, build a Fog bot (replies, streaming, buttons, dropdowns, forms, commands, files, threads, groups), lock a bot to its owner, or debug a fog-bot integration. For Hermes Agent, use the hermes-fog plugin instead of writing code.
---

# fog-bot

`fog-bot` runs a Fog account as a bot. It holds the account's keys and does all the end-to-end
encryption on the bot owner's machine, then gives the bot a plain JSON HTTP API on `127.0.0.1`. A bot is
an ordinary Fog account: the Fog server can't tell it's a bot and never sees what anyone says. You write
the bot against the API; you never touch the crypto.

Full API reference: `README.md` in the fog repo's `bot/` folder (https://github.com/0xGingi/fog/tree/main/bot).
Working bots that use every feature below: `examples/bot.py` (Python, standard library) and
`examples/bot.ts` (TypeScript, no dependencies), next to this file.

**Using Hermes Agent?** Don't write a bot: install the plugin (`hermes plugins install 0xGingi/hermes-fog`,
then set `FOG_BOT_TOKEN` and `FOG_ALLOWED_USERS`). It already does everything here.

## 1. Set it up

Get the binary from the Fog releases (`fog-bot-linux-x64`, `-linux-arm64`, `-darwin-arm64`, `-darwin-x64`,
`-windows-x64.exe`), or build it from the fog repo (needs Rust with the `wasm32-unknown-unknown` target and
`wasm-bindgen-cli` 0.2.130, as in the repo README): `cd web && bun install && bun run core && cd .. && bun build --compile bot/main.ts --outfile fog-bot`.

```sh
fog-bot init --username my_agent --name "My Agent" --owner @you
fog-bot run
```

- `init` prints the account's **recovery phrase** (the only way back into the account; tell the user to
  store it safely, and never put it in code or logs) and the **API token**. `fog-bot token` prints the token again.
- `--owner @you` locks the bot to its owner. Always suggest it for personal agents. Without an allowlist,
  anyone can message the bot.
- `--server URL` for a self-hosted Fog server (default `https://getfog.org`). `--dir DIR` for a second bot
  (default `~/.fog-bot`, one folder per bot; it holds the keys, keep it private).
- The API listens on `127.0.0.1:8790` (`--port`, `--host`). Only expose it beyond localhost if the user
  understands that the token then gives full control of the account.
- Only one `fog-bot run` per folder. `fog-bot allow` works while it runs (it picks up changes within a second); `info` needs it stopped.

Keep it running as a service. macOS (`~/Library/LaunchAgents/org.getfog.bot.plist`, then
`launchctl load` it):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>org.getfog.bot</string>
  <key>ProgramArguments</key><array><string>/usr/local/bin/fog-bot</string><string>run</string></array>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
</dict></plist>
```

Linux (`~/.config/systemd/user/fog-bot.service`, then `systemctl --user enable --now fog-bot`):

```ini
[Unit]
Description=fog-bot
After=network-online.target
[Service]
ExecStart=%h/.local/bin/fog-bot run
Restart=always
[Install]
WantedBy=default.target
```

## 2. Who the bot talks to

```sh
fog-bot allow                  # show the list
fog-bot allow --add @partner   # also --remove, --set, --clear
```

People not on the list can't reach the bot at all. Their messages stay unanswered requests: no receipts,
and they never get the bot's profile. They never appear in the API, and the bot gets `403 not_allowed` if it
tries to write to them. In groups, the bot joins only groups owned by someone on the list and only hears
people on the list. Usernames are looked up once and saved as account ids.

## 3. The loop

Every request sends `Authorization: Bearer $FOG_BOT_TOKEN`. Bodies and answers are JSON.

```text
PATCH /v1/me           {about, name?, avatar?}           # once at startup
PUT   /v1/commands     {commands: [...]}                 # the / menu
GET   /v1/events?offset=-1                               # → {next}: skip the backlog on first start
loop: GET /v1/events?offset=<next>&timeout=30            # → {events, next}; long-polls up to 30 s
      handle each event, then use the new `next` (that confirms the old ones)
```

Events are kept for a week, so a bot that restarts with its saved offset misses nothing. On connection
errors (fog-bot restarting), wait a few seconds and poll again.

| event | what to do |
|---|---|
| `message` | `event.message`: `chat {id, type: dm\|group, title}`, `from {id, username, name, is_bot}`, `text`, `reply_to`, `mentions_me`, `attachment`, `thread`, `poll` |
| `button` | a tap on your button (`data`), a dropdown choice (`data` = its id, `values`) or a submitted form (`data` = form id, `fields`). Answer with `query_id`. |
| `autocomplete` | someone typing a command option: answer with suggestions |
| `edited` / `deleted` / `reaction` | someone changed, removed or reacted to a message |
| `chat` / `thread` | a group or thread was created or changed |

In groups, answer only when `mentions_me` is true, when the message is in a thread you're part of, or when
it replies to the bot (`reply_to.from.is_bot` and it's the bot's id). Otherwise bots that answer
everything get annoying.

## 4. Recipes

URL-encode chat and message ids (`encodeURIComponent` / `urllib.parse.quote(s, safe="")`): group ids contain `:`.

**Reply.** `POST /v1/chats/{chat}/messages {text, reply_to?}`. Text is Markdown by default: headings,
**bold**, lists, tables, fenced code with a language, links, `||spoilers||`. Send `format: "plain"` to turn
that off. `{chat}` can also be `@username` or an account id to start a DM.

**Stream a reply** (an LLM answer as it's generated): send with `live: true`, then
`PATCH /v1/chats/{chat}/messages/{id} {text}` with the text so far (every ~0.5-1 s is plenty), then a final
`PATCH {text, live: false}`. Live edits don't show "edited"; Fog shows a typing cursor. Always finish with
`live: false` (fog-bot does it for you after 2 idle minutes if the bot dies).

**Working indicators.** `POST /v1/chats/{chat}/typing` (lasts ~5 s; repeat every 4 s while busy). React
👀 on the user's message while working and ✅ when done: `PUT /v1/chats/{chat}/messages/{id}/reaction {emoji}`
(`null` removes it). `POST /v1/chats/{chat}/read` sends read receipts. `silent: true` on a send means no
notification (use it for progress messages).

**Buttons.** `buttons` is a list of rows; a row is a list of buttons or one dropdown:

```json
{"text": "Run `rm -rf build`?",
 "card": {"title": "Approval needed", "color": "#e0a030", "footer": "expires in 5 min"},
 "buttons": [
   [{"text": "Allow", "data": "ok:42", "style": "primary"}, {"text": "Deny", "data": "no:42", "style": "danger"}],
   [{"text": "Docs", "url": "https://example.com"}],
   {"select": {"id": "model", "placeholder": "Pick a model", "max": 1,
               "options": [{"label": "Fast", "value": "fast"}, {"label": "Smart", "value": "smart"}]}}]}
```

A tap arrives as a `button` event. Answer it within 15 minutes with
`POST /v1/buttons/{query_id}/answer {text}` (a small note), `{text, alert: true}` (a dialog), or
`{form}` (see below). Then **settle** the message so it can't be tapped twice:
`PATCH {buttons: null, card: {title: "Allowed", color: "#2e9d5b"}}`. Fog only delivers taps on buttons the
bot really sent, but still check who tapped (`from.id`) before doing anything sensitive. `data` is up to
256 characters: put an id in it, not the payload.

**Forms** (ask for a code, a password, a short text): answer a tap with

```json
{"form": {"id": "vault", "title": "Vault code",
          "fields": [{"id": "code", "label": "One-time code", "secret": true, "required": true, "min_length": 6, "max_length": 6}]}}
```

It comes back as a `button` event with `data: "vault"` and `fields: {"code": "…"}`. Up to 5 fields
(`multiline` for long text).

**Commands.** `PUT /v1/commands` publishes the menu shown when people type `/`:

```json
{"commands": [
  {"name": "new", "description": "Start over"},
  {"name": "model", "description": "Switch model", "options": [
    {"name": "name", "description": "Model", "autocomplete": true}]},
  {"name": "effort", "description": "Reasoning effort", "options": [
    {"name": "level", "description": "Level", "choices": [{"label": "High", "value": "high"}, {"label": "Low", "value": "low"}]}]}]}
```

A picked command arrives as an ordinary message (`/effort high`). For `autocomplete` options you get
`autocomplete` events (`command`, `option`, `value`, `args`); answer quickly (people are typing) with
`POST /v1/autocomplete/{query_id}/answer {choices: [{label, value}]}`, up to 25. Limits: 100 commands,
25 options each, names `a-z 0-9 _ -` up to 32 characters.

**Files.** Upload first, then send: `POST /v1/files?name=report.pdf&kind=file` with the raw bytes and the
right `Content-Type` → `{file: {file_id}}`, then `POST …/messages {text, file_id}`. `kind` is `photo`,
`video`, `audio`, `voice` (a voice note; add `&duration=3.2`), `file`, `sticker` or `videonote`; it
defaults from the content type. One file per message (`file_ids` sends several messages). Up to 2 GB.
Download any attachment with `GET /v1/files/{file_id}`. Voice notes from the apps arrive as `audio/webm`
or `audio/mp4` (Opus or AAC), which speech-to-text services accept.

**Only one person sees it.** In a group, `only_to: "<account id>"` shows a message to that member alone.
Use it for "that button isn't yours" style answers.

**Threads** (one conversation per topic, like Discord): start one on the user's message with
`POST /v1/chats/{chat}/threads {name, message_id}`, then send with `thread_id`. Messages in a thread carry
`thread {id, name}`; keep one conversation (session) per thread id. Rename with
`PATCH /v1/chats/{chat}/threads/{id} {name}`. `GET /v1/chats/{chat}/messages?thread_id=…` gives its history.

**More:** history `GET /v1/chats/{chat}/messages?limit=50&before=id`; chat info and members
`GET /v1/chats/{chat}`; pins `PUT|DELETE /v1/chats/{chat}/pins/{id}`; groups
`POST /v1/groups {name, members}`, `PATCH /v1/chats/{chat} {name, add, remove}`; polls
`{poll: {question, options, multiple}}` on a send; `GET /v1/users/@name`.

## 5. Errors

Errors are `{"error": "code", "message": "…"}`.

| status | meaning |
|---|---|
| 202 `queued: true` | not delivered yet (offline, or the other side unreachable). It's kept and resent; you can still edit it by id. |
| 400 | bad request: the `error` code says what (`invalid_buttons`, `text_too_long`, `unknown_file`…) |
| 401 | wrong or missing token |
| 403 `not_allowed` | the person isn't on the allowlist; `not_yours` / `not_owner` for others' messages and groups |
| 404 | unknown chat, message, file, thread, or an expired `query_id` (answer taps within 15 minutes) |

`GET /health` (no token) answers `{ok, connected}`; `connected: false` means fog-bot can't reach the Fog
server right now (it reconnects by itself and resends what's waiting).

## Checklist for a new bot

- [ ] `fog-bot init … --owner @them`, recovery phrase stored safely, token in an env var (not in code)
- [ ] fog-bot running as a service
- [ ] `about` and the command menu set at startup
- [ ] the event loop starts with `offset=-1` (or a saved offset) and always moves to `next`
- [ ] groups: only answers when mentioned, in its threads, or when replied to
- [ ] long answers streamed with `live`, and always finished with `live: false`
- [ ] every tap answered, and settled messages edited to remove their buttons
- [ ] sensitive actions check `from.id`, not just the button
