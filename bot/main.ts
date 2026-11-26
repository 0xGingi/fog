#!/usr/bin/env bun
// fog-bot: run a Fog account as a bot. It holds the account's keys, does the end-to-end encryption
// with the app's own engine (web/src/fog.ts), and gives your bot a plain HTTP API on this machine.
// The Fog server sees an ordinary account; it never learns that it's a bot or what it says.
import { mkdirSync, existsSync, readFileSync, writeFileSync, chmodSync, watch, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
// The crypto core, embedded in the binary by `bun build --compile`.
import wasmPath from '../web/src/core/fog_core_bg.wasm' with { type: 'file' }

const VERSION = '0.4.1'
const USAGE = `fog-bot ${VERSION}: run a Fog account as a bot, with a local HTTP API.

  fog-bot init [--server URL] [--username NAME] [--name "Display name"] [--owner @you] [--restore]
      Create the bot's account (or --restore one from its recovery phrase, read from stdin).
      --owner: only this person (and anyone added with \`fog-bot allow\`) can reach the bot.
  fog-bot run [--port 8790] [--host 127.0.0.1] [--allow @you,@them]
      Connect and serve the API (see the README for the endpoints).
  fog-bot allow [--add @x,ID] [--remove @x,ID] [--set @x,ID] [--clear]
      Who the bot talks to. Anyone else can't reach it: their messages stay unanswered
      requests and never show up in the API. With an empty list, anyone can.
      Works while \`fog-bot run\` is running: it picks up the change within a second.
  fog-bot token [--rotate]
      Print the API token (or replace it).
  fog-bot info
      The bot's account id, username and invite link.

  --dir DIR   where the bot keeps its keys and messages (default: $FOG_BOT_DIR or ~/.fog-bot)
`

// ---------- arguments and config ----------
const [cmd = 'help', ...rest] = process.argv.slice(2)
const flags: Record<string, string | true> = {}
for (let i = 0; i < rest.length; i++) {
  const a = rest[i]
  if (!a.startsWith('--')) continue
  const next = rest[i + 1]
  flags[a.slice(2)] = next !== undefined && !next.startsWith('--') ? (i++, next) : true
}
const flag = (k: string) => (typeof flags[k] === 'string' ? (flags[k] as string) : undefined)
const dir = flag('dir') ?? process.env.FOG_BOT_DIR ?? join(homedir(), '.fog-bot')
/** `allow`: account ids the bot talks to (empty: anyone). Usernames are looked up once, when added. */
type Config = { server: string; port: number; host: string; accept: 'all' | 'none'; allow: string[] }
/** A change to the allowlist, from `fog-bot allow` to the running bot. */
type AllowChange = { id: string; clear?: boolean; set?: string[]; add?: string[]; remove?: string[] }
const configPath = join(dir, 'config.json')
const config: Config = { server: 'https://getfog.org', port: 8790, host: '127.0.0.1', accept: 'all', allow: [], ...(existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {}) }
if (flag('server')) config.server = flag('server')!.replace(/\/+$/, '')
if (flag('port')) config.port = Number(flag('port'))
if (flag('host')) config.host = flag('host')!
if (flag('accept') === 'all' || flag('accept') === 'none') config.accept = flag('accept') as Config['accept']
/** Write a file whole (temp file, then rename), so a reader never sees half of it. */
const writeAtomic = (path: string, text: string) => {
  writeFileSync(`${path}.tmp`, text, { mode: 0o600 })
  renameSync(`${path}.tmp`, path)
}
const saveConfig = () => writeAtomic(configPath, JSON.stringify(config, null, 2) + '\n')
const tokenPath = join(dir, 'token')
const newToken = () => {
  const t = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')
  writeAtomic(tokenPath, t + '\n')
  return t
}
const token = () => (existsSync(tokenPath) ? readFileSync(tokenPath, 'utf8').trim() : newToken())

if (cmd === 'help' || cmd === '--help' || cmd === '-h' || !['init', 'run', 'token', 'info', 'allow'].includes(cmd)) {
  console.log(USAGE)
  process.exit(cmd === 'help' || cmd === '--help' || cmd === '-h' ? 0 : 2)
}
mkdirSync(dir, { recursive: true, mode: 0o700 })
chmodSync(dir, 0o700)
if (cmd === 'token') {
  // A running fog-bot watches this file: the old token stops working as soon as it's replaced.
  console.log(flags.rotate ? newToken() : token())
  process.exit(0)
}

// `allow` while the bot is running: edit the list in config.json, and the running bot (which watches it)
// looks up any @usernames and saves their account ids. Until then a username matches nobody.
const runningPid = (() => {
  if (!existsSync(join(dir, 'fog.db'))) return null
  try {
    const { Database } = require('bun:sqlite') as typeof import('bun:sqlite')
    const db = new Database(join(dir, 'fog.db'), { readonly: true })
    const pid = db.query<{ pid: number }, []>('SELECT pid FROM lock').get()?.pid ?? null
    db.close()
    return pid && pid !== process.pid && isAlive(pid) ? pid : null
  } catch {
    return null
  }
})()
// The running bot does the change (it can look up @usernames) and answers in allow-result.json. All or
// nothing: if any name doesn't resolve, the list stays as it was.
if (cmd === 'allow' && runningPid) {
  const list = (k: string) => (flag(k) ?? '').split(/[\s,]+/).filter(Boolean)
  const req: AllowChange = { id: crypto.randomUUID(), clear: !!flags.clear, set: flag('set') !== undefined ? list('set') : undefined, add: list('add'), remove: list('remove') }
  if (req.clear || req.set || req.add?.length || req.remove?.length) {
    writeAtomic(join(dir, 'allow-request.json'), JSON.stringify(req))
    let res: { id: string; ok: boolean; error?: string; allow?: string[] } | null = null
    for (let i = 0; i < 150 && res?.id !== req.id; i++) {
      await Bun.sleep(100)
      try {
        res = JSON.parse(readFileSync(join(dir, 'allow-result.json'), 'utf8'))
      } catch {}
    }
    if (res?.id !== req.id) fail(`The running bot (pid ${runningPid}) didn't answer. Nothing changed; is it connected?`)
    if (!res.ok) fail(`Nothing changed: ${res.error}`)
    config.allow = res.allow ?? []
    console.log('Saved; the running bot uses it now.')
  }
  console.log(config.allow.length ? `The bot talks only to:\n${config.allow.map((e) => `  ${e}`).join('\n')}` : 'Anyone can message the bot (no allowlist).')
  process.exit(0)
}

// ---------- the engine ----------
process.env.FOG_SERVER = config.server
await import('./shim')
const { openStore } = await import('./store')
const { useStore } = await import('../web/src/db')
const store = openStore(dir)
useStore(store)
// One process per account: two would advance the same encryption ratchets and break them.
store.db.run('CREATE TABLE IF NOT EXISTS lock (pid INTEGER)')
const other = store.db.query<{ pid: number }, []>('SELECT pid FROM lock').get()
if (other && other.pid !== process.pid && isAlive(other.pid)) {
  console.error(`fog-bot is already running for ${dir} (pid ${other.pid}).`)
  process.exit(1)
}
store.db.run('DELETE FROM lock')
store.db.run('INSERT INTO lock (pid) VALUES (?)', [process.pid])
function isAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const core = await import('../web/src/core/fog_core.js')
await core.default({ module_or_path: await Bun.file(wasmPath).arrayBuffer() })
const fog = await import('../web/src/fog')
const media = await import('../web/src/media')
await fog.boot()

// ---------- who the bot talks to ----------
const ID = /^[A-Za-z0-9_-]{43}$/
const EMPTY = 'Nothing changed: that would leave the allowlist empty, which lets anyone message the bot. Use --clear if you mean that.'
/** Account ids for a list of @usernames / ids / invite links. Looked up now, so later the server can't swap who a name means. */
async function lookup(list: string, die: (msg: string) => never = fail) {
  await fog.waitOnline()
  const ids: string[] = []
  for (const raw of list.split(/[\s,]+/).filter(Boolean)) {
    const p = await fog.findPeer(raw).catch(() => die(`No Fog account ${raw}.`))
    if (p.id === fog.getState().me?.id) die(`${raw} is the bot itself.`)
    console.log(`  ${raw} → ${p.id}${p.username ? ` (@${p.username})` : ''}`)
    ids.push(p.id)
  }
  if (!ids.length) die('No accounts given.')
  return ids
}
const showAllow = () =>
  console.log(
    config.allow.length
      ? `The bot talks only to:\n${config.allow.map((id) => `  ${id}${fog.getState().people[id]?.username ? ` (@${fog.getState().people[id]?.username})` : ''}`).join('\n')}`
      : 'Anyone can message the bot (no allowlist). Set one with: fog-bot allow --add @you',
  )

if (cmd === 'init') await init()
if (cmd === 'info' || cmd === 'allow') {
  const me = fog.getState().me
  if (!me) fail('No account yet: run `fog-bot init` first.')
  await fog.waitOnline()
  if (cmd === 'info') console.log(`account: ${me.id}\nusername: ${fog.getState().me?.username ? '@' + fog.getState().me?.username : '(none)'}\ninvite: ${fog.inviteLink()}`)
  if (cmd === 'allow') {
    if (flags.clear) config.allow = []
    if (flag('set')) config.allow = await lookup(flag('set')!)
    if (flag('add')) config.allow = [...new Set([...config.allow, ...(await lookup(flag('add')!))])]
    if (flag('remove')) {
      const gone = await lookup(flag('remove')!)
      config.allow = config.allow.filter((id) => !gone.includes(id))
    }
    if (!config.allow.length && !flags.clear) fail(EMPTY)
    if (flags.clear || flag('set') || flag('add') || flag('remove')) (saveConfig(), console.log('Saved. Restart fog-bot run if it\'s running.'))
  }
  showAllow()
  process.exit(0)
}

function fail(msg: string): never {
  console.error(msg)
  process.exit(1)
}

async function init() {
  if (fog.getState().me) fail(`There's already an account in ${dir}. Use another --dir for another bot.`)
  let phrase = fog.newPhrase()
  if (flags.restore) {
    phrase = (await Bun.stdin.text()).trim().replace(/\s+/g, ' ')
    if (!fog.validPhrase(phrase)) fail("That isn't a valid recovery phrase.")
  }
  saveConfig()
  console.log(`Creating the bot's account on ${config.server}…`)
  await fog.createAccount(phrase)
  const name = flag('name')
  if (name) fog.setProfile({ name: name.slice(0, 64) })
  const username = flag('username')?.replace(/^@/, '').toLowerCase()
  if (username) {
    const ok = await fog.checkUsername(username)
    if (ok !== 'available') console.error(`Username @${username} is ${ok}; the bot has none for now.`)
    else await fog.claimUsername(username)
  } else fog.skipUsername()
  // A bad --owner mustn't stop init before the recovery phrase is shown: warn, and leave the list empty.
  if (flag('owner'))
    try {
      config.allow = await lookup(flag('owner')!, (msg) => {
        throw new Error(msg)
      })
      saveConfig()
    } catch (e) {
      console.error(`\n${(e as Error).message} The bot has no allowlist yet: set one with fog-bot allow --add @you`)
    }
  await Bun.sleep(500) // let the profile and username settle
  console.log(`
Done. The bot's account id is ${fog.getState().me!.id}${fog.getState().me?.username ? ` (@${fog.getState().me?.username})` : ''}.
Invite link: ${fog.inviteLink()}
${flags.restore ? '' : `
Recovery phrase (the only way to get this account back; keep it somewhere safe):
  ${phrase}
`}
API token (also in ${tokenPath}):
  ${token()}

${config.allow.length ? `Only ${flag('owner')} can reach it (add people with: fog-bot allow --add @them).` : 'Anyone can message it. To keep it to yourself: fog-bot allow --add @you'}
Start it with: fog-bot run`)
  process.exit(0)
}

// ---------- run: events ----------
if (!fog.getState().me) fail('No account yet: run `fog-bot init` first.')
store.db.run('CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, ev TEXT NOT NULL, at INTEGER NOT NULL)')
store.db.run('CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, att TEXT NOT NULL)')
const insertEvent = store.db.query('INSERT INTO events (ev, at) VALUES (?, ?)')
const waiting = new Set<() => void>()
type Ev = Record<string, unknown> & { type: string }
function emit(ev: Ev) {
  insertEvent.run(JSON.stringify({ ...ev, date: Date.now() }), Date.now())
  waiting.forEach((w) => w())
}
// Events nobody collected in a week are dropped (like the server's own queue).
setInterval(() => store.db.run('DELETE FROM events WHERE at < ?', [Date.now() - 7 * 86400_000]), 3600_000)

type Msg = ReturnType<typeof fog.getState>['chats'][string]['messages'][number]
type Att = NonNullable<Msg['att']>
const rememberFile = store.db.query('INSERT OR REPLACE INTO files (id, att) VALUES (?, ?)')
const fileAtt = (id: string) => {
  const r = store.db.query<{ att: string }, [string]>('SELECT att FROM files WHERE id = ?').get(id)
  return r ? (JSON.parse(r.att) as Att) : undefined
}

const people = () => fog.getState().people
function user(id: string) {
  const me = fog.getState().me!
  if (id === me.id) return { id, username: me.username, name: fog.getState().profile.name || null, is_bot: true }
  const p = people()[id]
  return { id, username: p?.username ?? null, name: p?.name ?? null, is_bot: !!p?.bot }
}
function chatInfo(id: string) {
  const c = fog.getState().chats[id]
  const group = c?.group
  return {
    id,
    type: group ? 'group' : 'dm',
    title: c ? fog.chatTitle(c) : fog.personName(id),
    ...(group ? { owner: group.owner, members: group.members.filter((m) => !group.gone?.includes(m)).map(user), left: !!group.left } : {}),
    ...(c?.pins?.length ? { pinned: c.pins } : {}),
  }
}
/** `{thread}` for a message that's in one (deleted messages: remembered from when they were seen). */
const msgThreads = new Map<string, string>()
function threadAt(chat: string, id: string) {
  const th = fog.getState().chats[chat]?.messages.find((m) => m.id === id)?.th ?? msgThreads.get(id)
  return th ? { thread: thread(chat, th) } : {}
}
function thread(chat: string, id: string) {
  const t = fog.getState().chats[chat]?.threads?.[id]
  return { id, name: t?.name ?? 'Thread', ...(t?.root ? { message_id: t.root } : {}), ...(t?.by ? { by: user(t.by) } : {}) }
}
function file(att: Att) {
  rememberFile.run(att.lid, JSON.stringify(att))
  return { file_id: att.lid, kind: att.kind, mime: att.mime, name: att.name, size: att.size, width: att.w, height: att.h, duration: att.dur }
}
function message(chat: string, m: Msg) {
  const c = fog.getState().chats[chat]
  const me = fog.getState().me!.id
  const from = m.mine ? me : (m.from ?? chat)
  const reply = m.reply ? c?.messages.find((x) => x.id === m.reply) : undefined
  return {
    id: m.id,
    chat: { id: chat, type: c?.group ? 'group' : 'dm', title: c ? fog.chatTitle(c) : fog.personName(chat) },
    from: user(from),
    date: m.ts,
    text: m.text,
    ...(m.mine && m.status ? { status: m.status === 'failed' ? 'queued' : m.status } : {}),
    ...(m.sys ? { system: m.sys } : {}),
    ...(m.reply ? { reply_to: { id: m.reply, ...(reply ? { text: reply.text, from: user(reply.mine ? me : (reply.from ?? chat)) } : {}) } } : {}),
    ...(m.men?.length ? { mentions: m.men.map(user), mentions_me: m.men.includes(me) } : {}),
    ...(m.att ? { attachment: file(m.att) } : {}),
    ...(m.poll ? { poll: { question: m.poll.q, options: m.poll.o, multiple: !!m.poll.multi } } : {}),
    ...(m.fwd ? { forwarded: true } : {}),
    ...(m.edited ? { edited: true } : {}),
    ...(m.only ? { only_me: true } : {}),
    ...(m.th ? (msgThreads.set(m.id, m.th), { thread: thread(chat, m.th) }) : {}),
    ...(m.re && Object.keys(m.re).length ? { reactions: Object.entries(m.re).map(([who, emoji]) => ({ from: user(who === 'me' ? me : who), emoji })) } : {}),
  }
}

// A streamed reply the bot stopped updating (it crashed mid-answer) is finished after 2 minutes,
// so it doesn't show as still being written forever.
const liveSince = new Map<string, number>()
const touchLive = (chat: string, id: string, live: boolean) => (live ? liveSince.set(`${chat}\n${id}`, Date.now()) : liveSince.delete(`${chat}\n${id}`))
setInterval(() => {
  for (const [k, at] of liveSince) {
    if (Date.now() - at < 120_000) continue
    liveSince.delete(k)
    const [chat, id] = k.split('\n')
    const m = fog.getState().chats[chat]?.messages.find((x) => x.id === id)
    if (m?.live) fog.editMessage(chat, id, m.text, { live: false }).catch(() => {})
  }
}, 30_000)

// Queries waiting for an answer from the bot (button taps, autocomplete), by query id.
const queries = new Map<string, { chat: string; from: string; msg?: string; at: number }>()
setInterval(() => queries.forEach((q, k) => Date.now() - q.at > 15 * 60_000 && queries.delete(k)), 60_000)

if (flag('allow')) {
  config.allow = await lookup(flag('allow')!)
  saveConfig()
}
const me0 = fog.getState().me!.id
// Changes while running, without a restart: `fog-bot allow` (allow-request.json), an edit to config.json,
// and `fog-bot token --rotate` (the old token stops working right away).
const debounce = new Map<string, ReturnType<typeof setTimeout>>()
watch(dir, (_, file) => {
  if (file !== 'allow-request.json' && file !== 'config.json' && file !== 'token') return
  clearTimeout(debounce.get(file))
  debounce.set(
    file,
    setTimeout(() => {
      const run = file === 'token' ? reloadToken : file === 'config.json' ? reloadConfig : applyAllowChange
      void Promise.resolve(run()).catch((e) => console.error(`${file}:`, (e as Error).message))
    }, 200),
  )
})
function reloadToken() {
  const t = existsSync(tokenPath) ? readFileSync(tokenPath, 'utf8').trim() : ''
  if (t.length >= 32 && t !== TOKEN) (TOKEN = t), console.log('API token replaced; the old one no longer works.')
}
/** Account ids for these entries (@usernames looked up now). Throws, naming them, if any don't resolve. */
async function resolveAll(entries: string[]) {
  const ids: string[] = []
  const bad: string[] = []
  for (const e of entries) {
    if (ID.test(e)) {
      ids.push(e)
      continue
    }
    const p = await fog.findPeer(e).catch(() => null)
    if (p && p.id !== me0) ids.push(p.id)
    else bad.push(e)
  }
  if (bad.length) throw new Error(`no Fog account ${bad.join(', ')}`)
  return ids
}
function useAllow(next: string[]) {
  if (JSON.stringify(next) === JSON.stringify(config.allow)) return
  config.allow = next
  console.log(next.length ? `allowlist: now ${next.length} ${next.length === 1 ? 'person' : 'people'}` : 'allowlist: cleared; anyone can message the bot')
  // People just added may be waiting as requests; people just removed go back to being requests.
  for (const c of Object.values(fog.getState().chats)) accept(c.id)
}
async function applyAllowChange() {
  const path = join(dir, 'allow-request.json')
  if (!existsSync(path)) return
  const req: AllowChange = JSON.parse(readFileSync(path, 'utf8'))
  rmSync(path, { force: true })
  const answer = (r: object) => writeAtomic(join(dir, 'allow-result.json'), JSON.stringify({ id: req.id, ...r }))
  try {
    let next = req.clear ? [] : req.set ? await resolveAll(req.set) : [...config.allow]
    next = [...new Set([...next, ...(await resolveAll(req.add ?? []))])]
    const gone = await resolveAll(req.remove ?? [])
    next = next.filter((id) => !gone.includes(id))
    if (!next.length && !req.clear) throw new Error(EMPTY.replace('Nothing changed: ', ''))
    const disk = JSON.parse(readFileSync(configPath, 'utf8'))
    writeAtomic(configPath, JSON.stringify({ ...disk, allow: next }, null, 2) + '\n')
    useAllow(next)
    answer({ ok: true, allow: next })
  } catch (e) {
    console.warn(`allowlist change refused, list unchanged: ${(e as Error).message}`)
    answer({ ok: false, error: (e as Error).message })
  }
}
/** config.json edited by hand: use its list if every entry resolves; otherwise keep the current one. */
async function reloadConfig() {
  const disk = JSON.parse(readFileSync(configPath, 'utf8'))
  const entries: string[] = Array.isArray(disk.allow) ? disk.allow : []
  try {
    const next = [...new Set(await resolveAll(entries))]
    // Usernames are saved as the account ids they pointed to just now.
    if (entries.some((e) => !ID.test(e))) writeAtomic(configPath, JSON.stringify({ ...disk, allow: next }, null, 2) + '\n')
    useAllow(next)
  } catch (e) {
    console.warn(`config.json allowlist not used, keeping the current one: ${(e as Error).message}`)
  }
}
/** Someone the bot talks to (everyone, without an allowlist). */
const allowed = (id: string) => !config.allow.length || id === me0 || config.allow.includes(id)
/** A chat the bot is in for someone allowed: a DM with them, or a group one of them owns (they're who adds members). */
const chatAllowed = (chat: string) => {
  const c = fog.getState().chats[chat]
  return !config.allow.length || (!!c && !fog.isLocalChat(chat) && (c.group ? allowed(c.group.owner) : allowed(chat)))
}
// Anyone else's request stays a request: no receipts, no profile, nothing reaches the API. And someone
// taken off the list goes back to being one, so they stop getting receipts that show the bot is online.
const accept = (chat: string) => {
  if (fog.isLocalChat(chat)) return
  if (!chatAllowed(chat)) return fog.unaccept(chat)
  if (config.accept === 'all' && fog.getState().chats[chat]?.request) fog.acceptRequest(chat)
}
/** Only events from allowed people, in chats the bot accepted for them. */
const shown = (chat: string, from: string) => allowed(from) && chatAllowed(chat) && !fog.getState().chats[chat]?.request
fog.setBotHooks({
  message(chat, m, from) {
    accept(chat)
    if (!shown(chat, from)) return
    emit({ type: 'message', message: message(chat, { ...m, from }) })
  },
  edited(chat, m, from) {
    if (!shown(chat, from)) return
    emit({ type: 'edited', message: message(chat, { ...m, from }) })
  },
  deleted(chat, id, from) {
    if (!shown(chat, from)) return
    emit({ type: 'deleted', chat: chatInfo(chat), message_id: id, from: user(from), ...threadAt(chat, id) })
  },
  reaction(chat, id, from, emoji) {
    if (!shown(chat, from)) return
    emit({ type: 'reaction', chat: chatInfo(chat), message_id: id, from: user(from), emoji, ...threadAt(chat, id) })
  },
  button(e) {
    if (!shown(e.chat, e.from)) return
    queries.set(e.q, { chat: e.chat, from: e.from, msg: e.msg, at: Date.now() })
    emit({ type: 'button', query_id: e.q, chat: chatInfo(e.chat), message_id: e.msg, from: user(e.from), data: e.data, ...threadAt(e.chat, e.msg), ...(e.values ? { values: e.values } : {}), ...(e.fields ? { fields: e.fields } : {}) })
  },
  autocomplete(e) {
    if (!shown(e.chat, e.from)) return
    queries.set(e.q, { chat: e.chat, from: e.from, at: Date.now() })
    emit({ type: 'autocomplete', query_id: e.q, chat: chatInfo(e.chat), from: user(e.from), command: e.cmd, option: e.opt, value: e.val, args: e.args })
  },
  group(chat) {
    accept(chat)
    if (!chatAllowed(chat) || fog.getState().chats[chat]?.request) return
    emit({ type: 'chat', chat: chatInfo(chat) })
  },
  thread(chat, t, from, created) {
    if (!shown(chat, from)) return
    emit({ type: 'thread', chat: chatInfo(chat), thread: thread(chat, t.id), from: user(from), created })
  },
})
// Requests that arrived while the bot was stopped.
for (const c of Object.values(fog.getState().chats)) accept(c.id)

// ---------- run: the API ----------
let TOKEN = token()
class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message?: string,
  ) {
    super(message ?? code)
  }
}
const bad = (code: string, message?: string) => new HttpError(400, code, message)
const json = (v: unknown, status = 200) => Response.json(v, { status })

/** A chat by account id, group id, @username or invite link. A person we've never talked to gets a new chat. */
async function resolveChat(raw: string, create = false) {
  const id = decodeURIComponent(raw)
  const chats = fog.getState().chats
  const notAllowed = () => new HttpError(403, 'not_allowed', 'not on the bot\'s allowlist (see `fog-bot allow`)')
  if (chats[id]) {
    if (!chatAllowed(id)) throw notAllowed()
    return id
  }
  if (id.startsWith('g:')) throw new HttpError(404, 'chat_not_found')
  if (!create) {
    if (/^[A-Za-z0-9_-]{43}$/.test(id)) throw new HttpError(404, 'chat_not_found')
  }
  const peer = await fog.findPeer(id).catch(() => {
    throw new HttpError(404, 'user_not_found')
  })
  if (!allowed(peer.id)) throw notAllowed()
  if (!create && !chats[peer.id]) throw new HttpError(404, 'chat_not_found')
  if (!chats[peer.id]) fog.startChat(peer.id)
  return peer.id
}
const findMsg = (chat: string, id: string) => {
  const m = fog.getState().chats[chat]?.messages.find((x) => x.id === decodeURIComponent(id))
  if (!m) throw new HttpError(404, 'message_not_found')
  return m
}

type Body = Record<string, any>
async function body(req: Request): Promise<Body> {
  try {
    const b = await req.json()
    return b && typeof b === 'object' ? b : {}
  } catch {
    throw bad('invalid_json')
  }
}

/** API rows of buttons/dropdowns → wire rows. */
function rows(v: unknown): import('../web/src/fog').Row[] | undefined {
  if (v === undefined || v === null) return undefined
  if (!Array.isArray(v)) throw bad('invalid_buttons', 'buttons must be a list of rows')
  return v.map((r: any) => {
    if (Array.isArray(r)) return r.map((b: any) => ({ l: String(b.text ?? ''), ...(b.url ? { u: String(b.url) } : { d: String(b.data ?? b.text ?? '') }), ...(b.style ? { s: b.style } : {}) }))
    if (r && typeof r === 'object' && r.select) {
      const s = r.select
      return { sel: String(s.id), ph: s.placeholder, min: s.min, max: s.max, o: (s.options ?? []).map((o: any) => ({ l: String(o.label), v: String(o.value), d: o.description, on: o.default })) }
    }
    throw bad('invalid_buttons', 'each row is a list of buttons or {select: …}')
  })
}
const card = (v: any) => (v === undefined ? undefined : v === null ? null : { title: v.title, color: v.color, footer: v.footer })
function cmds(list: any[]): import('../web/src/fog').BotCmd[] {
  if (!Array.isArray(list)) throw bad('invalid_commands')
  if (list.length > 100) throw bad('too_many_commands', 'up to 100 commands')
  const name = /^[a-z0-9_-]{1,32}$/
  for (const c of list) {
    if (!name.test(String(c?.name ?? '').replace(/^\//, '').toLowerCase())) throw bad('invalid_command_name', `command names are 1-32 of a-z 0-9 _ - (got ${JSON.stringify(c?.name)})`)
    if (Array.isArray(c.options) && (c.options.length > 25 || c.options.some((o: any) => !name.test(String(o?.name ?? '').toLowerCase())))) throw bad('invalid_command_options', `options: up to 25, names like command names (${c.name})`)
  }
  return list.map((c) => ({
    n: String(c.name).replace(/^\//, '').toLowerCase(),
    d: String(c.description ?? ''),
    o: Array.isArray(c.options) ? c.options.map((o: any) => ({ n: String(o.name).toLowerCase(), d: String(o.description ?? ''), req: !!o.required, auto: !!o.autocomplete, ch: Array.isArray(o.choices) ? o.choices.map((x: any) => ({ l: String(x.label ?? x.value), v: String(x.value) })) : undefined })) : undefined,
  }))
}

/** Wait for a sent message to leave "sending". */
async function settled(chat: string, id: string) {
  for (let i = 0; i < 600; i++) {
    const m = fog.getState().chats[chat]?.messages.find((x) => x.id === id)
    if (!m || m.status !== 'sending') return m
    await Bun.sleep(100)
  }
}

async function send(chat: string, b: Body) {
  const text = typeof b.text === 'string' ? b.text : ''
  if (text.length > 65536) throw bad('text_too_long', 'text can be up to 65536 characters')
  const files: string[] = b.file_id ? [b.file_id] : Array.isArray(b.file_ids) ? b.file_ids : []
  const atts = files.map((f) => fileAtt(String(f)) ?? (() => { throw bad('unknown_file', `no file ${f}: upload it to /v1/files first`) })())
  if (!text && !atts.length && !b.poll) throw bad('empty_message')
  // In a DM everything is already only for them.
  if (!fog.getState().chats[chat]?.group) delete b.only_to
  if (b.thread_id && !fog.getState().chats[chat]?.threads?.[b.thread_id]) throw new HttpError(404, 'thread_not_found')
  const opts: import('../web/src/fog').SendOpts = {
    reply: b.reply_to,
    md: b.format !== 'plain',
    kb: rows(b.buttons),
    card: card(b.card) ?? undefined,
    live: !!b.live,
    quiet: !!b.silent,
    only: b.only_to,
    th: b.thread_id,
    men: Array.isArray(b.mentions) ? b.mentions : undefined,
    poll: b.poll ? { q: String(b.poll.question), o: (b.poll.options ?? []).map(String), multi: !!b.poll.multiple } : undefined,
  }
  const ids: string[] = []
  const markLive = () => opts.live && ids[0] && touchLive(chat, ids[0], true)
  // One attachment per message: the caption and buttons go on the first.
  for (const [i, att] of (atts.length ? atts : [undefined]).entries()) {
    const id = await fog.sendMessage(chat, i === 0 ? text : '', i === 0 ? { ...opts, att } : { att, quiet: opts.quiet, only: opts.only, th: opts.th })
    ids.push(id)
  }
  markLive()
  const sent = await Promise.all(ids.map((id) => settled(chat, id)))
  // Not delivered yet (offline, or the other side unreachable): it's kept and resent on reconnect.
  const queued = sent.some((m) => m?.status === 'failed')
  return json({ message: message(chat, sent[0]!), ...(ids.length > 1 ? { messages: sent.map((m) => message(chat, m!)) } : {}), ...(queued ? { queued: true } : {}) }, queued ? 202 : 200)
}

async function upload(req: Request, url: URL) {
  const kinds = ['photo', 'video', 'audio', 'voice', 'file', 'sticker', 'videonote'] as const
  const mime = (req.headers.get('content-type') ?? 'application/octet-stream').split(';')[0].trim().toLowerCase()
  let data = new Uint8Array(await req.arrayBuffer())
  if (!data.length) throw bad('empty_file')
  if (data.length > media.MAX_FILE) throw new HttpError(413, 'file_too_large', 'files can be up to 2 GB')
  const q = (k: string) => url.searchParams.get(k) ?? undefined
  const guess = mime.startsWith('image/') ? 'photo' : mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : 'file'
  const kind = (kinds as readonly string[]).includes(q('kind') ?? '') ? (q('kind') as Att['kind']) : guess
  const { imageSize, stripJpegMeta } = await import('./media')
  if (mime === 'image/jpeg') data = stripJpegMeta(data) as Uint8Array<ArrayBuffer>
  const size = kind === 'photo' || kind === 'sticker' ? imageSize(data) : undefined
  const num = (k: string) => (q(k) && Number.isFinite(Number(q(k))) ? Number(q(k)) : undefined)
  const att: Att = {
    lid: crypto.randomUUID(),
    kind,
    mime,
    name: (q('name') ?? `${kind}.${mime.split('/')[1]?.replace(/[^a-z0-9]/g, '') || 'bin'}`).slice(0, 255),
    size: data.length,
    w: num('width') ?? size?.w,
    h: num('height') ?? size?.h,
    dur: num('duration'),
    wave: q('waveform')?.split(',').map(Number).slice(0, 100),
  }
  await media.storeLocal(att.lid, new Blob([data], { type: mime }))
  return json({ file: file(att) })
}

async function download(id: string) {
  const att = fileAtt(id)
  if (!att) throw new HttpError(404, 'file_not_found')
  if (!(await media.download(att))) throw new HttpError(502, 'download_failed')
  const blob = await media.localBlob(att.lid)
  if (!blob) throw new HttpError(502, 'download_failed')
  return new Response(blob, { headers: { 'content-type': att.mime || 'application/octet-stream', 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(att.name)}` } })
}

async function events(url: URL) {
  // offset=-1: drop whatever's waiting and start from now.
  if (url.searchParams.get('offset') === '-1') {
    store.db.run('DELETE FROM events')
    const last = store.db.query<{ s: number }, [string]>('SELECT seq AS s FROM sqlite_sequence WHERE name = ?').get('events')?.s ?? 0
    return json({ events: [], next: last + 1 })
  }
  const offset = Number(url.searchParams.get('offset') ?? 0) || 0
  const timeout = Math.min(Math.max(Number(url.searchParams.get('timeout') ?? 30) || 0, 0), 60)
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 100) || 100, 1), 500)
  // Asking from an offset confirms everything before it.
  if (offset > 0) store.db.run('DELETE FROM events WHERE seq < ?', [offset])
  const read = () => store.db.query<{ seq: number; ev: string }, [number, number]>('SELECT seq, ev FROM events WHERE seq >= ? ORDER BY seq LIMIT ?').all(offset, limit)
  let rows = read()
  if (!rows.length && timeout) {
    await new Promise<void>((res) => {
      const done = () => (waiting.delete(done), clearTimeout(t), res())
      const t = setTimeout(done, timeout * 1000)
      waiting.add(done)
    })
    rows = read()
  }
  return json({ events: rows.map((r) => ({ seq: r.seq, ...JSON.parse(r.ev) })), next: rows.length ? rows.at(-1)!.seq + 1 : offset })
}

type Route = [method: string, pattern: RegExp, handler: (req: Request, url: URL, p: string[]) => Promise<Response> | Response]
const routes: Route[] = [
  ['GET', /^\/v1\/me$/, () => json({ ...user(fog.getState().me!.id), invite: fog.inviteLink(), about: fog.getState().profile.bot?.about ?? null, connected: fog.getState().conn === 'online' })],
  [
    'PATCH',
    /^\/v1\/me$/,
    async (req) => {
      const b = await body(req)
      const profile = fog.getState().profile
      const patch: Parameters<typeof fog.setProfile>[0] = {}
      if (typeof b.name === 'string') patch.name = b.name.slice(0, 64)
      if (b.avatar !== undefined) {
        if (b.avatar !== null && !/^data:image\/(webp|jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(b.avatar)) throw bad('invalid_avatar', 'avatar is a data: URL of a PNG, JPEG or WebP')
        if (b.avatar && b.avatar.length > 120_000) throw bad('avatar_too_large', 'avatar can be up to 120 KB (as a data: URL); 256×256 is plenty')
        patch.avatar = b.avatar ?? undefined
      }
      if (b.about !== undefined || b.commands !== undefined) patch.bot = { ...profile.bot, ...(b.about !== undefined ? { about: b.about ?? undefined } : {}), ...(b.commands !== undefined ? { cmds: cmds(b.commands) } : {}) }
      if (typeof b.username === 'string') {
        const name = b.username.replace(/^@/, '').toLowerCase()
        const ok = await fog.checkUsername(name)
        if (ok !== 'available') throw new HttpError(409, `username_${ok}`)
        await fog.claimUsername(name)
      }
      fog.setProfile({ ...patch, bot: patch.bot ?? profile.bot ?? {} })
      return json(user(fog.getState().me!.id))
    },
  ],
  [
    'PUT',
    /^\/v1\/commands$/,
    async (req) => {
      const b = await body(req)
      const list = Array.isArray(b) ? b : b.commands
      fog.setProfile({ bot: { ...fog.getState().profile.bot, cmds: cmds(list) } })
      return json({ ok: true, count: list.length })
    },
  ],
  ['GET', /^\/v1\/events$/, (_r, url) => events(url)],
  [
    'GET',
    /^\/v1\/chats$/,
    () =>
      json({
        chats: Object.values(fog.getState().chats)
          .filter((c) => !fog.isLocalChat(c.id) && chatAllowed(c.id) && !c.request)
          .map((c) => ({ ...chatInfo(c.id), unread: c.unread, last: c.messages.at(-1)?.ts ?? null })),
      }),
  ],
  ['GET', /^\/v1\/chats\/([^/]+)$/, async (_r, _u, [c]) => json(chatInfo(await resolveChat(c)))],
  [
    'GET',
    /^\/v1\/chats\/([^/]+)\/messages$/,
    async (_r, url, [c]) => {
      const chat = await resolveChat(c)
      const tid = url.searchParams.get('thread_id')
      const all = fog.getState().chats[chat].messages.filter((m) => (tid ? m.th === tid : url.searchParams.has('all') || !m.th) && (m.mine || allowed(m.from ?? chat)))
      const before = url.searchParams.get('before')
      const end = before ? all.findIndex((m) => m.id === before) : all.length
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 50) || 50, 1), 200)
      return json({ messages: all.slice(Math.max(0, (end < 0 ? all.length : end) - limit), end < 0 ? all.length : end).map((m) => message(chat, m)) })
    },
  ],
  [
    'GET',
    /^\/v1\/chats\/([^/]+)\/threads$/,
    async (_r, _u, [c]) => {
      const chat = await resolveChat(c)
      // Only threads started by people on the allowlist (or the bot); one we were caught up on, by whoever its id belongs to.
      const starterOk = (t: { id: string; by: string }) => (t.by ? allowed(t.by) : [me0, ...config.allow].some((a) => t.id.startsWith(`${a.slice(0, 16)}.`)) || !config.allow.length)
      return json({ threads: Object.values(fog.getState().chats[chat].threads ?? {}).filter(starterOk).map((t) => thread(chat, t.id)) })
    },
  ],
  [
    'POST',
    /^\/v1\/chats\/([^/]+)\/threads$/,
    async (req, _u, [c]) => {
      const chat = await resolveChat(c)
      const b = await body(req)
      if (b.message_id) findMsg(chat, b.message_id)
      const id = await fog.createThread(chat, String(b.name ?? ''), b.message_id)
      return json({ thread: thread(chat, id) })
    },
  ],
  [
    'PATCH',
    /^\/v1\/chats\/([^/]+)\/threads\/([^/]+)$/,
    async (req, _u, [c, t]) => {
      const chat = await resolveChat(c)
      const tid = decodeURIComponent(t)
      const th = fog.getState().chats[chat].threads?.[tid]
      if (!th) throw new HttpError(404, 'thread_not_found')
      const me = fog.getState().me!.id
      if (th.by !== me && fog.getState().chats[chat].group?.owner !== me) throw new HttpError(403, 'not_yours', 'threads are renamed by whoever started them, or the group owner')
      const b = await body(req)
      await fog.renameThread(chat, tid, String(b.name ?? ''))
      return json({ thread: thread(chat, tid) })
    },
  ],
  ['POST', /^\/v1\/chats\/([^/]+)\/messages$/, async (req, _u, [c]) => send(await resolveChat(c, true), await body(req))],
  [
    'PATCH',
    /^\/v1\/chats\/([^/]+)\/messages\/([^/]+)$/,
    async (req, _u, [c, id]) => {
      const chat = await resolveChat(c)
      const m = findMsg(chat, id)
      if (!m.mine) throw new HttpError(403, 'not_yours', 'bots can only edit their own messages')
      const b = await body(req)
      const text = typeof b.text === 'string' ? b.text : m.text
      await fog.editMessage(chat, m.id, text, { kb: b.buttons === null ? null : rows(b.buttons), card: card(b.card), live: typeof b.live === 'boolean' ? b.live : undefined })
      if (findMsg(chat, m.id).live) touchLive(chat, m.id, true)
      else touchLive(chat, m.id, false)
      return json({ message: message(chat, findMsg(chat, m.id)) })
    },
  ],
  [
    'DELETE',
    /^\/v1\/chats\/([^/]+)\/messages\/([^/]+)$/,
    async (_r, _u, [c, id]) => {
      const chat = await resolveChat(c)
      const m = findMsg(chat, id)
      // Our own messages go for everyone; anyone else's only from the bot's own view.
      fog.deleteMessages(chat, [m.id], m.mine)
      return json({ ok: true })
    },
  ],
  [
    'PUT',
    /^\/v1\/chats\/([^/]+)\/messages\/([^/]+)\/reaction$/,
    async (req, _u, [c, id]) => {
      const chat = await resolveChat(c)
      const m = findMsg(chat, id)
      const b = await body(req)
      if (b.emoji !== null && (typeof b.emoji !== 'string' || !b.emoji || b.emoji.length > 16)) throw bad('invalid_emoji')
      fog.react(chat, m.id, b.emoji)
      return json({ ok: true })
    },
  ],
  [
    'POST',
    /^\/v1\/chats\/([^/]+)\/typing$/,
    async (_r, _u, [c]) => {
      fog.typing(await resolveChat(c))
      return json({ ok: true })
    },
  ],
  [
    'POST',
    /^\/v1\/chats\/([^/]+)\/read$/,
    async (_r, _u, [c]) => {
      fog.markRead(await resolveChat(c))
      return json({ ok: true })
    },
  ],
  [
    'PUT',
    /^\/v1\/chats\/([^/]+)\/pins\/([^/]+)$/,
    async (_r, _u, [c, id]) => {
      const chat = await resolveChat(c)
      fog.pinMessage(chat, findMsg(chat, id).id, true)
      return json({ ok: true })
    },
  ],
  [
    'DELETE',
    /^\/v1\/chats\/([^/]+)\/pins\/([^/]+)$/,
    async (_r, _u, [c, id]) => {
      const chat = await resolveChat(c)
      fog.pinMessage(chat, findMsg(chat, id).id, false)
      return json({ ok: true })
    },
  ],
  [
    'POST',
    /^\/v1\/groups$/,
    async (req) => {
      const b = await body(req)
      if (typeof b.name !== 'string' || !b.name.trim()) throw bad('name_required')
      const members = await Promise.all((Array.isArray(b.members) ? b.members : []).map(async (m: string) => (await fog.findPeer(String(m)).catch(() => { throw new HttpError(404, 'user_not_found', `no user ${m}`) })).id))
      if (!members.every(allowed)) throw new HttpError(403, 'not_allowed', 'every member must be on the bot\'s allowlist')
      const id = await fog.createGroup(b.name.trim().slice(0, 64), members)
      return json(chatInfo(id))
    },
  ],
  [
    'PATCH',
    /^\/v1\/chats\/([^/]+)$/,
    async (req, _u, [c]) => {
      const chat = await resolveChat(c)
      const g = fog.getState().chats[chat].group
      if (!g) throw bad('not_a_group')
      if (g.owner !== fog.getState().me!.id) throw new HttpError(403, 'not_owner', 'only the group owner can change it')
      const b = await body(req)
      const ids = async (l: unknown) => (Array.isArray(l) ? Promise.all(l.map(async (m) => (await fog.findPeer(String(m))).id)) : undefined)
      const add = await ids(b.add)
      if (add && !add.every(allowed)) throw new HttpError(403, 'not_allowed', 'new members must be on the bot\'s allowlist')
      await fog.updateGroup(chat, { name: typeof b.name === 'string' ? b.name.slice(0, 64) : undefined, add, remove: await ids(b.remove) })
      return json(chatInfo(chat))
    },
  ],
  [
    'POST',
    /^\/v1\/chats\/([^/]+)\/leave$/,
    async (_r, _u, [c]) => {
      await fog.leaveGroup(await resolveChat(c))
      return json({ ok: true })
    },
  ],
  [
    'GET',
    /^\/v1\/users\/([^/]+)$/,
    async (_r, _u, [u]) => {
      const p = await fog.findPeer(decodeURIComponent(u)).catch(() => {
        throw new HttpError(404, 'user_not_found')
      })
      return json(user(p.id))
    },
  ],
  [
    'POST',
    /^\/v1\/users\/([^/]+)\/block$/,
    async (_r, _u, [u]) => {
      fog.block((await fog.findPeer(decodeURIComponent(u))).id)
      return json({ ok: true })
    },
  ],
  [
    'POST',
    /^\/v1\/buttons\/([^/]+)\/answer$/,
    async (req, _u, [qid]) => {
      const q = queries.get(qid)
      if (!q) throw new HttpError(404, 'query_not_found', 'unknown or expired query (answer within 15 minutes)')
      const b = await body(req)
      const form = b.form ? { id: String(b.form.id), title: String(b.form.title ?? ''), f: (b.form.fields ?? []).map((f: any) => ({ id: String(f.id), l: String(f.label ?? f.id), ph: f.placeholder, long: !!f.multiline, secret: !!f.secret, req: !!f.required, min: f.min_length, max: f.max_length })) } : undefined
      queries.delete(qid)
      await fog.answerTap(q.chat, q.from, qid, { text: b.text, alert: !!b.alert, form, msg: q.msg })
      return json({ ok: true })
    },
  ],
  [
    'POST',
    /^\/v1\/autocomplete\/([^/]+)\/answer$/,
    async (req, _u, [qid]) => {
      const q = queries.get(qid)
      if (!q) throw new HttpError(404, 'query_not_found')
      const b = await body(req)
      queries.delete(qid)
      await fog.answerSuggest(q.chat, q.from, qid, (Array.isArray(b.choices) ? b.choices : []).map((x: any) => ({ l: String(x.label ?? x.value), v: String(x.value) })))
      return json({ ok: true })
    },
  ],
  ['POST', /^\/v1\/files$/, (req, url) => upload(req, url)],
  ['GET', /^\/v1\/files\/([^/]+)$/, (_r, _u, [id]) => download(decodeURIComponent(id))],
]

const timingSafe = (a: string, b: string) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))
const server = Bun.serve({
  hostname: config.host,
  port: config.port,
  maxRequestBodySize: media.MAX_FILE + 1024 * 1024,
  idleTimeout: 255, // long polls and big uploads
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === '/health') return json({ ok: true, connected: fog.getState().conn === 'online' })
    const auth = req.headers.get('authorization') ?? ''
    if (!timingSafe(auth, `Bearer ${TOKEN}`)) return json({ error: 'unauthorized' }, 401)
    try {
      for (const [method, re, handler] of routes) {
        const m = re.exec(url.pathname)
        if (m && req.method === method) return await handler(req, url, m.slice(1))
      }
      return json({ error: 'not_found' }, 404)
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.code, message: e.message }, e.status)
      console.error(e)
      return json({ error: 'internal', message: String((e as Error).message ?? e) }, 500)
    }
  },
})
const me = fog.getState().me!
console.log(`fog-bot ${VERSION}: ${me.username ? '@' + me.username : me.id} on ${config.server}`)
console.log(`API on http://${server.hostname}:${server.port} (token in ${tokenPath})`)
if (config.allow.length) console.log(`Talks only to ${config.allow.length} ${config.allow.length === 1 ? 'person' : 'people'} on its allowlist (fog-bot allow).`)
else console.warn('Anyone can message this bot. To keep it to yourself: fog-bot allow --add @you')
if (config.host !== '127.0.0.1' && config.host !== 'localhost' && config.host !== '::1') console.warn('Warning: the API is reachable from other machines. Anyone with the token can read and send as this bot.')
