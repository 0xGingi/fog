// IndexedDB key-value store, optionally encrypted at rest (app lock).
//
// App lock: every value is sealed with AES-256-GCM under a random data key (DEK). The DEK is stored
// only wrapped: by a key derived from your passcode (Argon2id, 64 MiB / 3 passes; older locks used
// PBKDF2-SHA256 600k) and, optionally, by a passkey's PRF output run through HKDF (Touch ID / Face ID /
// Windows Hello). Locking = reloading the page, which drops every key from memory.
import { argon2id } from './core/fog_core.js'
let dbp: Promise<IDBDatabase> | null = null
const idb = () =>
  (dbp ??= new Promise<IDBDatabase>((res, rej) => {
    const r = indexedDB.open('fog', 1)
    r.onupgradeneeded = () => r.result.createObjectStore('kv')
    r.onsuccess = () => res(r.result)
    r.onerror = () => rej(r.error)
  }))

/** Somewhere else to keep the records instead of IndexedDB: the bot daemon (bot/store.ts) uses a folder. */
export type Store = { get(key: string): Promise<unknown>; put(key: string, value: unknown): Promise<void>; del(key: string): Promise<void>; keys(): Promise<string[]>; clear(): Promise<void> }
let store: Store | null = null
export const useStore = (s: Store) => void (store = s)

const subtle = crypto.subtle
const te = new TextEncoder()
const td = new TextDecoder()
const rand = (n: number) => crypto.getRandomValues(new Uint8Array(n))

type Wrapped = { iv: Uint8Array<ArrayBuffer>; ct: ArrayBuffer }
type LockRecord = { salt: Uint8Array<ArrayBuffer>; iter: number; kdf?: 'argon2id'; pass: Wrapped; prf?: Wrapped & { cred: ArrayBuffer; salt: Uint8Array<ArrayBuffer>; v?: 2 } }
/** `a: 1`: the record's key name is bound in as AES-GCM additional data, so records can't be swapped. */
type Sealed = { __fog: 1; iv: Uint8Array<ArrayBuffer>; ct: ArrayBuffer; k: 'json' | 'bytes' | 'blob'; type?: string; a?: 1 }
const LOCK = 'lock'
/**
 * Turning the lock on or off converts every record, one at a time. This record (sealed, so it can't be
 * planted) says a conversion is under way ('on' / 'off'); if the app closes midway, unlocking finishes it.
 */
const MIG = 'lock-mig'
let migrating: 'on' | 'off' | null = null

let dek: CryptoKey | null = null
let dekRaw: Uint8Array<ArrayBuffer> | null = null

/** The device couldn't store something (quota, I/O). Callers must not treat the data as saved. */
export class StorageError extends Error {}

async function raw<T>(key: string, value?: unknown): Promise<T | undefined> {
  if (store) {
    try {
      if (value === undefined) return (await store.get(key)) as T | undefined
      await (value === null ? store.del(key) : store.put(key, value))
      return
    } catch (e) {
      throw new StorageError(String(e))
    }
  }
  const db = await idb()
  return new Promise((res, rej) => {
    const fail = (e: unknown) => rej(new StorageError(String(e)))
    try {
      const tx = db.transaction('kv', value === undefined ? 'readonly' : 'readwrite')
      const store = tx.objectStore('kv')
      const r = value === undefined ? store.get(key) : value === null ? store.delete(key) : store.put(value, key)
      tx.oncomplete = () => res(value === undefined ? (r.result as T) : undefined)
      tx.onerror = tx.onabort = () => fail(tx.error)
    } catch (e) {
      fail(e)
    }
  })
}

async function seal(key: string, v: unknown): Promise<Sealed> {
  const iv = rand(12)
  const [k, bytes, type] =
    v instanceof Blob ? (['blob', await v.arrayBuffer(), v.type] as const) : v instanceof Uint8Array ? (['bytes', v, undefined] as const) : (['json', te.encode(JSON.stringify(v)), undefined] as const)
  return { __fog: 1, iv, ct: await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(key) }, dek!, bytes as BufferSource), k, type, a: 1 }
}
async function unseal(key: string, s: Sealed): Promise<unknown> {
  if (!dek) throw new Error('locked')
  const pt = await subtle.decrypt(s.a ? { name: 'AES-GCM', iv: s.iv, additionalData: te.encode(key) } : { name: 'AES-GCM', iv: s.iv }, dek, s.ct)
  return s.k === 'blob' ? new Blob([pt], { type: s.type }) : s.k === 'bytes' ? new Uint8Array(pt) : JSON.parse(td.decode(pt))
}
const isSealed = (v: any): v is Sealed => v && typeof v === 'object' && v.__fog === 1

/**
 * Writes to one key commit in the order they were made, though sealing each takes a while: otherwise
 * an older snapshot still being sealed could land after a newer one (a just-received message gone).
 * Converting a key for the lock (read, seal or unseal, write back) waits its turn the same way.
 */
const queues = new Map<string, Promise<unknown>>()
function inTurn<T>(key: string, f: () => Promise<T>): Promise<T> {
  const run = (queues.get(key) ?? Promise.resolve()).then(f, f)
  const tail = run.catch(() => {})
  queues.set(key, tail)
  void tail.then(() => queues.get(key) === tail && queues.delete(key))
  return run
}

/** get (value omitted), put (value), or delete (null). Transparent encryption when the app lock is on. */
export async function kv<T>(key: string, value?: T | null): Promise<T | undefined> {
  if (value === undefined) {
    const v = await raw<unknown>(key)
    if (isSealed(v)) return (await unseal(key, v)) as T
    // With the lock on, everything we wrote is sealed: a plaintext record was planted, so ignore it.
    // (Except while records are being converted: then some are legitimately still plaintext.)
    return v !== undefined && key !== LOCK && !migrating && (await lockIsOn()) ? undefined : (v as T | undefined)
  }
  // Seal before opening the transaction: IndexedDB transactions don't survive awaiting other work.
  // While the lock is being turned off, new writes go in plaintext (the key is about to be dropped).
  return inTurn(key, async () => raw<T>(key, value !== null && dek && key !== LOCK && migrating !== 'off' ? await seal(key, value) : value))
}

export async function kvClear() {
  lockOn = Promise.resolve(false)
  dek = dekRaw = null
  migrating = null
  if (store) return store.clear()
  // The few small things kept outside kv (recent emoji) go too: the next person on this browser
  // shouldn't see them.
  try {
    localStorage.clear()
  } catch {}
  const db = await idb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('kv', 'readwrite')
    tx.objectStore('kv').clear()
    tx.oncomplete = () => resolve()
    tx.onerror = tx.onabort = () => reject(new StorageError(String(tx.error)))
  })
}

async function allKeys(): Promise<string[]> {
  if (store) return (await store.keys()).filter((k) => k !== LOCK && k !== MIG)
  const db = await idb()
  return new Promise((res) => {
    const r = db.transaction('kv').objectStore('kv').getAllKeys()
    r.onsuccess = () => res((r.result as string[]).filter((k) => k !== LOCK && k !== MIG))
  })
}

// ---------- app lock ----------
const lockRecord = () => raw<LockRecord>(LOCK)
let lockOn: Promise<boolean> | null = null
const lockIsOn = () => (lockOn ??= lockRecord().then((l) => !!l))
export const lockEnabled = async () => !!(await lockRecord())
export const passkeyEnabled = async () => !!(await lockRecord())?.prf
export const isUnlocked = () => !!dek

async function passKey(code: string, salt: Uint8Array<ArrayBuffer>, iter: number, kdf?: 'argon2id') {
  if (kdf === 'argon2id') return subtle.importKey('raw', new Uint8Array(argon2id(code, salt)), 'AES-GCM', false, ['encrypt', 'decrypt'])
  const base = await subtle.importKey('raw', te.encode(code), 'PBKDF2', false, ['deriveKey'])
  return subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}
async function wrap(kek: CryptoKey, data: Uint8Array<ArrayBuffer>): Promise<Wrapped> {
  const iv = rand(12)
  return { iv, ct: await subtle.encrypt({ name: 'AES-GCM', iv }, kek, data) }
}
async function useDek(bytes: Uint8Array<ArrayBuffer>) {
  dekRaw = bytes
  dek = await subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt'])
  // Records sealed before key binding existed get re-sealed with it.
  for (const k of await allKeys())
    await inTurn(k, async () => {
      const v = await raw<unknown>(k)
      if (isSealed(v) && !v.a) await raw(k, await seal(k, await unseal(k, v)))
    })
  // Turning the lock on or off was interrupted (app closed, storage error): finish it now.
  const m = await raw<unknown>(MIG)
  migrating = isSealed(m) ? ((await unseal(MIG, m)) as 'on' | 'off') : null
  if (migrating === 'on') await finishOn()
  else if (migrating === 'off') await finishOff()
}
/** Seal every record still in plaintext, then mark the conversion done. */
async function finishOn() {
  // Each value is re-read right before sealing it, in turn with other writes to its key, so writes
  // that land mid-migration aren't lost.
  for (const k of await allKeys())
    await inTurn(k, async () => {
      const v = await raw<unknown>(k)
      if (v !== undefined && !isSealed(v)) await raw(k, await seal(k, v))
    })
  await raw(MIG, null)
  migrating = null
}
/** Decrypt every sealed record, then remove the lock (and the key) for good. */
async function finishOff() {
  for (const k of await allKeys())
    await inTurn(k, async () => {
      const v = await raw<unknown>(k)
      if (isSealed(v)) await raw(k, await unseal(k, v))
    })
  await raw(LOCK, null)
  await raw(MIG, null)
  lockOn = Promise.resolve(false)
  dek = dekRaw = null
  migrating = null
}

export async function unlockWithPasscode(code: string) {
  const l = await lockRecord()
  if (!l) return
  try {
    const kek = await passKey(code, l.salt, l.iter, l.kdf)
    await useDek(new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: l.pass.iv }, kek, l.pass.ct)))
  } catch {
    throw new Error('wrong_passcode')
  }
}

/**
 * Turn the lock on: new data key, wrapped by the passcode, then every stored value re-sealed.
 * The wrapped key is saved before any record is sealed, and the conversion is marked as under way,
 * so closing the app midway never leaves a record sealed under a key that wasn't kept.
 */
export async function enableLock(code: string) {
  const salt = rand(16)
  const bytes = rand(32)
  const rec: LockRecord = { salt, iter: 0, kdf: 'argon2id', pass: await wrap(await passKey(code, salt, 0, 'argon2id'), bytes) }
  dekRaw = bytes
  dek = await subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt'])
  await raw(MIG, await seal(MIG, 'on'))
  migrating = 'on'
  await raw(LOCK, rec)
  lockOn = Promise.resolve(true)
  await finishOn()
}

export async function changePasscode(code: string) {
  const l = await lockRecord()
  if (!l || !dekRaw) return
  const salt = rand(16)
  // Changing the passcode also upgrades older PBKDF2 locks to Argon2id.
  await raw(LOCK, { ...l, salt, iter: 0, kdf: 'argon2id', pass: await wrap(await passKey(code, salt, 0, 'argon2id'), dekRaw) })
}

/** Turn the lock off: decrypt everything back in place (resumed on the next unlock if interrupted). Requires being unlocked. */
export async function disableLock() {
  if (!dek) return
  await raw(MIG, await seal(MIG, 'off'))
  migrating = 'off'
  await finishOff()
}

/** Rough passcode strength in bits (character pool × length, penalised for repeats and sequences). */
export function passcodeBits(code: string) {
  if (!code) return 0
  const pool = (/[0-9]/.test(code) ? 10 : 0) + (/[a-z]/.test(code) ? 26 : 0) + (/[A-Z]/.test(code) ? 26 : 0) + (/[^0-9a-zA-Z]/.test(code) ? 33 : 0)
  let bits = code.length * Math.log2(Math.max(pool, 2))
  const unique = new Set(code).size
  if (unique < code.length / 2) bits /= 2
  if (/(0123|1234|2345|3456|4567|5678|6789|abcd|qwer|asdf|password|fogfog)/i.test(code)) bits -= 20
  return Math.max(0, Math.round(bits))
}
export const MIN_PASSCODE_BITS = 40

// ---------- passkey (WebAuthn PRF) ----------
export const passkeySupported = () => typeof PublicKeyCredential !== 'undefined' && !('__TAURI_INTERNALS__' in window)

async function prfOutput(cred: ArrayBuffer, salt: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer> {
  const a = (await navigator.credentials.get({
    publicKey: { challenge: rand(32), allowCredentials: [{ type: 'public-key', id: cred }], userVerification: 'required', extensions: { prf: { eval: { first: salt } } } as any },
  })) as PublicKeyCredential | null
  const out = (a?.getClientExtensionResults() as any)?.prf?.results?.first as ArrayBuffer | undefined
  if (!out) throw new Error('prf_unsupported')
  return out
}
/** Passkey PRF output → wrapping key via HKDF (v2). Locks made before v2 used the output directly. */
async function prfKey(out: ArrayBuffer, v?: 2) {
  if (v !== 2) return subtle.importKey('raw', out, 'AES-GCM', false, ['encrypt', 'decrypt'])
  const base = await subtle.importKey('raw', out, 'HKDF', false, ['deriveKey'])
  return subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: te.encode('fog/applock/prf/v2') }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

/** Register a passkey whose PRF output also wraps the data key. Requires being unlocked. */
export async function addPasskey() {
  const l = await lockRecord()
  if (!l || !dekRaw) throw new Error('locked')
  const cred = (await navigator.credentials.create({
    publicKey: {
      challenge: rand(32),
      rp: { name: 'Fog' },
      user: { id: rand(16), name: 'Fog app lock', displayName: 'Fog app lock' },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -257 },
      ],
      authenticatorSelection: { userVerification: 'required', residentKey: 'preferred' },
      extensions: { prf: {} } as any,
    },
  })) as PublicKeyCredential | null
  if (!cred || !(cred.getClientExtensionResults() as any)?.prf?.enabled) throw new Error('prf_unsupported')
  const salt = rand(32)
  const kek = await prfKey(await prfOutput(cred.rawId, salt), 2)
  await raw(LOCK, { ...l, prf: { ...(await wrap(kek, dekRaw)), cred: cred.rawId, salt, v: 2 } })
}

export async function removePasskey() {
  const l = await lockRecord()
  if (l) await raw(LOCK, { ...l, prf: undefined })
}

export async function unlockWithPasskey() {
  const l = await lockRecord()
  if (!l?.prf) throw new Error('no_passkey')
  const kek = await prfKey(await prfOutput(l.prf.cred, l.prf.salt), l.prf.v)
  await useDek(new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: l.prf.iv }, kek, l.prf.ct)))
}
