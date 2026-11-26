// Attachments: encrypt in the browser, upload ciphertext, put {id, key} inside the E2EE message.
// Also: photo/video processing, voice recording, a single shared audio player, and the message chime.
import { useSyncExternalStore } from 'react'
import { kv } from './db'

/** Fog server. The page's own origin on the web; native builds set VITE_FOG_SERVER (e.g. https://getfog.org). */
export const SERVER = new URL(import.meta.env.VITE_FOG_SERVER || location.origin)

export type Kind = 'photo' | 'video' | 'audio' | 'voice' | 'file' | 'sticker' | 'videonote'
/** `lid` keys the local plaintext copy; `id`/`key` exist once uploaded. */
export type Att = {
  lid: string
  id?: string
  key?: string
  kind: Kind
  size: number
  mime: string
  name: string
  w?: number
  h?: number
  dur?: number
  thumb?: string
  wave?: number[]
  /** Encrypted in chunks of this many bytes (big files; see `uploadChunked`). */
  ch?: number
}
export const MAX_FILE = 2 * 1024 ** 3
/** Files above this go up in encrypted 4 MB chunks, and resume if the connection drops. */
const CHUNKED_ABOVE = 32 * 1024 * 1024
const CHUNK = 4 * 1024 * 1024
const TAG = 16

const b64 = (u: Uint8Array) => {
  let s = ''
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000))
  return btoa(s)
}
const unb64 = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

// ---------- transfer progress (shared by every view of the same attachment) ----------
export type Transfer = { p: number; dir: 'up' | 'down'; err?: boolean }
const transfers = new Map<string, Transfer>()
const tl = new Set<() => void>()
function setT(lid: string, t: Transfer | null) {
  if (t) transfers.set(lid, t)
  else transfers.delete(lid)
  tl.forEach((l) => l())
}
export const useTransfer = (lid: string) =>
  useSyncExternalStore(
    (l) => (tl.add(l), () => tl.delete(l)),
    () => transfers.get(lid),
  )

// ---------- local plaintext cache ----------
const urls = new Map<string, string>()
const ul = new Set<() => void>()
export const localBlob = (lid: string) => kv<Blob>(`att:${lid}`)
export async function storeLocal(lid: string, blob: Blob) {
  await kv(`att:${lid}`, blob.type === safeType(blob.type) ? blob : new Blob([blob], { type: safeType(blob.type) }))
}
export async function localUrl(lid: string): Promise<string | null> {
  if (urls.has(lid)) return urls.get(lid)!
  const blob = await localBlob(lid)
  if (!blob) return null
  const url = URL.createObjectURL(blob)
  urls.set(lid, url)
  ul.forEach((l) => l())
  return url
}
/** Object URL if the plaintext is already here (reactive). */
export const useLocalUrl = (lid: string) =>
  useSyncExternalStore(
    (l) => (ul.add(l), () => ul.delete(l)),
    () => urls.get(lid),
  )
export function dropLocal(lid: string) {
  const u = urls.get(lid)
  if (u) URL.revokeObjectURL(u)
  urls.delete(lid)
  kv(`att:${lid}`, null)
}

// Only types we render inline get their real MIME on the object URL. Everything else is opaque bytes:
// a blob: URL shares our origin, so an attached .html/.svg must never be rendered or opened as a page.
const INLINE = /^(image\/(png|jpeg|webp|gif|avif)|video\/(mp4|webm|quicktime|ogg)|audio\/[\w.+-]+)$/
function safeType(mime: string) {
  return INLINE.test(mime) ? mime : 'application/octet-stream'
}

// ---------- crypto + transport ----------
/** Pad attachment sizes to ~5% buckets (Signal's scheme) so stored blobs don't reveal exact sizes. */
export const padBucket = (n: number) => Math.max(541, Math.floor(1.05 ** Math.ceil(Math.log(Math.max(1, n)) / Math.log(1.05))))

async function encrypt(data: ArrayBuffer) {
  const raw = crypto.getRandomValues(new Uint8Array(32))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt'])
  const padded = new Uint8Array(padBucket(data.byteLength))
  padded.set(new Uint8Array(data))
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, padded))
  const out = new Uint8Array(12 + ct.length)
  out.set(iv)
  out.set(ct, 12)
  return { out, key: b64(raw) }
}
async function decrypt(data: Uint8Array<ArrayBuffer>, key: string) {
  const k = await crypto.subtle.importKey('raw', unb64(key), 'AES-GCM', false, ['decrypt'])
  return crypto.subtle.decrypt({ name: "AES-GCM", iv: data.subarray(0, 12) }, k, data.subarray(12))
}

/**
 * Big files: the padded file is cut into 4 MB chunks, each sealed with AES-256-GCM under the file's
 * key with its index as the nonce and an end-of-file marker as associated data. Reordered, swapped
 * or cut-off chunks fail to decrypt. Only one chunk is in memory at a time on either end.
 */
const nonce = (i: number) => {
  const n = new Uint8Array(12)
  new DataView(n.buffer).setBigUint64(4, BigInt(i))
  return n
}
const chunkLayout = (size: number) => {
  const padded = padBucket(size)
  const n = Math.max(1, Math.ceil(padded / CHUNK))
  return { padded, n, total: padded + n * TAG }
}

/** Send one part of a resumable upload, with progress. */
function putPart(id: string, offset: number, data: Uint8Array<ArrayBuffer>, progress: (sent: number) => void) {
  return put(`${SERVER.origin}/blob/${id}?offset=${offset}`, data, progress)
}
/** PUT with upload progress (XMLHttpRequest has it, fetch doesn't). The bot daemon has only fetch. */
function put(url: string, data: Uint8Array<ArrayBuffer>, progress: (sent: number) => void) {
  if (typeof XMLHttpRequest === 'undefined')
    return fetch(url, { method: 'PUT', body: data }).then(
      (r) => {
        if (r.status >= 300) throw Object.assign(new Error(`upload ${r.status}`), { status: r.status })
        progress(data.length)
      },
      () => Promise.reject(new Error('upload failed')),
    )
  return new Promise<void>((res, rej) => {
    const x = new XMLHttpRequest()
    x.open('PUT', url)
    x.upload.onprogress = (e) => progress(e.loaded)
    x.onload = () => (x.status < 300 ? res() : rej(Object.assign(new Error(`upload ${x.status}`), { status: x.status })))
    x.onerror = () => rej(new Error('upload failed'))
    x.send(data)
  })
}
/** How much of an upload the server has: null once the slot is gone (finished or expired),
 *  undefined if the server couldn't be asked (still offline). */
async function serverOffset(id: string): Promise<number | null | undefined> {
  const r = await fetch(`${SERVER.origin}/blob/${id}/offset`).catch(() => undefined)
  if (!r) return undefined
  return r.ok ? ((await r.json()).offset as number) : r.status === 404 ? null : undefined
}

async function uploadChunked(att: Att, blob: Blob, reserve: (size: number) => Promise<string>): Promise<Att> {
  const { padded, n, total } = chunkLayout(blob.size)
  // Where an earlier attempt got to (the app may have been closed mid-upload): carry on from there.
  let st = await kv<{ id: string; key: string }>(`up:${att.lid}`)
  let offset = st ? await serverOffset(st.id) : null
  if (offset === undefined) throw new Error('offline') // try again later, from the same place
  if (!st || offset === null) {
    st = { id: await reserve(total), key: b64(crypto.getRandomValues(new Uint8Array(32))) }
    await kv(`up:${att.lid}`, st)
    offset = 0
  }
  const k = await crypto.subtle.importKey('raw', unb64(st.key), 'AES-GCM', false, ['encrypt'])
  const span = CHUNK + TAG
  let fails = 0
  for (let i = Math.floor(offset / span); i < n; ) {
    const start = i * CHUNK
    const end = Math.min(padded, start + CHUNK)
    // Past the end of the file is the size padding: zeros.
    const plain = new Uint8Array(end - start)
    if (start < blob.size) plain.set(new Uint8Array(await blob.slice(start, Math.min(end, blob.size)).arrayBuffer()))
    const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce(i), additionalData: new Uint8Array([i === n - 1 ? 1 : 0]) }, k, plain))
    try {
      await putPart(st.id, i * span, sealed, (sent) => setT(att.lid, { p: (i * span + sent) / total, dir: 'up' }))
      i++
      fails = 0
    } catch (e) {
      // Dropped connection: wait, ask the server where it got to, and resume. Give up after a while
      // (the message shows "failed"; retrying it resumes from the same place).
      if (++fails > 6) throw e
      await new Promise((r) => setTimeout(r, 1000 * 2 ** fails))
      const at = await serverOffset(st.id)
      if (at === null) throw e // the upload is gone (expired): start over next time
      if (at !== undefined) i = Math.floor(at / span)
    }
  }
  await kv(`up:${att.lid}`, null)
  return { ...att, id: st.id, key: st.key, ch: CHUNK }
}

export async function upload(att: Att, reserve: (size: number) => Promise<string>): Promise<Att> {
  const blob = await localBlob(att.lid)
  if (!blob) throw new Error('missing local file')
  setT(att.lid, { p: 0, dir: 'up' })
  try {
    if (blob.size > CHUNKED_ABOVE) {
      const done = await uploadChunked(att, blob, reserve)
      setT(att.lid, null)
      return done
    }
    const { out, key } = await encrypt(await blob.arrayBuffer())
    const id = await reserve(out.length)
    await put(`${SERVER.origin}/blob/${id}`, out, (sent) => setT(att.lid, { p: sent / out.length, dir: 'up' }))
    setT(att.lid, null)
    return { ...att, id, key }
  } catch (e) {
    setT(att.lid, { p: 0, dir: 'up', err: true })
    throw e
  }
}

const inflight = new Map<string, Promise<string | null>>()
/** Fetch, verify (AES-GCM tag) and cache an attachment. Resolves to an object URL. */
export function download(att: Att): Promise<string | null> {
  const running = inflight.get(att.lid)
  if (running) return running
  const p = (async () => {
    const have = await localUrl(att.lid)
    if (have || !att.id || !att.key) return have
    setT(att.lid, { p: 0, dir: 'down' })
    try {
      const r = await fetch(`${SERVER.origin}/blob/${att.id}`)
      if (!r.ok || !r.body) throw new Error(`download ${r.status}`)
      if (att.ch) {
        await storeLocal(att.lid, await decryptChunked(r.body, att))
        setT(att.lid, null)
        return localUrl(att.lid)
      }
      const total = Number(r.headers.get('content-length')) || att.size || 1
      const reader = r.body.getReader()
      const parts: Uint8Array[] = []
      let got = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        parts.push(value)
        got += value.length
        setT(att.lid, { p: Math.min(1, got / total), dir: 'down' })
      }
      const data = new Uint8Array(got)
      let o = 0
      for (const part of parts) (data.set(part, o), (o += part.length))
      const plain = await decrypt(data, att.key)
      // The real size travels inside the encrypted message; drop the bucket padding.
      const exact = att.size > 0 && att.size <= plain.byteLength ? plain.slice(0, att.size) : plain
      await storeLocal(att.lid, new Blob([exact], { type: safeType(att.mime) }))
      setT(att.lid, null)
      return localUrl(att.lid)
    } catch {
      setT(att.lid, { p: 0, dir: 'down', err: true })
      return null
    } finally {
      inflight.delete(att.lid)
    }
  })()
  inflight.set(att.lid, p)
  return p
}

/** Decrypt a chunked attachment as it streams in, one chunk at a time. */
async function decryptChunked(body: ReadableStream<Uint8Array>, att: Att): Promise<Blob> {
  const ch = att.ch!
  if (ch !== CHUNK) throw new Error('unknown chunk size')
  const { padded, n, total } = chunkLayout(att.size)
  const k = await crypto.subtle.importKey('raw', unb64(att.key!), 'AES-GCM', false, ['decrypt'])
  const reader = body.getReader()
  const parts: BlobPart[] = []
  let pending: Uint8Array[] = []
  let pendingLen = 0
  let got = 0
  let i = 0
  let kept = 0 // plaintext bytes kept so far (padding beyond att.size is dropped)
  const take = (len: number) => {
    const out = new Uint8Array(len)
    let o = 0
    while (o < len) {
      const head = pending[0]
      const use = Math.min(head.length, len - o)
      out.set(head.subarray(0, use), o)
      o += use
      if (use === head.length) pending.shift()
      else pending[0] = head.subarray(use)
    }
    pendingLen -= len
    return out
  }
  const chunkLen = (j: number) => (j < n - 1 ? CHUNK : padded - (n - 1) * CHUNK) + TAG
  for (;;) {
    const { done, value } = await reader.read()
    if (value) {
      pending.push(value)
      pendingLen += value.length
      got += value.length
      setT(att.lid, { p: Math.min(1, got / total), dir: 'down' })
    }
    while (i < n && pendingLen >= chunkLen(i)) {
      const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce(i), additionalData: new Uint8Array([i === n - 1 ? 1 : 0]) }, k, take(chunkLen(i))))
      const keep = Math.min(plain.length, att.size - kept)
      if (keep > 0) parts.push(keep === plain.length ? plain : plain.slice(0, keep))
      kept += Math.max(0, keep)
      i++
      // Fold finished chunks into a Blob now and then, so the browser can keep them out of memory.
      if (parts.length >= 16) parts.splice(0, parts.length, new Blob(parts))
    }
    if (done) break
  }
  // Every chunk, ending with the one sealed as last: anything shorter was cut off.
  if (i !== n || pendingLen) throw new Error('truncated')
  return new Blob(parts, { type: safeType(att.mime) })
}

/** Hand the file to the browser's downloads. Always as opaque bytes, never opened in a tab. */
export async function saveFile(att: Att) {
  if (!(await download(att))) return false
  const blob = await localBlob(att.lid)
  if (!blob) return false
  const url = URL.createObjectURL(new Blob([blob], { type: 'application/octet-stream' }))
  const a = document.createElement('a')
  a.href = url
  a.download = att.name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
  return true
}

// ---------- preparing files ----------
const RASTER = /^image\/(png|jpeg|webp|avif|bmp)$/

async function toDataUrl(src: CanvasImageSource, sw: number, sh: number, max: number, q: number) {
  const s = Math.min(1, max / Math.max(sw, sh))
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(sw * s))
  c.height = Math.max(1, Math.round(sh * s))
  c.getContext('2d')!.drawImage(src, 0, 0, c.width, c.height)
  const webp = c.toDataURL('image/webp', q)
  return webp.startsWith('data:image/webp') ? webp : c.toDataURL('image/jpeg', q)
}

async function encodeBlob(bmp: ImageBitmap, w: number, h: number, q: number) {
  const c = new OffscreenCanvas(w, h)
  c.getContext('2d')!.drawImage(bmp, 0, 0, w, h)
  const webp = await c.convertToBlob({ type: 'image/webp', quality: q })
  // Safari can't encode WebP and silently returns PNG; use JPEG there.
  return webp.type === 'image/webp' ? webp : c.convertToBlob({ type: 'image/jpeg', quality: q })
}

function mediaMeta(url: string, video: boolean) {
  return new Promise<{ w: number; h: number; dur: number; el: HTMLVideoElement | HTMLAudioElement }>((res, rej) => {
    const el = document.createElement(video ? 'video' : 'audio')
    el.preload = 'metadata'
    el.muted = true
    const t = setTimeout(() => rej(new Error('timeout')), 8000)
    el.onloadedmetadata = () => {
      clearTimeout(t)
      const v = el as HTMLVideoElement
      res({ w: v.videoWidth || 0, h: v.videoHeight || 0, dur: Number.isFinite(el.duration) ? el.duration : 0, el })
    }
    el.onerror = () => (clearTimeout(t), rej(new Error('unsupported')))
    el.src = url
  })
}

/** Mostly black (a frame that hasn't been decoded yet, or a fade-in)? */
export function blank(src: CanvasImageSource, w: number, h: number) {
  const c = document.createElement('canvas')
  c.width = c.height = 16
  const g = c.getContext('2d', { willReadFrequently: true })!
  g.drawImage(src, 0, 0, w, h, 0, 0, 16, 16)
  const d = g.getImageData(0, 0, 16, 16).data
  let sum = 0
  for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2]
  return sum / (d.length / 4) / 3 < 10
}
const seekTo = (v: HTMLVideoElement, t: number) =>
  new Promise<void>((res) => {
    const done = () => res()
    v.addEventListener('seeked', done, { once: true })
    v.currentTime = t
    setTimeout(done, 2500)
  })

/**
 * A still for the chat bubble. WebKit (iPhones, Safari) only decodes frames once real data has
 * loaded and the video has played, so load it fully, play it muted for a moment, then pick the
 * first frame that isn't black (skipping fade-ins). Null if every try is black.
 */
/** A still from a video that's playing right now (for videos whose thumbnail came out black). */
export async function posterNow(v: HTMLVideoElement) {
  return v.videoWidth && !blank(v, v.videoWidth, v.videoHeight) ? toDataUrl(v, v.videoWidth, v.videoHeight, 360, 0.7) : undefined
}
/** Is this thumbnail (a data URL) missing or black? */
export async function thumbIsBlank(thumb?: string) {
  if (!thumb) return true
  const img = new Image()
  img.src = thumb
  await img.decode().catch(() => {})
  return !img.naturalWidth || blank(img, img.naturalWidth, img.naturalHeight)
}

export async function videoPoster(v: HTMLVideoElement, dur: number): Promise<string | undefined> {
  v.muted = true
  v.playsInline = true
  v.preload = 'auto'
  if (v.readyState < 2)
    await new Promise<void>((res) => {
      v.addEventListener('loadeddata', () => res(), { once: true })
      v.load()
      setTimeout(res, 4000)
    })
  await v.play().then(() => v.pause(), () => {})
  for (const t of [Math.min(0.5, dur / 2), dur * 0.1, dur * 0.25, dur * 0.5]) {
    await seekTo(v, t)
    await new Promise((r) => setTimeout(r, 60))
    if (v.videoWidth && !blank(v, v.videoWidth, v.videoHeight)) return toDataUrl(v, v.videoWidth, v.videoHeight, 360, 0.7)
  }
  return undefined
}

/**
 * Turn a picked/dropped/pasted file into an attachment ready to send. Photos are re-encoded (which
 * also strips EXIF location) unless sent "as file"; video gets a poster and duration.
 */
export async function prepare(file: File, asFile = false): Promise<Att> {
  const lid = crypto.randomUUID()
  const base = { lid, mime: file.type || 'application/octet-stream', name: file.name || 'file', size: file.size }
  if (file.size > MAX_FILE) throw new Error('too_large')
  try {
    if (!asFile && (RASTER.test(file.type) || file.type === 'image/gif')) {
      const bmp = await createImageBitmap(file)
      const thumb = await toDataUrl(bmp, bmp.width, bmp.height, 40, 0.5)
      if (file.type === 'image/gif') {
        await storeLocal(lid, file)
        return { ...base, kind: 'photo', w: bmp.width, h: bmp.height, thumb }
      }
      const s = Math.min(1, 2560 / Math.max(bmp.width, bmp.height))
      const w = Math.round(bmp.width * s)
      const h = Math.round(bmp.height * s)
      const blob = await encodeBlob(bmp, w, h, 0.86)
      await storeLocal(lid, blob)
      return { ...base, kind: 'photo', mime: blob.type, size: blob.size, name: file.name.replace(/\.\w+$/, '') + (blob.type === 'image/webp' ? '.webp' : '.jpg'), w, h, thumb }
    }
    if (!asFile && file.type.startsWith('video/')) {
      const url = URL.createObjectURL(file)
      try {
        const m = await mediaMeta(url, true)
        const thumb = await videoPoster(m.el as HTMLVideoElement, m.dur)
        await storeLocal(lid, file)
        return { ...base, kind: 'video', w: m.w, h: m.h, dur: m.dur, thumb }
      } finally {
        URL.revokeObjectURL(url)
      }
    }
    if (file.type.startsWith('audio/')) {
      const url = URL.createObjectURL(file)
      try {
        const m = await mediaMeta(url, false)
        await storeLocal(lid, file)
        return { ...base, kind: 'audio', dur: m.dur }
      } finally {
        URL.revokeObjectURL(url)
      }
    }
  } catch {
    // Not decodable here (e.g. HEVC in Chrome): fall through and send it as a plain file.
  }
  await storeLocal(lid, file)
  return { ...base, kind: 'file' }
}

/** Square-crop and shrink a profile or group photo to a small data URL (sent inside messages). */
export async function avatarFrom(file: Blob): Promise<string> {
  const bmp = await createImageBitmap(file)
  const s = Math.min(bmp.width, bmp.height)
  const c = document.createElement('canvas')
  c.width = c.height = 256
  c.getContext('2d')!.drawImage(bmp, (bmp.width - s) / 2, (bmp.height - s) / 2, s, s, 0, 0, 256, 256)
  const webp = c.toDataURL('image/webp', 0.85)
  return webp.startsWith('data:image/webp') ? webp : c.toDataURL('image/jpeg', 0.85)
}

/** Stickers: up to 512px WebP, transparency kept (PNG where WebP encoding isn't available). */
/** Animated GIF, animated WebP or APNG? (Read from the file's first bytes.) */
async function isAnimated(file: Blob) {
  const b = new Uint8Array(await file.slice(0, 64 * 1024).arrayBuffer())
  const at = (s: string, o: number) => [...s].every((c, i) => b[o + i] === c.charCodeAt(0))
  if (at('GIF8', 0)) return true // treated as animated: re-encoding would lose any frames anyway
  if (at('RIFF', 0) && at('WEBP', 8) && at('VP8X', 12)) return (b[20] & 0x02) !== 0
  if (b[0] === 0x89 && at('PNG', 1)) {
    for (let i = 8; i + 8 < b.length; ) {
      const len = new DataView(b.buffer, i, 4).getUint32(0)
      if (at('acTL', i + 4)) return true
      if (at('IDAT', i + 4)) return false
      i += 12 + len
    }
  }
  return false
}
export const MAX_ANIMATED_STICKER = 2 * 1024 * 1024

export async function prepareSticker(file: Blob): Promise<Att> {
  const bmp = await createImageBitmap(file)
  const s = Math.min(1, 512 / Math.max(bmp.width, bmp.height))
  const w = Math.round(bmp.width * s)
  const h = Math.round(bmp.height * s)
  // Animated stickers are kept as they are (shrinking them would mean re-encoding every frame).
  if (await isAnimated(file)) {
    if (file.size > MAX_ANIMATED_STICKER) throw new Error('animated_too_large')
    const lid = crypto.randomUUID()
    await storeLocal(lid, file)
    return { lid, kind: 'sticker', mime: file.type || 'image/gif', name: 'sticker', size: file.size, w, h }
  }
  const c = new OffscreenCanvas(w, h)
  c.getContext('2d')!.drawImage(bmp, 0, 0, w, h)
  let blob = await c.convertToBlob({ type: 'image/webp', quality: 0.9 })
  if (blob.type !== 'image/webp') blob = await c.convertToBlob({ type: 'image/png' })
  const lid = crypto.randomUUID()
  await storeLocal(lid, blob)
  return { lid, kind: 'sticker', mime: blob.type, name: 'sticker', size: blob.size, w, h }
}

/** Shrink a link-preview image (a data URL from the server) to a small thumbnail for the message. */
export async function previewThumb(dataUrl: string): Promise<string | undefined> {
  try {
    const [head, b64data] = dataUrl.split(',')
    const type = /data:([^;]+)/.exec(head)?.[1] ?? 'image/jpeg'
    const bmp = await createImageBitmap(new Blob([unb64(b64data)], { type }))
    return toDataUrl(bmp, bmp.width, bmp.height, 480, 0.72)
  } catch {
    return undefined
  }
}

// ---------- round video messages ----------
export type VideoNoteRec = { stream: MediaStream; started: number; stop: (poster: HTMLVideoElement) => Promise<Att | null>; cancel: () => void }
export const MAX_NOTE = 60

export async function recordVideoNote(): Promise<VideoNoteRec> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true },
    video: { width: { ideal: 480 }, height: { ideal: 480 }, aspectRatio: 1, facingMode: 'user' },
  })
  const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/mp4', 'video/webm'].find((t) => MediaRecorder.isTypeSupported(t))
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 900_000 } : undefined)
  const chunks: Blob[] = []
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data)
  rec.start(500)
  const started = performance.now()
  const end = () => stream.getTracks().forEach((t) => t.stop())
  return {
    stream,
    started,
    cancel: () => {
      rec.onstop = null
      if (rec.state !== 'inactive') rec.stop()
      end()
    },
    stop: (poster) =>
      new Promise((res) => {
        const dur = (performance.now() - started) / 1000
        const v = poster.videoWidth ? poster : null
        const s = v ? Math.min(v.videoWidth, v.videoHeight) : 0
        let thumb: string | undefined
        if (v && s) {
          const c = document.createElement('canvas')
          c.width = c.height = 240
          c.getContext('2d')!.drawImage(v, (v.videoWidth - s) / 2, (v.videoHeight - s) / 2, s, s, 0, 0, 240, 240)
          thumb = c.toDataURL('image/webp', 0.7)
        }
        rec.onstop = async () => {
          end()
          if (dur < 1) return res(null)
          const type = (rec.mimeType || 'video/webm').split(';')[0]
          const blob = new Blob(chunks, { type })
          const lid = crypto.randomUUID()
          await storeLocal(lid, blob)
          res({ lid, kind: 'videonote', mime: type, name: `video-message.${type.includes('mp4') ? 'mp4' : 'webm'}`, size: blob.size, dur, w: 240, h: 240, thumb })
        }
        rec.stop()
      }),
  }
}

// ---------- voice recording ----------
export type Recording = { levels: number[]; started: number; stop: () => Promise<Att | null>; cancel: () => void }

export async function record(): Promise<Recording> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
  const mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find((t) => MediaRecorder.isTypeSupported(t))
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 48000 } : undefined)
  const ctx = new AudioContext()
  const an = ctx.createAnalyser()
  an.fftSize = 1024
  ctx.createMediaStreamSource(stream).connect(an)
  const buf = new Uint8Array(an.fftSize)
  const levels: number[] = []
  const tick = setInterval(() => {
    an.getByteTimeDomainData(buf)
    let sum = 0
    for (const v of buf) sum += ((v - 128) / 128) ** 2
    levels.push(Math.min(1, Math.sqrt(sum / buf.length) * 4))
  }, 50)
  const chunks: Blob[] = []
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data)
  rec.start(250)
  const started = performance.now()
  const cleanup = () => {
    clearInterval(tick)
    stream.getTracks().forEach((t) => t.stop())
    ctx.close()
  }
  return {
    levels,
    started,
    cancel: () => {
      rec.onstop = null
      if (rec.state !== 'inactive') rec.stop()
      cleanup()
    },
    stop: () =>
      new Promise((res) => {
        rec.onstop = async () => {
          cleanup()
          const dur = (performance.now() - started) / 1000
          if (dur < 0.6) return res(null)
          const type = rec.mimeType || 'audio/webm'
          const blob = new Blob(chunks, { type })
          const lid = crypto.randomUUID()
          await storeLocal(lid, blob)
          // 48 bars, 0..31, for the waveform drawn in the bubble.
          const n = 48
          const wave = Array.from({ length: n }, (_, i) => {
            const slice = levels.slice(Math.floor((i * levels.length) / n), Math.floor(((i + 1) * levels.length) / n) || undefined)
            return Math.round(Math.min(1, Math.max(...slice, 0)) * 31)
          })
          const ext = type.includes('mp4') ? 'm4a' : 'webm'
          res({ lid, kind: 'voice', mime: type.split(';')[0], name: `voice-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.${ext}`, size: blob.size, dur, wave })
        }
        rec.stop()
      }),
  }
}

// ---------- one shared audio player ----------
type PlayerState = { lid: string | null; playing: boolean; t: number; dur: number; rate: number; loading: boolean }
const audio = typeof Audio !== 'undefined' ? new Audio() : null
let ps: PlayerState = { lid: null, playing: false, t: 0, dur: 0, rate: 1, loading: false }
const pl = new Set<() => void>()
const setP = (patch: Partial<PlayerState>) => ((ps = { ...ps, ...patch }), pl.forEach((l) => l()))
if (audio) {
  audio.ontimeupdate = () => setP({ t: audio.currentTime, dur: Number.isFinite(audio.duration) ? audio.duration : ps.dur })
  audio.onplay = () => setP({ playing: true })
  audio.onpause = () => setP({ playing: false })
  audio.onended = () => setP({ playing: false, t: 0 })
}
export const usePlayer = () =>
  useSyncExternalStore(
    (l) => (pl.add(l), () => pl.delete(l)),
    () => ps,
  )

export async function togglePlay(att: Att) {
  if (!audio) return
  if (ps.lid === att.lid) return audio.paused ? audio.play() : audio.pause()
  audio.pause()
  setP({ lid: att.lid, loading: true, t: 0, dur: att.dur ?? 0, playing: false })
  const url = await download(att)
  if (!url || ps.lid !== att.lid) return setP({ loading: false })
  audio.src = url
  audio.playbackRate = ps.rate
  setP({ loading: false })
  audio.play()
}
export function seek(att: Att, frac: number) {
  if (!audio || ps.lid !== att.lid) return
  audio.currentTime = frac * (audio.duration || att.dur || 0)
}
export function cycleRate() {
  const rate = ps.rate === 1 ? 1.5 : ps.rate === 1.5 ? 2 : 1
  if (audio) audio.playbackRate = rate
  setP({ rate })
}

// ---------- incoming-message chime (synthesised, no asset) ----------
let ac: AudioContext | null = null
export function chime() {
  try {
    ac ??= new AudioContext()
    const t = ac.currentTime
    ;[660, 990].forEach((f, i) => {
      const o = ac!.createOscillator()
      const g = ac!.createGain()
      const at = t + i * 0.085
      o.type = 'sine'
      o.frequency.value = f
      g.gain.setValueAtTime(0, at)
      g.gain.linearRampToValueAtTime(0.09, at + 0.012)
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.28)
      o.connect(g).connect(ac!.destination)
      o.start(at)
      o.stop(at + 0.3)
    })
  } catch {}
}

export const fmtSize = (n: number) =>
  n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB` : `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB`
export const fmtDur = (s = 0) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
