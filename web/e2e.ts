// End-to-end protocol check against a running server: `bun e2e.ts` (server on 127.0.0.1:8787).
// Accounts register, find each other by username, exchange Signal-encrypted messages, and link
// extra devices.
import { initSync, Account, new_mnemonic, solve_pow, link_keypair, link_agree } from './src/core/fog_core.js'

initSync({ module: await Bun.file(new URL('./src/core/fog_core_bg.wasm', import.meta.url)).arrayBuffer() })
const HOST = process.env.FOG_HOST ?? '127.0.0.1:8787'
const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64')
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'))
const te = new TextEncoder()
const td = new TextDecoder()
const assert = (c: unknown, msg: string) => {
  if (!c) throw new Error(`FAIL: ${msg}`)
  if (process.env.E2E_VERBOSE) console.log(`  ok ${msg}`)
}

type Client = Awaited<ReturnType<typeof client>>
/** Log in as `acct`'s device. Device 1 also signs with the main-device key; a new linked device presents its link token. */
async function client(acct: Account, opts: { token?: string; noMainSig?: boolean; asDevice?: number } = {}) {
  const ws = new WebSocket(`ws://${HOST}/ws`)
  const inbox: any[] = []
  const pushes: any[] = []
  const pending = new Map<number, (m: any) => void>()
  let rid = 0
  let onInbox = () => {}
  let nonce = ''
  const ready = new Promise<any>((res) => {
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data as string)
      if (m.t === 'challenge') {
        nonce = m.nonce
        const challenge = te.encode(`fog-auth-v1|${HOST}|${m.nonce}`)
        const auth: any = { id: acct.id, device: opts.asDevice ?? acct.device, sig: b64(acct.sign(challenge)) }
        if (acct.is_main && !opts.noMainSig) Object.assign(auth, { main: acct.main_public(), msig: b64(acct.main_sign(challenge)) })
        if (!acct.is_main) Object.assign(auth, { dkey: acct.device_public(), dsig: b64(acct.device_sign(challenge)) })
        if (opts.token) Object.assign(auth, { token: opts.token, name: 'Test laptop' })
        ws.send(JSON.stringify(auth))
      } else if (m.t === 'ready' || m.t === 'error') res(m)
      else if (m.rid !== undefined) pending.get(m.rid)!(m)
      else if (m.t === 'msg') inbox.push(m), onInbox()
      else pushes.push(m)
    }
  })
  const rpc = (req: object) =>
    new Promise<any>((res) => {
      const id = ++rid
      pending.set(id, res)
      ws.send(JSON.stringify({ ...req, rid: id }))
    })
  const next = () =>
    new Promise<any>((res) => {
      if (inbox.length) return res(inbox.shift())
      onInbox = () => {
        onInbox = () => {}
        res(inbox.shift())
      }
    })
  const r = await ready
  return { ws, ready: r, rpc, next, pushes, pow: () => solve_pow(nonce, r.pow) }
}
const until = async (f: () => unknown, ms = 3000) => {
  for (const t = Date.now(); Date.now() - t < ms; await Bun.sleep(50)) if (f()) return true
  return false
}
const enc = (from: Account, to: string, device: number, text: string) => ({ device, body: b64(from.encrypt(to, device, te.encode(text), Date.now())) })
const open = (acct: Account, m: any) => td.decode(acct.decrypt(m.from, m.dev, unb64(m.body)))

const tag = Math.random().toString(36).slice(2, 8)
const alice = Account.create(new_mnemonic(), Date.now())
const bob = Account.create(new_mnemonic(), Date.now())
const A = await client(alice)
const B = await client(bob)
assert(!A.ready.registered && A.ready.device === 1, 'fresh account is unregistered, device 1')

assert((await A.rpc({ t: 'keys', keys: JSON.parse(alice.keys(10, 3)), replace: true })).error === 'pow_required', 'signup needs proof-of-work')
assert((await A.rpc({ t: 'lookup', name: 'anyone' })).error === 'not_registered', 'unregistered keys get no lookups')
assert((await fetch(`http://${HOST}/sealed`, { method: 'POST', body: JSON.stringify({ to: 'x'.repeat(5000), body: 'AA==', access: 'AA==' }) })).status === 400, 'sealed rejects a malformed recipient')
for (const [c, acct, name] of [[A, alice, `alice_${tag}`], [B, bob, `bob_${tag}`]] as const) {
  const t0 = performance.now()
  const res = await c.rpc({ t: 'keys', keys: JSON.parse(acct.keys(10, 3)), replace: true, pow: c.pow() })
  assert(!res.error, `upload keys (${res.error})`)
  if (c === A) console.log(`  signup proof-of-work: ${Math.round(performance.now() - t0)} ms`)
  assert((await c.rpc({ t: 'username', name })).username === name, 'claim username')
}
assert((await B.rpc({ t: 'username', name: `alice_${tag}` })).error === 'taken', 'username uniqueness')

const found = await A.rpc({ t: 'lookup', name: `bob_${tag}` })
assert(found.id === bob.id, 'lookup by username')
const { bundle } = await A.rpc({ t: 'bundle', id: bob.id })
assert(bundle.pk, 'bundle carries a one-time prekey')
assert(bundle.kpk.id >= 100000, 'bundle carries a one-time post-quantum prekey')
assert(!(await A.rpc({ t: 'report', id: bob.id })).error, 'report accepted')
alice.start_session(bob.id, 1, JSON.stringify(bundle), Date.now())

await A.rpc({ t: 'send', to: bob.id, msgs: [enc(alice, bob.id, 1, 'hello bob')] })
const m1 = await B.next()
assert(m1.from === alice.id && m1.dev === 1, 'sender id and device')
assert(open(bob, m1) === 'hello bob', 'bob decrypts')
await B.rpc({ t: 'ack', id: m1.id })

await B.rpc({ t: 'send', to: alice.id, msgs: [enc(bob, alice.id, 1, 'hi alice')] })
const m2 = await A.next()
assert(open(alice, m2) === 'hi alice', 'alice decrypts')
await A.rpc({ t: 'ack', id: m2.id })

// Push: phones register a token; tokens outside their alphabet are refused (they end up in URLs).
assert(!(await B.rpc({ t: 'push', kind: 'fcm', token: 'e2e-test:APA91b-token_0123456789' })).error, 'push token registered')
assert((await B.rpc({ t: 'push', kind: 'apns', token: `${'a'.repeat(64)}/../x` })).error === 'bad token', 'bad push token refused')
assert(!(await B.rpc({ t: 'away', away: true })).error, 'away accepted')

// Offline delivery: bob disconnects, alice sends, bob reconnects and gets it queued.
B.ws.close()
await A.rpc({ t: 'send', to: bob.id, msgs: [enc(alice, bob.id, 1, 'while you were out')], urgent: true })
const B2 = await client(bob)
assert(B2.ready.username === `bob_${tag}`, 'username survives reconnect')
const m3 = await B2.next()
assert(open(bob, m3) === 'while you were out', 'queued message')
await B2.rpc({ t: 'ack', id: m3.id })

// Encrypted attachments: upload needs a reserved slot; the server stores and returns bytes verbatim.
const blob = crypto.getRandomValues(new Uint8Array(70_000))
assert((await fetch(`http://${HOST}/blob/${'0'.repeat(32)}`, { method: 'PUT', body: blob })).status === 403, 'upload without a slot refused')
const { id: blobId } = await A.rpc({ t: 'upload', size: blob.length })
assert((await fetch(`http://${HOST}/blob/${blobId}`, { method: 'PUT', body: blob })).status === 201, 'upload accepted')
assert((await fetch(`http://${HOST}/blob/${blobId}`, { method: 'PUT', body: blob })).status === 403, 'upload slot is single-use')
const back = new Uint8Array(await (await fetch(`http://${HOST}/blob/${blobId}`)).arrayBuffer())
assert(back.length === blob.length && back.every((b, i) => b === blob[i]), 'download matches upload')
const { id: small } = await A.rpc({ t: 'upload', size: 10 })
assert((await fetch(`http://${HOST}/blob/${small}`, { method: 'PUT', body: blob })).status === 413, 'oversized upload refused')

// Sealed sender: Bob registers an access key; Alice sends with it and no sender attached.
const access = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64')
assert(!(await B2.rpc({ t: 'access', key: access })).error, 'register access key')
const { cert } = await A.rpc({ t: 'cert' })
const sealedMsg = (text: string) => ({ device: 1, body: b64(alice.seal(bob.id, 1, te.encode(text), unb64(cert), Date.now())) })
const post = (body: object) => fetch(`http://${HOST}/sealed`, { method: 'POST', body: JSON.stringify(body) })
assert((await post({ to: bob.id, msgs: [sealedMsg('x')], access: 'AAAAAAAAAAAAAAAAAAAAAA==' })).status === 401, 'wrong access key refused')
assert((await post({ to: bob.id, msgs: [sealedMsg('sealed hello')], access })).status === 201, 'sealed send accepted')
const s1 = await B2.next()
assert(s1.sealed === true && s1.from === null, 'server delivers without a sender')
const opened = bob.unseal(unb64(s1.body), unb64(B2.ready.trust), s1.ts)
assert(td.decode(opened.subarray(0, 43)) === alice.id && opened[43] === 1, 'recipient learns the real sender and device')
assert(td.decode(opened.subarray(44)) === 'sealed hello', 'sealed plaintext')
await B2.rpc({ t: 'ack', id: s1.id })

// A forged login (signature over the wrong host) is refused.
const evil = new WebSocket(`ws://${HOST}/ws`)
const refused = await new Promise<boolean>((res) => {
  evil.onmessage = (e) => {
    const m = JSON.parse(e.data as string)
    if (m.t === 'challenge') evil.send(JSON.stringify({ id: alice.id, sig: b64(alice.sign(te.encode(`fog-auth-v1|evil.example|${m.nonce}`))) }))
    else res(m.error === 'bad_auth')
  }
})
assert(refused, 'wrong-host signature refused')

// ---------- multi-device ----------
// Device 1 must prove the main-device key once the account has one; the identity key alone isn't enough.
assert((await client(alice, { noMainSig: true })).ready.error === 'bad_auth', 'device 1 needs the main-device key')

async function hkdf(secret: Uint8Array) {
  const base = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits'])
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: te.encode('fog/link/v1') }, base, 256))
}
/** Link a new device to `main` the way the app does: anonymous link socket, approval, encrypted transfer. */
async function link(main: Client, mainAcct: Account): Promise<{ acct: Account; c: Client }> {
  const sock = new WebSocket(`ws://${HOST}/link`)
  const got: any[] = []
  sock.onmessage = (e) => got.push(JSON.parse(e.data as string))
  await until(() => got.length)
  const channel = got[0].id
  const mine = link_keypair() // the new device's QR code carries the channel and mine[32..]
  // Main device: approve a slot, then encrypt the identity key to the new device.
  const { device, token, error } = await main.rpc({ t: 'link_begin' })
  assert(!error, `link_begin (${error})`)
  const eph = link_keypair()
  const key = await crypto.subtle.importKey('raw', await hkdf(link_agree(eph.subarray(0, 32), mine.subarray(32))), 'AES-GCM', false, ['encrypt'])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const payload = te.encode(JSON.stringify({ identity: b64(mainAcct.link_identity()), device, token }))
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, payload))
  assert(!(await main.rpc({ t: 'provision', channel, body: b64(new Uint8Array([...eph.subarray(32), ...iv, ...ct])) })).error, 'provision relayed')
  await until(() => got.length > 1)
  // New device: decrypt with its private key.
  const raw = unb64(got[1].body)
  const k2 = await crypto.subtle.importKey('raw', await hkdf(link_agree(mine.subarray(0, 32), raw.subarray(0, 32))), 'AES-GCM', false, ['decrypt'])
  const p = JSON.parse(td.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.subarray(32, 44) }, k2, raw.subarray(44))))
  const acct = Account.create_linked(unb64(p.identity), p.device, Date.now())
  assert(acct.id === mainAcct.id && acct.device === device, 'linked device has the account identity')
  const c = await client(acct, { token: p.token })
  assert(c.ready.registered && c.ready.device === device, 'linked device logs in with its token')
  assert(!(await c.rpc({ t: 'keys', keys: JSON.parse(acct.keys(10, 3)), replace: true })).error, 'linked device uploads its keys (no proof-of-work)')
  return { acct, c }
}

const { acct: laptop, c: first } = await link(A, alice)
const devs = (await A.rpc({ t: 'devices' })).devices
assert(devs.length === 2 && devs[1].name === 'Test laptop' && devs[1].ready, 'device list shows the laptop')
// Logging in again (no token needed now) takes over from the first connection.
const L = await client(laptop)
assert(L.ready.error === undefined, 'a linked device can log in again without a token')
first.ws.close()
assert((await L.rpc({ t: 'link_begin' })).error === 'main_only', 'only the main device can link devices')
assert((await L.rpc({ t: 'unlink', device: 1 })).error === 'not_allowed', "a linked device can't unlink the main device")
assert((await L.rpc({ t: 'username', name: `x_${tag}` })).error === 'main_only', "a linked device can't change the username")

// Bob's stale device list is caught, then he writes to both devices.
const stale = await B2.rpc({ t: 'send', to: alice.id, msgs: [enc(bob, alice.id, 1, 'only phone')] })
assert(stale.error === 'devices' && stale.missing.join() === `${laptop.device}`, 'send to a stale device list names the missing device')
const { bundles } = await B2.rpc({ t: 'bundles', id: alice.id })
assert(bundles.map((b: any) => b.device).join() === `1,${laptop.device}`, 'bundles for every device')
for (const b of bundles) if (!bob.has_session(alice.id, b.device)) bob.start_session(alice.id, b.device, JSON.stringify(b.bundle), Date.now())
assert(!(await B2.rpc({ t: 'send', to: alice.id, msgs: [enc(bob, alice.id, 1, 'phone copy'), enc(bob, alice.id, laptop.device, 'both')] })).error, 'send to both devices')
assert(open(alice, await A.next()) === 'phone copy', 'phone decrypts its copy')
assert(open(laptop, await L.next()) === 'both', 'laptop decrypts its own copy')

// The laptop replies; Bob sees which device it came from. It also syncs the message to the phone.
const { bundle: bobBundle } = await L.rpc({ t: 'bundle', id: bob.id, device: 1 })
laptop.start_session(bob.id, 1, JSON.stringify(bobBundle), Date.now())
await L.rpc({ t: 'send', to: bob.id, msgs: [enc(laptop, bob.id, 1, 'sent from laptop')] })
const fromLaptop = await B2.next()
assert(fromLaptop.dev === laptop.device && open(bob, fromLaptop) === 'sent from laptop', 'reply carries the sending device')
const own = await L.rpc({ t: 'bundles', id: alice.id })
assert(own.bundles.map((b: any) => b.device).join() === '1', 'your own bundles skip this device')
laptop.start_session(alice.id, 1, JSON.stringify(own.bundles[0].bundle), Date.now())
assert((await L.rpc({ t: 'send', to: alice.id, msgs: [enc(laptop, alice.id, 1, 'x'), { device: laptop.device, body: 'AA==' }] })).error === 'devices', "can't send to your own device")
await L.rpc({ t: 'send', to: alice.id, msgs: [enc(laptop, alice.id, 1, 'sync: sent "sent from laptop"')] })
const synced = await A.next()
assert(synced.dev === laptop.device, 'sync arrives from the laptop')
// (The refused send above advanced the laptop's session once; Signal handles the gap.)
assert(open(alice, synced).startsWith('sync:'), 'phone receives the sync from the laptop')

// Unlinking takes effect immediately and for good. A second linked device exists, so we can check
// the laptop (which still holds the identity key) can't slip into its slot either.
const { acct: phone2, c: P2 } = await link(A, alice)
assert(!(await A.rpc({ t: 'unlink', device: laptop.device })).error, 'main device unlinks the laptop')
assert(await until(() => L.pushes.some((p) => p.t === 'unlinked')), 'laptop is told it was unlinked')
assert(await until(() => L.ws.readyState === WebSocket.CLOSED), "the laptop's open connection is closed")
assert((await client(laptop)).ready.error === 'unlinked', "an unlinked device can't log back in")
assert((await client(laptop, { asDevice: phone2.device })).ready.error === 'unlinked', "an unlinked device can't sign in as another linked device")
assert((await client(laptop, { asDevice: 1 })).ready.error === 'bad_auth', "an unlinked device can't sign in as the main device")
assert(!(await A.rpc({ t: 'unlink', device: phone2.device })).error, 'unlink the second device too')
assert(await until(() => P2.ws.readyState === WebSocket.CLOSED), 'its connection closes as well')
const after = await B2.rpc({ t: 'send', to: alice.id, msgs: [enc(bob, alice.id, 1, 'a'), enc(bob, alice.id, laptop.device, 'b')] })
assert(after.error === 'devices' && after.extra.join() === `${laptop.device}`, 'senders learn the device is gone')

// Restoring the recovery phrase makes a new main device and signs out every linked device.
const { acct: tablet, c: T } = await link(A, alice)
assert(tablet.device === phone2.device + 1, "device ids aren't reused")
const restored = Account.create(alice.phrase, Date.now())
const R = await client(restored)
assert(!(await R.rpc({ t: 'keys', keys: JSON.parse(restored.keys(10, 3)), replace: true })).error, 'restore uploads fresh keys')
assert(await until(() => T.pushes.some((p) => p.t === 'unlinked')), 'restore unlinks the tablet')
assert((await R.rpc({ t: 'devices' })).devices.length === 1, 'only the restored main device remains')

console.log('e2e ok')
process.exit(0)
