// Landing page: a live side-by-side of a chat and what Fog's server receives for it.
import './landing.css'

// Invite links (getfog.org/#add=<id>) open the app.
if (location.hash.startsWith('#add=')) location.replace(`/app/${location.hash}`)

const te = new TextEncoder()
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

/** Bytes after padding, as the app pads them: the JSON payload plus a 0x80 marker, to 160-byte steps. */
function padded(text: string) {
  const payload = JSON.stringify({ t: 'text', id: `${'x'.repeat(16)}.${crypto.randomUUID()}`, text, ts: Date.now() })
  return Math.ceil((te.encode(payload).length + 1) / 160) * 160
}
/** Stand-in ciphertext: random bytes of the padded size (real ciphertext is indistinguishable from this). */
function noise(n: number) {
  let s = ''
  for (const b of crypto.getRandomValues(new Uint8Array(n))) s += String.fromCharCode(b)
  return btoa(s)
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string) {
  const e = document.createElement(tag)
  e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

const you = $<HTMLOListElement>('you')
const server = $<HTMLOListElement>('server')
const size = $<HTMLParagraphElement>('size')
const say = $<HTMLInputElement>('say')

function add(text: string, mine: boolean, animate: boolean) {
  const time = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const li = el('li', `${animate ? 'row-in ' : ''}flex ${mine ? 'justify-end' : 'justify-start'}`)
  const bubble = el('p', `max-w-[85%] rounded-2xl px-3 py-1.5 text-[15px] leading-snug shadow-[0_1px_1px_rgba(0,0,0,0.06)] ${mine ? 'rounded-br-md bg-out text-out-ink' : 'rounded-bl-md bg-in'}`, text)
  bubble.append(el('span', 'ml-2 align-[-2px] text-[11px] whitespace-nowrap opacity-60', time))
  li.append(bubble)
  you.append(li)

  const n = padded(text)
  const row = el('li', animate ? 'row-in' : '')
  const meta = el('p', 'mb-1 flex justify-between gap-2 font-sans text-[12px] text-white/50')
  // Between contacts both directions are sealed: the server knows the recipient's ID, not the sender.
  meta.append(el('span', '', mine ? "Sealed, for Maya's ID" : 'Sealed, for your ID'), el('span', 'tabular-nums', `${n} bytes`))
  row.append(meta, el('p', 'cipher line-clamp-2 text-white/75', noise(n)))
  server.append(row)

  for (const list of [you, server]) while (list.children.length > 4) list.firstElementChild!.remove()
}

function showSize() {
  const text = say.value.trim()
  size.textContent = text ? `This message would be sent as ${padded(text)} bytes of ciphertext.` : 'Short or long, every message travels in 160-byte steps.'
}

add('Are we still on for Saturday?', false, false)
add('Yes! 8am at the trailhead', true, false)
add('👍', false, false)
showSize()
say.addEventListener('input', showSize)
$<HTMLFormElement>('compose').addEventListener('submit', (e) => {
  e.preventDefault()
  const text = say.value.trim()
  if (!text) return
  add(text, true, true)
  say.value = ''
  showSize()
})

// Returning users: the call to action opens their chats. (databases() never creates a database.)
indexedDB
  .databases?.()
  .then((dbs) => {
    if (dbs.some((d) => d.name === 'fog')) document.querySelectorAll('a[data-open]').forEach((a) => a.textContent === 'Open Fog in your browser' && (a.textContent = 'Open your chats'))
  })
  .catch(() => {})

// Highlight the download for this device.
const ua = navigator.userAgent
const touchMac = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1 // iPadOS reports itself as a Mac
const os = /Android/.test(ua) ? 'android' : /iPhone|iPad/.test(ua) || touchMac ? 'ios' : /Mac/.test(ua) ? 'mac' : /Win/.test(ua) ? 'windows' : /Linux|X11/.test(ua) ? (/aarch64|arm64|armv8/i.test(ua) ? 'linux-arm64' : 'linux-x64') : null
if (os) document.querySelector(`[data-os="${os}"]`)?.classList.add('os-match')
