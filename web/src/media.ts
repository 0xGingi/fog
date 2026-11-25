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
}
export const MAX_FILE = 100 * 1024 * 1024

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

// ponytail: whole-file encrypt/decrypt in memory (fine to 100 MB). Chunked streaming for bigger files later.
export async function upload(att: Att, reserve: (size: number) => Promise<string>): Promise<Att> {
  const blob = await localBlob(att.lid)
  if (!blob) throw new Error('missing local file')
  setT(att.lid, { p: 0, dir: 'up' })
  try {
    const { out, key } = await encrypt(await blob.arrayBuffer())
    const id = await reserve(out.length)
    await new Promise<void>((res, rej) => {
      const x = new XMLHttpRequest()
      x.open('PUT', `${SERVER.origin}/blob/${id}`)
      x.upload.onprogress = (e) => e.lengthComputable && setT(att.lid, { p: e.loaded / e.total, dir: 'up' })
      x.onload = () => (x.status < 300 ? res() : rej(new Error(`upload ${x.status}`)))
      x.onerror = () => rej(new Error('upload failed'))
      x.send(out)
    })
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

async function videoPoster(v: HTMLVideoElement, dur: number) {
  await new Promise<void>((res) => {
    v.onseeked = () => res()
    v.currentTime = Math.min(0.5, dur / 2)
    setTimeout(res, 3000)
  })
  return toDataUrl(v, v.videoWidth, v.videoHeight, 360, 0.7)
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
export async function prepareSticker(file: Blob): Promise<Att> {
  const bmp = await createImageBitmap(file)
  const s = Math.min(1, 512 / Math.max(bmp.width, bmp.height))
  const w = Math.round(bmp.width * s)
  const h = Math.round(bmp.height * s)
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
