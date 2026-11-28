#!/usr/bin/env bun
// fog-telegram: brings your Telegram chats into Fog. It signs in to Telegram as one of your devices and
// talks to Fog through a fog-bot you run, so nothing new reaches the Fog server: your Fog side stays
// end-to-end encrypted, and only this machine (and Telegram, as always) sees the Telegram messages.
import { TelegramClient, InputMedia, getMarkedPeerId, type Message, type Peer, type DeleteMessageUpdate } from '@mtcute/bun'
import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { renderANSI } from 'uqr'
import { toMarkdown, type Entity } from './markdown'

const VERSION = '0.5.2'
const USAGE = `fog-telegram ${VERSION}: bridge your Telegram account into Fog, through a fog-bot.

  fog-telegram login [--api-id N --api-hash H]   sign in to Telegram (phone, code, 2FA password);
                                                  --qr signs in by scanning a QR code instead (no code needed),
                                                  --sms asks for the code by SMS instead of in the Telegram app
  fog-telegram run [--owner @you]                 run the bridge (needs \`fog-bot run\` going)
  fog-telegram logout                             sign this bridge out of Telegram and forget the session

Options:
  --dir DIR        where the bridge keeps its Telegram session and state (default $FOG_TELEGRAM_DIR or ~/.fog-telegram)
  --bot URL        the fog-bot API (default http://127.0.0.1:8790; anything off this machine must be https)
  --bot-dir DIR    the fog-bot folder to read its API token from (default $FOG_BOT_DIR or ~/.fog-bot),
                   or set FOG_BOT_TOKEN
  --max-mb N       biggest file to carry across, in MB (default 50)
  --history N      earlier messages to copy in when a chat is first bridged (default 20, 0 for none)

Get an API id and hash for your own account at https://my.telegram.org (API development tools).`

process.umask(0o077) // the session file is a full login to the Telegram account
const { positionals, values: flags } = parseArgs({
  allowPositionals: true,
  options: {
    dir: { type: 'string' },
    bot: { type: 'string' },
    'bot-dir': { type: 'string' },
    sms: { type: 'boolean' },
    qr: { type: 'boolean' },
    owner: { type: 'string' },
    'api-id': { type: 'string' },
    'api-hash': { type: 'string' },
    'max-mb': { type: 'string' },
    history: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
})
const cmd = flags.help ? 'help' : (positionals[0] ?? 'help')
function fail(msg: string): never {
  console.error(msg)
  process.exit(1)
}

const dir = flags.dir ?? process.env.FOG_TELEGRAM_DIR ?? join(homedir(), '.fog-telegram')
mkdirSync(dir, { recursive: true, mode: 0o700 })
const configPath = join(dir, 'config.json')
type Config = { apiId?: number; apiHash?: string; bot: string; botDir?: string; owner?: string; maxMb: number; history: number }
const config: Config = { bot: 'http://127.0.0.1:8790', maxMb: 50, history: 20, ...(existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {}) }
const saveConfig = () => {
  writeFileSync(configPath + '.tmp', JSON.stringify(config, null, 2) + '\n')
  renameSync(configPath + '.tmp', configPath)
}
if (flags.bot) config.bot = flags.bot.replace(/\/+$/, '')
if (flags['bot-dir']) config.botDir = flags['bot-dir']
if (flags['max-mb']) config.maxMb = Number(flags['max-mb']) || config.maxMb
if (flags.history) config.history = Math.max(0, Math.min(100, Number(flags.history) || 0))
if (flags['api-id']) config.apiId = Number(flags['api-id'])
if (flags['api-hash']) config.apiHash = flags['api-hash']

const sessionPath = join(dir, 'telegram.session')
const telegram = () =>
  new TelegramClient({
    apiId: config.apiId!,
    apiHash: config.apiHash!,
    storage: sessionPath,
    updates: { catchUp: true }, // pick up what arrived while the bridge was stopped
    // What Telegram lists under Settings > Devices, instead of this machine's OS details.
    initConnectionOptions: { deviceModel: 'fog-telegram', systemVersion: VERSION, appVersion: VERSION },
  })

function hidden(q: string) {
  Bun.spawnSync(['stty', '-echo'], { stdin: 'inherit' })
  try {
    return prompt(q) ?? ''
  } finally {
    Bun.spawnSync(['stty', 'echo'], { stdin: 'inherit' })
    console.log()
  }
}
const ask = (q: string) => prompt(q)?.trim() || fail('Cancelled.')

if (cmd === 'help') {
  console.log(USAGE)
  process.exit(0)
}

if (cmd === 'login') {
  config.apiId ??= Number(ask('Telegram API id (from https://my.telegram.org):'))
  config.apiHash ??= ask('Telegram API hash:')
  if (!config.apiId || !/^[0-9a-f]{32}$/i.test(config.apiHash)) fail('That API id or hash doesn\'t look right. Get them at https://my.telegram.org.')
  saveConfig()
  const tg = telegram()
  const me = await tg.start({
    phone: () => ask('Phone number, with country code (+15551234567):'),
    code: () => ask('Code Telegram sent you:'),
    password: () => hidden('Two-step verification password:'),
    invalidCodeCallback: (t) => console.log(t === 'code' ? 'Wrong code, try again.' : 'Wrong password, try again.'),
    forceSms: !!flags.sms,
    // QR login: scan it from another device where you're signed in. Telegram replaces the code every ~30s.
    qrCodeHandler: flags.qr
      ? (url) => {
          process.stdout.write('\x1b[2J\x1b[H')
          console.log(renderANSI(url, { border: 2 }))
          console.log('In Telegram on your phone: Settings > Devices > Link Desktop Device, then scan this.')
          console.log('It refreshes by itself. Press Ctrl+C to cancel.')
        }
      : undefined,
    codeSentCallback: (c) => {
      if (c.type === 'email_required') fail('Telegram wants a login email set up first: add one in the Telegram app (Settings > Privacy and Security > Login Email), then try again.')
      const where: Record<string, string> = {
        app: 'in the Telegram app, in the chat from "Telegram" (blue check) on your other devices',
        sms: 'by SMS',
        email: 'to your Telegram login email',
        call: 'in a phone call',
        flash_call: 'as the last digits of a missed call',
        missed_call: 'as the last digits of a missed call',
        fragment: 'through Fragment (fragment.com)',
        firebase: 'by SMS',
      }
      console.log(`Telegram sent you a code ${where[c.type] ?? `(${c.type})`}.`)
      if (c.type === 'app') console.log('Nothing there? Press Ctrl+C and run `fog-telegram login --qr` to sign in with a QR code instead.')
    },
  })
  console.log(`Signed in to Telegram as ${me.displayName}. Now: fog-telegram run --owner @you`)
  await tg.destroy()
  process.exit(0)
}

if (cmd === 'logout') {
  if (!existsSync(sessionPath) || !config.apiId) fail('Not signed in.')
  const tg = telegram()
  await tg.logOut().catch(() => {})
  await tg.destroy()
  for (const f of [sessionPath, sessionPath + '-wal', sessionPath + '-shm']) rmSync(f, { force: true })
  console.log('Signed out of Telegram. The chats already in Fog stay there.')
  process.exit(0)
}

if (cmd !== 'run') fail(USAGE)
if (!config.apiId || !existsSync(sessionPath)) fail('Sign in to Telegram first: fog-telegram login')

// ---------- fog-bot API ----------
const base = new URL(config.bot)
const loopback = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/i.test(base.hostname)
// The token is a full login to the bot's Fog account: never send it in the clear over a network.
if (base.protocol !== 'https:' && !(base.protocol === 'http:' && loopback)) fail(`--bot must be https:// unless it's on this machine (got ${config.bot}).`)
const tokenFile = join(config.botDir ?? process.env.FOG_BOT_DIR ?? join(homedir(), '.fog-bot'), 'token')
const readToken = () => process.env.FOG_BOT_TOKEN ?? (existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8').trim() : fail(`No fog-bot token: set FOG_BOT_TOKEN or --bot-dir (looked in ${tokenFile}).`))
let token = readToken()

async function call(method: string, path: string, body?: unknown, raw?: { data: Uint8Array; type: string }): Promise<Response> {
  for (let retried = false; ; retried = true) {
    const res = await fetch(config.bot + path, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(raw ? { 'content-type': raw.type } : body ? { 'content-type': 'application/json' } : {}) },
      body: raw ? (raw.data as Uint8Array<ArrayBuffer>) : body ? JSON.stringify(body) : undefined,
    })
    if (res.status === 401 && !retried) {
      token = readToken() // `fog-bot token --rotate`
      continue
    }
    if (!res.ok) {
      const e = (await res.json().catch(() => ({}))) as { error?: string; message?: string }
      throw new Error(`${method} ${path.split('?')[0]}: ${e.message ?? e.error ?? res.status}`)
    }
    return res
  }
}
const api = async (method: string, path: string, body?: unknown, raw?: { data: Uint8Array; type: string }): Promise<any> => (await call(method, path, body, raw)).json()
const enc = encodeURIComponent

const me = await api('GET', '/v1/me').catch((e) => fail(`Can't reach fog-bot at ${config.bot}: ${e.message}. Is \`fog-bot run\` going?`))
if (flags.owner) config.owner = (await api('GET', `/v1/users/${enc(flags.owner)}`).catch(() => fail(`No Fog account ${flags.owner}.`))).id
if (!config.owner) fail('Who gets the chats? fog-telegram run --owner @you')
saveConfig()
const owner = config.owner

// ---------- state ----------
const db = new Database(join(dir, 'bridge.db'))
db.run('PRAGMA journal_mode = WAL')
// A Telegram chat (marked id) and the Fog group it's bridged to. closed: you turned it off with /close.
db.run('CREATE TABLE IF NOT EXISTS chats (tg INTEGER PRIMARY KEY, fog TEXT UNIQUE, closed INTEGER NOT NULL DEFAULT 0)')
// The same message on both sides. bot: the Fog copy was posted by the bridge (so it can edit or delete it).
db.run('CREATE TABLE IF NOT EXISTS msgs (tg INTEGER, tgmsg INTEGER, fog TEXT, fogmsg TEXT, bot INTEGER, PRIMARY KEY (tg, tgmsg))')
db.run('CREATE INDEX IF NOT EXISTS msgs_fog ON msgs (fog, fogmsg)')
db.run('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)')
// A topic in a Telegram forum group and the Fog thread it became.
db.run('CREATE TABLE IF NOT EXISTS topics (tg INTEGER, topic INTEGER, thread TEXT, PRIMARY KEY (tg, topic))')
const threadByTopic = db.query<{ thread: string }, [number, number]>('SELECT thread FROM topics WHERE tg = ? AND topic = ?')
const topicByThread = db.query<{ topic: number }, [number, string]>('SELECT topic FROM topics WHERE tg = ? AND thread = ?')
const setTopic = db.query('INSERT OR REPLACE INTO topics (tg, topic, thread) VALUES (?, ?, ?)')
const chatByTg = db.query<{ fog: string | null; closed: number }, [number]>('SELECT fog, closed FROM chats WHERE tg = ?')
const chatByFog = db.query<{ tg: number }, [string]>('SELECT tg FROM chats WHERE fog = ?')
const setChat = db.query('INSERT OR REPLACE INTO chats (tg, fog, closed) VALUES (?, ?, ?)')
const remember = db.query('INSERT OR REPLACE INTO msgs (tg, tgmsg, fog, fogmsg, bot) VALUES (?, ?, ?, ?, ?)')
const byTg = db.query<{ fog: string; fogmsg: string; bot: number }, [number, number]>('SELECT fog, fogmsg, bot FROM msgs WHERE tg = ? AND tgmsg = ?')
const byFog = db.query<{ tg: number; tgmsg: number; bot: number }, [string, string]>('SELECT tg, tgmsg, bot FROM msgs WHERE fog = ? AND fogmsg = ?')
// ponytail: msgs grows by one small row per message; prune old rows if a bridge ever gets big.
const kv = (k: string) => db.query<{ v: string }, [string]>('SELECT v FROM kv WHERE k = ?').get(k)?.v
const setKv = (k: string, v: string) => db.query('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)').run(k, v)

// ---------- Telegram ----------
const tg = telegram()
const self = await tg.start({ phone: () => fail('Not signed in to Telegram any more. Run: fog-telegram login') })
await tg.startUpdatesLoop()
const maxBytes = config.maxMb * 1024 * 1024
const isChannel = (p: Peer) => p.type === 'chat' && p.chatType === 'channel'
const tgName = (p: Peer) => (p.id === self.id ? 'Saved Messages' : p.displayName)

// Work for one chat runs in order; different chats run side by side, so a big download only holds up its own chat.
const chains = new Map<number | string, Promise<void>>()
function queue(key: number | string, what: string, f: () => Promise<unknown>) {
  const run = (chains.get(key) ?? Promise.resolve()).then(f).then(
    () => {},
    (e) => console.warn(`${what}: ${e?.message ?? e}`),
  )
  chains.set(key, run)
  void run.then(() => chains.get(key) === run && chains.delete(key))
  return run
}

// Muted on Telegram: the chat doesn't open in Fog by itself, and once it's open its messages come in silently,
// except when someone mentions or replies to you (as on Telegram). ponytail: a chat left on the account-wide
// default counts as not muted.
const muteCache = new Map<number, { muted: boolean; at: number }>()
async function muted(p: Peer) {
  const hit = muteCache.get(p.id)
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.muted
  const v = !!(await tg.getPeerDialogs(p.id).catch(() => []))[0]?.isMuted
  muteCache.set(p.id, { muted: v, at: Date.now() })
  return v
}

// One Fog group per Telegram chat, made the first time something happens there (run inside that chat's queue).
async function groupFor(p: Peer, { opening = false, before = Infinity, mention = false } = {}): Promise<string | undefined> {
  const row = chatByTg.get(p.id)
  if (row?.fog) return row.fog
  // Channels (broadcasts), muted chats and chats you closed only come in when you /open them
  // (a muted one also when someone mentions you there).
  if (!opening && (row?.closed || isChannel(p) || (!mention && (await muted(p))))) return
  const g = await api('POST', '/v1/groups', { name: `${tgName(p).slice(0, 50)} (Telegram)`, members: [owner] })
  setChat.run(p.id, g.id, 0)
  const history = config.history ? (await tg.getHistory(p, { limit: config.history }).catch(() => [])).filter((m) => !m.isService && m.id < before).reverse() : []
  await api('POST', `/v1/chats/${enc(g.id)}/messages`, {
    text: `This chat is bridged from Telegram. Telegram keeps it on its servers without end-to-end encryption, so it isn't private the way your Fog chats are. Send /close to stop bridging it.${history.length ? `\n\nThe ${history.length} messages below were sent before it was bridged.` : ''}`,
    format: 'plain',
    silent: true,
  })
  for (const m of history) await post(g.id, m, true).catch((e) => console.warn(`telegram history: ${e.message ?? e}`))
  return g.id as string
}

const KINDS: Record<string, string> = { photo: 'photo', video: 'video', voice: 'voice', audio: 'audio', document: 'file', sticker: 'sticker' }
const md = (s: string) => toMarkdown(s)
// The Telegram message as Fog Markdown, its formatting kept and everything else escaped.
function textOf(m: Message) {
  const who = (m.isOutgoing ? 'You' : m.chat.type === 'user' && m.chat.id !== self.id ? '' : m.sender.displayName).trim()
  const head = `${who ? `**${md(who)}:** ` : ''}${m.forward ? md(`[forwarded from ${m.forward.sender.displayName}] `) : ''}`
  const body = toMarkdown(m.text, m.entities as readonly Entity[])
  const text = head && /^(```|> )/.test(body) ? `${head}\n${body}` : head + body
  const note = noteFor(m)
  return note ? `${text}${text ? '\n' : ''}${md(`[${note}]`)}` : text
}
// What to say instead of the attachment, when it isn't a file Fog can show.
function noteFor(m: Message): string | undefined {
  const md = m.media as any
  if (!md || md.type === 'webpage') return // a link preview: the link is in the text
  if (md.type === 'sticker' && md.mimeType !== 'image/webp') return `sticker ${md.emoji}` // animated ones don't play in Fog
  if (KINDS[md.type]) return md.fileSize > maxBytes ? `${md.type} too big to bridge (${Math.round(md.fileSize / 1048576)} MB), open Telegram to see it` : undefined
  if (md.type === 'location' || md.type === 'live_location' || md.type === 'venue') {
    const at = md.location ?? md
    return `location: https://www.openstreetmap.org/?mlat=${at.latitude}&mlon=${at.longitude}`
  }
  if (md.type === 'poll') return `poll: ${md.question}`
  return `${md.type}, open Telegram to see it`
}
// The Telegram message as Fog text, plus its file uploaded to fog-bot when there is one.
async function toFog(m: Message): Promise<{ text: string; file_id?: string }> {
  const text = textOf(m)
  const md = m.media as any
  if (!md || noteFor(m) || !KINDS[md.type]) return { text }
  const kind = md.type === 'video' ? (md.isRound ? 'videonote' : 'video') : KINDS[md.type]!
  const data = await tg.downloadAsBuffer(md)
  const mime = md.type === 'photo' ? 'image/jpeg' : md.mimeType || 'application/octet-stream'
  const name = md.fileName ?? `${md.type}.${mime.split('/')[1]?.split(/[;+]/)[0] ?? 'bin'}`
  const q = new URLSearchParams({ name, kind, ...(md.duration ? { duration: String(md.duration) } : {}), ...(md.width ? { width: String(md.width), height: String(md.height) } : {}) })
  const { file } = await api('POST', `/v1/files?${q}`, undefined, { data, type: mime })
  return { text, file_id: file.file_id }
}

// Each topic of a Telegram forum group becomes a Fog thread, started the first time something is said in it.
const topicOf = (m: Message) => (m.isTopicMessage ? (m.replyToMessage?.threadId ?? null) : null)
async function threadFor(chat: number, fog: string, topic: number) {
  const known = threadByTopic.get(chat, topic)
  if (known) return known.thread
  const title = (await tg.getForumTopicsById(chat, topic).catch(() => []))[0]?.title || 'Topic'
  const { thread } = await api('POST', `/v1/chats/${enc(fog)}/threads`, { name: title.slice(0, 64) })
  setTopic.run(chat, topic, thread.id)
  return thread.id as string
}

async function post(fog: string, m: Message, silent: boolean) {
  if (byTg.get(m.chat.id, m.id)) return // catching up can repeat updates
  const topic = topicOf(m)
  // In a topic, "replying" to the topic itself is just being in it.
  const replyId = m.replyToMessage?.id
  const reply = replyId && replyId !== topic ? byTg.get(m.chat.id, replyId) : null
  const body = await toFog(m)
  if (!body.text && !body.file_id) return
  const r = await api('POST', `/v1/chats/${enc(fog)}/messages`, {
    ...body,
    silent,
    ...(reply ? { reply_to: reply.fogmsg } : {}),
    ...(topic ? { thread_id: await threadFor(m.chat.id, fog, topic) } : {}),
    // Mentioned or replied to on Telegram: a mention in Fog too.
    ...(m.isMention && !m.isOutgoing ? { mentions: [owner] } : {}),
  })
  remember.run(m.chat.id, m.id, fog, r.message.id, 1)
}

async function fromTelegram(m: Message) {
  if (m.isService) return serviceFromTelegram(m)
  const mention = m.isMention && !m.isOutgoing
  const fog = await groupFor(m.chat, { before: m.id, mention }) // history stops short of this message, which notifies as usual
  if (!fog) return
  // Your own messages from your other Telegram devices come in silently, and so does a muted chat.
  await post(fog, m, m.isOutgoing || (!mention && (await muted(m.chat))))
}

// Joins, leaves and renames, as a quiet line (only in chats already in Fog).
async function serviceFromTelegram(m: Message) {
  const row = chatByTg.get(m.chat.id)
  const a = m.action as any
  if (!row?.fog || !a || byTg.get(m.chat.id, m.id)) return
  const who = m.isOutgoing ? 'You' : m.sender.displayName
  const names = async (ids: number[]) => (await tg.getUsers(ids).catch(() => [])).map((u) => u?.displayName ?? 'someone').join(', ') || 'someone'
  const topic = topicOf(m)
  let text: string | undefined
  if (a.type === 'users_added') text = a.users.length === 1 && a.users[0] === m.sender.id ? `${who} joined` : `${who} added ${await names(a.users)}`
  else if (a.type === 'user_joined_link' || a.type === 'user_joined_approved') text = `${who} joined`
  else if (a.type === 'user_left') text = `${who} left`
  else if (a.type === 'user_removed') text = a.user === m.sender.id ? `${who} left` : `${who} removed ${await names([a.user])}`
  else if (a.type === 'title_changed') {
    text = `${who} renamed the group to "${a.title}"`
    await api('PATCH', `/v1/chats/${enc(row.fog)}`, { name: `${String(a.title).slice(0, 50)} (Telegram)` }).catch(() => {})
  } else if (a.type === 'topic_edited' && a.title && topic) {
    const t = threadByTopic.get(m.chat.id, topic)
    if (t) await api('PATCH', `/v1/chats/${enc(row.fog)}/threads/${enc(t.thread)}`, { name: String(a.title).slice(0, 64) }).catch(() => {})
  }
  if (!text) return
  const r = await api('POST', `/v1/chats/${enc(row.fog)}/messages`, {
    text,
    format: 'plain',
    silent: true,
    ...(topic && threadByTopic.get(m.chat.id, topic) ? { thread_id: threadByTopic.get(m.chat.id, topic)!.thread } : {}),
  })
  remember.run(m.chat.id, m.id, row.fog, r.message.id, 1)
}

async function editFromTelegram(m: Message) {
  const row = byTg.get(m.chat.id, m.id)
  if (!row?.bot || m.media?.type === 'live_location') return // a live location edits itself every few seconds
  await api('PATCH', `/v1/chats/${enc(row.fog)}/messages/${enc(row.fogmsg)}`, { text: textOf(m) })
}

function deleteFromTelegram(u: DeleteMessageUpdate) {
  // Message ids are unique per account outside channels, so a delete there doesn't say which chat.
  const rows = u.channelId
    ? u.messageIds.map((id) => ({ tg: getMarkedPeerId(u.channelId!, 'channel'), tgmsg: id }))
    : db.query<{ tg: number; tgmsg: number }, []>(`SELECT tg, tgmsg FROM msgs WHERE tg > -1000000000000 AND tgmsg IN (${u.messageIds.map(Number).join(',') || 'NULL'})`).all()
  for (const { tg: chat, tgmsg } of rows)
    queue(chat, 'telegram delete', async () => {
      const row = byTg.get(chat, tgmsg)
      if (row?.bot) await api('DELETE', `/v1/chats/${enc(row.fog)}/messages/${enc(row.fogmsg)}`).catch(() => {})
    })
}

// Telegram reactions show in Fog as the bot's own reaction: the one most people chose, not counting yours
// (yours you add in Fog). ponytail: remembered in memory only, so a restart may set one again (harmless).
const shownReaction = new Map<string, string | null>()
async function reactionFromTelegram(chat: number, msgId: number, results: { reaction: { _: string; emoticon?: string }; count: number; chosenOrder?: number }[]) {
  const row = byTg.get(chat, msgId)
  if (!row) return
  let best: string | null = null
  let most = 0
  for (const r of results) {
    const n = r.count - (r.chosenOrder === undefined ? 0 : 1)
    if (r.reaction._ === 'reactionEmoji' && r.reaction.emoticon && n > most) [best, most] = [r.reaction.emoticon, n]
  }
  const key = `${row.fog}\n${row.fogmsg}`
  if ((shownReaction.get(key) ?? null) === best) return
  shownReaction.set(key, best)
  await api('PUT', `/v1/chats/${enc(row.fog)}/messages/${enc(row.fogmsg)}/reaction`, { emoji: best })
}

// They read what you sent on Telegram: the bot marks the Fog chat read, so your messages there show as read.
async function readFromTelegram(chat: number, maxId: number) {
  const row = chatByTg.get(chat)
  const last = db.query<{ n: number | null }, [number]>('SELECT MAX(tgmsg) AS n FROM msgs WHERE tg = ? AND bot = 0').get(chat)?.n
  if (row?.fog && last != null && maxId >= last) await api('POST', `/v1/chats/${enc(row.fog)}/read`)
}

tg.onNewMessage.add((m) => queue(m.chat.id, 'telegram message', () => fromTelegram(m)))
tg.onEditMessage.add((m) => queue(m.chat.id, 'telegram edit', () => editFromTelegram(m)))
tg.onDeleteMessage.add(deleteFromTelegram)
tg.onHistoryRead.add((u) => {
  if (u.isOutbox && !u.isDiscussion) queue(u.chatId, 'telegram read', () => readFromTelegram(u.chatId, u.maxReadId))
})
tg.onRawUpdate.add(({ update: u }) => {
  if (u._ === 'updateNotifySettings') muteCache.clear() // muted or unmuted somewhere: look again
  if (u._ !== 'updateMessageReactions') return
  const chat = getMarkedPeerId(u.peer)
  queue(chat, 'telegram reaction', () => reactionFromTelegram(chat, u.msgId, u.reactions.results as any))
})

// ---------- Fog ----------
const HELP = `I bring your Telegram chats into Fog. New messages open a chat here by themselves (channels don't, so they can't flood you).

/chats  pick one of your recent Telegram chats to bring in
/open @username  bring in a chat by username, phone number or name
/close  (inside a bridged chat) stop bridging it`

async function sendDm(text: string, buttons?: unknown) {
  await api('POST', `/v1/chats/${enc(owner)}/messages`, { text, format: 'plain', ...(buttons ? { buttons } : {}) })
}

async function findPeer(q: string): Promise<Peer | undefined> {
  if (/^-?\d+$/.test(q)) return tg.getPeer(Number(q)).catch(() => undefined)
  const byHandle = await tg.getPeer(q.replace(/^@/, '')).catch(() => undefined)
  if (byHandle) return byHandle
  const want = q.toLowerCase()
  for await (const d of tg.iterDialogs({ limit: 300 })) if (tgName(d.peer).toLowerCase().includes(want)) return d.peer
}

const open = (p: Peer) =>
  queue(p.id, 'open', async () => {
    const row = chatByTg.get(p.id)
    if (row?.closed) setChat.run(p.id, null, 0)
    const fog = await groupFor(p, { opening: true })
    if (row?.fog) await api('POST', `/v1/chats/${enc(fog!)}/messages`, { text: `${tgName(p)} is already here.`, format: 'plain' })
  })

async function control(e: any) {
  if (e.type === 'button' && String(e.data).startsWith('open:')) {
    const p = await findPeer(String(e.data).slice(5))
    await api('POST', `/v1/buttons/${enc(e.query_id)}/answer`, { text: p ? `Opening ${tgName(p)}` : 'That chat is gone.' })
    if (p) await open(p)
    return
  }
  if (e.type !== 'message') return
  const text: string = e.message.text?.trim() ?? ''
  if (text === '/chats') {
    const rows = []
    for await (const d of tg.iterDialogs({ limit: 10 })) rows.push([{ text: tgName(d.peer).slice(0, 60), data: `open:${d.peer.id}` }])
    return sendDm('Pick a Telegram chat to bring into Fog:', rows)
  }
  const m = text.match(/^\/open\s+(.+)/)
  if (m) {
    const p = await findPeer(m[1]!.trim())
    return p ? open(p) : sendDm(`No Telegram chat matches "${m[1]}".`)
  }
  return sendDm(HELP)
}

const fogFile = async (id: string) => new Uint8Array(await (await call('GET', `/v1/files/${enc(id)}`)).arrayBuffer())

async function toTelegram(chat: number, fog: string, msg: any) {
  if (msg.text?.trim() === '/close') {
    setChat.run(chat, null, 1)
    db.query('DELETE FROM msgs WHERE tg = ?').run(chat)
    db.query('DELETE FROM topics WHERE tg = ?').run(chat)
    await api('POST', `/v1/chats/${enc(fog)}/messages`, { text: 'Stopped bridging. Send /open in my chat to bring it back.', format: 'plain' })
    await api('POST', `/v1/chats/${enc(fog)}/leave`)
    return
  }
  const reply = msg.reply_to ? byFog.get(fog, msg.reply_to.id) : null
  // In a thread that's a Telegram topic, a message goes to that topic.
  const topic = msg.thread?.id ? topicByThread.get(chat, msg.thread.id)?.topic : undefined
  const replyTo = reply?.tgmsg ?? topic
  const params = replyTo ? { replyTo } : {}
  const a = msg.attachment
  let sent
  if (a) {
    if (a.size > maxBytes) return api('POST', `/v1/chats/${enc(fog)}/messages`, { text: `That file is over ${config.maxMb} MB, so it didn't go to Telegram.`, format: 'plain', reply_to: msg.id })
    const file = await fogFile(a.file_id)
    const meta = { caption: msg.text ?? '', fileName: a.name, fileMime: a.mime, ...(a.duration ? { duration: a.duration } : {}), ...(a.width ? { width: a.width, height: a.height } : {}) }
    const media =
      a.kind === 'photo' ? InputMedia.photo(file, meta)
      : a.kind === 'video' || a.kind === 'videonote' ? InputMedia.video(file, { ...meta, isRound: a.kind === 'videonote' })
      : a.kind === 'voice' ? InputMedia.voice(file, meta)
      : a.kind === 'audio' ? InputMedia.audio(file, meta)
      : InputMedia.document(file, meta)
    sent = await tg.sendMedia(chat, media, params)
  } else if (msg.text) sent = await tg.sendText(chat, msg.text, params)
  if (!sent) return
  remember.run(chat, sent.id, fog, msg.id, 0)
  await tg.readHistory(chat).catch(() => {}) // you answered, so you've read it (as Telegram's own apps do)
}

async function fromFog(e: any) {
  const from = e.message?.from?.id ?? e.from?.id
  const chat: string | undefined = e.message?.chat?.id ?? e.chat?.id
  if (!chat) return
  if (e.type === 'chat') {
    // You left or deleted the group: stop bridging that chat rather than talk to an empty room.
    const row = chatByFog.get(chat)
    const info = row && (await api('GET', `/v1/chats/${enc(chat)}`).catch(() => null))
    if (row && info && !info.members?.some((u: any) => u.id === owner)) {
      setChat.run(row.tg, null, 1)
      await api('POST', `/v1/chats/${enc(chat)}/leave`).catch(() => {})
    }
    return
  }
  if (from !== owner) return // only you drive the bridge
  if (chat === owner) return control(e)
  const row = chatByFog.get(chat)
  if (!row) return
  if (e.type === 'message') return toTelegram(row.tg, chat, e.message)
  if (e.type === 'read') {
    // You read it in Fog (with read receipts on): mark it read on Telegram up to there.
    const ids: number[] = (e.message_ids ?? []).map((id: string) => byFog.get(chat, id)?.tgmsg ?? 0)
    const maxId = Math.max(0, ...ids)
    if (maxId) await tg.readHistory(row.tg, { maxId })
    return
  }
  const link = byFog.get(chat, e.message?.id ?? e.message_id)
  if (!link) return
  // Edits and deletes only for what you sent: in a Telegram DM you could otherwise delete their messages for both.
  if (link.bot && e.type !== 'reaction') return
  if (e.type === 'edited') await tg.editMessage({ chatId: link.tg, message: link.tgmsg, text: e.message.text })
  else if (e.type === 'deleted') await tg.deleteMessagesById(link.tg, [link.tgmsg], { revoke: true })
  else if (e.type === 'reaction') await tg.sendReaction({ chatId: link.tg, message: link.tgmsg, emoji: e.emoji })
}

console.log(`fog-telegram ${VERSION}: Telegram ${self.displayName} <-> Fog @${me.username ?? me.id}. Message the bot /chats in Fog to bring chats in.`)
let offset = Number(kv('offset') ?? 0)
for (;;) {
  try {
    const { events, next } = await api('GET', `/v1/events?offset=${offset}&timeout=30`)
    // In order within a chat, chats side by side. ponytail: the next batch waits for this one (offset = done).
    await Promise.all(events.map((e: any) => queue(`fog:${e.message?.chat?.id ?? e.chat?.id}`, `fog ${e.type}`, () => fromFog(e))))
    offset = next
    setKv('offset', String(next))
  } catch (e) {
    console.warn(`fog-bot: ${(e as Error).message}`)
    await Bun.sleep(5000)
  }
}
