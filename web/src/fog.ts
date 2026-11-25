// Client engine: keys, server connection, Signal sessions, chats, groups.
// Everything that touches crypto goes through `serial` so ratchet state is saved in order.
import { useSyncExternalStore } from 'react'
import init, { Account, new_mnemonic, solve_pow, valid_mnemonic, verify as verifySig } from './core/fog_core.js'
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
export type Settings = { readReceipts: boolean; typing: boolean; sounds: boolean; theme: 'system' | 'light' | 'dark'; textSize: number; linkPreviews: boolean; relayCalls: boolean; autoLock: number; lockPrompted?: boolean }
export type State = {
  phase: 'loading' | 'locked' | 'unlock' | 'welcome' | 'username' | 'app'
  me: { id: string; username: string | null } | null
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
}

// Wire form of an attachment pointer (inside the encryption).
type WireAtt = Omit<Att, 'lid'>
// Payloads inside the encryption. The server never sees these. `g` scopes a payload to a group.
type Payload = (
  | { t: 'text'; id: string; text: string; ts: number; reply?: string; att?: WireAtt; fwd?: boolean; ttl?: number; men?: string[]; poll?: Poll; link?: LinkPreview }
  | { t: 'vote'; id: string; c: number[] }
  | { t: 'call'; id: string; k: 'offer' | 'answer' | 'end' | 'decline' | 'busy'; sdp?: string; video?: boolean }
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
    me: { id: acct.id, username: meta?.username ?? null },
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
  set({ me: { id: acct.id, username: null } })
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
}

/** Update our display name / photo and push it (encrypted) to everyone we've written to. */
export function setProfile(patch: Partial<Omit<Profile, 'v'>>) {
  set({ profile: { ...state.profile, ...patch, v: Date.now() } })
  saveMeta()
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
  ws?.close()
  await kvClear()
  location.reload()
}

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
      m.error ? p?.rej(new Error(m.error)) : p?.res(m)
    } else onPush(m)
  }
  sock.onclose = () => {
    if (ws !== sock) return
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
      const sig = acct!.sign(te.encode(`fog-auth-v1|${SERVER.host}|${m.nonce}`))
      ws!.send(JSON.stringify({ id: acct!.id, sig: b64(sig) }))
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
      // Register our access key before anything else goes out (the RPC layer only works once online).
      await rpc({ t: 'access', key: myAk }).catch(() => {})
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
    case 'error':
      console.error('server:', m.error)
  }
}

let authNonce = ''
function topUp(count: number, kyber: number) {
  return serial(async () => {
    const keys = JSON.parse(acct!.keys(Math.max(0, 100 - count), Math.max(0, 40 - kyber)))
    await saveAccount()
    await rpc({ t: 'keys', keys })
  })
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
 * Send one encrypted payload. To contacts who've shared their access key it goes sealed (the server
 * never learns it was from us); otherwise, e.g. a first message to a stranger, it's a normal send.
 */
function deliver(peer: string, p: Payload) {
  return serial(async () => {
    if (!acct!.has_session(peer)) {
      const { bundle } = await rpc({ t: 'bundle', id: peer })
      acct!.start_session(peer, JSON.stringify(bundle), Date.now())
    }
    const bytes = pad(te.encode(JSON.stringify(p)))
    const ak = state.people[peer]?.ak
    let akRequest = false
    if (ak) {
      try {
        const env = acct!.seal(peer, bytes, await senderCert(), Date.now())
        await saveAccount()
        const r = await fetch(`${SERVER.origin}/sealed`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to: peer, body: b64(env), access: ak }) })
        if (r.ok) return
        // Anything but "wrong access key" fails the send instead of quietly revealing who we are.
        if (r.status !== 401) throw new Error(`sealed send failed: ${r.status}`)
        // Their key changed (or they blocked us). Like Signal, fall back to a normal send, and ask
        // for the new key so later messages go sealed again.
        setPerson(peer, { ak: undefined })
        akRequest = true
      } catch (e) {
        if (!akRequest) throw e
      }
    }
    const env = acct!.encrypt(peer, bytes, Date.now())
    await saveAccount()
    await rpc({ t: 'send', to: peer, body: b64(env) })
    if (akRequest) {
      const req = acct!.encrypt(peer, pad(te.encode(JSON.stringify({ t: 'akreq' }))), Date.now())
      await saveAccount()
      await rpc({ t: 'send', to: peer, body: b64(req) })
    }
  })
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
  if (chat === SAVED) return patchMsg(chat, m.id, { status: 'sent' })
  try {
    let att = m.att
    if (att && !att.id) {
      att = await upload(att, (size) => rpc({ t: 'upload', size }).then((r) => r.id))
      patchMsg(chat, m.id, { att })
    }
    const c = state.chats[chat]
    for (const peer of c ? others(c) : []) await shareProfile(peer)
    await deliverChat(chat, { t: 'text', id: m.id, text: m.text, ts: m.ts, reply: m.reply, fwd: m.fwd, att: att && wire(att), ttl: m.ttl, men: m.men, poll: m.poll, link: m.link })
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
}
function withVote(v: Msg['votes'], who: string, c: number[]) {
  const next = { ...v }
  if (c.length) next[who] = c
  else delete next[who]
  return next
}

// ---------- calls (signaling only; media lives in call.ts) ----------
type CallSignal = Extract<Payload, { t: 'call' }>
let onCall: ((from: string, p: CallSignal) => void) | null = null
export const setCallHandler = (f: typeof onCall) => void (onCall = f)
/** Call signaling rides the Signal session, so SDP (incl. DTLS fingerprints) is end-to-end authenticated. */
export const sendSignal = (peer: string, p: Omit<CallSignal, 't'>) => deliver(peer, { t: 'call', ...p })

export function addCallRecord(peer: string, call: CallRecord) {
  const me = state.me!.id
  const missed = !call.out && call.missed
  const req = !state.chats[peer] || !!state.chats[peer].request
  setChat(peer, (c) => ({ ...c, request: req && !call.out ? true : c.request, unread: missed && state.active !== peer ? c.unread + 1 : c.unread, messages: [...c.messages, sysMsg({ k: 'call', by: call.out ? me : peer, call })] }))
  saveChats()
  if (missed && !req) notify(peer, `Missed ${call.video ? 'video' : 'voice'} call`)
}

/** Invite links: https://host/#add=<account id> opens a chat with that account. */
export const inviteLink = () => `${SERVER.origin}/#add=${state.me?.id}`
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
  if (everyone) for (const m of gone) if (m.mine && m.status !== 'failed') deliverChat(chat, { t: 'delete', id: m.id }).catch(() => toast("Couldn't delete for everyone. Check your connection."))
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
}
export function markUnread(chat: string, unread: boolean) {
  if (unread) setChat(chat, (c) => ({ ...c, markedUnread: true }))
  else (setChat(chat, (c) => ({ ...c, markedUnread: false })), markRead(chat))
  saveChatsSoon()
}
export function muteChat(chat: string, until: number) {
  setChat(chat, (c) => ({ ...c, muted: until || undefined }))
  saveChatsSoon()
}
export function archiveChat(chat: string, archived: boolean) {
  setChat(chat, (c) => ({ ...c, archived: archived || undefined, pinned: archived ? false : c.pinned }))
  saveChatsSoon()
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
}

// ---------- message requests & blocking ----------
export const isBlocked = (id: string) => state.blocked.includes(id)
/** Someone we've accepted: we started the chat, wrote to them, or accepted their request. */
export const isTrusted = (id: string) => !isBlocked(id) && !!state.chats[id] && !state.chats[id].request

export function acceptRequest(chat: string) {
  setChat(chat, (c) => ({ ...c, request: undefined }))
  saveChats()
  markRead(chat)
  if (state.chats[chat]?.group) shareWithGroup(chat)
}

export function block(id: string) {
  if (!isBlocked(id)) set({ blocked: [...state.blocked, id] })
  rotateAccessKey()
  saveMeta()
  if (state.chats[id]?.request) deleteChat(id)
  toast('Blocked')
}
export function unblock(id: string) {
  set({ blocked: state.blocked.filter((b) => b !== id) })
  saveMeta()
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

function receive(m: { id: number; from: string | null; sealed?: boolean; body: string; ts: number }) {
  serial(async () => {
    let decoded: Payload
    let from = m.from ?? ''
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
        decoded = JSON.parse(td.decode(unpad(out.subarray(43))))
      } else decoded = JSON.parse(td.decode(unpad(acct!.decrypt(from, unb64(m.body)))))
    } catch (e) {
      // Already handled (its ack was lost): libsignal refuses the reused message key. Nothing to show.
      if (/old counter/.test(String(e))) return ack(m.id)
      console.warn('decrypt failed', e)
      if (m.sealed || !ID_RE.test(from) || isBlocked(from)) return ack(m.id)
      // No session (e.g. we restored on a new device): start a fresh one so their next message works.
      // At most once per sender per 10 minutes, so a server can't use us to burn people's prekeys.
      if (!acct!.has_session(from) && Date.now() - (lastReset.get(from) ?? 0) > 600_000) {
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
      if (valid) await handlePayload(m, from, decoded)
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

async function handlePayload(m: { id: number; ts: number }, from: string, decoded: Payload) {
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
  } else if (p.t === 'call' && !inGroup) {
    const sig = p
    setTimeout(() => onCall?.(from, sig), 0)
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
  if (document.visibilityState === 'visible' || typeof Notification === 'undefined' || Notification.permission !== 'granted') return
  const c = state.chats[chat]
  const n = new Notification(c ? chatTitle(c) : 'New message', { body: text, tag: chat, icon: c ? chatAvatar(c) : undefined })
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
