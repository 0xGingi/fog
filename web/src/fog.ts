// Client engine: keys, server connection, Signal sessions, chats, groups.
// Everything that touches crypto goes through `serial` so ratchet state is saved in order.
import { useSyncExternalStore } from 'react'
import init, { Account, link_agree, link_keypair, new_mnemonic, solve_pow, valid_mnemonic, verify as verifySig } from './core/fog_core.js'
import { isUnlocked, kv, kvClear, lockEnabled, StorageError } from './db'
import { chime, dropLocal, MAX_FILE, SERVER, prepare, prepareSticker, upload, download, type Att, type Kind } from './media'

export { new_mnemonic as newPhrase, valid_mnemonic as validPhrase }

export type Status = 'sending' | 'sent' | 'delivered' | 'read' | 'failed'
export type CallRecord = { out: boolean; video: boolean; dur?: number; missed?: boolean; declined?: boolean; group?: boolean }
export type Sys = { k: 'create' | 'add' | 'remove' | 'leave' | 'rename' | 'decrypt' | 'timer' | 'pin' | 'call' | 'fork' | 'thread'; by: string; who?: string[]; name?: string; secs?: number; call?: CallRecord; /** k 'thread': which one. */ th?: string }
/** A side conversation in a chat: started from a message (`root`), or on its own (like a topic). */
export type Thread = { id: string; name: string; root?: string; by: string; ts: number; v: number }
export type Poll = { q: string; o: string[]; multi?: boolean }
export type LinkPreview = { url: string; title?: string; desc?: string; site?: string; img?: string }
// ---------- bots ----------
/** A button under a bot's message: `d` goes back to the bot when tapped; `u` opens a link instead. */
export type Btn = { l: string; d?: string; u?: string; s?: 'primary' | 'danger' | 'success' }
/** A dropdown under a bot's message (it takes a whole row). */
export type Sel = { sel: string; ph?: string; o: { l: string; v: string; d?: string; on?: boolean }[]; min?: number; max?: number }
export type Row = Btn[] | Sel
/** A form a bot asks you to fill in after a tap (shown as a dialog). */
export type Form = { id: string; title: string; f: { id: string; l: string; ph?: string; long?: boolean; secret?: boolean; req?: boolean; min?: number; max?: number }[] }
/** A frame around a bot's message: title, accent colour and footer. */
export type Card = { title?: string; color?: string; footer?: string }
/** A command a bot takes, with its options (choices, or suggestions the bot gives as you type). */
export type BotCmd = { n: string; d: string; o?: { n: string; d: string; req?: boolean; ch?: { l: string; v: string }[]; auto?: boolean }[] }
/** A bot's public card, inside its encrypted profile: the server doesn't know who's a bot. */
export type BotInfo = { about?: string; cmds?: BotCmd[] }
export type Msg = {
  id: string
  mine: boolean
  text: string
  ts: number
  /** Sender, for incoming group messages. */
  from?: string
  status?: Status
  /** Per-member receipts in groups. */
  rc?: Record<string, 'delivered' | 'read'>
  seen?: boolean
  sys?: Sys
  reply?: string
  att?: Att
  fwd?: boolean
  edited?: boolean
  /** Reactions by person id ('me' for ours). */
  re?: Record<string, string>
  /** Disappearing: seconds after reading, and the resulting deadline. */
  ttl?: number
  exp?: number
  /** Group members mentioned; whether that includes us. */
  men?: string[]
  mentionsMe?: boolean
  poll?: Poll
  link?: LinkPreview
  /** Poll votes by person id ('me' for ours): chosen option indexes. */
  votes?: Record<string, number[]>
  /** Bots: Markdown text, buttons/dropdowns, a card frame. */
  md?: boolean
  kb?: Row[]
  card?: Card
  /** Still being written (a streamed reply): edits don't count as edits. */
  live?: boolean
  /** No notification or sound. */
  quiet?: boolean
  /** Shown to one group member only: their id. */
  only?: string
  /** In this thread (not the main conversation). */
  th?: string
  /** Not sent: the recipient's server refused it as a sealed (anonymous) message. Sending it anyway would reveal it's from us. */
  sealFail?: boolean
}
export type Group = {
  members: string[]
  owner: string
  left?: boolean
  /** Signed state: version, owner's signature, fingerprint. */
  v?: number
  sig?: string
  hash?: string
  /** Members who announced they left (until the owner signs them out). */
  gone?: string[]
  forkedAt?: number
}
export type Chat = {
  id: string
  messages: Msg[]
  unread: number
  group?: Group
  /** Group name / photo. People's names live in `people`. */
  name?: string
  avatar?: string
  typing?: { by: string; until: number }
  pinned?: boolean
  draft?: string
  markedUnread?: boolean
  /** Muted until this timestamp. */
  muted?: number
  archived?: boolean
  /** Disappearing-message timer in seconds (0 = off). */
  timer?: number
  /** Pinned message ids, oldest first. */
  pins?: string[]
  /** Unread mentions of us. */
  mentions?: number
  /** Side conversations, by id. */
  threads?: Record<string, Thread>
  /** From someone we haven't accepted yet: no receipts, no ringing, no notifications. */
  request?: boolean
}
export type Person = { username?: string | null; name?: string; avatar?: string; sent?: number; /** Their sealed-sender access key. */ ak?: string; /** Safety number confirmed in person. */ verified?: boolean; /** A bot, and what it offers. */ bot?: BotInfo }
export type Profile = { name: string; avatar?: string; v: number; bot?: BotInfo }
export type Settings = { readReceipts: boolean; typing: boolean; sounds: boolean; theme: 'system' | 'light' | 'dark'; textSize: number; linkPreviews: boolean; relayCalls: boolean; autoLock: number; lockPrompted?: boolean; /** Encrypted chat backup to the server (main device; on unless turned off). */ backup?: boolean; /** Desktop app: native notifications. */ notifications?: boolean; /** Show the sender and text in notifications (off: just "New message"). */ previews?: boolean; /** Desktop layout: chat list width, or folded to an avatar rail. */ sidebar?: number; sidebarCollapsed?: boolean }
export type State = {
  phase: 'loading' | 'locked' | 'unlock' | 'welcome' | 'username' | 'app'
  /** `device` is this device's id; `main` means it holds the recovery phrase (device 1). */
  me: { id: string; username: string | null; device: number; main: boolean } | null
  profile: Profile
  conn: 'connecting' | 'online' | 'offline'
  chats: Record<string, Chat>
  people: Record<string, Person>
  active: string | null
  settings: Settings
  jump: { id: string; at: number } | null
  toast: { text: string; at: number } | null
  /** Personal sticker library (already uploaded, so sending never re-uploads). */
  stickers: Att[]
  /** Saved GIFs, the same way: our own collection, no GIF service involved. */
  gifs: Att[]
  blocked: string[]
  /** Our devices, from the server. */
  devices: DeviceInfo[]
  /** Chat backup (main device): when the last one was made, and whether one is being made now. */
  backup: { at: number | null; busy: boolean; /** Restoring from the backup failed: no new backup until it works or you choose to start over. */ restoreFailed?: boolean }
  /** A bot answered a tap with something to read, or a form to fill in. */
  alert: { text: string; at: number; from: string } | null
  form: { chat: string; msg: string; bot: string; form: Form } | null
  /** The thread open in the active chat (null: its main conversation). */
  thread: string | null
}
export type DeviceInfo = { id: number; name: string | null; created: number; seen: number; ready: boolean }

// Wire form of an attachment pointer (inside the encryption).
type WireAtt = Omit<Att, 'lid'>
// Payloads inside the encryption. The server never sees these. `g` scopes a payload to a group.
type Payload = (
  | { t: 'text'; id: string; text: string; ts: number; reply?: string; att?: WireAtt; fwd?: boolean; ttl?: number; men?: string[]; poll?: Poll; link?: LinkPreview; md?: 1; kb?: Row[]; card?: Card; live?: 1; quiet?: 1; /** Sent to one group member only (to our devices: which one). */ only?: 1 | string; th?: string }
  | { t: 'vote'; id: string; c: number[] }
  /** `to`: only that device of the recipient acts on it. 'elsewhere': answered or declined on another of our devices. */
  /** 'screen': the sender started (`on`) or stopped sharing their screen, so the other side shows it whole.
   *  Group calls: 'ring', 'hello' (joined) and 'leave' go to the whole group; offers and answers go
   *  device to device with `gc`, the group the call is in. */
  | { t: 'call'; id: string; k: 'offer' | 'answer' | 'end' | 'decline' | 'busy' | 'elsewhere' | 'screen' | 'ring' | 'hello' | 'leave'; sdp?: string; video?: boolean; to?: number; on?: boolean; gc?: string }
  | { t: 'receipt'; ids: string[]; s: 'delivered' | 'read' }
  | { t: 'typing' }
  | { t: 'reset' }
  | { t: 'react'; id: string; emoji: string | null }
  /** `kb`/`card`: replaced (null removes). `live`: the message is still being written (1) or done (0). */
  | { t: 'edit'; id: string; text: string; kb?: Row[] | null; card?: Card | null; live?: 0 | 1 }
  /** Bots: a tap on a button (`d`), a dropdown choice (`d` = its id, `v`), or a filled-in form (`d` = its id, `f`). */
  | { t: 'btn'; id: string; d: string; q: string; v?: string[]; f?: Record<string, string> }
  /** The bot's answer to a tap: something to show, or a form to fill in. */
  | { t: 'btnack'; q: string; text?: string; alert?: 1; form?: Form }
  /** A thread was started, or renamed (newer `v` wins). `by` (from the group owner): catching a new member up on an existing thread. */
  | { t: 'thread'; id: string; name: string; root?: string; v: number; by?: string }
  /** Bots: suggestions for a command option as you type it, and the bot's answer. */
  | { t: 'auto'; q: string; cmd: string; opt: string; val: string; /** everything typed after the command */ args?: string }
  | { t: 'autoans'; q: string; o: { l: string; v: string }[] }
  | { t: 'delete'; id: string }
  | { t: 'profile'; name: string; avatar?: string; ak?: string; bot?: BotInfo }
  /** "Your access key stopped working, please re-share it." */
  | { t: 'akreq' }
  | { t: 'group'; name: string; avatar?: string; members: string[]; owner: string; v: number; sig: string }
  | { t: 'leave' }
  | { t: 'timer'; s: number }
  | { t: 'pin'; id: string; on: boolean }
  // Between our own devices only:
  /** Something we did in a chat on another device (a message we sent, a reaction, an edit...). */
  | { t: 'sent'; chat: string; p: Payload }
  /** We read a chat up to `at` on another device. */
  | { t: 'read'; chat: string; at: number }
  | { t: 'acct'; profile?: Profile; blocked?: string[]; ak?: string }
  | { t: 'chatmeta'; chat: string; pinned?: boolean; muted?: number; archived?: boolean; accepted?: boolean; deleted?: boolean }
) & { g?: string; /** Sender's view of the group: version + fingerprint. */ gv?: number; gh?: string }

// ---------- search (on this device only; nothing is sent anywhere) ----------
/** Lowercase, accents off: "Café" and "cafe" match. */
export const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
/** The words to look for. Every one must appear, in any order. */
export const searchTerms = (q: string) => fold(q).split(/\s+/).filter(Boolean)
/** Does a message match? Looks at its text, file name, link title and poll. */
export function msgMatches(m: Msg, terms: string[]) {
  if (m.sys || !terms.length) return false
  const hay = fold([m.text, m.att?.name, m.link?.title, m.link?.site, m.poll?.q, ...(m.poll?.o ?? [])].filter(Boolean).join(' '))
  return terms.every((t) => hay.includes(t))
}

export const MAX_GROUP = 50 // ponytail: groups encrypt per member (pairwise). Signal sender keys for big groups.

// ---------- store ----------
let state: State = {
  phase: 'loading',
  me: null,
  profile: { name: '', v: 0 },
  conn: 'connecting',
  chats: {},
  people: {},
  active: null,
  // Calls go through our relay by default, so the people you call never see your IP address.
  settings: { readReceipts: true, typing: true, sounds: true, theme: 'system', textSize: 16, linkPreviews: false, relayCalls: true, autoLock: 5 },
  jump: null,
  toast: null,
  stickers: [],
  gifs: [],
  blocked: [],
  devices: [],
  backup: { at: null, busy: false },
  alert: null,
  form: null,
  thread: null,
}
const listeners = new Set<() => void>()
function set(patch: Partial<State>) {
  state = { ...state, ...patch }
  listeners.forEach((l) => l())
}
function setChat(id: string, fn: (c: Chat) => Chat) {
  const c = state.chats[id] ?? { id, messages: [], unread: 0 }
  dirty.add(id)
  set({ chats: { ...state.chats, [id]: fn(c) } })
}
function setMsgs(chat: string, fn: (ms: Msg[]) => Msg[]) {
  setChat(chat, (c) => ({ ...c, messages: fn(c.messages) }))
  saveChatsSoon()
}
function setPerson(id: string, patch: Partial<Person>) {
  set({ people: { ...state.people, [id]: { ...state.people[id], ...patch } } })
  savePeopleSoon()
}
export function useFog<T>(sel: (s: State) => T): T {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => sel(state),
  )
}
export const getState = () => state
export const toast = (text: string) => set({ toast: { text, at: Date.now() } })
export const jumpTo = (id: string) => set({ jump: { id, at: Date.now() } })
export const isGroup = (id: string) => id.startsWith('g:')
/** Notes to self: a local-only chat that never touches the network. */
export const SAVED = 'saved'
/** The Fog guide: a scripted chat that lives only on this device (see guide.ts). */
export const GUIDE = 'guide'
/** Chats that exist only on this device: nothing in them is ever sent. */
export const isLocalChat = (id: string) => id === SAVED || id === GUIDE
const GUIDE_AVATAR = `data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f3bd52"/><stop offset="1" stop-color="#df9418"/></linearGradient></defs><rect width="512" height="512" fill="url(#g)"/><g fill="none" stroke="#2a1d04" stroke-linecap="round" stroke-width="34"><path d="M132 200c40-22 82-22 124 0s84 22 124 0"/><path d="M100 270c50-26 104-26 156 0s106 26 156 0"/><path d="M148 340c36-18 72-18 108 0s72 18 108 0"/></g></svg>')}`
export const isMuted = (c: Chat) => (c.muted ?? 0) > Date.now()
export const TIMERS = [0, 30, 300, 3600, 86400, 604800]
export const timerLabel = (s = 0) => (!s ? 'Off' : s < 60 ? `${s} seconds` : s < 3600 ? `${s / 60} minutes` : s < 86400 ? `${s / 3600} hour${s === 3600 ? '' : 's'}` : s < 604800 ? `${s / 86400} day${s === 86400 ? '' : 's'}` : '1 week')

export const shortId = (id: string) => `${id.slice(0, 6)}…${id.slice(-4)}`
/** Display name for a person: their shared name, else @username, else a short id. */
export const personName = (id: string, p = state.people[id]) => (id === state.me?.id ? 'You' : p?.name || (p?.username ? `@${p.username}` : shortId(id)))
export const chatTitle = (c: Chat, p?: Person) => (c.id === SAVED ? 'Saved Messages' : c.id === GUIDE ? 'Fog Guide' : c.group ? c.name || 'Group' : personName(c.id, p ?? state.people[c.id]))
export const chatAvatar = (c: Chat, p?: Person) => (c.id === GUIDE ? GUIDE_AVATAR : c.group ? c.avatar : (p ?? state.people[c.id])?.avatar)
export const others = (c: Chat) => (isLocalChat(c.id) ? [] : c.group ? c.group.members.filter((m) => m !== state.me?.id && !c.group!.gone?.includes(m)) : [c.id])

// ---------- helpers ----------
const b64 = (u: Uint8Array) => {
  let s = ''
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000))
  return btoa(s)
}
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
const te = new TextEncoder()
const td = new TextDecoder()

// Padding (like Signal): plaintexts are padded to multiples of 160 bytes before encryption so the
// server can't tell a "k" from a paragraph. ISO 7816-4 style: 0x80 then zeros.
const PAD = 160
export function pad(b: Uint8Array) {
  const out = new Uint8Array(Math.ceil((b.length + 1) / PAD) * PAD)
  out.set(b)
  out[b.length] = 0x80
  return out
}
export function unpad(b: Uint8Array) {
  let i = b.length - 1
  while (i >= 0 && b[i] === 0) i--
  return i >= 0 && b[i] === 0x80 ? b.subarray(0, i) : b
}

let acct: Account | null = null
let q: Promise<unknown> = Promise.resolve()
/** Run crypto + persistence one at a time. Ratchet state must never fork. */
function serial<T>(fn: () => Promise<T> | T): Promise<T> {
  const p = q.then(fn)
  q = p.catch(() => {})
  return p
}
const saveAccount = () => kv('account', acct!.save())
// Each chat is its own record (plus an index), so a new message rewrites one chat, not all of them.
const dirty = new Set<string>()
let indexed = ''
async function saveChats() {
  const ids = [...dirty]
  dirty.clear()
  try {
    for (const id of ids) await kv(`chat:${id}`, state.chats[id] ?? null)
  } catch (e) {
    ids.forEach((id) => dirty.add(id)) // retried on the next save
    throw e
  }
  const index = Object.keys(state.chats).join('\n')
  if (index !== indexed) {
    await kv('chat-index', index)
    indexed = index // only once it's really stored, so a failed write is retried next save
  }
}
async function loadChats(): Promise<Record<string, Chat>> {
  const index = await kv<string>('chat-index')
  if (index === undefined) {
    // Migrate the old single-blob format.
    const legacy = (await kv<Record<string, Chat>>('chats')) ?? {}
    Object.keys(legacy).forEach((id) => dirty.add(id))
    state = { ...state, chats: legacy }
    await saveChats()
    await kv('chats', null)
    return legacy
  }
  indexed = index
  const chats: Record<string, Chat> = {}
  for (const id of index ? index.split('\n') : []) {
    const c = await kv<Chat>(`chat:${id}`)
    if (c) chats[id] = c
  }
  return chats
}
let chatTimer = 0
const saveChatsSoon = () => {
  clearTimeout(chatTimer)
  chatTimer = window.setTimeout(saveChats, 300)
}
let peopleTimer = 0
const savePeopleSoon = () => {
  clearTimeout(peopleTimer)
  peopleTimer = window.setTimeout(() => kv('people', state.people), 300)
}

// ---------- desktop app ----------
/** The desktop app's native bridge. The page may call only `notify` and `set_unread`. */
const desktop = (window as unknown as { __TAURI_INTERNALS__?: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } }).__TAURI_INTERNALS__
export const isDesktop = !!desktop
if (desktop) {
  // Unread count next to the menu bar icon and on the Dock icon (muted and archived chats don't count).
  let shown = -1
  listeners.add(() => {
    const n = state.phase === 'app' ? Object.values(state.chats).reduce((sum, c) => sum + (isMuted(c) || c.archived || c.request ? 0 : c.unread), 0) : 0
    if (n !== shown) desktop.invoke('set_unread', { count: (shown = n) }).catch(() => {})
  })
}

/**
 * Phone apps: a push token lets the server wake this device when a message arrives while Fog is closed
 * or in the background. The push itself only says "New message"; the message comes over the socket.
 */
let pushOn = false
async function registerPush() {
  const r = (await desktop?.invoke('push_token', { on: state.settings.notifications !== false }).catch(() => null)) as { kind: string; token: string } | null | undefined
  if (!r) return // desktop and the web: no push (no token on this phone either)
  await rpc({ t: 'push', kind: r.kind, token: r.token }).catch(() => {})
  pushOn = !!r.token
  if (pushOn) rpc({ t: 'away', away: document.hidden }).catch(() => {})
}
// In the background the socket may live on for a while, but nobody's looking: ask for pushes.
document.addEventListener('visibilitychange', () => pushOn && state.conn === 'online' && rpc({ t: 'away', away: document.hidden }).catch(() => {}))

// ---------- theme ----------
const mq = matchMedia('(prefers-color-scheme: dark)')
function applyTheme() {
  const s = state.settings
  const t = s.theme === 'system' ? (mq.matches ? 'dark' : 'light') : s.theme
  const root = document.documentElement
  root.dataset.theme = t
  root.style.setProperty('--msg', `${s.textSize}px`)
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', t === 'dark' ? '#17202a' : '#ffffff')
}
mq.addEventListener('change', applyTheme)
applyTheme()

// ---------- boot ----------
type Meta = { username: string | null; skipped?: boolean; settings?: Partial<Settings>; profile?: Profile; blocked?: string[]; ak?: string; trust?: string }

export async function boot() {
  // One tab owns the keys. Two tabs advancing the same ratchet would corrupt sessions.
  // On reload the old page may still hold the lock for a moment, so wait instead of failing;
  // show "open in another tab" only if it takes a while, and take over once that tab closes.
  await new Promise<void>((res) => {
    const t = setTimeout(() => set({ phase: 'locked' }), 1500)
    navigator.locks.request('fog-owner', () => {
      clearTimeout(t)
      res()
      return new Promise(() => {})
    })
  })
  set({ phase: 'loading' })
  await init()
  // App lock: wait for the passcode or passkey before reading anything.
  if (await lockEnabled()) {
    set({ phase: 'unlock' })
    await waitFor(isUnlocked)
    set({ phase: 'loading' })
  }
  const saved = await kv<Uint8Array>('account')
  const meta = (await kv<Meta>('meta')) ?? null
  set({ chats: await loadChats(), people: (await kv<Record<string, Person>>('people')) ?? {}, stickers: (await kv<Att[]>('stickers')) ?? [], gifs: (await kv<Att[]>('gifs')) ?? [], blocked: meta?.blocked ?? [] })
  if (meta?.settings) set({ settings: { ...state.settings, ...meta.settings } })
  applyTheme()
  if (!saved) return set({ phase: 'welcome' })
  acct = Account.load(saved)
  skipped = !!meta?.skipped
  myAk = meta?.ak ?? b64(crypto.getRandomValues(new Uint8Array(16)))
  pinnedTrust = meta?.trust ?? null
  set({
    me: { id: acct.id, username: meta?.username ?? null, device: acct.device, main: acct.is_main },
    profile: meta?.profile ?? state.profile,
    phase: meta?.username || meta?.skipped ? 'app' : 'username',
  })
  connect()
}

/** Create a new account, or restore one from its phrase. Resolves once the server knows our keys. */
export async function createAccount(phrase: string): Promise<void> {
  acct = Account.create(phrase, Date.now())
  myAk = b64(crypto.getRandomValues(new Uint8Array(16)))
  pinnedTrust = null
  await saveAccount()
  await kv('uploaded', null)
  // Until the old backup is back (or turns out not to exist), nothing may replace it on the server.
  await kv('restore', true)
  set({ me: { id: acct.id, username: null, device: acct.device, main: true } })
  await saveMeta()
  signupError = null
  connect()
  await waitFor(() => state.conn === 'online' || !!signupError)
  if (signupError) {
    // Start clean so a retry gets fresh keys and a fresh connection.
    ws?.close()
    ws = null
    await kv('account', null)
    throw new Error(signupError)
  }
  // Restoring from the phrase: the chats come back from the backup, if there is one.
  await tryRestore()
  // A brand-new account starts with the guide, as a first chat to try things in.
  if (!Object.keys(state.chats).length) guide?.start()
  set({ phase: state.me?.username ? 'app' : 'username' })
}
let signupError: string | null = null

let skipped = false
// Sealed sender: our access key (shared only with accepted contacts) and the server's pinned trust root.
let myAk = ''
let pinnedTrust: string | null = null
function saveMeta() {
  return kv<Meta>('meta', { username: state.me?.username ?? null, skipped, settings: state.settings, profile: state.profile, blocked: state.blocked, ak: myAk, trust: pinnedTrust ?? undefined })
}

export function skipUsername() {
  skipped = true
  set({ phase: 'app' })
  saveMeta()
}

export function updateSettings(patch: Partial<Settings>) {
  set({ settings: { ...state.settings, ...patch } })
  applyTheme()
  saveMeta()
  if ('notifications' in patch) registerPush()
  // Backups off: delete the copy on the server too. Back on: make one now.
  // (Not while the old backup is still waiting to be restored: it may be the only copy of those chats.)
  if (patch.backup === false && acct?.is_main)
    void kv('restore').then((waiting) => {
      if (!waiting) rpc({ t: 'backup', id: '' }).then(() => kv('backup', null), () => {})
    })
  if (patch.backup === true) void backupNow(true)
}

/** Update our display name / photo and push it (encrypted) to everyone we've written to. */
export function setProfile(patch: Partial<Omit<Profile, 'v'>>) {
  set({ profile: { ...state.profile, ...patch, v: Date.now() } })
  saveMeta()
  mirror({ t: 'acct', profile: state.profile, ak: myAk })
  const ids = new Set<string>()
  for (const c of Object.values(state.chats)) if (c.messages.some((m) => m.mine) && !c.group?.left) others(c).forEach((m) => ids.add(m))
  ids.forEach((id) => shareProfile(id).catch(() => {}))
}

export async function checkUsername(name: string): Promise<'available' | 'taken' | 'invalid'> {
  if (!/^[a-z][a-z0-9_]{2,31}$/.test(name)) return 'invalid'
  try {
    const r = await rpc({ t: 'lookup', name })
    return r.id === state.me?.id ? 'available' : 'taken'
  } catch (e) {
    return (e as Error).message === 'not_found' ? 'available' : 'taken'
  }
}

export async function claimUsername(name: string) {
  const r = await rpc({ t: 'username', name })
  set({ me: { ...state.me!, username: r.username }, phase: 'app' })
  await saveMeta()
}

export async function logout() {
  // A linked device also takes itself off the account, so it stops receiving copies.
  if (acct && !acct.is_main) await rpc({ t: 'unlink', device: acct.device }).catch(() => {})
  unlinkedNow = true
  ws?.close()
  await kvClear()
  location.reload()
}
export const loadDevices = () => refreshDevices()

/** The lock screen calls this after db.unlockWith…() succeeds; boot() then carries on. */
export const unlocked = () => listeners.forEach((l) => l())
/** Lock now: reloading drops every key and message from memory. */
export const lockNow = () => location.reload()

// Auto-lock after inactivity (only when the app lock is on).
let lastActive = Date.now()
for (const e of ['pointerdown', 'keydown', 'wheel', 'touchstart']) addEventListener(e, () => (lastActive = Date.now()), { passive: true })
setInterval(async () => {
  const mins = state.settings.autoLock
  const inCall = !!document.querySelector('[role=dialog][aria-label^="Call with"]')
  if (state.phase === 'app' && mins > 0 && !inCall && Date.now() - lastActive > mins * 60_000 && (await lockEnabled())) lockNow()
}, 15_000)

export const phrase = () => acct?.phrase ?? ''
export const safetyNumber = (peer: string) => acct?.safety_number(peer) ?? ''
export const safetyQr = (peer: string) => b64(acct!.safety_qr(peer))
/** Check a scanned safety code; on a match the contact is marked verified. */
export function verifySafetyCode(peer: string, scanned: string) {
  let ok = false
  try {
    ok = acct!.safety_compare(peer, unb64(scanned))
  } catch {}
  if (ok) setPerson(peer, { verified: true })
  return ok
}
export const setVerified = (peer: string, verified: boolean) => setPerson(peer, { verified })

/** Resolves once connected to the server. */
export const waitOnline = () => waitFor(() => state.conn === 'online')
function waitFor(cond: () => boolean): Promise<void> {
  return new Promise((res) => {
    if (cond()) return res()
    const l = () => cond() && (listeners.delete(l), res())
    listeners.add(l)
  })
}

// ---------- connection ----------
let ws: WebSocket | null = null
let rid = 0
let backoff = 500
const pending = new Map<number, { res: (v: any) => void; rej: (e: Error) => void }>()

function connect() {
  ws?.close()
  set({ conn: 'connecting' })
  const sock = (ws = new WebSocket(`${SERVER.protocol === 'https:' ? 'wss' : 'ws'}://${SERVER.host}/ws`))
  sock.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.rid !== undefined) {
      const p = pending.get(m.rid)
      pending.delete(m.rid)
      m.error ? p?.rej(Object.assign(new Error(m.error), { data: m })) : p?.res(m)
    } else onPush(m)
  }
  sock.onclose = () => {
    if (ws !== sock || unlinkedNow) return
    set({ conn: 'offline' })
    pending.forEach((p) => p.rej(new Error('offline')))
    pending.clear()
    setTimeout(connect, backoff)
    backoff = Math.min(backoff * 2, 15000)
  }
}

/**
 * Heartbeat. A phone app in the background or a Mac app hidden in the menu bar can have its
 * connection die without the socket noticing, and then it looks connected while nothing arrives.
 * So every 30 s while Fog is open, and right away when it comes back to the front or the network
 * returns, ask the server something small; no answer within 5 s means reconnect now.
 */
async function checkAlive() {
  if (!acct || unlinkedNow) return
  if (state.conn === 'offline') {
    backoff = 500 // back from the background or offline: reconnect now, not after the backoff
    return connect()
  }
  if (state.conn !== 'online' || ws?.readyState !== WebSocket.OPEN) return
  const sock = ws
  const dead = setTimeout(() => {
    if (ws !== sock) return
    pending.forEach((p) => p.rej(new Error('offline')))
    pending.clear()
    connect()
  }, 5000)
  // Any answer (even an error) proves the connection is alive. `away` also tells the server
  // whether anyone's looking, which phones need for push.
  await rpc({ t: 'away', away: document.hidden }).catch(() => {})
  clearTimeout(dead)
}
setInterval(() => document.visibilityState === 'visible' && void checkAlive(), 30_000)
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && void checkAlive())
window.addEventListener('online', () => void checkAlive())
window.addEventListener('focus', () => void checkAlive())

function rpc(req: Record<string, unknown>): Promise<any> {
  // Before `ready` the socket isn't authenticated; only the key upload in the ready handler may go out.
  if (ws?.readyState !== WebSocket.OPEN || (state.conn !== 'online' && req.t !== 'keys'))
    return Promise.reject(new Error('offline'))
  const id = ++rid
  return new Promise((res, rej) => {
    pending.set(id, { res, rej })
    ws!.send(JSON.stringify({ ...req, rid: id }))
  })
}

/**
 * Tell the server it can delete a message. Queued messages replay right after `ready`, before we're
 * online, so acks wait for the connection instead of being dropped (and redelivered next time).
 */
const unacked = new Set<number>()
function ack(id: number) {
  if (state.conn !== 'online') return void unacked.add(id)
  rpc({ t: 'ack', id }).catch(() => unacked.add(id))
}

async function onPush(m: any) {
  switch (m.t) {
    case 'challenge': {
      authNonce = m.nonce
      const challenge = te.encode(`fog-auth-v1|${SERVER.host}|${m.nonce}`)
      const auth: Record<string, unknown> = { id: acct!.id, device: acct!.device, sig: b64(acct!.sign(challenge)) }
      // The main device also proves the key derived from the recovery phrase; linked devices can't.
      if (acct!.is_main) Object.assign(auth, { main: acct!.main_public(), msig: b64(acct!.main_sign(challenge)) })
      // Linked devices sign with their own login key, so the shared identity key alone can't sign in as them.
      else Object.assign(auth, { dkey: acct!.device_public(), dsig: b64(acct!.device_sign(challenge)) })
      // A newly linked device's first login carries the approval token from the main device.
      if (linkToken) auth.token = linkToken
      auth.name = deviceName()
      ws!.send(JSON.stringify(auth))
      break
    }
    case 'ready': {
      backoff = 500
      // First connect on this device: replace any keys an old device left on the server.
      if (!(await kv('uploaded'))) {
        try {
          await serial(async () => {
            const keys = JSON.parse(acct!.keys(100, 40))
            await saveAccount()
            // New accounts pay a small proof-of-work (about a second) so signups can't be scripted cheaply.
            const pow = m.registered ? undefined : solve_pow(authNonce, m.pow ?? 20)
            await rpc({ t: 'keys', keys, replace: true, pow })
            await kv('uploaded', true)
          })
        } catch (e) {
          signupError =
            (e as Error).message === 'signup_limit' ? 'Too many new accounts from your network. Try again in a few minutes.' : "Couldn't create your account. Check your connection and try again."
          listeners.forEach((l) => l())
          return
        }
      } else {
        if (m.prekeys < 20 || (m.kyber ?? 0) < 10) await topUp(m.prekeys, m.kyber ?? 0)
        // Weekly signed-prekey rotation.
        await serial(async () => {
          if (!acct!.rotate(Date.now())) return
          const keys = JSON.parse(acct!.keys(0, 0))
          await saveAccount()
          await rpc({ t: 'keys', keys })
        })
      }
      if (m.username && m.username !== state.me?.username) {
        set({ me: { ...state.me!, username: m.username } })
        saveMeta()
      }
      // Sealed sender setup: pin the server's trust root on first sight, register our access key.
      if (typeof m.trust === 'string') {
        if (!pinnedTrust) pinnedTrust = m.trust
        else if (pinnedTrust !== m.trust) console.warn('server trust root changed; sealed messages will be refused')
      }
      if (!myAk) myAk = b64(crypto.getRandomValues(new Uint8Array(16)))
      saveMeta()
      set({ conn: 'online' })
      for (const id of unacked) unacked.delete(id), ack(id)
      linkToken = null
      refreshDevices()
      // Register our access key before anything else goes out (the RPC layer only works once online).
      await rpc({ t: 'access', key: myAk }).catch(() => {})
      registerPush()
      // A restore that didn't finish (or failed) goes first: a backup made before it would replace the old one.
      if (acct!.is_main) void (async () => ((await kv('restore')) ? (await tryRestore()) && backupSoon() : backupSoon()))()
      retryPending()
      if (state.phase === 'app') handleInvite()
      break
    }
    case 'prekeys':
      topUp(m.count, m.kyber ?? 40)
      break
    case 'msg':
      receive(m)
      break
    case 'devices':
      refreshDevices()
      break
    case 'unlinked':
      unlinkedHere()
      break
    case 'error':
      if (m.error === 'unlinked') unlinkedHere()
      else console.error('server:', m.error)
  }
}

// ---------- devices ----------
let linkToken: string | null = null
let unlinkedNow = false
/** Device ids of ours that can receive messages (this one included). */
let ownDevices: number[] = []
const otherDevices = () => ownDevices.filter((d) => d !== acct?.device)
async function refreshDevices() {
  try {
    const r = await rpc({ t: 'devices' })
    const before = state.devices
    set({ devices: r.devices })
    ownDevices = r.devices.filter((d: DeviceInfo) => d.ready).map((d: DeviceInfo) => d.id)
    // Tell every device when one is added, so a device you didn't link can't hide.
    for (const d of r.devices as DeviceInfo[])
      if (before.length && d.ready && !before.some((b) => b.id === d.id && b.ready) && d.id !== acct?.device) toast(`New device linked to your account: ${d.name ?? `device ${d.id}`}`)
  } catch {}
}
/** A label for this device in the main device's list. */
function deviceName() {
  const ua = navigator.userAgent
  if (ua === 'fog-bot') return 'Fog bot'
  // iPhones say "like Mac OS X", and iPads can report a Mac: check them first.
  const ipad = /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
  const os = /iPhone/.test(ua) ? 'iPhone' : ipad ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'this computer'
  if (location.protocol === 'tauri:' || location.hostname === 'tauri.localhost') return `Fog for ${os}`
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser'
  return `${browser} on ${os}`
}
/**
 * This device was unlinked (by the main device, by itself, or by a restore elsewhere). Everything
 * local goes: an unlinked device may be lost or stolen.
 */
async function unlinkedHere() {
  if (unlinkedNow) return
  unlinkedNow = true
  ws?.close()
  try {
    sessionStorage.setItem('fog-unlinked', '1')
  } catch {}
  await kvClear()
  location.reload()
}
/** Shown once on the welcome screen after an unlink. */
export function wasUnlinked() {
  try {
    const v = sessionStorage.getItem('fog-unlinked')
    sessionStorage.removeItem('fog-unlinked')
    return !!v
  } catch {
    return false
  }
}
export async function unlinkDevice(id: number) {
  await rpc({ t: 'unlink', device: id })
  if (id === acct?.device) return unlinkedHere()
  // It keeps what it already had, so stop trusting it: forget our sessions with it, and replace the
  // access key it knew (contacts get the new one) so it can't deliver sealed messages to us.
  await serial(() => (acct!.drop_session(acct!.id, id), saveAccount()))
  rotateAccessKey()
  refreshDevices()
}

let authNonce = ''
function topUp(count: number, kyber: number) {
  return serial(async () => {
    const keys = JSON.parse(acct!.keys(Math.max(0, 100 - count), Math.max(0, 40 - kyber)))
    await saveAccount()
    await rpc({ t: 'keys', keys })
  })
}

// ---------- linking devices ----------
// The new device shows a QR code: a link channel on the server plus a one-time public key. The main
// device scans it, gets the server's approval for a new device slot, uploads your chat history as an
// encrypted blob, and sends the identity key, that approval and the blob's key to the new device,
// encrypted to its one-time key (X25519 + HKDF + AES-GCM). The server relays ciphertext only.
const wsBase = () => `${SERVER.protocol === 'https:' ? 'wss' : 'ws'}://${SERVER.host}`
const b64url = (u: Uint8Array) => b64(u).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const unb64url = (s: string) => unb64(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4))
type Bytes = Uint8Array<ArrayBuffer>
const bytes = (u: Uint8Array) => new Uint8Array(u) as Bytes
async function linkKey(secret: Uint8Array) {
  const base = await crypto.subtle.importKey('raw', bytes(secret), 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: te.encode('fog/link/v1') }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}
/** Six digits both screens show, from the link's shared secret: they only match if nobody else got in between. */
async function linkCode(secret: Uint8Array) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes(new Uint8Array([...te.encode('fog/link/code'), ...secret]))))
  const n = ((h[0] << 16) | (h[1] << 8) | h[2]) % 1_000_000
  return String(n).padStart(6, '0').replace(/(\d{3})(\d{3})/, '$1 $2')
}
async function linkSeal(theirPub: Uint8Array, data: Uint8Array) {
  const eph = link_keypair()
  const secret = link_agree(eph.subarray(0, 32), theirPub)
  const key = await linkKey(secret)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes(data)))
  return { body: new Uint8Array([...eph.subarray(32), ...iv, ...ct]), code: await linkCode(secret) }
}
async function linkOpen(priv: Uint8Array, raw: Uint8Array) {
  const secret = link_agree(priv, raw.subarray(0, 32))
  const key = await linkKey(secret)
  const data = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(raw.subarray(32, 44)) }, key, bytes(raw.subarray(44))))
  return { data, code: await linkCode(secret) }
}
/** What the new device shows (as a QR code and as text to paste). */
export function parseLinkCode(code: string) {
  const m = /fog-link:([0-9a-f]{32}):([A-Za-z0-9_-]{43})/.exec(code.trim())
  return m ? { channel: m[1], pub: unb64url(m[2]) } : null
}

type LinkPayload = { v: 1; identity: string; device: number; token: string; ak: string; username: string | null; skipped: boolean; profile: Profile; archive?: ArchiveRef }
type ArchiveRef = { id: string; key: string; gz: boolean }
type Archive = { v: 1; chats: Record<string, Chat>; people: Record<string, Person>; stickers: Att[]; gifs?: Att[]; blocked: string[]; profile?: Profile }

const pipe = async (data: Uint8Array, t: CompressionStream | DecompressionStream) => new Uint8Array(await new Response(new Blob([bytes(data)]).stream().pipeThrough(t)).arrayBuffer())

/** Our chat history as JSON (gzipped where the browser can). */
async function packArchive(withProfile = false) {
  // Attachments travel as their encrypted pointers (re-downloaded while the server keeps them);
  // unsent messages stay behind so the new device doesn't send them a second time.
  const chats = Object.fromEntries(
    Object.entries(state.chats).map(([id, c]) => [id, { ...c, typing: undefined, draft: undefined, messages: c.messages.filter((m) => !(m.mine && (m.status === 'sending' || m.status === 'failed'))) }]),
  )
  const archive: Archive = { v: 1, chats, people: state.people, stickers: state.stickers, gifs: state.gifs, blocked: state.blocked, profile: withProfile ? state.profile : undefined }
  const json = te.encode(JSON.stringify(archive))
  const gz = typeof CompressionStream !== 'undefined'
  return { data: gz ? await pipe(json, new CompressionStream('gzip')) : json, gz, json }
}

/** Encrypt (AES-256-GCM, fresh IV) and upload like an attachment. Returns the blob id. */
async function sealUpload(data: Uint8Array, key: Uint8Array, backup = false) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const k = await crypto.subtle.importKey('raw', bytes(key), 'AES-GCM', false, ['encrypt'])
  const blob = new Uint8Array([...iv, ...new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, bytes(data)))])
  const { id } = await rpc({ t: 'upload', size: blob.length, backup })
  const r = await fetch(`${SERVER.origin}/blob/${id}`, { method: 'PUT', body: blob })
  if (!r.ok) throw new Error('upload failed')
  return id as string
}

async function openDownload(id: string, key: Uint8Array, gz: boolean): Promise<Archive> {
  const r = await fetch(`${SERVER.origin}/blob/${id}`)
  if (!r.ok) throw new Error('download failed')
  const raw = new Uint8Array(await r.arrayBuffer())
  const k = await crypto.subtle.importKey('raw', bytes(key), 'AES-GCM', false, ['decrypt'])
  let data = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(raw.subarray(0, 12)) }, k, bytes(raw.subarray(12))))
  if (gz) data = await pipe(data, new DecompressionStream('gzip'))
  const a: Archive = JSON.parse(td.decode(data))
  if (a.v !== 1) throw new Error('unknown archive')
  return a
}

/** Chat history for a new device: encrypted with a fresh key and uploaded like an attachment. */
async function makeArchive(): Promise<ArchiveRef> {
  const { data, gz } = await packArchive()
  const key = crypto.getRandomValues(new Uint8Array(32))
  return { id: await sealUpload(data, key), key: b64(key), gz }
}

async function importArchive(ref: ArchiveRef) {
  await mergeArchive(await openDownload(ref.id, unb64(ref.key), ref.gz))
}

/**
 * Encrypted chat backup. The main device uploads its history once a day (when it changed),
 * encrypted with a key derived from the recovery phrase, so it opens with the phrase alone, on a new
 * phone after losing the old one. The server keeps the latest one and only ever sees ciphertext and
 * its size. Attachments come back while the server still has them (45 days); text is kept for good.
 */
const BACKUP_EVERY = 24 * 3_600_000
export async function backupNow(force = false) {
  if (!acct?.is_main || state.backup.busy || state.conn !== 'online' || typeof CompressionStream === 'undefined') return
  if (!force && state.settings.backup === false) return
  // Never replace a backup we haven't restored yet: it may hold the only copy of the old chats.
  if (await kv('restore')) return void (force && toast("Your old chats haven't been restored yet, so Fog won't replace their backup. Try restoring again in Settings."))
  set({ backup: { ...state.backup, busy: true } })
  try {
    const { data, json } = await packArchive(true)
    const hash = b64(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes(json))))
    const last = await kv<{ at: number; hash: string }>('backup')
    // Nothing changed since the last one: no need to upload the same thing again.
    if (!force && last?.hash === hash) return void (await kv('backup', { ...last, at: Date.now() }), set({ backup: { at: Date.now(), busy: false } }))
    const id = await sealUpload(data, acct.backup_key(), true)
    await rpc({ t: 'backup', id })
    await kv('backup', { at: Date.now(), hash })
    set({ backup: { at: Date.now(), busy: false } })
    if (force) toast('Chats backed up')
  } catch {
    set({ backup: { ...state.backup, busy: false } })
    if (force) toast("Couldn't back up your chats. Try again in a bit.")
  }
}
async function backupSoon() {
  const last = await kv<{ at: number }>('backup')
  if (last) set({ backup: { ...state.backup, at: last.at } })
  if (!last || Date.now() - last.at > BACKUP_EVERY) setTimeout(() => void backupNow(), 30_000)
}

/** Restore from the backup, once at a time. True when done (or there was nothing to restore). */
let restoring: Promise<boolean> | null = null
function tryRestore() {
  return (restoring ??= (async () => {
    try {
      await restoreBackup()
      await kv('restore', null)
      set({ backup: { ...state.backup, restoreFailed: false } })
      return true
    } catch {
      set({ backup: { ...state.backup, restoreFailed: true } })
      toast("Your account is back, but its chat backup couldn't be restored yet. Fog keeps the old backup until it is.")
      return false
    } finally {
      restoring = null
    }
  })())
}
export async function retryRestore() {
  if (await tryRestore()) void backupSoon()
}
/** Give up on the old backup and start fresh: the next backup replaces it. Only on the user's say-so. */
export async function skipRestore() {
  await kv('restore', null)
  set({ backup: { ...state.backup, restoreFailed: false } })
  await backupNow(true)
}

/** After restoring an account from its phrase: bring back the chats from its backup, if there is one. */
async function restoreBackup() {
  if (!acct?.is_main) return
  const { id } = await rpc({ t: 'backup' })
  if (!id) return
  const a = await openDownload(id, acct.backup_key(), true)
  await mergeArchive(a)
  if (a.profile && !state.profile.name) setProfile({ name: a.profile.name, avatar: a.profile.avatar })
  const n = Object.keys(a.chats).length
  toast(`Restored ${n} ${n === 1 ? 'chat' : 'chats'} from your backup`)
}

async function mergeArchive(a: Archive) {
  // Anything that arrived here while the history was on its way wins.
  const chats = { ...a.chats }
  for (const [id, c] of Object.entries(state.chats)) {
    const old = chats[id]
    chats[id] = old ? { ...old, messages: [...old.messages, ...c.messages.filter((m) => !old.messages.some((x) => x.id === m.id))], unread: old.unread + c.unread } : c
  }
  Object.keys(chats).forEach((id) => dirty.add(id))
  set({ chats, people: { ...a.people, ...state.people }, stickers: a.stickers ?? [], gifs: a.gifs ?? [], blocked: a.blocked ?? [] })
  await saveChats()
  await kv('people', state.people)
  await saveStickers()
  await saveGifs()
  await saveMeta()
}

/**
 * New device: show `onCode` (QR + text), wait for the main device, then set up this device and copy
 * the chat history. Resolves once it's ready to use.
 */
export async function linkThisDevice(onCode: (code: string) => void, onStep: (s: 'linking' | 'history') => void, signal: AbortSignal, confirm: (code: string) => Promise<boolean>) {
  const kp = link_keypair()
  const sock = new WebSocket(`${wsBase()}/link`)
  signal.addEventListener('abort', () => sock.close())
  const body = await new Promise<string>((res, rej) => {
    sock.onmessage = (e) => {
      const m = JSON.parse(e.data)
      if (m.t === 'channel') onCode(`fog-link:${m.id}:${b64url(kp.subarray(32))}`)
      else if (m.t === 'provision') res(m.body)
    }
    sock.onclose = () => rej(new Error(signal.aborted ? 'cancelled' : 'expired'))
  })
  sock.onclose = null
  sock.close()
  const opened = await linkOpen(kp.subarray(0, 32), unb64(body))
  // Someone who saw this screen's code could link it to *their* account; the matching code proves it's yours.
  if (!(await confirm(opened.code))) throw new Error('cancelled')
  onStep('linking')
  const p: LinkPayload = JSON.parse(td.decode(opened.data))
  acct = Account.create_linked(unb64(p.identity), p.device, Date.now())
  linkToken = p.token
  myAk = p.ak
  pinnedTrust = null
  skipped = p.skipped
  await saveAccount()
  await kv('uploaded', null)
  set({ me: { id: acct.id, username: p.username, device: acct.device, main: false }, profile: p.profile ?? state.profile })
  await saveMeta()
  signupError = null
  connect()
  await waitFor(() => state.conn === 'online' || !!signupError)
  if (signupError) {
    ws?.close()
    ws = null
    await kvClear()
    throw new Error("Couldn't finish linking. Try again.")
  }
  onStep('history')
  if (p.archive) await importArchive(p.archive).catch(() => toast("Your chat history couldn't be copied. New messages will arrive here."))
  set({ phase: 'app' })
}

/** Main device: link the device showing `code`. Resolves once the new device is set up. */
export async function linkDevice(code: string, onStep: (s: 'sending' | 'waiting', check?: string) => void) {
  const c = parseLinkCode(code)
  if (!c) throw new Error('bad_code')
  const { device, token } = await rpc({ t: 'link_begin' })
  onStep('sending')
  // ponytail: messages that arrive between this snapshot and the new device going live only reach this one.
  const archive = await makeArchive().catch(() => undefined)
  const payload: LinkPayload = { v: 1, identity: b64(acct!.link_identity()), device, token, ak: myAk, username: state.me!.username, skipped, profile: state.profile, archive }
  const sealed = await linkSeal(c.pub, te.encode(JSON.stringify(payload)))
  await rpc({ t: 'provision', channel: c.channel, body: b64(sealed.body) })
  onStep('waiting', sealed.code)
  await Promise.race([waitFor(() => state.devices.some((d) => d.id === device && d.ready)), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 120_000))])
  if (!archive) toast("Linked, but your chat history couldn't be copied")
}

// ---------- sending ----------
let cert: { b: Uint8Array; exp: number } | null = null
async function senderCert() {
  if (!cert || cert.exp - Date.now() < 3_600_000) {
    const r = await rpc({ t: 'cert' })
    cert = { b: unb64(r.cert), exp: r.expires }
  }
  return cert.b
}

/**
 * Prekey bundles for a contact, fetched without logging in: the request carries their access key
 * instead of who we are, so asking doesn't tell the server who's about to write to them.
 */
async function sealedBundles(peer: string, access: string, devices?: number[]): Promise<{ device: number; bundle: unknown }[]> {
  const r = await fetch(`${SERVER.origin}/sealed/bundles`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to: peer, access, devices }) })
  if (r.status === 401) throw new SealedRefused()
  if (!r.ok) throw new Error(`bundles ${r.status}`)
  return (await r.json()).bundles
}
/** A contact's server refused our sealed send. Retrying in the open would tell the server it's us, so that's the user's call. */
export class SealedRefused extends Error {
  constructor() {
    super('sealed_refused')
  }
}

/** Make sure we have sessions with each of these devices of `peer`, fetching their prekey bundles. With their access key (`ak`), anonymously. */
async function ensureSessions(peer: string, devices?: number[], ak?: string) {
  if (ak) {
    const need = devices?.filter((d) => !acct!.has_session(peer, d))
    if (need && !need.length) return
    for (const b of await sealedBundles(peer, ak, need)) if (!acct!.has_session(peer, b.device)) acct!.start_session(peer, b.device, JSON.stringify(b.bundle), Date.now())
    return
  }
  if (!devices) {
    const { bundles } = await rpc({ t: 'bundles', id: peer })
    for (const b of bundles) if (!acct!.has_session(peer, b.device)) acct!.start_session(peer, b.device, JSON.stringify(b.bundle), Date.now())
    return
  }
  for (const d of devices) {
    if (acct!.has_session(peer, d)) continue
    const { bundle } = await rpc({ t: 'bundle', id: peer, device: d })
    acct!.start_session(peer, d, JSON.stringify(bundle), Date.now())
  }
}
/** The server says our device list for `peer` is stale: forget removed devices, add new ones. */
async function fixDevices(peer: string, m: { missing?: number[]; extra?: number[] }, ak?: string) {
  for (const d of m.extra ?? []) acct!.drop_session(peer, d)
  await ensureSessions(peer, m.missing ?? [], ak)
}

/**
 * Send one encrypted payload to every device of `peer` (to your own other devices when `peer` is
 * you). To contacts who've shared their access key it goes sealed (the server never learns it was
 * from us); otherwise, e.g. a first message to a stranger, it's a normal send.
 */
function deliver(peer: string, p: Payload, opts: { openOk?: boolean } = {}) {
  return serial(async () => {
    const self = peer === acct!.id
    const bytes = pad(te.encode(JSON.stringify(p)))
    // Worth waking their phone for: messages and incoming calls, not receipts, typing or our own syncs.
    // (The server learns this one bit per message; Signal sends the same.)
    // Incoming calls ring (a 1:1 offer, or a group call starting); offers inside a group call don't.
    const call = p.t === 'call' && ((p.k === 'offer' && !p.gc) || p.k === 'ring')
    const urgent = (p.t === 'text' && !p.quiet) || call
    let ak = self ? undefined : state.people[peer]?.ak
    let akRequest = false
    const targets = () => Array.from(acct!.session_devices(peer)).filter((d) => !(self && d === acct!.device))
    if (!targets().length) await ensureSessions(peer, undefined, ak)
    // Each try encrypts for the devices we know; a stale list is corrected and we go again.
    for (let attempt = 0; attempt < 4; attempt++) {
      const devices = targets()
      if (!devices.length) return
      if (ak) {
        const c = await senderCert()
        const msgs = devices.map((d) => ({ device: d, body: b64(acct!.seal(peer, d, bytes, c, Date.now())) }))
        await saveAccount()
        const r = await fetch(`${SERVER.origin}/sealed`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to: peer, msgs, access: ak, urgent, call }) })
        if (r.ok) return
        if (r.status === 409) {
          await fixDevices(peer, await r.json(), ak)
          continue
        }
        // Anything but "wrong access key" fails the send instead of quietly revealing who we are.
        if (r.status !== 401) throw new Error(`sealed send failed: ${r.status}`)
        // Their key changed, they blocked us, or the server is trying to make us reveal ourselves. A
        // normal send would tell the server who's writing to them, so it only happens if the user says so.
        // (Then, like Signal, we ask for their new key so later messages go sealed again.)
        if (!opts.openOk) throw new SealedRefused()
        setPerson(peer, { ak: undefined })
        ak = undefined
        akRequest = true
        continue
      }
      const msgs = devices.map((d) => ({ device: d, body: b64(acct!.encrypt(peer, d, bytes, Date.now())) }))
      await saveAccount()
      try {
        await rpc({ t: 'send', to: peer, msgs, urgent, call })
      } catch (e: any) {
        if (e.message !== 'devices') throw e
        await fixDevices(peer, e.data)
        continue
      }
      if (akRequest) {
        const req = pad(te.encode(JSON.stringify({ t: 'akreq' })))
        const again = targets().map((d) => ({ device: d, body: b64(acct!.encrypt(peer, d, req, Date.now())) }))
        await saveAccount()
        await rpc({ t: 'send', to: peer, msgs: again }).catch(() => {})
      }
      return
    }
    throw new Error("Couldn't reach every device")
  })
}

/** Mirror something we did to our other devices (nothing to do with just one). */
function mirror(p: Payload) {
  if ('chat' in p && p.chat === GUIDE) return // the guide lives only on this device
  if (otherDevices().length) deliver(acct!.id, p).catch(() => {})
}

/** Send to one person in a chat (in a group: tagged as group traffic, so it shows in the group). */
async function deliverTo(chatId: string, who: string, p: Payload, opts: { openOk?: boolean } = {}) {
  const c = state.chats[chatId]
  if (!c || c.group?.left || !others(c).includes(who)) throw new Error('not in this chat')
  await deliver(who, c.group ? { ...p, g: chatId, gv: c.group.v, gh: c.group.hash } : p, opts)
}

/** Send to a chat: one peer, or every other group member (each with its own Signal session). */
async function deliverChat(chatId: string, p: Payload, opts: { openOk?: boolean } = {}) {
  const c = state.chats[chatId]
  if (!c || c.group?.left) return
  // Settle every member's copy before reporting, so one refusal doesn't hide another member's failure.
  const results = await Promise.allSettled(others(c).map((m) => deliver(m, c.group ? { ...p, g: chatId, gv: c.group.v, gh: c.group.hash } : p, opts)))
  const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
  if (failed.length) throw failed.find((r) => r.reason instanceof SealedRefused)?.reason ?? failed[0].reason
}

const patchMsg = (chat: string, id: string, patch: Partial<Msg>) => setMsgs(chat, (ms) => ms.map((m) => (m.id === id ? { ...m, ...patch } : m)))
/** A video's thumbnail came out black (made on an older app): use a frame we grabbed while it played. Local only. */
export function setVideoThumb(chat: string, id: string, thumb: string) {
  setMsgs(chat, (ms) => ms.map((m) => (m.id === id && m.att ? { ...m, att: { ...m.att, thumb } } : m)))
  saveChatsSoon()
}

/**
 * After blocking someone, replace our sealed-sender access key and re-share it with everyone else,
 * so the blocked person can no longer deliver sealed messages to us at all.
 */
function rotateAccessKey() {
  myAk = b64(crypto.getRandomValues(new Uint8Array(16)))
  rpc({ t: 'access', key: myAk }).catch(() => {})
  setProfile({})
  for (const c of Object.values(state.chats)) if (c.group && !c.group.left && !c.request) shareWithGroup(c.id)
}

/** Profiles are shared lazily: only with people we write to (like Signal's profile keys). */
async function shareProfile(peer: string, openOk = false) {
  if (isBlocked(peer)) return
  const p = state.profile
  if (state.people[peer]?.sent === p.v) return
  await deliver(peer, { t: 'profile', name: p.name, avatar: p.avatar, ak: myAk, bot: p.bot }, { openOk })
  setPerson(peer, { sent: p.v })
}

const wire = ({ lid: _, ...a }: Att): WireAtt => a

export type SendOpts = { reply?: string; att?: Att; fwd?: boolean; men?: string[]; poll?: Poll; link?: LinkPreview; md?: boolean; kb?: Row[]; card?: Card; live?: boolean; quiet?: boolean; only?: string; th?: string }
/** Send a message. Resolves (with its id) once it's sent, or has failed: see its status. */
export async function sendMessage(chat: string, text: string, opts: SendOpts = {}) {
  const ttl = state.chats[chat]?.timer || undefined
  const now = Date.now()
  const m: Msg = { id: msgId(), mine: true, text, ts: now, status: 'sending', reply: opts.reply, att: opts.att, fwd: opts.fwd, ttl, exp: ttl ? now + ttl * 1000 : undefined, men: opts.men?.length ? opts.men : undefined, poll: opts.poll, link: opts.link }
  for (const k of ['md', 'kb', 'card', 'live', 'quiet', 'only', 'th'] as const) if (opts[k]) Object.assign(m, { [k]: opts[k] })
  setChat(chat, (c) => ({ ...c, request: undefined, messages: [...c.messages, m] }))
  saveChatsSoon()
  await push(chat, m)
  return m.id
}
/** The bot fields of a message, as they go on the wire. */
const botWire = (m: Msg) => ({ md: m.md ? 1 : undefined, kb: m.kb, card: m.card, live: m.live ? 1 : undefined, quiet: m.quiet ? 1 : undefined, th: m.th }) as const

/** Attach files: each becomes its own message (caption goes on the first). */
export async function sendFiles(chat: string, files: File[], opts: { caption?: string; reply?: string; asFile?: boolean; th?: string } = {}) {
  for (const [i, f] of files.entries()) {
    if (f.size > MAX_FILE) {
      toast(`${f.name} is over 2 GB`)
      continue
    }
    try {
      const att = await prepare(f, opts.asFile)
      // Don't wait for the upload: every file shows up immediately with its own progress.
      void sendMessage(chat, i === 0 ? opts.caption ?? '' : '', { att, reply: i === 0 ? opts.reply : undefined, th: opts.th })
    } catch {
      toast(`Couldn't send ${f.name}`)
    }
  }
}

export async function sendAtt(chat: string, att: Att, text = '', reply?: string, th?: string) {
  await sendMessage(chat, text, { att, reply, th })
}

async function push(chat: string, m: Msg, openOk = false) {
  if (chat === SAVED && !otherDevices().length) return patchMsg(chat, m.id, { status: 'sent' })
  if (chat === GUIDE) return patchMsg(chat, m.id, { status: 'read' }), guide?.hear(m)
  try {
    let att = m.att
    if (att && !att.id) {
      att = await upload(att, (size) => rpc({ t: 'upload', size }).then((r) => r.id))
      patchMsg(chat, m.id, { att })
    }
    const c = state.chats[chat]
    for (const peer of c ? others(c) : []) await shareProfile(peer, openOk)
    if (chat === SAVED) {
      mirror({ t: 'sent', chat, p: { t: 'text', id: m.id, text: m.text, ts: m.ts, reply: m.reply, att: att && wire(att) } })
      return patchMsg(chat, m.id, { status: 'sent' })
    }
    const p: Payload = { t: 'text', id: m.id, text: m.text, ts: m.ts, reply: m.reply, fwd: m.fwd, att: att && wire(att), ttl: m.ttl, men: m.men, poll: m.poll, link: m.link, ...botWire(m) }
    // Our other devices first, so they already have the message when the recipient's receipt arrives.
    mirror({ t: 'sent', chat, p: m.only ? { ...p, only: m.only } : p })
    await (m.only ? deliverTo(chat, m.only, { ...p, only: 1 }, { openOk }) : deliverChat(chat, p, { openOk }))
    patchMsg(chat, m.id, { status: 'sent', sealFail: undefined })
  } catch (e) {
    patchMsg(chat, m.id, { status: 'failed', sealFail: e instanceof SealedRefused || undefined })
  }
}

/** Resend a failed message. `openOk`: the user agreed to send it without sealed sender (the server then learns it's from us). */
export const retry = (chat: string, m: Msg, openOk = false) => (patchMsg(chat, m.id, { status: 'sending' }), push(chat, m, openOk))

/** Resend anything that didn't make it while offline. Receivers dedupe by message id. */
function retryPending() {
  for (const c of Object.values(state.chats))
    for (const m of c.messages) if (m.mine && (m.status === 'sending' || m.status === 'failed')) push(c.id, m)
}

const lastTyping = new Map<string, number>()
export function typing(chat: string) {
  if (!state.settings.typing || Date.now() - (lastTyping.get(chat) ?? 0) < 4000 || !state.chats[chat]?.messages.length) return
  lastTyping.set(chat, Date.now())
  deliverChat(chat, { t: 'typing' }).catch(() => {})
}

export function react(chat: string, id: string, emoji: string | null) {
  setMsgs(chat, (ms) => ms.map((m) => (m.id === id ? { ...m, re: withReaction(m.re, 'me', emoji) } : m)))
  deliverChat(chat, { t: 'react', id, emoji }).catch(() => toast("Reaction wasn't sent. Check your connection."))
  mirror({ t: 'sent', chat, p: { t: 'react', id, emoji } })
}
function withReaction(re: Msg['re'], who: string, emoji: string | null | undefined) {
  const next = { ...re }
  if (emoji) next[who] = emoji
  else delete next[who]
  return next
}

// ---------- link previews, stickers, call servers ----------
/** Ask our server to fetch a preview (sender side only; recipients get it inside the message). */
export async function fetchPreview(url: string): Promise<{ url: string; title?: string; desc?: string; site?: string; image?: string } | null> {
  try {
    return (await rpc({ t: 'preview', url })).preview
  } catch {
    return null
  }
}

const saveStickers = () => kv('stickers', state.stickers)
export async function addSticker(file: File) {
  try {
    const att = await upload(await prepareSticker(file), (size) => rpc({ t: 'upload', size }).then((r) => r.id))
    set({ stickers: [att, ...state.stickers] })
    saveStickers()
    toast('Sticker added')
  } catch (e) {
    toast((e as Error).message === 'animated_too_large' ? 'Animated stickers can be up to 2 MB' : "Couldn't add that sticker")
  }
}
/** Save a received sticker or photo to your stickers (reuses the uploaded blob). */
export function saveSticker(att: Att) {
  if (state.stickers.some((s) => s.id === att.id)) return toast('Already in your stickers')
  set({ stickers: [{ ...att, kind: 'sticker' }, ...state.stickers] })
  saveStickers()
  toast('Saved to your stickers')
}
// Saved GIFs: sending one reuses its upload, like a sticker. Nothing goes to a GIF service.
const saveGifs = () => kv('gifs', state.gifs)
export const isGif = (a?: Att) => a?.mime === 'image/gif'
export async function addGif(file: File) {
  if (file.type !== 'image/gif') return toast('Choose a GIF')
  try {
    const att = await upload(await prepare(file), (size) => rpc({ t: 'upload', size }).then((r) => r.id))
    set({ gifs: [att, ...state.gifs] })
    saveGifs()
    toast('GIF saved')
  } catch {
    toast("Couldn't add that GIF")
  }
}
/** Save a GIF someone sent to your GIFs. */
export function saveGif(att: Att) {
  if (state.gifs.some((g) => g.id === att.id)) return toast('Already in your GIFs')
  set({ gifs: [{ ...att, kind: 'photo' }, ...state.gifs] })
  saveGifs()
  toast('Saved to your GIFs')
}
export function removeGif(lid: string) {
  set({ gifs: state.gifs.filter((g) => g.lid !== lid) })
  saveGifs()
}

export function removeSticker(lid: string) {
  set({ stickers: state.stickers.filter((s) => s.lid !== lid) })
  saveStickers()
}

let ice: { at: number; servers: RTCIceServer[] } | null = null
/** STUN/TURN servers for calls, with short-lived TURN credentials minted by our server. */
export async function iceServers(): Promise<RTCIceServer[]> {
  if (ice && Date.now() - ice.at < 3_600_000) return ice.servers
  try {
    ice = { at: Date.now(), servers: (await rpc({ t: 'ice' })).servers }
    return ice.servers
  } catch {
    return [{ urls: `stun:${SERVER.hostname}:3478` }]
  }
}

/** Vote in a poll (empty choices retracts). */
export function vote(chat: string, id: string, c: number[]) {
  setMsgs(chat, (ms) => ms.map((m) => (m.id === id ? { ...m, votes: withVote(m.votes, 'me', c) } : m)))
  if (chat === GUIDE) return void guide?.voted(id, c)
  deliverChat(chat, { t: 'vote', id, c }).catch(() => toast("Vote wasn't sent. Check your connection."))
  mirror({ t: 'sent', chat, p: { t: 'vote', id, c } })
}
function withVote(v: Msg['votes'], who: string, c: number[]) {
  const next = { ...v }
  if (c.length) next[who] = c
  else delete next[who]
  return next
}

// ---------- the Fog guide (script in guide.ts) ----------
type Guide = { start: () => void; hear: (m: Msg) => void; voted: (id: string, c: number[]) => void }
let guide: Guide | null = null
export const setGuide = (g: Guide) => void (guide = g)
/** Open the guide chat (from Settings), starting it again if it was deleted. */
export function openGuide() {
  // The chat has to exist before it's opened (the guide's first message arrives a moment later).
  if (!state.chats[GUIDE]) {
    setChat(GUIDE, (c) => c)
    saveChatsSoon()
    guide?.start()
  }
  openChat(GUIDE)
}
/** The guide writes a message (shown as typing first, like a person). */
export function guideSay(text: string, extra: Partial<Msg> = {}, typingMs = 900) {
  return new Promise<string>((res) => {
    setChat(GUIDE, (c) => ({ ...c, typing: { by: GUIDE, until: Date.now() + typingMs + 500 } }))
    setTimeout(() => {
      const m: Msg = { id: `guide.${crypto.randomUUID()}`, mine: false, from: GUIDE, text, ts: Date.now(), ...extra }
      setChat(GUIDE, (c) => ({ ...c, typing: undefined, unread: state.active === GUIDE && document.visibilityState === 'visible' ? c.unread : c.unread + 1, messages: [...c.messages, m] }))
      saveChatsSoon()
      if (state.active === GUIDE) markRead(GUIDE)
      res(m.id)
    }, typingMs)
  })
}
/** The guide reacts to one of your messages. */
export function guideReact(id: string, emoji: string) {
  setMsgs(GUIDE, (ms) => ms.map((m) => (m.id === id ? { ...m, re: withReaction(m.re, GUIDE, emoji) } : m)))
  saveChatsSoon()
}

// ---------- calls (signaling only; media lives in call.ts) ----------
type CallSignal = Extract<Payload, { t: 'call' }>
let onCall: ((from: string, dev: number, p: CallSignal) => void) | null = null
export const setCallHandler = (f: typeof onCall) => void (onCall = f)
/** Call signaling rides the Signal session, so SDP (incl. DTLS fingerprints) is end-to-end authenticated. */
export const sendSignal = (peer: string, p: Omit<CallSignal, 't'>) => deliver(peer, { t: 'call', ...p })
/** A group call signal for everyone in the group (each copy end-to-end encrypted, like any message). */
export const sendGroupSignal = (group: string, p: Omit<CallSignal, 't'>) => deliverChat(group, { t: 'call', ...p })
/** Is `who` a current member of group `gid` (and are we)? */
export const inGroupCall = (gid: string, who: string) => {
  const g = state.chats[gid]?.group
  return !!g && !g.left && g.members.includes(who) && !g.gone?.includes(who)
}
/** Tell our other devices to stop ringing: this one answered or declined. */
export const callHandled = (id: string) => mirror({ t: 'call', id, k: 'elsewhere' })

export function addCallRecord(peer: string, call: CallRecord, by?: string) {
  const me = state.me!.id
  const missed = !call.out && call.missed
  const req = !state.chats[peer] || !!state.chats[peer].request
  setChat(peer, (c) => ({ ...c, request: req && !call.out ? true : c.request, unread: missed && state.active !== peer ? c.unread + 1 : c.unread, messages: [...c.messages, sysMsg({ k: 'call', by: by ?? (call.out ? me : peer), call })] }))
  saveChats()
  if (missed && !req) notify(peer, `Missed ${call.video ? 'video' : 'voice'} call`)
}

/**
 * Invite links: https://host/app/#add=<account id> opens a chat with that account. On phones with
 * the app installed, /app/ links open the app (see public/.well-known). The id stays in the
 * fragment, so it never reaches the server. Older links (https://host/#add=...) still work.
 */
export const inviteLink = () => `${SERVER.origin}/app/#add=${state.me?.id}`
async function handleInvite() {
  const m = /^#add=([A-Za-z0-9_-]{43})$/.exec(location.hash)
  if (!m) return
  history.replaceState(null, '', location.pathname)
  if (m[1] === state.me?.id) return
  try {
    await findPeer(m[1])
    startChat(m[1])
  } catch {
    toast("That invite link doesn't match any account")
  }
}
window.addEventListener('hashchange', () => state.conn === 'online' && handleInvite())

export type EditOpts = { kb?: Row[] | null; card?: Card | null; live?: boolean }
/** Edit one of our messages. Bots can also swap its buttons or card, and stream into it (`live`). */
export function editMessage(chat: string, id: string, text: string, opts: EditOpts = {}) {
  const m = state.chats[chat]?.messages.find((x) => x.id === id)
  if (!m?.mine || (m.text === text && opts.kb === undefined && opts.card === undefined && opts.live === undefined)) return Promise.resolve()
  const p: Extract<Payload, { t: 'edit' }> = { t: 'edit', id, text, kb: opts.kb, card: opts.card, live: opts.live === undefined ? undefined : opts.live ? 1 : 0 }
  patchMsg(chat, id, applyEdit(m, p))
  mirror({ t: 'sent', chat, p })
  const sent = m.only ? deliverTo(chat, m.only, p) : deliverChat(chat, p)
  sent.catch(() => toast("Edit wasn't sent. Check your connection."))
  return sent
}
/** What an edit changes. A message being streamed (or just finished) isn't marked "edited". */
function applyEdit(x: Msg, p: Extract<Payload, { t: 'edit' }>): Partial<Msg> {
  const patch: Partial<Msg> = { text: str(p.text, 65536) }
  if (p.live !== undefined) patch.live = p.live === 1 || undefined
  else if (!x.live && patch.text !== x.text) patch.edited = true // swapping only buttons or the card isn't an edit
  if (p.kb !== undefined) patch.kb = p.kb === null ? undefined : readKb(p.kb)
  if (p.card !== undefined) patch.card = p.card === null ? undefined : readCard(p.card)
  return patch
}

/** Drop a local attachment copy unless another message (e.g. a forward) still uses it. */
function releaseAtt(att?: Att) {
  if (!att) return
  for (const c of Object.values(state.chats)) if (c.messages.some((m) => m.att?.lid === att.lid)) return
  dropLocal(att.lid)
}

export function deleteMessages(chat: string, ids: string[], everyone: boolean) {
  const gone = state.chats[chat]?.messages.filter((x) => ids.includes(x.id)) ?? []
  setMsgs(chat, (ms) => ms.filter((x) => !ids.includes(x.id)))
  gone.forEach((m) => releaseAtt(m.att))
  if (everyone)
    for (const m of gone)
      if (m.mine && m.status !== 'failed') {
        deliverChat(chat, { t: 'delete', id: m.id }).catch(() => toast("Couldn't delete for everyone. Check your connection."))
        mirror({ t: 'sent', chat, p: { t: 'delete', id: m.id } })
      }
}

/** Forward copies (attachments reuse the uploaded blob; nothing is re-uploaded). */
export function forward(chat: string, ids: string[], targets: string[]) {
  const msgs = (state.chats[chat]?.messages ?? []).filter((m) => ids.includes(m.id) && !m.sys)
  for (const t of targets) for (const m of msgs) sendMessage(t, m.text, { att: m.att, fwd: true })
  toast(targets.length === 1 ? `Forwarded to ${chatTitle(state.chats[targets[0]])}` : `Forwarded to ${targets.length} chats`)
}

// ---------- chat list actions ----------
export function setDraft(chat: string, draft: string) {
  if (!state.chats[chat] || (state.chats[chat].draft ?? '') === draft) return
  setChat(chat, (c) => ({ ...c, draft }))
  saveChatsSoon()
}
export function pinChat(chat: string, pinned: boolean) {
  setChat(chat, (c) => ({ ...c, pinned }))
  saveChatsSoon()
  mirror({ t: 'chatmeta', chat, pinned })
}
export function markUnread(chat: string, unread: boolean) {
  if (unread) setChat(chat, (c) => ({ ...c, markedUnread: true }))
  else (setChat(chat, (c) => ({ ...c, markedUnread: false })), markRead(chat))
  saveChatsSoon()
}
export function muteChat(chat: string, until: number) {
  setChat(chat, (c) => ({ ...c, muted: until || undefined }))
  saveChatsSoon()
  mirror({ t: 'chatmeta', chat, muted: until })
}
export function archiveChat(chat: string, archived: boolean) {
  setChat(chat, (c) => ({ ...c, archived: archived || undefined, pinned: archived ? false : c.pinned }))
  saveChatsSoon()
  mirror({ t: 'chatmeta', chat, archived, ...(archived ? { pinned: false } : {}) })
  if (archived && state.active === chat) openChat(null)
}
export function openSaved() {
  if (!state.chats[SAVED]) setChat(SAVED, (c) => c)
  saveChatsSoon()
  openChat(SAVED)
}

/** Disappearing messages: both sides switch together; the change shows as a system line. */
export function setTimer(chat: string, secs: number) {
  setChat(chat, (c) => ({ ...c, timer: secs || undefined, messages: [...c.messages, sysMsg({ k: 'timer', by: state.me!.id, secs })] }))
  saveChats()
  deliverChat(chat, { t: 'timer', s: secs }).catch(() => toast("Timer change wasn't sent. Check your connection."))
  mirror({ t: 'sent', chat, p: { t: 'timer', s: secs } })
}

export function pinMessage(chat: string, id: string, on: boolean) {
  const m = state.chats[chat]?.messages.find((x) => x.id === id)
  setChat(chat, (c) => ({
    ...c,
    pins: on ? [...(c.pins ?? []).filter((x) => x !== id), id] : (c.pins ?? []).filter((x) => x !== id),
    messages: on && m ? [...c.messages, sysMsg({ k: 'pin', by: state.me!.id, name: m.text.slice(0, 60) || attLabel(m.att!) })] : c.messages,
  }))
  saveChats()
  deliverChat(chat, { t: 'pin', id, on }).catch(() => {})
  mirror({ t: 'sent', chat, p: { t: 'pin', id, on } })
}

// ---------- message requests & blocking ----------
export const isBlocked = (id: string) => state.blocked.includes(id)
/** Someone we've accepted: we started the chat, wrote to them, or accepted their request. */
export const isTrusted = (id: string) => !isBlocked(id) && !!state.chats[id] && !state.chats[id].request

/** Bots: treat a chat as an unanswered request again (no receipts or profile), e.g. after removing someone from the allowlist. */
export function unaccept(chat: string) {
  if (!state.chats[chat] || state.chats[chat].request) return
  setChat(chat, (c) => ({ ...c, request: true }))
  saveChatsSoon()
}

export function acceptRequest(chat: string) {
  setChat(chat, (c) => ({ ...c, request: undefined }))
  saveChats()
  mirror({ t: 'chatmeta', chat, accepted: true })
  markRead(chat)
  if (state.chats[chat]?.group) shareWithGroup(chat)
}

export function block(id: string) {
  if (!isBlocked(id)) set({ blocked: [...state.blocked, id] })
  rotateAccessKey()
  saveMeta()
  mirror({ t: 'acct', blocked: state.blocked, ak: myAk })
  if (state.chats[id]?.request) deleteChat(id)
  toast('Blocked')
}
export function unblock(id: string) {
  set({ blocked: state.blocked.filter((b) => b !== id) })
  saveMeta()
  mirror({ t: 'acct', blocked: state.blocked })
  toast('Unblocked')
}
export async function report(id: string) {
  rpc({ t: 'report', id }).catch(() => {})
  block(id)
  if (state.chats[id]) deleteChat(id)
  toast('Reported and blocked')
}

export function deleteChat(chat: string) {
  const c = state.chats[chat]
  if (c?.group && !c.group.left) leaveGroup(chat)
  const { [chat]: _, ...rest } = state.chats
  dirty.add(chat)
  set({ chats: rest, active: state.active === chat ? null : state.active })
  c?.messages.forEach((m) => releaseAtt(m.att))
  saveChats()
  mirror({ t: 'chatmeta', chat, deleted: true })
}

// ---------- groups ----------
// Group state (members, name, photo) is versioned and signed by the owner's identity key. Members
// only accept newer, correctly signed versions, and every group message carries a fingerprint of the
// sender's view: if two members hold the same version with different contents (an owner showing
// different groups to different people), everyone is warned.
const ID_RE = /^[A-Za-z0-9_-]{43}$/
/** g:<owner account id>:<random>. Binding the owner into the id stops anyone else claiming the group. */
const GID_RE = /^g:[A-Za-z0-9_-]{43}:[A-Za-z0-9_-]{22}$/
/** Message ids start with the sender's account id prefix (checked on receipt in groups). */
const msgId = () => `${state.me!.id.slice(0, 16)}.${crypto.randomUUID()}`
const sysMsg = (sys: Sys, ts = Date.now()): Msg => ({ id: crypto.randomUUID(), mine: false, text: '', ts, sys, seen: true })

const sha256 = async (s: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', te.encode(s)))
async function groupCanon(id: string, g: { members: string[]; owner: string; v: number }, name: string, avatar?: string) {
  const av = avatar ? b64((await sha256(avatar)).subarray(0, 16)) : ''
  return `fog-group-v1\n${id}\n${g.v}\n${g.owner}\n${name}\n${av}\n${[...g.members].sort().join(',')}`
}
const groupHash = async (canon: string) => b64((await sha256(canon)).subarray(0, 16))

/** Owner side: bump the version and sign the new state. */
async function signGroup(id: string, members: string[], name: string, avatar?: string, prev?: Group): Promise<Group> {
  const g = { members, owner: state.me!.id, v: (prev?.v ?? 0) + 1 }
  const canon = await groupCanon(id, g, name, avatar)
  return { ...g, sig: b64(acct!.sign(te.encode(canon))), hash: await groupHash(canon) }
}

export async function createGroup(name: string, members: string[], avatar?: string) {
  const me = state.me!.id
  const id = `g:${me}:${b64(crypto.getRandomValues(new Uint8Array(16))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`
  const group = await signGroup(id, [me, ...members.filter((m) => m !== me)].slice(0, MAX_GROUP), name, avatar)
  setChat(id, () => ({ id, messages: [sysMsg({ k: 'create', by: me, name })], unread: 0, group, name, avatar }))
  saveChats()
  openChat(id)
  await announce(id)
  shareWithGroup(id)
  return id
}

/** Joining a group means choosing to be seen by its members, so they get our name and photo (like Signal). */
function shareWithGroup(id: string) {
  const c = state.chats[id]
  if (c?.group && !c.group.left) others(c).forEach((m) => void shareProfile(m).catch(() => {}))
}

/** Send the group's current signed state to every other member (and to anyone just removed). */
async function announce(id: string, extra: string[] = []) {
  const c = state.chats[id]
  if (!c?.group?.sig) return
  const g = c.group
  const p: Payload = { t: 'group', g: id, name: c.name ?? '', avatar: c.avatar, members: g.members, owner: g.owner, v: g.v!, sig: g.sig! }
  const to = [...new Set([...g.members, ...extra])].filter((m) => m !== state.me?.id)
  await Promise.all(to.map((m) => deliver(m, p).catch(() => {})))
  mirror({ t: 'sent', chat: id, p })
}

export async function updateGroup(id: string, patch: { name?: string; avatar?: string | null; add?: string[]; remove?: string[] }) {
  const c = state.chats[id]
  const me = state.me!.id
  if (!c?.group || c.group.owner !== me || c.group.left) return
  const members = [...new Set([...c.group.members.filter((m) => !patch.remove?.includes(m)), ...(patch.add ?? [])])].slice(0, MAX_GROUP)
  const name = patch.name ?? c.name ?? ''
  const avatar = patch.avatar === null ? undefined : (patch.avatar ?? c.avatar)
  const group = await signGroup(id, members, name, avatar, c.group)
  const sys: Msg[] = []
  if (patch.add?.length) sys.push(sysMsg({ k: 'add', by: me, who: patch.add }))
  if (patch.remove?.length) sys.push(sysMsg({ k: 'remove', by: me, who: patch.remove }))
  if (patch.name && patch.name !== c.name) sys.push(sysMsg({ k: 'rename', by: me, name: patch.name }))
  setChat(id, (c) => ({ ...c, name, avatar, group: { ...group, gone: c.group?.gone?.filter((x) => members.includes(x)) }, messages: [...c.messages, ...sys] }))
  saveChats()
  await announce(id, patch.remove ?? [])
  if (patch.add?.length) shareWithGroup(id)
  // New members don't have the history, so tell them which threads exist (and who started each).
  const threads = Object.values(state.chats[id]?.threads ?? {}).filter((t) => t.v)
  for (const m of patch.add ?? []) for (const t of threads) deliverTo(id, m, { t: 'thread', id: t.id, name: t.name, v: t.v, by: '' }).catch(() => {})
}

/** Leaving is its own message; the owner then signs a new member list without us. */
export async function leaveGroup(id: string) {
  const c = state.chats[id]
  const me = state.me!.id
  if (!c?.group || c.group.left) return
  await Promise.all(others(c).map((m) => deliver(m, { t: 'leave', g: id }).catch(() => {})))
  mirror({ t: 'sent', chat: id, p: { t: 'leave' } })
  setChat(id, (c) => ({ ...c, group: { ...c.group!, left: true }, messages: [...c.messages, sysMsg({ k: 'leave', by: me })] }))
  saveChats()
}

function onLeave(from: string, id: string, ts: number) {
  const c = state.chats[id]
  if (!c?.group || !c.group.members.includes(from) || c.group.gone?.includes(from)) return
  setChat(id, (c) => ({ ...c, group: { ...c.group!, gone: [...(c.group!.gone ?? []), from] }, messages: [...c.messages, sysMsg({ k: 'leave', by: from }, ts)] }))
  if (c.group.owner === state.me?.id) queueMicrotask(() => void updateGroup(id, { remove: [from] }))
}

async function onGroup(from: string, p: Extract<Payload, { t: 'group' }>, ts: number) {
  const id = p.g!
  const members = Array.isArray(p.members) ? [...new Set(p.members.filter((m) => typeof m === 'string' && ID_RE.test(m)))].slice(0, MAX_GROUP) : []
  const name = str(p.name, 64).trim()
  const avatar = imgUrl(p.avatar, 120_000)
  const me = state.me!.id
  const v = Number(p.v)
  // Only the owner publishes group state, and it must be signed by their identity key.
  if (from !== p.owner || id.slice(2, 45) !== from || !members.includes(from) || !Number.isInteger(v) || v < 1 || typeof p.sig !== 'string') return
  const canon = await groupCanon(id, { members, owner: from, v }, name, avatar)
  if (!verifySig(from, te.encode(canon), unb64(p.sig))) return
  const hash = await groupHash(canon)
  const cur = state.chats[id]?.group
  if (!cur) {
    if (!members.includes(me)) return
    // A group we created on another of our devices.
    if (from === me) return setChat(id, () => ({ id, messages: [sysMsg({ k: 'create', by: me, name }, ts)], unread: 0, group: { members, owner: me, v, sig: p.sig, hash }, name, avatar }))
    setChat(id, () => ({ id, messages: [sysMsg({ k: 'add', by: from, who: [me] }, ts)], unread: 1, group: { members, owner: from, v, sig: p.sig, hash }, name, avatar, request: !isTrusted(from) || undefined }))
    members.forEach((m) => m !== me && !state.people[m] && resolveName(m))
    // Not awaited: we're inside the receive queue, and sharing enqueues sends behind it.
    if (isTrusted(from)) shareWithGroup(id)
    return
  }
  if (cur.owner !== from) return // ownership never changes
  if (v === cur.v && hash !== cur.hash) return forked(id, ts)
  if (v <= (cur.v ?? 0)) return // stale or duplicate
  const added = members.filter((m) => !cur.members.includes(m))
  const removed = cur.members.filter((m) => !members.includes(m) && !cur.gone?.includes(m))
  const sys: Msg[] = []
  if (added.length) sys.push(sysMsg({ k: 'add', by: from, who: added }, ts))
  if (removed.length) sys.push(sysMsg({ k: 'remove', by: from, who: removed }, ts))
  if (name && name !== state.chats[id].name) sys.push(sysMsg({ k: 'rename', by: from, name }, ts))
  setChat(id, (c) => ({
    ...c,
    name,
    avatar,
    group: { members, owner: from, v, sig: p.sig, hash, gone: c.group?.gone?.filter((x) => members.includes(x)), left: !members.includes(me) || c.group?.left },
    messages: [...c.messages, ...sys],
  }))
  added.forEach((m) => m !== me && !state.people[m] && resolveName(m))
  if (added.length) added.forEach((m) => m !== me && void shareProfile(m).catch(() => {}))
}

/** Someone holds a different signed state for the same version: the owner equivocated. */
function forked(id: string, ts: number) {
  const c = state.chats[id]
  if (!c?.group || c.group.forkedAt === c.group.v) return
  setChat(id, (c) => ({ ...c, group: { ...c.group!, forkedAt: c.group!.v }, messages: [...c.messages, sysMsg({ k: 'fork', by: c.group!.owner }, ts)] }))
}

// ---------- receiving ----------
const rank: Record<Status, number> = { failed: 0, sending: 1, sent: 2, delivered: 3, read: 4 }
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '')
const num = (v: unknown, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(Number(v) || lo)))
const imgUrl = (v: unknown, max: number) => (typeof v === 'string' && v.length <= max && /^data:image\/(webp|jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(v) ? v : undefined)
const KINDS: Kind[] = ['photo', 'video', 'audio', 'voice', 'file', 'sticker', 'videonote']

/** Validate an attachment pointer from a peer. */
function readAtt(a: any): Att | undefined {
  if (!a || typeof a.id !== 'string' || !/^[0-9a-f]{32}$/.test(a.id) || typeof a.key !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(a.key)) return
  return {
    // Local cache key includes the key, so a forged pointer to a known blob id can't reuse our plaintext.
    lid: `${a.id}.${a.key.slice(0, 10).replace(/[+/]/g, '_')}`,
    id: a.id,
    key: a.key,
    kind: KINDS.includes(a.kind) ? a.kind : 'file',
    size: num(a.size, 0, MAX_FILE),
    mime: str(a.mime, 100),
    name: str(a.name, 255).replace(/[\\/\0]/g, '_') || 'file',
    w: a.w ? num(a.w, 1, 16384) : undefined,
    h: a.h ? num(a.h, 1, 16384) : undefined,
    dur: Number.isFinite(+a.dur) ? Math.min(Math.max(0, +a.dur), 86400) : undefined,
    thumb: imgUrl(a.thumb, 80_000),
    wave: Array.isArray(a.wave) ? a.wave.slice(0, 100).map((v: unknown) => num(v, 0, 31)) : undefined,
    // Big files come in 4 MB encrypted chunks (the only chunk size there is).
    ch: a.ch === 4 * 1024 * 1024 ? a.ch : undefined,
  }
}

// ---------- bots: what a peer may send, checked and capped like everything else ----------
const COLOR = /^#[0-9a-fA-F]{6}$/
const CMD = /^[a-z0-9_-]{1,32}$/
const isUrl = (u: string) => /^https?:\/\/[^\s]+$/.test(u)
const choice = (x: any, max = 100) => ({ l: str(x?.l, max).trim(), v: str(x?.v, max) })
function readKb(v: unknown): Row[] | undefined {
  if (!Array.isArray(v)) return
  const rows: Row[] = []
  for (const r of v.slice(0, 10)) {
    if (Array.isArray(r)) {
      const bs: Btn[] = []
      for (const b of r.slice(0, 8)) {
        const l = str(b?.l, 64).trim()
        const d = str(b?.d, 256)
        const u = str(b?.u, 2048)
        if (!l || (!d && !isUrl(u))) continue
        bs.push({ l, ...(d ? { d } : { u }), ...(['primary', 'danger', 'success'].includes(b.s) ? { s: b.s } : {}) })
      }
      if (bs.length) rows.push(bs)
    } else if (r && typeof r === 'object' && typeof (r as Sel).sel === 'string') {
      const s = r as Sel
      const o = Array.isArray(s.o) ? s.o.slice(0, 25).map((x) => ({ ...choice(x), ...(x?.d ? { d: str(x.d, 100) } : {}), ...(x?.on ? { on: true } : {}) })).filter((x) => x.l && x.v) : []
      if (!o.length || !s.sel) continue
      const max = num(s.max ?? 1, 1, o.length)
      rows.push({ sel: str(s.sel, 100), ph: str(s.ph, 150) || undefined, o, min: num(s.min ?? 1, 0, max), max })
    }
  }
  return rows.length ? rows : undefined
}
function readCard(v: any): Card | undefined {
  if (!v || typeof v !== 'object') return
  const c: Card = { title: str(v.title, 256) || undefined, color: COLOR.test(v.color) ? v.color : undefined, footer: str(v.footer, 256) || undefined }
  return c.title || c.color || c.footer ? c : undefined
}
function readBot(v: any): BotInfo | undefined {
  if (!v || typeof v !== 'object') return
  const cmds = Array.isArray(v.cmds)
    ? v.cmds
        .slice(0, 100)
        .filter((c: any) => CMD.test(c?.n))
        .map((c: any): BotCmd => {
          const o = Array.isArray(c.o)
            ? c.o
                .slice(0, 25)
                .filter((x: any) => CMD.test(x?.n))
                .map((x: any) => ({ n: x.n, d: str(x.d, 100), ...(x.req ? { req: true } : {}), ...(x.auto ? { auto: true } : {}), ...(Array.isArray(x.ch) ? { ch: x.ch.slice(0, 25).map((y: any) => choice(y)).filter((y: any) => y.l && y.v) } : {}) }))
            : []
          return { n: c.n, d: str(c.d, 100), ...(o.length ? { o } : {}) }
        })
    : []
  return { about: str(v.about, 512) || undefined, cmds: cmds.length ? cmds : undefined }
}
function readForm(v: any): Form | undefined {
  if (!v || typeof v !== 'object' || !str(v.id, 100) || !Array.isArray(v.f)) return
  const f = v.f
    .slice(0, 5)
    .map((x: any) => ({ id: str(x?.id, 100), l: str(x?.l, 45).trim(), ph: str(x?.ph, 100) || undefined, long: !!x?.long || undefined, secret: !!x?.secret || undefined, req: !!x?.req || undefined, min: x?.min ? num(x.min, 0, 4000) : undefined, max: x?.max ? num(x.max, 1, 4000) : undefined }))
    .filter((x: any) => x.id && x.l)
  return f.length ? { id: str(v.id, 100), title: str(v.title, 45) || 'Form', f } : undefined
}
/** The bot parts of a text payload, checked. */
function readBotParts(p: any): Partial<Msg> {
  const out: Partial<Msg> = {}
  if (p.md) out.md = true
  if (p.live) out.live = true
  if (p.quiet) out.quiet = true
  const kb = readKb(p.kb)
  if (kb) out.kb = kb
  const card = readCard(p.card)
  if (card) out.card = card
  return out
}

/** The bot daemon (bot/) listens here; the app doesn't. */
export type Tap = { chat: string; from: string; msg: string; data: string; q: string; values?: string[]; fields?: Record<string, string> }
export type BotHooks = {
  message?(chat: string, m: Msg, from: string): void
  edited?(chat: string, m: Msg, from: string): void
  deleted?(chat: string, id: string, from: string): void
  reaction?(chat: string, id: string, from: string, emoji: string | null): void
  button?(e: Tap): void
  autocomplete?(e: { chat: string; from: string; q: string; cmd: string; opt: string; val: string; args: string }): void
  group?(chat: string): void
  thread?(chat: string, t: Thread, from: string, created: boolean): void
}
let bot: BotHooks | null = null
export const setBotHooks = (h: BotHooks) => void (bot = h)
// ---------- threads ----------
/** Thread ids are message-style: the starter's id prefix, then a uuid (so nobody can start one as someone else). */
const THREAD_RE = /^[A-Za-z0-9_-]{16}\.[0-9a-f-]{36}$/
/** The thread a message says it's in. One we haven't heard of yet (we joined later) gets a placeholder. */
function threadOf(chat: string, th: unknown): string | undefined {
  if (typeof th !== 'string' || !THREAD_RE.test(th)) return
  // Placeholder until its name arrives (the owner sends existing threads to new members; see updateGroup).
  if (!state.chats[chat]?.threads?.[th]) setChat(chat, (c) => ({ ...c, threads: { ...c.threads, [th]: { id: th, name: 'Thread', by: '', ts: Date.now(), v: 0 } } }))
  return th
}
function onThread(chat: string, from: string, p: Extract<Payload, { t: 'thread' }>, ts: number) {
  const c = state.chats[chat]
  const id = str(p.id, 64)
  if (!c || !THREAD_RE.test(id)) return
  const cur = c.threads?.[id]
  const fresh = !cur || !cur.v
  // The owner catching us up on a thread from before we joined. We can't check who really started it
  // (the owner could claim anyone), so it isn't credited to anyone: `by` stays unknown ('').
  const sync = fresh && typeof p.by === 'string' && from === c.group?.owner
  const prefixOf = (who: string) => id.startsWith(`${who.slice(0, 16)}.`)
  // Started by whoever's id it carries; renamed by them (for a thread we were caught up on: whoever's id
  // prefix it has) or the group's owner.
  if (fresh ? !sync && !prefixOf(from) : from !== c.group?.owner && (cur.by ? from !== cur.by : !prefixOf(from))) return
  const v = num(p.v, 1, 1e15)
  if (cur && v <= cur.v) return
  const root = typeof p.root === 'string' && c.messages.some((x) => x.id === p.root) ? p.root : cur?.root
  const t: Thread = { id, name: str(p.name, 100).trim() || 'Thread', root, by: fresh ? (sync ? '' : from) : cur.by, ts: cur?.ts ?? ts, v }
  // A thread we're only being caught up on is in the Threads list, not announced in the chat as new.
  setChat(chat, (c) => ({ ...c, threads: { ...c.threads, [id]: t }, messages: fresh && !root && !sync ? [...c.messages, sysMsg({ k: 'thread', by: from, name: t.name, th: id }, ts)] : c.messages }))
  if (from !== state.me?.id) bot?.thread?.(chat, t, from, fresh)
}
/** Start a thread, from a message or on its own. Resolves with its id. */
export async function createThread(chat: string, name: string, root?: string) {
  const p = { t: 'thread' as const, id: msgId(), name: name.trim().slice(0, 100) || 'Thread', root, v: Date.now() }
  onThread(chat, state.me!.id, p, p.v)
  await saveChats()
  mirror({ t: 'sent', chat, p })
  await deliverChat(chat, p)
  return p.id
}
export async function renameThread(chat: string, id: string, name: string) {
  const t = state.chats[chat]?.threads?.[id]
  if (!t) return
  const p = { t: 'thread' as const, id, name: name.trim().slice(0, 100) || t.name, root: t.root, v: Math.max(Date.now(), t.v + 1) }
  onThread(chat, state.me!.id, p, Date.now())
  saveChatsSoon()
  mirror({ t: 'sent', chat, p })
  await deliverChat(chat, p)
}
export const openThread = (id: string | null) => set({ thread: id })

/** Forms we asked someone to fill in, so only those can come back (key: who:form id). */
const forms = new Map<string, { msg: string; until: number; form: Form }>()

/** A tap on one of our messages. Only on buttons we really sent, or forms we asked for: nobody can invent callback data. */
function onTap(chat: string, from: string, p: Extract<Payload, { t: 'btn' }>) {
  const m = state.chats[chat]?.messages.find((x) => x.id === p.id && x.mine)
  const d = str(p.d, 256)
  const q = str(p.q, 64)
  if (!m || !d || !q || (m.only && m.only !== from)) return
  const rows = m.kb ?? []
  const sel = rows.find((r): r is Sel => !Array.isArray(r) && r.sel === d)
  const form = forms.get(`${from}:${d}`)
  const e: Tap = { chat, from, msg: m.id, data: d, q }
  if (sel) {
    const v = Array.isArray(p.v) ? [...new Set(p.v.map((x) => str(x, 100)))].filter((x) => sel.o.some((o) => o.v === x)) : []
    if (v.length < (sel.min ?? 1) || v.length > (sel.max ?? 1)) return
    e.values = v
  } else if (form && form.msg === m.id && form.until > Date.now()) {
    // Exactly the fields we asked for, within their rules (a modified client can send anything), and only once.
    if (!p.f || typeof p.f !== 'object') return
    const got = p.f as Record<string, unknown>
    if (Object.keys(got).some((k) => !form.form.f.some((f) => f.id === k))) return
    const fields: Record<string, string> = {}
    for (const f of form.form.f) {
      const v = typeof got[f.id] === 'string' ? (got[f.id] as string) : ''
      const n = v.trim().length
      if ((f.req && !n) || (n && f.min && v.length < f.min) || v.length > (f.max ?? 4000)) return
      fields[f.id] = v
    }
    forms.delete(`${from}:${d}`)
    e.fields = fields
  } else if (!rows.some((r) => Array.isArray(r) && r.some((b) => b.d === d))) return
  bot?.button?.(e)
}

/** Taps waiting for the bot's answer (key: bot:query id). Answers nobody asked for are ignored. */
const tapWaits = new Map<string, { chat: string; msg: string; done: () => void }>()
function onTapAnswer(chat: string, from: string, p: Extract<Payload, { t: 'btnack' }>) {
  const w = tapWaits.get(`${from}:${p.q}`)
  if (!w || w.chat !== chat) return
  const form = readForm(p.form)
  const text = str(p.text, 2000).trim()
  if (form) set({ form: { chat, msg: w.msg, bot: from, form } })
  else if (text && p.alert) set({ alert: { text, at: Date.now(), from } })
  else if (text) toast(text)
  w.done()
}
/** Tap a bot's button or choose from its dropdown (`v`), or send a filled-in form (`f`). Resolves when the bot answers (or after 15 s). */
export function tap(chat: string, msg: string, botId: string, d: string, extra: { v?: string[]; f?: Record<string, string> } = {}) {
  const q = crypto.randomUUID()
  const key = `${botId}:${q}`
  return new Promise<void>((res) => {
    const done = () => (tapWaits.delete(key), res())
    tapWaits.set(key, { chat, msg, done })
    setTimeout(done, 15_000)
    deliverTo(chat, botId, { t: 'btn', id: msg, d, q, ...extra }).catch(() => (toast("Couldn't reach the bot. Check your connection."), done()))
  })
}
export const closeForm = () => set({ form: null })
export const closeAlert = () => set({ alert: null })
/** Suggestions from a bot for a command option, as you type it (nothing after 3 s: none). */
const autoWaits = new Map<string, (o: { l: string; v: string }[]) => void>()
export function suggest(chat: string, botId: string, cmd: string, opt: string, val: string, args = val) {
  const q = crypto.randomUUID()
  const key = `${botId}:${q}`
  return new Promise<{ l: string; v: string }[]>((res) => {
    const done = (o: { l: string; v: string }[] = []) => (autoWaits.delete(key), res(o))
    autoWaits.set(key, done)
    setTimeout(done, 3000)
    deliverTo(chat, botId, { t: 'auto', q, cmd, opt, val, args }).catch(() => done())
  })
}
/** Bots: answer a tap with a note, an alert, or a form to fill in (on message `msg`). */
export function answerTap(chat: string, to: string, q: string, a: { text?: string; alert?: boolean; form?: Form; msg?: string }) {
  const form = a.form && readForm(a.form)
  if (form && a.msg) forms.set(`${to}:${form.id}`, { msg: a.msg, until: Date.now() + 15 * 60_000, form })
  return deliverTo(chat, to, { t: 'btnack', q, text: a.text, alert: a.alert ? 1 : undefined, form })
}
/** Bots: answer an autocomplete request. */
export const answerSuggest = (chat: string, to: string, q: string, o: { l: string; v: string }[]) => deliverTo(chat, to, { t: 'autoans', q, o: o.slice(0, 25) })

export const attLabel = (a: Att) => ({ photo: '📷 Photo', video: '🎬 Video', voice: '🎤 Voice message', audio: `🎵 ${a.name}`, file: `📎 ${a.name}`, sticker: '✨ Sticker', videonote: '📹 Video message' })[a.kind]

let warnedFull = 0
function storageFull() {
  if (Date.now() - warnedFull < 600_000) return
  warnedFull = Date.now()
  toast("This device is out of storage. New messages are waiting on the server until you free up space.")
}
const lastReset = new Map<string, number>()
/**
 * Decrypted messages we couldn't store yet (device full). The ratchet already moved past them in
 * memory, so a redelivery can't be decrypted again; we keep the plaintext until it's saved.
 */
const unsaved = new Map<number, { from: string; decoded: Payload }>()

function receive(m: { id: number; from: string | null; dev?: number; sealed?: boolean; body: string; ts: number }) {
  serial(async () => {
    let decoded: Payload
    let from = m.from ?? ''
    let dev = m.dev ?? 1
    const kept = unsaved.get(m.id)
    unsaved.delete(m.id)
    if (kept) ({ from, decoded } = kept)
    else try {
      if (m.sealed) {
        // Sealed: the server doesn't know the sender; the certificate inside tells us, and the
        // inner Signal message must still decrypt under that sender's identity.
        if (!pinnedTrust) throw new Error('no trust root')
        // Certificates are checked at server receipt time, so messages that waited offline still open.
        const out = acct!.unseal(unb64(m.body), unb64(pinnedTrust), m.ts)
        from = td.decode(out.subarray(0, 43))
        dev = out[43]
        decoded = JSON.parse(td.decode(unpad(out.subarray(44))))
      } else decoded = JSON.parse(td.decode(unpad(acct!.decrypt(from, dev, unb64(m.body)))))
    } catch (e) {
      // Already handled (its ack was lost): libsignal refuses the reused message key. Nothing to show.
      if (/old counter/.test(String(e))) return ack(m.id)
      console.warn('decrypt failed', e)
      if (m.sealed || !ID_RE.test(from) || isBlocked(from) || from === acct!.id) return ack(m.id)
      // No session (e.g. we restored on a new device): start a fresh one so their next message works.
      // At most once per sender per 10 minutes, so a server can't use us to burn people's prekeys.
      if (from !== acct!.id && !acct!.has_session(from, dev) && Date.now() - (lastReset.get(from) ?? 0) > 600_000) {
        lastReset.set(from, Date.now())
        queueMicrotask(() => deliver(from, { t: 'reset' }).catch(() => {}))
      }
      const unknown = !state.chats[from]
      if (!state.chats[from]?.messages.some((x) => x.id === `sys-${m.id}`))
        setChat(from, (c) => ({ ...c, request: unknown || c.request, messages: [...c.messages, { ...sysMsg({ k: 'decrypt', by: from }, m.ts), id: `sys-${m.id}` }] }))
      await saveChats()
      ack(m.id)
      return
    }
    // Order matters: chat first, then ratchet state, then ack. If a save fails we stop before the
    // ack, so the server keeps the message; and the stored ratchet hasn't moved past it, so it can
    // still be decrypted after a reload.
    const keep = () => (unsaved.set(m.id, { from, decoded }), storageFull())
    // Blocked: decrypted (keeps the session in step) and dropped. Same for anything that isn't a
    // payload object: a valid Signal message can still carry `null` or `[]`.
    const valid = !isBlocked(from) && !!decoded && typeof decoded === 'object' && !Array.isArray(decoded) && typeof decoded.t === 'string'
    try {
      // From another of our own devices: only sync messages, never chat traffic.
      if (valid && from === acct!.id) await handleSync(m, dev, decoded)
      else if (valid) await handlePayload(m, from, dev, decoded)
    } catch (e) {
      if (e instanceof StorageError) return keep()
      // A peer-crafted payload must never wedge our queue: an unacked message comes back on every
      // reconnect, and enough of them fill the server-side queue so nobody else can reach us.
      console.warn('dropping message that failed to process', e)
    }
    try {
      await saveAccount()
    } catch (e) {
      if (e instanceof StorageError) return keep()
      throw e
    }
    ack(m.id)
  })
}

/** A chat id we accept in sync messages: a person, a group, or Saved Messages. */
const okChat = (id: unknown): id is string => typeof id === 'string' && (ID_RE.test(id) || GID_RE.test(id) || id === SAVED)

/**
 * From another of our own devices: things we did there. Applied as our own actions, never as
 * someone else's message, and nothing is sent onward.
 */
async function handleSync(m: { id: number; ts: number }, dev: number, p: Payload) {
  const me = acct!.id
  // Only from devices currently on the account (a just-linked one may not be in our list yet).
  if (!ownDevices.includes(dev)) await refreshDevices()
  if (!ownDevices.includes(dev)) return
  if (p.t === 'sent' && okChat(p.chat) && p.p && typeof p.p === 'object') {
    const chat = p.chat
    const q = p.p
    if (q.t === 'text') {
      const id = str(q.id, 64)
      if (!id || state.chats[chat]?.messages.some((x) => x.id === id) || (isGroup(chat) && !state.chats[chat]?.group)) return
      const ttl = num(q.ttl, 0, 604800)
      const msg: Msg = { id, mine: true, text: str(q.text, 65536), ts: Math.min(Number(q.ts) || m.ts, m.ts), status: 'sent' }
      if (q.reply) msg.reply = str(q.reply, 64)
      if (q.fwd) msg.fwd = true
      if (ttl) (msg.ttl = ttl), (msg.exp = Date.now() + ttl * 1000)
      if (Array.isArray(q.men)) msg.men = q.men.filter((x) => typeof x === 'string' && ID_RE.test(x)).slice(0, 50)
      const att = readAtt(q.att)
      if (att) msg.att = att
      if (q.poll && typeof q.poll === 'object' && Array.isArray(q.poll.o)) msg.poll = { q: str(q.poll.q, 300), o: q.poll.o.map((x) => str(x, 100)).slice(0, 10), multi: !!q.poll.multi }
      if (q.link && typeof q.link === 'object' && /^https?:\/\//.test(str(q.link.url, 2048))) msg.link = { url: str(q.link.url, 2048), title: str(q.link.title, 200) || undefined, desc: str(q.link.desc, 300) || undefined, site: str(q.link.site, 80) || undefined, img: imgUrl(q.link.img, 120_000) }
      Object.assign(msg, readBotParts(q))
      if (typeof q.only === 'string' && ID_RE.test(q.only)) msg.only = q.only
      const th = threadOf(chat, q.th)
      if (th) msg.th = th
      setChat(chat, (c) => ({ ...c, request: undefined, archived: undefined, messages: [...c.messages, msg] }))
      if (att && att.size < 15_000_000) download(att)
    } else if (q.t === 'react') {
      setChat(chat, (c) => ({ ...c, messages: c.messages.map((x) => (x.id === q.id ? { ...x, re: withReaction(x.re, 'me', q.emoji ? str(q.emoji, 16) : null) } : x)) }))
    } else if (q.t === 'edit') {
      setChat(chat, (c) => ({ ...c, messages: c.messages.map((x) => (x.id === q.id && x.mine ? { ...x, ...applyEdit(x, q) } : x)) }))
    } else if (q.t === 'delete') {
      const gone = state.chats[chat]?.messages.find((x) => x.id === q.id && x.mine)
      setChat(chat, (c) => ({ ...c, messages: c.messages.filter((x) => !(x.mine && x.id === q.id)) }))
      releaseAtt(gone?.att)
    } else if (q.t === 'vote' && Array.isArray(q.c)) {
      setChat(chat, (c) => ({ ...c, messages: c.messages.map((x) => (x.id === q.id && x.poll ? { ...x, votes: withVote(x.votes, 'me', q.c.map(Number).filter((i) => Number.isInteger(i) && i >= 0 && i < x.poll!.o.length)) } : x)) }))
    } else if (q.t === 'timer') {
      const secs = TIMERS.includes(Number(q.s)) ? Number(q.s) : 0
      setChat(chat, (c) => ({ ...c, timer: secs || undefined, messages: [...c.messages, sysMsg({ k: 'timer', by: me, secs }, m.ts)] }))
    } else if (q.t === 'pin') {
      const target = state.chats[chat]?.messages.find((x) => x.id === q.id)
      if (target)
        setChat(chat, (c) => ({
          ...c,
          pins: q.on ? [...(c.pins ?? []).filter((x) => x !== q.id), q.id] : (c.pins ?? []).filter((x) => x !== q.id),
          messages: q.on ? [...c.messages, sysMsg({ k: 'pin', by: me, name: target.text.slice(0, 60) || attLabel(target.att!) }, m.ts)] : c.messages,
        }))
    } else if (q.t === 'thread') {
      onThread(chat, me, q, m.ts)
    } else if (q.t === 'group' && GID_RE.test(chat)) {
      await onGroup(me, { ...q, g: chat }, m.ts)
    } else if (q.t === 'leave' && state.chats[chat]?.group) {
      setChat(chat, (c) => ({ ...c, group: { ...c.group!, left: true }, messages: [...c.messages, sysMsg({ k: 'leave', by: me }, m.ts)] }))
    }
  } else if (p.t === 'read' && okChat(p.chat) && state.chats[p.chat]) {
    const at = Number(p.at) || m.ts
    const now = Date.now()
    setChat(p.chat, (c) => ({ ...c, unread: 0, mentions: 0, markedUnread: false, messages: c.messages.map((x) => (x.mine || x.seen || x.ts > at ? x : { ...x, seen: true, exp: x.ttl ? now + x.ttl * 1000 : undefined })) }))
  } else if (p.t === 'acct') {
    if (p.profile && typeof p.profile === 'object' && Number(p.profile.v) > state.profile.v)
      set({ profile: { name: str(p.profile.name, 64), avatar: imgUrl(p.profile.avatar, 120_000), v: Number(p.profile.v), bot: readBot(p.profile.bot) } })
    if (Array.isArray(p.blocked)) set({ blocked: p.blocked.filter((x) => typeof x === 'string' && ID_RE.test(x)) })
    if (typeof p.ak === 'string' && /^[A-Za-z0-9+/]{22}==$/.test(p.ak)) myAk = p.ak
    await saveMeta()
  } else if (p.t === 'chatmeta' && okChat(p.chat) && state.chats[p.chat]) {
    const chat = p.chat
    if (p.deleted) {
      const c = state.chats[chat]
      const { [chat]: _, ...rest } = state.chats
      dirty.add(chat)
      set({ chats: rest, active: state.active === chat ? null : state.active })
      c?.messages.forEach((x) => releaseAtt(x.att))
    } else
      setChat(chat, (c) => ({
        ...c,
        pinned: p.pinned ?? c.pinned,
        muted: p.muted === undefined ? c.muted : p.muted || undefined,
        archived: p.archived === undefined ? c.archived : p.archived || undefined,
        request: p.accepted ? undefined : c.request,
      }))
  } else if (p.t === 'call' && p.k === 'elsewhere') {
    const sig = p
    setTimeout(() => onCall?.(me, dev, sig), 0)
  }
  if (p.t !== 'call') await saveChats()
}

async function handlePayload(m: { id: number; ts: number }, from: string, dev: number, decoded: Payload) {
  // The peer is a trust boundary too: everything below is validated and size-capped.
  const p = decoded
  let chat = from
  if (p.g !== undefined) {
    if (typeof p.g !== 'string' || !GID_RE.test(p.g)) return
    if (p.t === 'group') {
      await onGroup(from, p, m.ts)
      await saveChats()
      bot?.group?.(p.g)
      return
    }
    if (p.t === 'leave') {
      onLeave(from, p.g, m.ts)
      await saveChats()
      bot?.group?.(p.g)
      return
    }
    const g = state.chats[p.g]?.group
    // Group traffic is only accepted from current members.
    if (!g || g.left || !g.members.includes(from) || g.gone?.includes(from)) return
    chat = p.g
    // Same version, different fingerprint: members were shown different groups.
    if (Number(p.gv) === g.v && typeof p.gh === 'string' && g.hash && p.gh !== g.hash) forked(chat, m.ts)
  }
  const known = !!state.chats[chat]
  const inGroup = chat !== from
  // A DM from someone with no chat yet starts as a message request.
  const fresh = (c: Chat): Chat => (!known && !inGroup ? { ...c, request: true } : c)
  const own = (id: unknown) => state.chats[chat]?.messages.find((x) => x.id === id && !x.mine && (x.from ?? from) === from)
  let receipt: Payload | null = null
  if (p.t === 'text') {
    const id = str(p.id, 64)
    if (id && (!inGroup || id.startsWith(`${from.slice(0, 16)}.`)) && !state.chats[chat]?.messages.some((x) => x.id === id)) {
      const viewing = state.active === chat && document.visibilityState === 'visible'
      const msg: Msg = { id, mine: false, text: str(p.text, 65536), ts: Math.min(Number(p.ts) || m.ts, m.ts), seen: viewing }
      if (inGroup) msg.from = from
      if (p.reply) msg.reply = str(p.reply, 64)
      if (p.fwd) msg.fwd = true
      const ttl = num(p.ttl, 0, 604800)
      if (ttl) (msg.ttl = ttl), viewing && (msg.exp = Date.now() + ttl * 1000)
      if (inGroup && Array.isArray(p.men)) {
        msg.men = p.men.filter((x) => typeof x === 'string' && ID_RE.test(x)).slice(0, 50)
        msg.mentionsMe = msg.men.includes(state.me!.id)
      }
      const att = readAtt(p.att)
      if (att) msg.att = att
      if (p.poll && typeof p.poll === 'object' && Array.isArray(p.poll.o)) {
        const o = p.poll.o.map((x) => str(x, 100).trim()).filter(Boolean).slice(0, 10)
        const q = str(p.poll.q, 300).trim()
        if (q && o.length >= 2) msg.poll = { q, o, multi: !!p.poll.multi }
      }
      // A card must describe a link that's really in the message, labelled with its real host,
      // so a sender can't dress evil.example up as a bank.
      const linkUrl = p.link && typeof p.link === 'object' ? str(p.link.url, 2048) : ''
      const linkHost = /^https?:\/\//.test(linkUrl) && msg.text.includes(linkUrl) ? URL.parse(linkUrl)?.hostname.replace(/^www\./, '') : undefined
      if (p.link && linkHost) {
        msg.link = {
          url: linkUrl,
          title: str(p.link.title, 200) || undefined,
          desc: str(p.link.desc, 300) || undefined,
          site: linkHost,
          img: imgUrl(p.link.img, 120_000),
        }
      }
      Object.assign(msg, readBotParts(p))
      const th = threadOf(chat, p.th)
      if (th) msg.th = th
      // "Only you can see this": in a group, a message sent to us alone.
      if (p.only && inGroup) msg.only = state.me!.id
      if (msg.text || msg.att || msg.poll) {
        const c0 = state.chats[chat]
        const muted = !!c0 && isMuted(c0)
        setChat(chat, (c) => ({
          ...fresh(c),
          typing: undefined,
          unread: viewing ? 0 : c.unread + 1,
          mentions: !viewing && msg.mentionsMe ? (c.mentions ?? 0) + 1 : c.mentions,
          // A new message pulls a chat out of the archive unless it's muted (like Telegram).
          archived: c.archived && (muted || viewing) ? c.archived : undefined,
          messages: [...c.messages, msg],
        }))
        const req = !known ? !inGroup : !!state.chats[chat].request
        // Requests get no receipts: they don't learn you've seen anything until you accept.
        if (!req) receipt = { t: 'receipt', ids: [id], s: viewing && state.settings.readReceipts ? 'read' : 'delivered' }
        // Photos and voice notes download right away, like other messengers. Big files wait for a tap.
        if (att && (att.kind === 'photo' || att.kind === 'voice' || (att.kind !== 'file' && att.size < 15_000_000))) download(att)
        if (!viewing && !req && !msg.quiet && (!muted || msg.mentionsMe)) {
          if (state.settings.sounds) chime()
          const body = msg.poll ? `📊 ${msg.poll.q}` : msg.text || attLabel(att!)
          notify(chat, inGroup ? `${personName(from)}: ${body}` : body)
        }
        bot?.message?.(chat, msg, from)
      }
    }
  } else if (p.t === 'receipt' && known && Array.isArray(p.ids)) {
    const ids = new Set(p.ids)
    const s = p.s === 'read' ? 'read' : 'delivered'
    setChat(chat, (c) => ({
      ...c,
      messages: c.messages.map((x) => {
        if (!x.mine || !ids.has(x.id)) return x
        if (inGroup) return x.rc?.[from] === 'read' ? x : { ...x, rc: { ...x.rc, [from]: s } }
        return rank[s] > rank[x.status ?? 'sent'] ? { ...x, status: s } : x
      }),
    }))
  } else if (p.t === 'typing' && known && !state.chats[chat].request) {
    setChat(chat, (c) => ({ ...c, typing: { by: from, until: Date.now() + 5000 } }))
    setTimeout(() => set({ chats: { ...state.chats } }), 5100)
  } else if (p.t === 'react' && known) {
    const emoji = p.emoji ? str(p.emoji, 16) : null
    setChat(chat, (c) => ({ ...c, messages: c.messages.map((x) => (x.id === p.id ? { ...x, re: withReaction(x.re, from, emoji) } : x)) }))
    if (typeof p.id === 'string') bot?.reaction?.(chat, p.id, from, emoji)
  } else if (p.t === 'edit' && own(p.id)) {
    setChat(chat, (c) => ({ ...c, messages: c.messages.map((x) => (x.id === p.id && !x.mine ? { ...x, ...applyEdit(x, p) } : x)) }))
    bot?.edited?.(chat, own(p.id)!, from)
  } else if (p.t === 'delete' && own(p.id)) {
    const gone = own(p.id)
    setChat(chat, (c) => ({ ...c, messages: c.messages.filter((x) => x.mine || x.id !== p.id) }))
    releaseAtt(gone?.att)
    bot?.deleted?.(chat, p.id, from)
  } else if (p.t === 'thread' && known) {
    onThread(chat, from, p, m.ts)
  } else if (p.t === 'btn' && known && !state.chats[chat].request) {
    onTap(chat, from, p)
  } else if (p.t === 'btnack' && typeof p.q === 'string') {
    onTapAnswer(chat, from, p)
  } else if (p.t === 'auto' && known && !state.chats[chat].request && typeof p.q === 'string') {
    bot?.autocomplete?.({ chat, from, q: str(p.q, 64), cmd: str(p.cmd, 32), opt: str(p.opt, 32), val: str(p.val, 100), args: str(p.args, 1000) })
  } else if (p.t === 'autoans' && typeof p.q === 'string') {
    const o = Array.isArray(p.o) ? p.o.slice(0, 25).map((x) => ({ l: str(x?.l, 100), v: str(x?.v, 100) })).filter((x) => x.l && x.v) : []
    autoWaits.get(`${from}:${p.q}`)?.(o)
  } else if (p.t === 'vote' && known && Array.isArray(p.c)) {
    const target = state.chats[chat].messages.find((x) => x.id === p.id && x.poll)
    if (target?.poll) {
      const n = target.poll.o.length
      const c = [...new Set(p.c.map(Number).filter((i) => Number.isInteger(i) && i >= 0 && i < n))].slice(0, target.poll.multi ? n : 1)
      setChat(chat, (ch) => ({ ...ch, messages: ch.messages.map((x) => (x.id === p.id ? { ...x, votes: withVote(x.votes, from, c) } : x)) }))
    }
  } else if (p.t === 'call' && !inGroup && (p.to === undefined || p.to === acct!.device)) {
    const sig = p
    setTimeout(() => onCall?.(from, dev, sig), 0)
  } else if (p.t === 'call' && inGroup && known && (p.k === 'ring' || p.k === 'hello' || p.k === 'leave' || p.k === 'screen')) {
    // Group call signals: the sender is a member (checked above), and `gc` is the group itself.
    const sig = { ...p, gc: chat }
    setTimeout(() => onCall?.(from, dev, sig), 0)
  } else if (p.t === 'timer' && (known || !inGroup)) {
    const secs = TIMERS.includes(Number(p.s)) ? Number(p.s) : 0
    setChat(chat, (c) => ({ ...fresh(c), timer: secs || undefined, messages: [...c.messages, sysMsg({ k: 'timer', by: from, secs }, m.ts)] }))
  } else if (p.t === 'pin' && known) {
    const target = state.chats[chat].messages.find((x) => x.id === p.id)
    if (target)
      setChat(chat, (c) => ({
        ...c,
        pins: p.on ? [...(c.pins ?? []).filter((x) => x !== p.id), p.id] : (c.pins ?? []).filter((x) => x !== p.id),
        messages: p.on ? [...c.messages, sysMsg({ k: 'pin', by: from, name: target.text.slice(0, 60) || attLabel(target.att!) }, m.ts)] : c.messages,
      }))
  } else if (p.t === 'akreq') {
    // Not awaited: we're inside the receive queue.
    if (isTrusted(from)) setPerson(from, { sent: undefined }), void shareProfile(from).catch(() => {})
  } else if (p.t === 'profile') {
    setPerson(from, { name: str(p.name, 64).trim() || undefined, avatar: imgUrl(p.avatar, 120_000), ak: typeof p.ak === 'string' && /^[A-Za-z0-9+/]{22}==$/.test(p.ak) ? p.ak : undefined, bot: readBot(p.bot) })
  }
  if (p.t !== 'typing' && p.t !== 'call') await saveChats()
  if (receipt) deliver(from, inGroup ? { ...receipt, g: chat } : receipt).catch(() => {})
  if (!state.people[from]?.username && state.people[from]?.username !== null) resolveName(from)
}

const resolving = new Set<string>()
async function resolveName(id: string) {
  if (resolving.has(id)) return
  resolving.add(id)
  try {
    const r = await rpc({ t: 'profile', id })
    setPerson(id, { username: r.username ?? null })
  } catch {
    resolving.delete(id)
  }
}

function notify(chat: string, text: string) {
  const c = state.chats[chat]
  const previews = state.settings.previews !== false
  const title = previews && c ? chatTitle(c) : 'Fog'
  const body = previews ? text : 'New message'
  if (desktop) {
    // Native notification whenever the window isn't in front (including hidden in the menu bar).
    // Phones with push in the background: the push already says "New message".
    if (pushOn && document.hidden) return
    if (state.settings.notifications !== false && !document.hasFocus()) desktop.invoke('notify', { title, body }).catch(() => {})
    return
  }
  if (document.visibilityState === 'visible' || typeof Notification === 'undefined' || Notification.permission !== 'granted') return
  const n = new Notification(title, { body, tag: chat, icon: previews && c ? chatAvatar(c) : undefined })
  n.onclick = () => (window.focus(), openChat(chat), n.close())
}

/** Open a chat and send read receipts for anything unseen. */
export function openChat(id: string | null) {
  set({ active: id, thread: null })
  if (id) markRead(id)
}

export function markRead(id: string) {
  const c = state.chats[id]
  if (!c || document.visibilityState !== 'visible') return
  const unseen = c.messages.filter((m) => !m.mine && !m.seen && !m.sys)
  if (!c.unread && !c.markedUnread && !c.mentions && (!unseen.length || c.request)) return
  const now = Date.now()
  setChat(id, (c) => ({
    ...c,
    unread: 0,
    mentions: 0,
    markedUnread: false,
    // Requests stay unacknowledged (no receipts, timers not started) until accepted.
    messages: c.request ? c.messages : c.messages.map((m) => (m.mine || m.seen ? m : { ...m, seen: true, exp: m.ttl ? now + m.ttl * 1000 : undefined })),
  }))
  saveChatsSoon()
  if (unseen.length || c.unread) mirror({ t: 'read', chat: id, at: now })
  if (!unseen.length || !state.settings.readReceipts || isLocalChat(id) || c.request) return
  if (!c.group) return void deliver(id, { t: 'receipt', ids: unseen.map((m) => m.id), s: 'read' }).catch(() => {})
  // In groups, each sender gets receipts for their own messages.
  const bySender = new Map<string, string[]>()
  for (const m of unseen) if (m.from) bySender.set(m.from, [...(bySender.get(m.from) ?? []), m.id])
  bySender.forEach((ids, from) => deliver(from, { t: 'receipt', ids, s: 'read', g: id }).catch(() => {}))
}

/** Group delivery state for one of our messages: read/delivered only once everyone has. */
export function msgStatus(c: Chat, m: Msg): Status | undefined {
  if (!c.group || m.status === 'sending' || m.status === 'failed') return m.status
  const os = others(c)
  if (os.length && os.every((o) => m.rc?.[o] === 'read')) return 'read'
  if (os.length && os.every((o) => m.rc?.[o])) return 'delivered'
  return m.status
}

document.addEventListener('visibilitychange', () => state.active && markRead(state.active))

// Disappearing messages vanish (with their attachments) once their deadline passes.
// ponytail: scans every message each second; index deadlines if histories get huge.
setInterval(() => {
  const now = Date.now()
  for (const c of Object.values(state.chats)) {
    if (!c.messages.some((m) => m.exp && m.exp <= now)) continue
    const gone = c.messages.filter((m) => m.exp && m.exp <= now)
    setChat(c.id, (c) => ({ ...c, messages: c.messages.filter((m) => !(m.exp && m.exp <= now)), pins: c.pins?.filter((p) => !gone.some((g) => g.id === p)) }))
    gone.forEach((m) => releaseAtt(m.att))
    saveChatsSoon()
  }
}, 1000)

/** Find someone by @username or by pasted account id. */
export async function findPeer(query: string): Promise<{ id: string; username: string | null }> {
  // Accept a pasted invite link too.
  const q = (/#add=([A-Za-z0-9_-]{43})/.exec(query)?.[1] ?? query).trim().replace(/^@/, '')
  const r = ID_RE.test(q) ? await rpc({ t: 'profile', id: q }) : await rpc({ t: 'lookup', name: q.toLowerCase() })
  if (r.id !== state.me?.id) setPerson(r.id, { username: r.username ?? null })
  return { id: r.id, username: r.username ?? null }
}

export function startChat(id: string) {
  if (id === state.me?.id) throw new Error("That's you")
  if (!state.chats[id]) setChat(id, (c) => c)
  saveChatsSoon()
  openChat(id)
}
