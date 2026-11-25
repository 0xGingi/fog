// 1:1 voice/video calls. WebRTC media goes peer to peer (DTLS-SRTP); the offer/answer, and with
// them the DTLS fingerprints, travel inside the Signal session, so nobody can sit in the middle.
import { useSyncExternalStore } from 'react'
import * as fog from './fog'

export type Call = {
  id: string
  peer: string
  out: boolean
  video: boolean
  phase: 'ringing' | 'connecting' | 'active' | 'ended'
  started?: number
  muted: boolean
  camOff: boolean
  sharing?: boolean
  /** Our screen capture while sharing (shown in our own preview instead of the camera). */
  screen?: MediaStream
  /** The other side is sharing their screen. */
  peerSharing?: boolean
  local?: MediaStream
  remote?: MediaStream
  ended?: string
  /** Which of the peer's devices we're talking to (they may have several; all of yours ring). */
  dev?: number
}

let call: Call | null = null
/** Read through a function so TypeScript doesn't narrow across awaits (the call can end meanwhile). */
const current = () => call
const ls = new Set<() => void>()
const set = (c: Call | null) => ((call = c), ls.forEach((l) => l()))
const patch = (p: Partial<Call>) => call && set({ ...call, ...p })
export const useCall = () =>
  useSyncExternalStore(
    (l) => (ls.add(l), () => ls.delete(l)),
    () => call,
  )

let pc: RTCPeerConnection | null = null
let offer: string | null = null
let timer = 0
let stopTone: (() => void) | null = null


const media = (video: boolean) =>
  navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true },
    video: video ? { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' } : false,
  })

/** Wait for ICE gathering so one encrypted message carries the full SDP (no trickle round trips). */
function gathered(p: RTCPeerConnection) {
  return new Promise<void>((res) => {
    if (p.iceGatheringState === 'complete') return res()
    const t = setTimeout(res, 2500)
    p.addEventListener('icegatheringstatechange', () => p.iceGatheringState === 'complete' && (clearTimeout(t), res()))
  })
}

// STUN/TURN come from our own server (never a third party). "Relay all calls" forces media through
// TURN so the other side never learns your IP address.
async function connect(stream: MediaStream) {
  const p = (pc = new RTCPeerConnection({
    iceServers: await fog.iceServers(),
    iceTransportPolicy: fog.getState().settings.relayCalls ? 'relay' : 'all',
  }))
  stream.getTracks().forEach((t) => p.addTrack(t, stream))
  const remote = new MediaStream()
  p.ontrack = (e) => {
    remote.addTrack(e.track)
    patch({ remote })
  }
  p.onconnectionstatechange = () => {
    if (p !== pc) return
    if (p.connectionState === 'connected' && call?.phase !== 'active') {
      tone(null)
      patch({ phase: 'active', started: Date.now() })
    }
    if (p.connectionState === 'failed') finish("Couldn't connect")
    if (p.connectionState === 'disconnected') setTimeout(() => p === pc && p.connectionState === 'disconnected' && finish('Connection lost'), 6000)
  }
  return p
}

export async function startCall(peer: string, video: boolean) {
  if (call) return fog.toast("You're already in a call")
  let stream: MediaStream
  try {
    stream = await media(video)
  } catch {
    return fog.toast(`Fog needs ${video ? 'camera and microphone' : 'microphone'} access to call`)
  }
  const id = crypto.randomUUID()
  set({ id, peer, out: true, video, phase: 'ringing', muted: false, camOff: false, local: stream })
  const p = await connect(stream)
  await p.setLocalDescription(await p.createOffer())
  await gathered(p)
  if (current()?.id !== id) return
  tone('ringback')
  timer = window.setTimeout(() => current()?.id === id && current()?.phase === 'ringing' && (signal('end'), finish('No answer')), 45_000)
  fog.sendSignal(peer, { id, k: 'offer', sdp: p.localDescription!.sdp, video }).catch(() => finish("Couldn't reach them"))
}

export async function accept(video = call?.video ?? false) {
  if (!call || call.out || call.phase !== 'ringing' || !offer) return
  const c = call
  tone(null)
  clearTimeout(timer)
  let stream: MediaStream
  try {
    stream = await media(video)
  } catch {
    fog.toast(`Fog needs ${video ? 'camera and microphone' : 'microphone'} access to answer`)
    return decline()
  }
  patch({ phase: 'connecting', local: stream, video })
  const p = await connect(stream)
  await p.setRemoteDescription({ type: 'offer', sdp: offer })
  await p.setLocalDescription(await p.createAnswer())
  await gathered(p)
  if (current()?.id !== c.id) return
  fog.sendSignal(c.peer, { id: c.id, k: 'answer', sdp: p.localDescription!.sdp, to: c.dev }).catch(() => finish("Couldn't reach them"))
  fog.callHandled(c.id)
}

const signal = (k: 'end' | 'decline' | 'busy', to = call) => to && fog.sendSignal(to.peer, { id: to.id, k, to: to.dev }).catch(() => {})

export const decline = () => (signal('decline'), fog.callHandled(call?.id ?? ''), finish('Declined', true))
export const hangup = () => (signal('end'), finish(call?.started ? 'Call ended' : 'Cancelled'))

export function toggleMute() {
  if (!call?.local) return
  const muted = !call.muted
  call.local.getAudioTracks().forEach((t) => (t.enabled = !muted))
  patch({ muted })
}
// ponytail: camera can only be paused in video calls; upgrading a voice call needs SDP renegotiation.
export function toggleCam() {
  if (!call?.local || !call.video) return
  const camOff = !call.camOff
  call.local.getVideoTracks().forEach((t) => (t.enabled = !camOff))
  patch({ camOff })
}

/** Tell the other side, so they show the screen whole (fitted, zoomable) rather than cropped like a face. */
const sharing = (on: boolean) => call && fog.sendSignal(call.peer, { id: call.id, k: 'screen', on, to: call.dev }).catch(() => {})

/** Swap the outgoing camera track for a screen capture (and back). Video calls only. */
let screenTrack: MediaStreamTrack | null = null
export async function toggleScreen() {
  if (!call?.video || !pc) return
  const sender = pc.getSenders().find((s) => s.track?.kind === 'video' || (screenTrack && s.track === screenTrack))
  const cam = call.local?.getVideoTracks()[0]
  if (!sender || !cam) return
  if (screenTrack) {
    screenTrack.stop()
    screenTrack = null
    await sender.replaceTrack(cam)
    sharing(false)
    return patch({ sharing: false, screen: undefined })
  }
  try {
    const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
    screenTrack = display.getVideoTracks()[0]
    await sender.replaceTrack(screenTrack)
    // The browser's own "Stop sharing" button ends the track: switch back to the camera.
    screenTrack.onended = () => screenTrack && toggleScreen()
    sharing(true)
    patch({ sharing: true, screen: display })
  } catch {
    // Picker cancelled.
  }
}

/** Tear down, leave a record in the chat, show the end state briefly. */
function finish(reason: string, declinedByMe = false, record = true) {
  const c = call
  if (!c || c.phase === 'ended') return
  clearTimeout(timer)
  tone(null)
  pc?.close()
  pc = null
  offer = null
  screenTrack?.stop()
  screenTrack = null
  c.local?.getTracks().forEach((t) => t.stop())
  const dur = c.started ? (Date.now() - c.started) / 1000 : undefined
  if (record) fog.addCallRecord(c.peer, { out: c.out, video: c.video, dur, missed: !c.out && !c.started && !declinedByMe, declined: declinedByMe || reason === 'Declined' })
  set({ ...c, phase: 'ended', ended: reason, local: undefined, remote: undefined })
  setTimeout(() => call?.id === c.id && set(null), 1400)
}

fog.setCallHandler((from, dev, p) => {
  if (typeof p.id !== 'string' || p.id.length > 64) return
  // Another of our devices picked this call up (or declined it): stop ringing here.
  if (p.k === 'elsewhere') {
    if (from === fog.getState().me?.id && call?.id === p.id && !call.out && call.phase === 'ringing') finish('Answered on another device', false, false)
    return
  }
  if (p.k === 'offer') {
    if (typeof p.sdp !== 'string' || p.sdp.length > 30_000) return
    if (fog.isBlocked(from)) return
    // Strangers don't ring: their call shows up as a missed call in a message request.
    if (!fog.isTrusted(from)) return void fog.addCallRecord(from, { out: false, video: !!p.video, missed: true })
    if (call) return void fog.sendSignal(from, { id: p.id, k: 'busy', to: dev }).catch(() => {})
    offer = p.sdp
    set({ id: p.id, peer: from, out: false, video: !!p.video, phase: 'ringing', muted: false, camOff: false, dev })
    tone('ring')
    const id = p.id
    timer = window.setTimeout(() => call?.id === id && call.phase === 'ringing' && finish('Missed'), 45_000)
    if (document.visibilityState !== 'visible' && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      const c = fog.getState().chats[from]
      const n = new Notification(c ? fog.chatTitle(c) : 'Incoming call', { body: `Incoming ${p.video ? 'video' : 'voice'} call`, tag: `call-${p.id}`, requireInteraction: true })
      n.onclick = () => (window.focus(), n.close())
    }
    return
  }
  if (!call || call.id !== p.id || call.peer !== from) return
  // Two of their devices answered at once: keep the first, hang up on the other.
  if (call.dev !== undefined && dev !== call.dev) {
    if (p.k === 'answer') fog.sendSignal(from, { id: p.id, k: 'end', to: dev }).catch(() => {})
    return
  }
  if (p.k === 'answer' && call.out && call.phase === 'ringing' && typeof p.sdp === 'string' && p.sdp.length <= 30_000) {
    tone(null)
    clearTimeout(timer)
    patch({ phase: 'connecting', dev })
    pc?.setRemoteDescription({ type: 'answer', sdp: p.sdp }).catch(() => finish("Couldn't connect"))
  }
  if (p.k === 'screen') patch({ peerSharing: p.on === true })
  if (p.k === 'end') finish(call.started ? 'Call ended' : call.out ? 'Call ended' : 'Missed')
  if (p.k === 'decline') finish('Declined')
  if (p.k === 'busy') finish('Busy on another call')
})

// ---------- tones (synthesised) ----------
let ac: AudioContext | null = null
function tone(kind: 'ring' | 'ringback' | null) {
  stopTone?.()
  stopTone = null
  if (!kind) return
  try {
    ac ??= new AudioContext()
    const ctx = ac
    const beep = () => {
      const t = ctx.currentTime
      // Incoming: a soft two-note chime. Outgoing: classic 440+480 Hz ringback.
      const freqs = kind === 'ring' ? [[784, 0], [988, 0.18], [784, 0.6], [988, 0.78]] : [[440, 0], [480, 0]]
      for (const [f, at] of freqs) {
        const o = ctx.createOscillator()
        const g = ctx.createGain()
        const len = kind === 'ring' ? 0.16 : 1.6
        o.frequency.value = f
        g.gain.setValueAtTime(0, t + at)
        g.gain.linearRampToValueAtTime(kind === 'ring' ? 0.12 : 0.05, t + at + 0.02)
        g.gain.setValueAtTime(kind === 'ring' ? 0.12 : 0.05, t + at + len - 0.05)
        g.gain.linearRampToValueAtTime(0, t + at + len)
        o.connect(g).connect(ctx.destination)
        o.start(t + at)
        o.stop(t + at + len)
      }
    }
    beep()
    const iv = setInterval(beep, kind === 'ring' ? 2200 : 4000)
    stopTone = () => clearInterval(iv)
  } catch {}
}
