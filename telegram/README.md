# fog-telegram

Bring your Telegram chats into Fog. `fog-telegram` signs in to Telegram as one more of your devices
and passes messages both ways through a [fog-bot](../bot/README.md) you run. Each Telegram chat
becomes its own Fog chat, named "Alice (Telegram)", where you read and answer as usual.

## What stays private and what doesn't

- **The Fog server sees nothing new.** The bridge talks to you through the bot's end-to-end encrypted
  Fog chats, like any other bot.
- **Telegram still sees your Telegram chats.** Ordinary Telegram chats aren't end-to-end encrypted:
  Telegram keeps them on its servers. Bridging doesn't change that, and every bridged chat says so
  when it opens.
- **The bridge machine sees everything that crosses the bridge.** It holds your Telegram login
  (`telegram.session`, written readable by you only) and the bot's keys, so run it on a machine you
  control.
- **Telegram sees the bridge machine's IP address**, not your phone's.
- **Secret chats can't be bridged.** They only exist on the phone that started them.

## Setup

You need a fog-bot that only you can reach, and a Telegram API id.

1. Get an API id and hash for your account at <https://my.telegram.org> → API development tools.
2. Create the bot, with you as the only person on its allowlist:

   On getfog.org, the adult running the bot must personally accept the current [Terms of Use](https://getfog.org/terms/). The CLI prints the dated flag to add to the command. Self-hosted servers set their own rules.

   ```sh
   fog-bot init --username my_telegram --name "Telegram" --owner @you
   fog-bot run
   ```

3. In another terminal, sign in to Telegram and start the bridge:

   ```sh
   fog-telegram login            # asks for the API id and hash, your phone number, the code, your 2FA password
   # No code arriving? fog-telegram login --qr shows a QR code to scan from Telegram on your phone
   # (Settings > Devices > Link Desktop Device) instead.
   fog-telegram run --owner @you
   ```

4. In Fog, message the bot `/chats` and pick a chat, or just wait: a new Telegram message opens its
   chat in Fog by itself, with the last 20 messages before it copied in silently.

`fog-telegram run` remembers `--owner` and the other options. To run it from source instead of a
release binary: `cd telegram && bun install && bun main.ts run`. To build one binary:
`bun build --compile telegram/main.ts --outfile fog-telegram`.

### Options

- `--dir DIR`: where the bridge keeps its Telegram login and state (default `$FOG_TELEGRAM_DIR` or `~/.fog-telegram`).
- `--bot URL`: the fog-bot API (default `http://127.0.0.1:8790`). Anything off this machine has to be `https://`,
  because the bot's token is a full login to its account.
- `--bot-dir DIR`: the fog-bot folder to read the API token from (default `$FOG_BOT_DIR` or `~/.fog-bot`).
  Or set `FOG_BOT_TOKEN`. If you rotate the token, the bridge reads it again.
- `--max-mb N`: the biggest file it carries across, either way (default 50). Bigger ones show as a note.
- `--history N`: how many earlier messages to copy in when a chat is first bridged (default 20, up to 100; 0 for none).
- `fog-telegram logout` signs the bridge out of Telegram and deletes its login. It also shows up in
  Telegram under Settings → Devices as "fog-telegram", where you can end it.

## In Fog

Message the bot directly:

- `/chats`: your 10 most recent Telegram chats, as buttons.
- `/open @username`: bring in a chat by username, phone number or name. This is also how you bring in
  a channel or a chat you've muted on Telegram. Those never open by themselves, so they can't flood you
  (a muted group still opens when someone mentions or replies to you there).

Inside a bridged chat:

- Send text, photos, videos, voice notes, files, replies, edits, deletes and reactions. They go to
  Telegram as you. In a thread that came from a forum topic, they go to that topic.
- When you read a bridged chat in Fog, it's marked read on Telegram too (only if your read receipts
  are on in Fog). Answering marks it read, as Telegram's own apps do.
- `/close` stops bridging that chat. New messages there stay on Telegram until you `/open` it again.
  Leaving the Fog chat does the same.

## What comes across

| From Telegram | In Fog |
|---|---|
| Text, with its bold, italic, strikethrough, spoilers, code, code blocks, quotes and links | The same formatting. Underline has no Fog equivalent and comes in plain |
| Replies, forwards | Replies, and "[forwarded from Name]" |
| Who wrote it | "**Name:**" in front in groups, and "**You:**" for what you sent from another Telegram device (those come in silently). Everything is posted by the bot: senders aren't Fog accounts |
| Groups and supergroups | One Fog chat each. If it's muted on Telegram, its messages come in silently |
| Someone mentions or replies to you | A mention in Fog. It notifies even if the chat is muted on Telegram |
| Topics in forum groups | A Fog thread per topic, named after it (renames follow). The General topic is the main chat |
| Joins, leaves, removals, group renames | A quiet line saying so, and the Fog chat is renamed too |
| Photos, videos, round videos, voice notes, music, files, still stickers | The same, up to `--max-mb` |
| Edits, deletes | Edited or deleted in Fog |
| Reactions | The bot reacts with the one most people chose (not counting yours) |
| They read your messages | Your messages show as read |
| Locations | A map link |
| Animated stickers, polls, contacts, and anything else | A short note saying what it was |

Each chat is handled in order, and different chats side by side, so a big file only holds up its own chat.

Telegram sometimes flags accounts that sign in through unofficial apps, mostly new or spammy
accounts. Using your own API id, as above, is what Telegram asks of third-party apps.
