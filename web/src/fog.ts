// Client engine: keys, server connection, Signal sessions, chats, groups.
// Everything that touches crypto goes through `serial` so ratchet state is saved in order.
import { useSyncExternalStore } from 'react'
import init, { Account, link_agree, link_keypair, new_mnemonic, solve_pow, valid_mnemonic, verify as verifySig } from './core/fog_core.js'
import { isUnlocked, kv, kvClear, lockEnabled, StorageError } from './db'
import { chime, dropLocal, MAX_FILE, SERVER, prepare, prepareSticker, upload, download, type Att, type Kind } from './media'

export { new_mnemonic as newPhrase, valid_mnemonic as validPhrase }

export type Status = 'sending' | 'sent' | 'delivered' | 'read' | 'failed'
export type CallRecord = { out: boolean; video: boolean; dur?: number; missed?: boolean; declined?: boolean }
export type Sys = { k: 'create' | 'add' | 'remove' | 'leave' | 'rename' | 'decrypt' | 'timer' | 'pin' | 'call' | 'fork'; by: string; who?: string[]; name?: string; secs?: number; call?: CallRecord }
export type Poll = { q: string; o: string[]; multi?: boolean }
export type LinkPreview = { url: string; title?: string; desc?: string; site?: string; img?: string }
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
  /** From someone we haven't accepted yet: no receipts, no ringing, no notifications. */
  request?: boolean
}
export type Person = { username?: string | null; name?: string; avatar?: string; sent?: number; /** Their sealed-sender access key. */ ak?: string; /** Safety number confirmed in person. */ verified?: boolean }
export type Profile = { name: string; avatar?: string; v: number }
export type Settings = { readReceipts: boolean; typing: boolean; sounds: boolean; theme: 'system' | 'light' | 'dark'; textSize: number; linkPreviews: boolean; relayCalls: boolean; autoLock: number; lockPrompted?: boolean; /** Desktop app: native notifications. */ notifications?: boolean; /** Show the sender and text in notifications (off: just "New message"). */ previews?: boolean; /** Desktop layout: chat list width, or folded to an avatar rail. */ sidebar?: number; sidebarCollapsed?: boolean }
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
  blocked: string[]
  /** Our devices, from the server. */
  devices: DeviceInfo[]
}
export type DeviceInfo = { id: number; name: string | null; created: number; seen: number; ready: boolean }

// Wire form of an attachment pointer (inside the encryption).
type WireAtt = Omit<Att, 'lid'>
// Payloads inside the encryption. The server never sees these. `g` scopes a payload to a group.
type Payload = (
  | { t: 'text'; id: string; text: string; ts: number; reply?: string; att?: WireAtt; fwd?: boolean; ttl?: number; men?: string[]; poll?: Poll; link?: LinkPreview }
  | { t: 'vote'; id: string; c: number[] }
  /** `to`: only that device of the recipient acts on it. 'elsewhere': answered or declined on another of our devices. */
  /** 'screen': the sender started (`on`) or stopped sharing their screen, so the other side shows it whole. */
  | { t: 'call'; id: string; k: 'offer' | 'answer' | 'end' | 'decline' | 'busy' | 'elsewhere' | 'screen'; sdp?: string; video?: boolean; to?: number; on?: boolean }
  | { t: 'receipt'; ids: string[]; s: 'delivered' | 'read' }
  | { t: 'typing' }
  | { t: 'reset' }
  | { t: 'react'; id: string; emoji: string | null }
  | { t: 'edit'; id: string; text: string }
  | { t: 'delete'; id: string }
  | { t: 'profile'; name: string; avatar?: string; ak?: string }
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
  settings: { readReceipts: true, typing: true, sounds: true, theme: 'system', textSize: 16, linkPreviews: false, relayCalls: false, autoLock: 5 },
  jump: null,
  toast: null,
  stickers: [],
  blocked: [],
  devices: [],
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
export const isMuted = (c: Chat) => (c.muted ?? 0) > Date.now()
export const TIMERS = [0, 30, 300, 3600, 86400, 604800]
export const timerLabel = (s = 0) => (!s ? 'Off' : s < 60 ? `${s} seconds` : s < 3600 ? `${s / 60} minutes` : s < 86400 ? `${s / 3600} hour${s === 3600 ? '' : 's'}` : s < 604800 ? `${s / 86400} day${s === 86400 ? '' : 's'}` : '1 week')

export const shortId = (id: string) => `${id.slice(0, 6)}…${id.slice(-4)}`
/** Display name for a person: their shared name, else @username, else a short id. */
export const personName = (id: string, p = state.people[id]) => (id === state.me?.id ? 'You' : p?.name || (p?.username ? `@${p.username}` : shortId(id)))
export const chatTitle = (c: Chat, p?: Person) => (c.id === SAVED ? 'Saved Messages' : c.group ? c.name || 'Group' : personName(c.id, p ?? state.people[c.id]))
export const chatAvatar = (c: Chat, p?: Person) => (c.group ? c.avatar : (p ?? state.people[c.id])?.avatar)
export const others = (c: Chat) => (c.id === SAVED ? [] : c.group ? c.group.members.filter((m) => m !== state.me?.id && !c.group!.gone?.includes(m)) : [c.id])

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
  set({ chats: await loadChats(), people: (await kv<Record<string, Person>>('people')) ?? {}, stickers: (await kv<Att[]>('stickers')) ?? [], blocked: meta?.blocked ?? [] })
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
  const os = /Mac/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : 'this computer'
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
type Archive = { v: 1; chats: Record<string, Chat>; people: Record<string, Person>; stickers: Att[]; blocked: string[] }

const pipe = async (data: Uint8Array, t: CompressionStream | DecompressionStream) => new Uint8Array(await new Response(new Blob([bytes(data)]).stream().pipeThrough(t)).arrayBuffer())

/** Chat history for a new device: encrypted with a fresh key and uploaded like an attachment. */
async function makeArchive(): Promise<ArchiveRef> {
  // Attachments travel as their encrypted pointers (re-downloaded while the server keeps them);
  // unsent messages stay behind so the new device doesn't send them a second time.
  const chats = Object.fromEntries(
    Object.entries(state.chats).map(([id, c]) => [id, { ...c, typing: undefined, draft: undefined, messages: c.messages.filter((m) => !(m.mine && (m.status === 'sending' || m.status === 'failed'))) }]),
  )
  const archive: Archive = { v: 1, chats, people: state.people, stickers: state.stickers, blocked: state.blocked }
  let data = te.encode(JSON.stringify(archive))
  const gz = typeof CompressionStream !== 'undefined'
  if (gz) data = await pipe(data, new CompressionStream('gzip'))
  const key = crypto.getRandomValues(new Uint8Array(32))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const k = await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt'])
  const blob = new Uint8Array([...iv, ...new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, bytes(data)))])
  const { id } = await rpc({ t: 'upload', size: blob.length })
  const r = await fetch(`${SERVER.origin}/blob/${id}`, { method: 'PUT', body: blob })
  if (!r.ok) throw new Error('upload failed')
  return { id, key: b64(key), gz }
}

async function importArchive(ref: ArchiveRef) {
  const r = await fetch(`${SERVER.origin}/blob/${ref.id}`)
  if (!r.ok) throw new Error('download failed')
  const raw = new Uint8Array(await r.arrayBuffer())
  const k = await crypto.subtle.importKey('raw', bytes(unb64(ref.key)), 'AES-GCM', false, ['decrypt'])
  let data = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(raw.subarray(0, 12)) }, k, bytes(raw.subarray(12))))
  if (ref.gz) data = await pipe(data, new DecompressionStream('gzip'))
  const a: Archive = JSON.parse(td.decode(data))
  if (a.v !== 1) throw new Error('unknown archive')
  // Anything that arrived here while the history was on its way wins.
  const chats = { ...a.chats }
  for (const [id, c] of Object.entries(state.chats)) {
    const old = chats[id]
    chats[id] = old ? { ...old, messages: [...old.messages, ...c.messages.filter((m) => !old.messages.some((x) => x.id === m.id))], unread: old.unread + c.unread } : c
  }
  Object.keys(chats).forEach((id) => dirty.add(id))
  set({ chats, people: { ...a.people, ...state.people }, stickers: a.stickers ?? [], blocked: a.blocked ?? [] })
  await saveChats()
  await kv('people', state.people)
  await saveStickers()
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

/** Make sure we have sessions with each of these devices of `peer`, fetching their prekey bundles. */
async function ensureSessions(peer: string, devices?: number[]) {
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
async function fixDevices(peer: string, m: { missing?: number[]; extra?: number[] }) {
  for (const d of m.extra ?? []) acct!.drop_session(peer, d)
  await ensureSessions(peer, m.missing ?? [])
}

/**
 * Send one encrypted payload to every device of `peer` (to your own other devices when `peer` is
 * you). To contacts who've shared their access key it goes sealed (the server never learns it was
 * from us); otherwise, e.g. a first message to a stranger, it's a normal send.
 */
function deliver(peer: string, p: Payload) {
  return serial(async () => {
    const self = peer === acct!.id
    const bytes = pad(te.encode(JSON.stringify(p)))
    // Worth waking their phone for: messages and incoming calls, not receipts, typing or our own syncs.
    // (The server learns this one bit per message; Signal sends the same.)
    const urgent = p.t === 'text' || (p.t === 'call' && p.k === 'offer')
    let ak = self ? undefined : state.people[peer]?.ak
    let akRequest = false
    const targets = () => Array.from(acct!.session_devices(peer)).filter((d) => !(self && d === acct!.device))
    if (!targets().length) await ensureSessions(peer)
    // Each try encrypts for the devices we know; a stale list is corrected and we go again.
    for (let attempt = 0; attempt < 4; attempt++) {
      const devices = targets()
      if (!devices.length) return
      if (ak) {
        const c = await senderCert()
        const msgs = devices.map((d) => ({ device: d, body: b64(acct!.seal(peer, d, bytes, c, Date.now())) }))
        await saveAccount()
        const r = await fetch(`${SERVER.origin}/sealed`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to: peer, msgs, access: ak, urgent }) })
        if (r.ok) return
        if (r.status === 409) {
          await fixDevices(peer, await r.json())
          continue
        }
        // Anything but "wrong access key" fails the send instead of quietly revealing who we are.
        if (r.status !== 401) throw new Error(`sealed send failed: ${r.status}`)
        // Their key changed (or they blocked us). Like Signal, fall back to a normal send, and ask
        // for the new key so later messages go sealed again.
        setPerson(peer, { ak: undefined })
        ak = undefined
        akRequest = true
        continue
      }
      const msgs = devices.map((d) => ({ device: d, body: b64(acct!.encrypt(peer, d, bytes, Date.now())) }))
      await saveAccount()
      try {
        await rpc({ t: 'send', to: peer, msgs, urgent })
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
  if (otherDevices().length) deliver(acct!.id, p).catch(() => {})
}

/** Send to a chat: one peer, or every other group member (each with its own Signal session). */
async function deliverChat(chatId: string, p: Payload) {
  const c = state.chats[chatId]
  if (!c || c.group?.left) return
  await Promise.all(others(c).map((m) => deliver(m, c.group ? { ...p, g: chatId, gv: c.group.v, gh: c.group.hash } : p)))
}

const patchMsg = (chat: string, id: string, patch: Partial<Msg>) => setMsgs(chat, (ms) => ms.map((m) => (m.id === id ? { ...m, ...patch } : m)))

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
async function shareProfile(peer: string) {
  if (isBlocked(peer)) return
  const p = state.profile
  if (state.people[peer]?.sent === p.v) return
  await deliver(peer, { t: 'profile', name: p.name, avatar: p.avatar, ak: myAk })
  setPerson(peer, { sent: p.v })
}

const wire = ({ lid: _, ...a }: Att): WireAtt => a

export async function sendMessage(chat: string, text: string, opts: { reply?: string; att?: Att; fwd?: boolean; men?: string[]; poll?: Poll; link?: LinkPreview } = {}) {
  const ttl = state.chats[chat]?.timer || undefined
  const now = Date.now()
  const m: Msg = { id: msgId(), mine: true, text, ts: now, status: 'sending', reply: opts.reply, att: opts.att, fwd: opts.fwd, ttl, exp: ttl ? now + ttl * 1000 : undefined, men: opts.men?.length ? opts.men : undefined, poll: opts.poll, link: opts.link }
  setChat(chat, (c) => ({ ...c, request: undefined, messages: [...c.messages, m] }))
  saveChatsSoon()
  await push(chat, m)
}

/** Attach files: each becomes its own message (caption goes on the first). */
export async function sendFiles(chat: string, files: File[], opts: { caption?: string; reply?: string; asFile?: boolean } = {}) {
  for (const [i, f] of files.entries()) {
    if (f.size > MAX_FILE) {
      toast(`${f.name} is over 100 MB`)
      continue
    }
    try {
      const att = await prepare(f, opts.asFile)
      // Don't wait for the upload: every file shows up immediately with its own progress.
      void sendMessage(chat, i === 0 ? opts.caption ?? '' : '', { att, reply: i === 0 ? opts.reply : undefined })
    } catch {
      toast(`Couldn't send ${f.name}`)
    }
  }
}

export async function sendAtt(chat: string, att: Att, text = '', reply?: string) {
  await sendMessage(chat, text, { att, reply })
}

async function push(chat: string, m: Msg) {
  if (chat === SAVED && !otherDevices().length) return patchMsg(chat, m.id, { status: 'sent' })
  try {
    let att = m.att
    if (att && !att.id) {
      att = await upload(att, (size) => rpc({ t: 'upload', size }).then((r) => r.id))
      patchMsg(chat, m.id, { att })
    }
    const c = state.chats[chat]
    for (const peer of c ? others(c) : []) await shareProfile(peer)
    if (chat === SAVED) {
      mirror({ t: 'sent', chat, p: { t: 'text', id: m.id, text: m.text, ts: m.ts, reply: m.reply, att: att && wire(att) } })
      return patchMsg(chat, m.id, { status: 'sent' })
    }
    const p: Payload = { t: 'text', id: m.id, text: m.text, ts: m.ts, reply: m.reply, fwd: m.fwd, att: att && wire(att), ttl: m.ttl, men: m.men, poll: m.poll, link: m.link }
    // Our other devices first, so they already have the message when the recipient's receipt arrives.
    mirror({ t: 'sent', chat, p })
    await deliverChat(chat, p)
    patchMsg(chat, m.id, { status: 'sent' })
  } catch {
    patchMsg(chat, m.id, { status: 'failed' })
  }
}

export const retry = (chat: string, m: Msg) => (patchMsg(chat, m.id, { status: 'sending' }), push(chat, m))

/** Resend anything that didn't make it while offline. Receivers dedupe by message id. */
function retryPending() {
  for (const c of Object.values(state.chats))
    for (const m of c.messages) if (m.mine && (m.status === 'sending' || m.status === 'failed')) push(c.id, m)
}

let lastTyping = 0
export function typing(chat: string) {
  if (!state.settings.typing || Date.now() - lastTyping < 4000 || !state.chats[chat]?.messages.length) return
  lastTyping = Date.now()
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
  } catch {
    toast("Couldn't add that sticker")
  }
}
/** Save a received sticker or photo to your stickers (reuses the uploaded blob). */
export function saveSticker(att: Att) {
  if (state.stickers.some((s) => s.id === att.id)) return toast('Already in your stickers')
  set({ stickers: [{ ...att, kind: 'sticker' }, ...state.stickers] })
  saveStickers()
  toast('Saved to your stickers')
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
  deliverChat(chat, { t: 'vote', id, c }).catch(() => toast("Vote wasn't sent. Check your connection."))
  mirror({ t: 'sent', chat, p: { t: 'vote', id, c } })
}
function withVote(v: Msg['votes'], who: string, c: number[]) {
  const next = { ...v }
  if (c.length) next[who] = c
  else delete next[who]
  return next
}

// ---------- calls (signaling only; media lives in call.ts) ----------
type CallSignal = Extract<Payload, { t: 'call' }>
let onCall: ((from: string, dev: number, p: CallSignal) => void) | null = null
export const setCallHandler = (f: typeof onCall) => void (onCall = f)
/** Call signaling rides the Signal session, so SDP (incl. DTLS fingerprints) is end-to-end authenticated. */
export const sendSignal = (peer: string, p: Omit<CallSignal, 't'>) => deliver(peer, { t: 'call', ...p })
/** Tell our other devices to stop ringing: this one answered or declined. */
export const callHandled = (id: string) => mirror({ t: 'call', id, k: 'elsewhere' })

export function addCallRecord(peer: string, call: CallRecord) {
  const me = state.me!.id
  const missed = !call.out && call.missed
  const req = !state.chats[peer] || !!state.chats[peer].request
  setChat(peer, (c) => ({ ...c, request: req && !call.out ? true : c.request, unread: missed && state.active !== peer ? c.unread + 1 : c.unread, messages: [...c.messages, sysMsg({ k: 'call', by: call.out ? me : peer, call })] }))
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

export function editMessage(chat: string, id: string, text: string) {
  const m = state.chats[chat]?.messages.find((x) => x.id === id)
  if (!m?.mine || m.text === text) return
  patchMsg(chat, id, { text, edited: true })
  deliverChat(chat, { t: 'edit', id, text }).catch(() => toast("Edit wasn't sent. Check your connection."))
  mirror({ t: 'sent', chat, p: { t: 'edit', id, text } })
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
  }
}

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
      setChat(chat, (c) => ({ ...c, request: undefined, archived: undefined, messages: [...c.messages, msg] }))
      if (att && att.size < 15_000_000) download(att)
    } else if (q.t === 'react') {
      setChat(chat, (c) => ({ ...c, messages: c.messages.map((x) => (x.id === q.id ? { ...x, re: withReaction(x.re, 'me', q.emoji ? str(q.emoji, 16) : null) } : x)) }))
    } else if (q.t === 'edit') {
      setChat(chat, (c) => ({ ...c, messages: c.messages.map((x) => (x.id === q.id && x.mine ? { ...x, text: str(q.text, 65536), edited: true } : x)) }))
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
      set({ profile: { name: str(p.profile.name, 64), avatar: imgUrl(p.profile.avatar, 120_000), v: Number(p.profile.v) } })
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
      return
    }
    if (p.t === 'leave') {
      onLeave(from, p.g, m.ts)
      await saveChats()
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
        if (!viewing && !req && (!muted || msg.mentionsMe)) {
          if (state.settings.sounds) chime()
          const body = msg.poll ? `📊 ${msg.poll.q}` : msg.text || attLabel(att!)
          notify(chat, inGroup ? `${personName(from)}: ${body}` : body)
        }
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
  } else if (p.t === 'edit' && own(p.id)) {
    const text = str(p.text, 65536)
    setChat(chat, (c) => ({ ...c, messages: c.messages.map((x) => (x.id === p.id && !x.mine ? { ...x, text, edited: true } : x)) }))
  } else if (p.t === 'delete' && own(p.id)) {
    const gone = own(p.id)
    setChat(chat, (c) => ({ ...c, messages: c.messages.filter((x) => x.mine || x.id !== p.id) }))
    releaseAtt(gone?.att)
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
    setPerson(from, { name: str(p.name, 64).trim() || undefined, avatar: imgUrl(p.avatar, 120_000), ak: typeof p.ak === 'string' && /^[A-Za-z0-9+/]{22}==$/.test(p.ak) ? p.ak : undefined })
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
  set({ active: id })
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
  if (!unseen.length || !state.settings.readReceipts || id === SAVED || c.request) return
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
