# fog-bot

Run a Fog account as a bot. `fog-bot` holds the account's keys, does all the end-to-end encryption with
the Fog app's own engine, and gives your bot (Hermes or your own code) a plain HTTP API on
your machine.

A bot is an ordinary Fog account. The server can't tell it's a bot, and like every Fog chat it never
sees what anyone says. The "bot" badge, its description and its commands travel inside its encrypted
profile, and only reach the people it talks to.

## Quick start

On getfog.org, the adult running the bot must personally accept the current [Terms of Use](https://getfog.org/terms/). The CLI prints the dated flag to add to the command. Self-hosted servers set their own rules.

```sh
fog-bot init --username my_agent --name "My Agent" --owner @you   # prints the recovery phrase and API token
fog-bot run                                                         # API on http://127.0.0.1:8790
```

Then open the invite link it printed (or search for `@my_agent` in Fog) and say hi.

- `--server URL`: another Fog server (default `https://getfog.org`). Saved by `init`.
- `--dir DIR`: where the bot keeps its keys and messages (default `$FOG_BOT_DIR` or `~/.fog-bot`). One folder per bot. Keep it private: it holds the account's keys.
- `--port`, `--host`: where the API listens (default `127.0.0.1:8790`). It only listens on this machine unless you change `--host`.
  The token gives full control of the account, so beyond this machine the API is HTTPS only: `--tls-cert cert.pem --tls-key key.pem`
  (also `tlsCert`/`tlsKey` in `config.json`). fog-bot refuses to start on a non-loopback `--host` without them. Or keep it on
  `127.0.0.1` and reach it through a TLS reverse proxy on the same machine or an SSH tunnel (`ssh -L 8790:127.0.0.1:8790 bot-host`).
- `--accept all|none`: accept message requests and group invites automatically (default `all`, but only from people on the allowlist when there is one).
- `fog-bot init --restore` reads a recovery phrase from stdin to bring an account back.
- `fog-bot token [--rotate]` prints (or replaces) the API token. `fog-bot info` prints the account id and invite link.

### Who the bot talks to

With an allowlist, the bot only exists for the people on it. Everyone else:

- stays an unanswered message request: no delivery or read receipts, and they never get the bot's name, photo or commands;
- never appears in the API: no events, chats or history, and the bot can't write to them (`403 not_allowed`);
- can't add the bot to a group, or be in one with it. The bot takes part only in groups owned by someone on the
  list in which **every** member is on the list. Everything the bot posts in a group is encrypted to every member,
  so if the owner adds someone who isn't on the list, the bot goes quiet there: the group drops out of
  `GET /v1/chats` and events, the newcomer gets no receipts or profile, and posting answers `403 not_allowed`
  ("this group has members who aren't on the bot's allowlist"). It comes back by itself once they leave, are
  removed, or are added to the list. The bot can still leave such a group, or remove them if it owns it.
- never shows up inside other people's messages either: replies to them keep only the message id, their reactions,
  thread names and mentions are left out, and the API never gives their name (only their public @username).

```sh
fog-bot init … --owner @you        # set it when creating the bot
fog-bot allow --add @partner       # add, --remove, --set, --clear (works while it's running)
fog-bot allow                      # show the list
fog-bot run --allow @you,@partner  # or set it when starting
```

Taking someone off the list (it takes effect within a second, even while `fog-bot run` is running) puts
their chat back to an unanswered request, so they stop getting receipts too. Events of theirs still waiting
in `/v1/events` are dropped, their files are no longer served (`404`), their pending taps can't be answered, and
the bot replaces the sealed-sender access key it shared, so they can't keep delivering messages to it sealed
(people still on the list get the new key). Usernames are looked up once,
when you add them, and saved as account ids, so the server can't later change who a name points to. With no allowlist, anyone can message the bot (it says so when it starts).

If `init --owner` can't find that account, `init` still prints the recovery phrase but fails, and the bot stays
**closed**: nobody can reach it until you set the list with `fog-bot allow --add @you` (`fog-bot allow --clear`
opens it to everyone on purpose).

Build a single binary with `bun build --compile bot/main.ts --outfile fog-bot` from the repo root, after
`bun install && bun run core` in `web/` (which builds the crypto core; see Local Development in the main
README). Releases include ready-made binaries.

### A skill for AI agents

[`skill/fog-bot/`](skill/fog-bot/SKILL.md) teaches an AI agent (Claude Code, Hermes, or anything that reads
`SKILL.md` skills) to set up fog-bot and program bots against this API, with two complete example bots:
[`bot.py`](skill/fog-bot/examples/bot.py) (standard-library Python) and
[`bot.ts`](skill/fog-bot/examples/bot.ts) (TypeScript, no dependencies). Install it by copying the folder:
`cp -r bot/skill/fog-bot ~/.claude/skills/` for Claude Code, or `~/.hermes/skills/` for Hermes.

## The API

Every request needs `Authorization: Bearer <token>`. Bodies and answers are JSON. Errors look like
`{"error": "code", "message": "…"}` with a 4xx/5xx status.

A **chat** is a person (their account id) or a group (`g:…`). Wherever a chat goes in a URL you can also
use `@username` or an account id; sending to someone the bot hasn't talked to yet starts the chat.

### Identity

| | |
|---|---|
| `GET /v1/me` | `{id, username, name, is_bot, invite, about, connected}` |
| `PATCH /v1/me` | `{name?, avatar?, about?, username?, commands?}`. `avatar` is a `data:image/(png\|jpeg\|webp);base64,…` URL up to 120 KB. |
| `PUT /v1/commands` | `{commands: [Command]}`: the command menu people see when they type `/`. |

```jsonc
// Command
{ "name": "model", "description": "Switch the model",
  "options": [ { "name": "name", "description": "Model name", "required": false,
                 "choices": [{"label": "Opus", "value": "opus"}],   // fixed choices, or…
                 "autocomplete": true } ] }                          // …ask the bot as they type
```

Up to 100 commands, each with up to 25 options; names are 1-32 of `a-z 0-9 _ -`, descriptions up to 100
characters. Commands arrive as ordinary messages (`/model opus`). In groups, picking a command from the menu also
mentions the bot, so `mentions_me` is true.

### Events

`GET /v1/events?offset=N&timeout=30&limit=100` long-polls for events, oldest first, answering
`{events, next}`. Each event has a `seq` and a `date` (ms). Ask again with `offset` = `next`, which also
confirms (deletes) everything before it. Events wait up to a week for you, so nothing is lost while your
bot restarts. `offset=-1` drops whatever is waiting and answers just `next`, to start from now. So that nobody
can fill the bot's disk by writing to it, at most 10,000 events (64 MB) wait, 1,000 per sender; past that the
oldest are dropped. Chat history keeps the last 2,000 messages of each chat.

| `type` | fields |
|---|---|
| `message` | `message`: Message |
| `edited` | `message`: Message (its new text) |
| `deleted` | `chat`, `message_id`, `from` |
| `reaction` | `chat`, `message_id`, `from`, `emoji` (`null`: removed) |
| `read` | `chat`, `message_ids` (the bot's messages they read), `from`. Only from people whose read receipts are on |
| `button` | `query_id`, `chat`, `message_id`, `from`, `data`, plus `values` (dropdown) or `fields` (form) |
| `autocomplete` | `query_id`, `chat`, `from`, `command`, `option`, `value` (the word being typed), `args` (everything after the command) |
| `chat` | `chat`: a group was created, changed, or someone left (only when what the API shows of it changed) |
| `thread` | `chat`, `thread`, `from`, `created` (false: renamed) |

`deleted`, `reaction` and `button` events also carry `thread` when the message is in one.

```jsonc
// Message
{ "id": "…", "date": 1764000000000,                 // ms
  "chat": { "id": "…", "type": "dm" | "group", "title": "…" },
  "from": { "id": "…", "username": "ana" | null, "name": "Ana" | null, "is_bot": false },
  "text": "…",
  "reply_to": { "id": "…", "text": "…", "from": User },        // optional
  "mentions": [User], "mentions_me": true,                     // groups
  "attachment": { "file_id": "…", "kind": "photo" | "video" | "audio" | "voice" | "file" | "sticker" | "videonote",
                  "mime": "image/jpeg", "name": "…", "size": 12345, "width": 800, "height": 600, "duration": 3.2 },
  "poll": { "question": "…", "options": ["…"], "multiple": false },
  "thread": { "id": "…", "name": "…", "message_id": "…" },    // in a thread (message_id: what it was started from)
  "forwarded": true, "edited": true, "only_me": true,
  "reactions": [ { "from": User, "emoji": "👍" } ] }
```

### Messages

`POST /v1/chats/{chat}/messages`

```jsonc
{ "text": "**Markdown** by default",
  "format": "markdown" | "plain",
  "reply_to": "message id",
  "file_id": "…", "file_ids": ["…"],        // upload first; one file per message (the text goes on the first)
  "buttons": [ Row ],
  "card": { "title": "Approval needed", "color": "#e0a030", "footer": "expires in 5 min" },
  "live": true,                              // still being written: stream into it with PATCH, then live:false
  "silent": true,                            // no notification or sound
  "only_to": "account id",                   // groups: only this member sees it
  "thread_id": "…",                          // post in a thread
  "mentions": ["account id"],
  "poll": { "question": "…", "options": ["…", "…"], "multiple": false } }
```

Answers `{message}` (and `messages` when several files went out). If it couldn't be delivered right now
(the bot is offline, or the other side unreachable), the answer is `202` with `queued: true`: the message
is kept and resent when the bot reconnects, and you can still edit it by its id. Text is up to 65,536
UTF-16 code units (JavaScript string length). `only_to` is ignored in DMs. Markdown covers headings, bold,
italic, strikethrough, `||spoilers||`, inline code, fenced code with a language, lists (nested, numbered,
`[ ]` tasks), quotes, tables and links (a link whose text isn't its address asks before opening). A backslash shows the next character as itself (`\*`, `\_`, `\#`).

```jsonc
// Row: a list of buttons…
[ { "text": "Allow once", "data": "ea:once:1", "style": "primary" | "danger" | "success" },
  { "text": "Docs", "url": "https://…" } ]
// …or one dropdown
{ "select": { "id": "model", "placeholder": "Pick a model", "min": 1, "max": 1,
              "options": [ { "label": "Opus", "value": "opus", "description": "slower", "default": false } ] } }
```

Up to 10 rows, 8 buttons a row, 25 dropdown options. `data` is up to 256 characters and comes back in the
`button` event; Fog only delivers taps on buttons the bot really sent.

| | |
|---|---|
| `PATCH /v1/chats/{chat}/messages/{id}` | `{text?, buttons?, card?, live?}` (`buttons: null`/`card: null` remove them). Edits made while `live` (and the final `live: false`) don't show "edited". A `live` message nobody updates for 2 minutes is finished automatically. |
| `DELETE /v1/chats/{chat}/messages/{id}` | The bot's own messages go for everyone; others only from the bot's view. |
| `PUT /v1/chats/{chat}/messages/{id}/reaction` | `{emoji}` (`null` removes it). |
| `POST /v1/chats/{chat}/typing` | Shows "typing…" for about 5 s. Repeat every few seconds while working. |
| `POST /v1/chats/{chat}/read` | Sends read receipts for everything so far. |
| `PUT`/`DELETE /v1/chats/{chat}/pins/{id}` | Pin or unpin a message. |
| `GET /v1/chats/{chat}/messages?limit=50&before=id` | History (oldest first), as Messages. |

### Threads

Side conversations in a group or DM, like Discord threads or Telegram topics. A thread is started from a
message (it shows under that message) or on its own (it shows in the chat as "X started a thread").
Messages in a thread carry `thread`, and don't show in the main conversation.

| | |
|---|---|
| `GET /v1/chats/{chat}/threads` | `{threads: [{id, name, message_id?, by}]}` |
| `POST /v1/chats/{chat}/threads` | `{name, message_id?}` starts one; answers `{thread}` |
| `PATCH /v1/chats/{chat}/threads/{id}` | `{name}`: renamed by whoever started it, or the group's owner |
| `GET /v1/chats/{chat}/messages?thread_id=…` | A thread's history (`?all` for every message in the chat) |

### Taps and suggestions

Answer within 15 minutes:

- `POST /v1/buttons/{query_id}/answer` with `{text?, alert?}` shows a small note (or, with `alert: true`, a dialog) to whoever tapped; with `{form}` it asks them to fill in a form instead, which comes back as another `button` event with `data` = the form's id and `fields`:

  ```jsonc
  { "form": { "id": "vault", "title": "Vault code",
              "fields": [ { "id": "code", "label": "One-time code", "placeholder": "6 digits",
                            "secret": true, "required": true, "multiline": false,
                            "min_length": 6, "max_length": 6 } ] } }   // up to 5 fields
  ```

- `POST /v1/autocomplete/{query_id}/answer` with `{choices: [{label, value}]}` (up to 25).

### Files

- `POST /v1/files?name=report.pdf&kind=voice&duration=3.2&width=&height=&waveform=` with the raw file as the body and its `Content-Type`. Answers `{file: {file_id, …}}`. `kind` defaults from the type (`photo`, `video`, `audio`, `file`); use `voice` for voice notes and `sticker`/`videonote` when you mean them. Photo sizes are read from the file, and EXIF (camera location) is removed from JPEGs. Up to 2 GB.
- `GET /v1/files/{file_id}` downloads (and decrypts) any attachment from an event or from history.

### Chats, groups and people

| | |
|---|---|
| `GET /v1/chats` | Every chat: `{id, type, title, members?, owner?, pinned?, unread, last}` |
| `GET /v1/chats/{chat}` | One chat, with group members (`User` + `is_bot`) and owner |
| `POST /v1/groups` | `{name, members: [id or @username]}` creates a group the bot owns |
| `PATCH /v1/chats/{chat}` | `{name?, add?, remove?}` (groups the bot owns; `add` only people on the allowlist) |
| `POST /v1/chats/{chat}/leave` | Leave a group (also one that has someone off the allowlist in it) |
| `GET /v1/users/{id or @username}` | `User` |
| `POST /v1/users/{id}/block` | Block someone |

`GET /health` (no token) answers `{ok, connected}`.
