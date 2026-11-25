// End-to-end protocol check against a running server: `bun e2e.ts` (server on 127.0.0.1:8787).
// Two accounts register, find each other by username, and exchange Signal-encrypted messages.
import { initSync, Account, new_mnemonic, solve_pow } from './src/core/fog_core.js'

initSync({ module: await Bun.file(new URL('./src/core/fog_core_bg.wasm', import.meta.url)).arrayBuffer() })
const HOST = process.env.FOG_HOST ?? '127.0.0.1:8787'
const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64')
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'))
const assert = (c: unknown, msg: string) => {
  if (!c) throw new Error(`FAIL: ${msg}`)
}

async function client(acct: Account) {
  const ws = new WebSocket(`ws://${HOST}/ws`)
  const inbox: any[] = []
  const pending = new Map<number, (m: any) => void>()
  let rid = 0
  let onInbox = () => {}
  let nonce = ''
  const ready = new Promise<any>((res) => {
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data as string)
      if (m.t === 'challenge') {
        nonce = m.nonce
        const sig = acct.sign(new TextEncoder().encode(`fog-auth-v1|${HOST}|${m.nonce}`))
        ws.send(JSON.stringify({ id: acct.id, sig: b64(sig) }))
      } else if (m.t === 'ready') res(m)
      else if (m.rid !== undefined) pending.get(m.rid)!(m)
      else if (m.t === 'msg') inbox.push(m), onInbox()
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
  return { ws, ready: r, rpc, next, pow: () => solve_pow(nonce, r.pow) }
}

const tag = Math.random().toString(36).slice(2, 8)
const alice = Account.create(new_mnemonic(), Date.now())
const bob = Account.create(new_mnemonic(), Date.now())
const A = await client(alice)
const B = await client(bob)
assert(!A.ready.registered, 'fresh account is unregistered')

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
alice.start_session(bob.id, JSON.stringify(bundle), Date.now())

await A.rpc({ t: 'send', to: bob.id, body: b64(alice.encrypt(bob.id, new TextEncoder().encode('hello bob'), Date.now())) })
const m1 = await B.next()
assert(m1.from === alice.id, 'sender id')
assert(new TextDecoder().decode(bob.decrypt(m1.from, unb64(m1.body))) === 'hello bob', 'bob decrypts')
await B.rpc({ t: 'ack', id: m1.id })

await B.rpc({ t: 'send', to: alice.id, body: b64(bob.encrypt(alice.id, new TextEncoder().encode('hi alice'), Date.now())) })
const m2 = await A.next()
assert(new TextDecoder().decode(alice.decrypt(m2.from, unb64(m2.body))) === 'hi alice', 'alice decrypts')
await A.rpc({ t: 'ack', id: m2.id })

// Offline delivery: bob disconnects, alice sends, bob reconnects and gets it queued.
B.ws.close()
await A.rpc({ t: 'send', to: bob.id, body: b64(alice.encrypt(bob.id, new TextEncoder().encode('while you were out'), Date.now())) })
const B2 = await client(bob)
assert(B2.ready.username === `bob_${tag}`, 'username survives reconnect')
const m3 = await B2.next()
assert(new TextDecoder().decode(bob.decrypt(m3.from, unb64(m3.body))) === 'while you were out', 'queued message')
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

// Sealed sender: Alice registers an access key; Bob sends with it and no sender attached.
const access = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64')
assert(!(await B2.rpc({ t: 'access', key: access })).error, 'register access key')
const { cert } = await A.rpc({ t: 'cert' })
const sealedBody = b64(alice.seal(bob.id, new TextEncoder().encode('sealed hello'), unb64(cert), Date.now()))
assert((await fetch(`http://${HOST}/sealed`, { method: 'POST', body: JSON.stringify({ to: bob.id, body: sealedBody, access: 'AAAAAAAAAAAAAAAAAAAAAA==' }) })).status === 401, 'wrong access key refused')
assert((await fetch(`http://${HOST}/sealed`, { method: 'POST', body: JSON.stringify({ to: bob.id, body: sealedBody, access }) })).status === 201, 'sealed send accepted')
const s1 = await B2.next()
assert(s1.sealed === true && s1.from === null, 'server delivers without a sender')
const opened = bob.unseal(unb64(s1.body), unb64(B2.ready.trust), Date.now())
assert(new TextDecoder().decode(opened.subarray(0, 43)) === alice.id, 'recipient learns the real sender')
assert(new TextDecoder().decode(opened.subarray(43)) === 'sealed hello', 'sealed plaintext')
await B2.rpc({ t: 'ack', id: s1.id })

// A forged login (signature over the wrong host) is refused.
const evil = new WebSocket(`ws://${HOST}/ws`)
const refused = await new Promise<boolean>((res) => {
  evil.onmessage = (e) => {
    const m = JSON.parse(e.data as string)
    if (m.t === 'challenge') evil.send(JSON.stringify({ id: alice.id, sig: b64(alice.sign(new TextEncoder().encode(`fog-auth-v1|evil.example|${m.nonce}`))) }))
    else res(m.error === 'bad_auth')
  }
})
assert(refused, 'wrong-host signature refused')

console.log('e2e ok')
process.exit(0)
