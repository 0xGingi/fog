// Voice/video calls, 1:1 and in groups. WebRTC media is encrypted end to end (DTLS-SRTP); the
// offers/answers, and with them the DTLS fingerprints, travel inside the Signal session, so nobody
// can sit in the middle. Group calls are a mesh (everyone connects to everyone, up to 8 people),
// always through our TURN relay, so nobody in the call learns anyone else's IP address.
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
  /** Group calls: the group (`peer` is the group too), whether we're in it, and who else is. */
  group?: string
  /** Who started the group call. */
  from?: string
  joined?: boolean
  peers?: Record<string, GroupPeer>
  /** Which way our camera faces (phones: front "user" or back "environment"). */
  facing?: 'user' | 'environment'
  /** How many cameras this device has (counted once the camera is in use). */
  cams?: number
  /** Shrunk to a floating card so the rest of Fog can be used; the call carries on. */
  minimized?: boolean
}
/** Someone in a group call: one of their devices, keyed "<account>.<device>". */
export type GroupPeer = { who: string; stream?: MediaStream; connected: boolean; sharing?: boolean }
export const MAX_GROUP_CALL = 8

let call: Call | null = null
/** Read through a function so TypeScript doesn't narrow across awaits (the call can end meanwhile). */
const current = () => call
/** Is call `id` still going? (An ended call lingers on screen for a moment with the same id.) */
const live = (id: string) => current()?.id === id && current()?.phase !== 'ended'
const stopAll = (s: MediaStream) => s.getTracks().forEach((t) => t.stop())
const ls = new Set<() => void>()
const set = (c: Call | null) => ((call = c), held(), ls.forEach((l) => l()))
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


const AUDIO: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true }
const VIDEO: MediaTrackConstraints = { width: { ideal: 1280 }, height: { ideal: 720 } }
/** A phone or tablet (not a laptop with a touch screen): front and back cameras, and an OS that cuts the mic in the background. */
const phone = navigator.maxTouchPoints > 1 && matchMedia('(pointer: coarse)').matches

const media = (video: boolean) =>
  navigator.mediaDevices
    .getUserMedia({ audio: AUDIO, video: video ? { ...VIDEO, facingMode: 'user' } : false })
    .then((s) => (s.getTracks().forEach(watch), s))

/** Count the cameras (only possible once one is in use), for the flip-camera button. */
async function countCams() {
  const n = (await navigator.mediaDevices.enumerateDevices().catch(() => [])).filter((d) => d.kind === 'videoinput').length
  if (current() && current()?.phase !== 'ended') patch({ cams: n })
}

/**
 * The phone apps: while we're in a call (holding the mic), the app tells the OS, so it keeps running
 * and recording in the background. Android starts a foreground service with an ongoing "call in
 * progress" notification; without it Android gives background apps a silent microphone. (iOS keeps
 * the mic through the app's background audio mode.) Desktop and the web: nothing.
 */
const native = (window as unknown as { __TAURI_INTERNALS__?: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } }).__TAURI_INTERNALS__
let holding = ''
function held() {
  const want = call?.local && call.phase !== 'ended' ? (call.local.getVideoTracks().length ? 'video' : 'audio') : ''
  if (want === holding) return
  holding = want
  if (want === 'video') void countCams()
  native?.invoke('call_active', { on: !!want, video: want === 'video' }).catch(() => {})
}

/** Senders of our audio or video on every connection in the call (one for 1:1, one per person in a group). */
const senders = (kind: 'audio' | 'video') =>
  (call?.group ? [...gpeers.values()].map((g) => g.pc) : pc ? [pc] : []).flatMap((p) => p.getSenders()).filter((s) => s.track?.kind === kind)

/**
 * Send a new microphone or camera track in place of the old one, on every connection, without
 * renegotiating (replaceTrack), and show it in our own preview. The old one is stopped.
 */
async function useTrack(t: MediaStreamTrack) {
  const c = current()
  if (!c?.local || c.phase === 'ended') return t.stop()
  const kind = t.kind as 'audio' | 'video'
  const old = c.local.getTracks().find((x) => x.kind === kind)
  t.enabled = kind === 'audio' ? !c.muted : !c.camOff
  watch(t)
  // While sharing the screen, the senders carry the screen; the new camera goes out when sharing stops.
  if (!(kind === 'video' && screenTrack)) await Promise.all(senders(kind).map((s) => s.replaceTrack(t).catch(() => {})))
  old?.stop()
  const now = current()
  if (now?.id !== c.id || now.phase === 'ended' || !now.local) return t.stop()
  patch({ local: new MediaStream([...now.local.getTracks().filter((x) => x.kind !== kind), t]) })
}

/** Front and back camera (or the next webcam), in 1:1 and group video calls. */
let flipping = false
export async function flipCamera() {
  const c = call
  const old = c?.local?.getVideoTracks()[0]
  if (!c?.video || !old || flipping) return
  flipping = true
  try {
    const was = old.getSettings()
    let facing = c.facing
    let want: MediaTrackConstraints
    if (was.facingMode === 'user' || was.facingMode === 'environment' || phone) {
      facing = (was.facingMode || c.facing || 'user') === 'user' ? 'environment' : 'user'
      want = { ...VIDEO, facingMode: { exact: facing } }
    } else {
      const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput' && d.deviceId)
      if (cams.length < 2) return void fog.toast('There is no other camera')
      const i = cams.findIndex((d) => d.deviceId === was.deviceId)
      want = { ...VIDEO, deviceId: { exact: cams[(i + 1) % cams.length].deviceId } }
    }
    // Most phones can't run two cameras at once: let go of this one first.
    old.stop()
    let next: MediaStream
    try {
      next = await navigator.mediaDevices.getUserMedia({ video: want })
    } catch {
      fog.toast("Couldn't switch the camera")
      facing = c.facing
      next = await navigator.mediaDevices.getUserMedia({ video: { ...VIDEO, ...(was.deviceId ? { deviceId: was.deviceId } : { facingMode: c.facing ?? 'user' }) } })
    }
    if (!live(c.id)) return stopAll(next)
    await useTrack(next.getVideoTracks()[0])
    if (live(c.id)) patch({ facing })
  } catch {
    // No camera at all now; coming back to Fog tries again (recover).
  } finally {
    flipping = false
  }
}

/**
 * The OS can take the microphone (or camera) away: in the background, or for a phone call or Siri.
 * The track then ends, or stays muted. When that happens while Fog is in front, or when Fog comes
 * back to the front, get a new one and send it in place of the old, so the call carries on.
 */
let recovering = false
async function recover() {
  const c = current()
  if (!c?.local || c.phase === 'ended' || recovering || document.hidden) return
  // A muted track on a desktop is usually the user's own hardware mute switch: leave it.
  const lost = (t?: MediaStreamTrack) => !!t && (t.readyState === 'ended' || (phone && t.muted))
  const kinds = (['audio', 'video'] as const).filter((k) => lost(k === 'audio' ? c.local!.getAudioTracks()[0] : c.local!.getVideoTracks()[0]) && !(k === 'video' && flipping))
  if (!kinds.length) return
  recovering = true
  try {
    for (const k of kinds) {
      try {
        const s = await navigator.mediaDevices.getUserMedia(k === 'audio' ? { audio: AUDIO } : { video: { ...VIDEO, facingMode: c.facing ?? 'user' } })
        if (!live(c.id)) return stopAll(s)
        await useTrack(s.getTracks()[0])
      } catch {
        // Still not available (another app has it): try again next time Fog comes to the front.
      }
    }
  } finally {
    recovering = false
  }
}
function watch(t: MediaStreamTrack) {
  t.onended = () => void recover()
  // The mic muted by an interruption (a phone call, Siri) and not back after a few seconds.
  if (t.kind === 'audio') t.onmute = () => phone && setTimeout(() => t.muted && void recover(), 3000)
}
document.addEventListener('visibilitychange', () => !document.hidden && setTimeout(() => void recover(), 1500))

export const minimize = (minimized: boolean) => call && call.phase !== 'ended' && patch({ minimized })

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
  if (current()) return (stopAll(stream), fog.toast("You're already in a call"))
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
  if (call?.group) return acceptGroup(video)
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
  // They hung up while we were asking for the mic/camera: finish() couldn't stop what we didn't have yet.
  if (!live(c.id) || !offer) return stopAll(stream)
  const sdp = offer
  patch({ phase: 'connecting', local: stream, video })
  const p = await connect(stream)
  if (!live(c.id)) return (p.close(), pc === p && (pc = null))
  await p.setRemoteDescription({ type: 'offer', sdp })
  await p.setLocalDescription(await p.createAnswer())
  await gathered(p)
  if (!live(c.id)) return (p.close(), pc === p && (pc = null))
  fog.sendSignal(c.peer, { id: c.id, k: 'answer', sdp: p.localDescription!.sdp, to: c.dev }).catch(() => finish("Couldn't reach them"))
  fog.callHandled(c.id)
}

const signal = (k: 'end' | 'decline' | 'busy', to = call) => to && fog.sendSignal(to.peer, { id: to.id, k, to: to.dev }).catch(() => {})

export const decline = () => {
  // A group call just stops ringing here; the others carry on.
  if (!call?.group) signal('decline')
  fog.callHandled(call?.id ?? '')
  finish('Declined', true)
}
export const hangup = () => {
  if (call?.group) {
    if (call.joined) fog.sendGroupSignal(call.group, { id: call.id, k: 'leave' }).catch(() => {})
    return finish(call.started ? 'Left the call' : 'Cancelled')
  }
  signal('end')
  finish(call?.started ? 'Call ended' : 'Cancelled')
}

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
const sharing = (on: boolean) =>
  call && (call.group ? fog.sendGroupSignal(call.group, { id: call.id, k: 'screen', on }) : fog.sendSignal(call.peer, { id: call.id, k: 'screen', on, to: call.dev })).catch(() => {})

/** Swap the outgoing camera track for a screen capture (and back). Video calls only. */
let screenTrack: MediaStreamTrack | null = null
export async function toggleScreen() {
  const conns = call?.group ? [...gpeers.values()].map((g) => g.pc) : pc ? [pc] : []
  if (!call?.video || !conns.length) return
  const videoSenders = () => conns.map((c) => c.getSenders().find((s) => s.track?.kind === 'video' || (screenTrack && s.track === screenTrack))).filter((s): s is RTCRtpSender => !!s)
  const cam = call.local?.getVideoTracks()[0]
  if (!videoSenders().length || !cam) return
  if (screenTrack) {
    screenTrack.stop()
    screenTrack = null
    await Promise.all(videoSenders().map((s) => s.replaceTrack(cam)))
    sharing(false)
    return patch({ sharing: false, screen: undefined })
  }
  try {
    const id = call.id
    const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
    // The call ended (or sharing started elsewhere) while the picker was open.
    if (!live(id) || screenTrack) return stopAll(display)
    screenTrack = display.getVideoTracks()[0]
    await Promise.all(videoSenders().map((s) => s.replaceTrack(screenTrack)))
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
  gpeers.forEach((g) => g.pc.close())
  gpeers.clear()
  screenTrack?.stop()
  screenTrack = null
  c.local?.getTracks().forEach((t) => t.stop())
  const dur = c.started ? (Date.now() - c.started) / 1000 : undefined
  if (record && c.group) fog.addCallRecord(c.peer, { out: c.out, video: c.video, dur, group: true, missed: !c.started }, c.out ? undefined : c.from)
  else if (record) fog.addCallRecord(c.peer, { out: c.out, video: c.video, dur, missed: !c.out && !c.started && !declinedByMe, declined: declinedByMe || reason === 'Declined' })
  set({ ...c, phase: 'ended', ended: reason, local: undefined, remote: undefined })
  setTimeout(() => call?.id === c.id && set(null), 1400)
}

fog.setCallHandler((from, dev, p) => {
  if (typeof p.id !== 'string' || p.id.length > 64) return
  if (p.gc) return groupSignal(from, dev, p)
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

// ---------- group calls ----------
// Signalling: 'ring' (someone started a call), 'hello' (someone joined) and 'leave' go to the whole
// group. Whoever is already in the call answers a 'hello' by connecting to the newcomer (offer ->
// answer, device to device), so two people never offer to each other at once.
const gpeers = new Map<string, { pc: RTCPeerConnection; who: string; dev: number }>()
/** Who's in the call (or ringing it) as far as we've heard, for knowing when it's over. */
const present = new Set<string>()
const keyOf = (who: string, dev: number) => `${who}.${dev}`
const setPeer = (key: string, p: Partial<GroupPeer> | null) => {
  if (!call) return
  const peers = { ...call.peers }
  if (p) peers[key] = { ...(peers[key] ?? { who: key.split('.')[0], connected: false }), ...p }
  else delete peers[key]
  patch({ peers })
}

// The group's members changed (someone removed or gone, or us): connections to anyone no longer in
// it close right away, so they stop getting our audio, video and screen.
let seenGroup: unknown
fog.onState(() => {
  const g = call?.group && fog.getState().chats[call.group]?.group
  if (g === seenGroup) return
  seenGroup = g
  queueMicrotask(() => {
    const c = current()
    if (!c?.group || c.phase === 'ended') return
    if (!fog.inGroupCall(c.group, fog.getState().me?.id ?? '')) return finish('You left the group')
    for (const key of [...present]) if (!fog.inGroupCall(c.group, key.split('.')[0])) present.delete(key)
    for (const [key, p] of [...gpeers]) if (!fog.inGroupCall(c.group, p.who)) dropPeer(key)
  })
})

async function groupPc(key: string, who: string, dev: number) {
  const old = gpeers.get(key)
  if (old) return old.pc
  const iceServers = await fog.iceServers()
  // Checked again after the await: other signals may have added peers meanwhile.
  const again = gpeers.get(key)
  if (again) return again.pc
  // The same limit for everyone, however they ask to connect (hello or a direct offer).
  if (gpeers.size + 1 >= MAX_GROUP_CALL || !call?.joined || call.phase === 'ended') return null
  // Always relayed: a group can include people you've never met.
  const p = new RTCPeerConnection({ iceServers, iceTransportPolicy: 'relay' })
  gpeers.set(key, { pc: p, who, dev })
  const local = call?.local
  local?.getTracks().forEach((t) => p.addTrack(screenTrack && t.kind === 'video' ? screenTrack : t, local))
  const stream = new MediaStream()
  p.ontrack = (e) => {
    stream.addTrack(e.track)
    setPeer(key, { stream })
  }
  p.onconnectionstatechange = () => {
    if (gpeers.get(key)?.pc !== p) return
    if (p.connectionState === 'connected') {
      setPeer(key, { connected: true })
      if (call && !call.started) (tone(null), clearTimeout(timer), patch({ phase: 'active', started: Date.now() }))
    }
    if (p.connectionState === 'failed' || p.connectionState === 'closed') dropPeer(key)
  }
  setPeer(key, { connected: false, stream })
  return p
}
function dropPeer(key: string) {
  gpeers.get(key)?.pc.close()
  gpeers.delete(key)
  present.delete(key)
  setPeer(key, null)
  // Everyone else left: the call is over for us too.
  if (call?.joined && call.started && !gpeers.size) {
    fog.sendGroupSignal(call.group!, { id: call.id, k: 'leave' }).catch(() => {})
    finish('Call ended')
  }
}

export async function startGroupCall(group: string, video: boolean) {
  if (call) return fog.toast("You're already in a call")
  let stream: MediaStream
  try {
    stream = await media(video)
  } catch {
    return fog.toast(`Fog needs ${video ? 'camera and microphone' : 'microphone'} access to call`)
  }
  if (current()) return (stopAll(stream), fog.toast("You're already in a call"))
  const id = crypto.randomUUID()
  present.clear()
  set({ id, peer: group, group, out: true, video, phase: 'ringing', muted: false, camOff: false, local: stream, joined: true, peers: {} })
  tone('ringback')
  timer = window.setTimeout(() => current()?.id === id && !current()?.started && hangup(), 45_000)
  fog.sendGroupSignal(group, { id, k: 'ring', video }).catch(() => finish("Couldn't reach the group"))
}

async function acceptGroup(video: boolean) {
  const c = call
  if (!c?.group || c.joined) return
  tone(null)
  clearTimeout(timer)
  let stream: MediaStream
  try {
    stream = await media(video)
  } catch {
    fog.toast(`Fog needs ${video ? 'camera and microphone' : 'microphone'} access to join`)
    return decline()
  }
  if (!live(c.id)) return stopAll(stream)
  if (present.size >= MAX_GROUP_CALL) {
    stream.getTracks().forEach((t) => t.stop())
    fog.toast(`Group calls are limited to ${MAX_GROUP_CALL} people`)
    return finish('Call full', false, false)
  }
  patch({ phase: 'connecting', local: stream, video, joined: true })
  fog.callHandled(c.id)
  fog.sendGroupSignal(c.group, { id: c.id, k: 'hello' }).catch(() => finish("Couldn't reach the group"))
  // Nobody connects within a while (they all left meanwhile): give up.
  timer = window.setTimeout(() => current()?.id === c.id && !current()?.started && finish("Couldn't connect"), 30_000)
}

async function groupSignal(from: string, dev: number, p: { id: string; k: string; gc?: string; sdp?: string; video?: boolean; on?: boolean }) {
  const gid = p.gc!
  // Only members of the group (and only while we're in it ourselves).
  if (!fog.inGroupCall(gid, from) || fog.isBlocked(from)) return
  const key = keyOf(from, dev)
  if (p.k === 'ring') {
    if (call || fog.getState().chats[gid]?.request) return // busy, or a group we haven't accepted
    present.clear()
    present.add(key)
    set({ id: p.id, peer: gid, group: gid, from, out: false, video: !!p.video, phase: 'ringing', muted: false, camOff: false, joined: false, peers: {} })
    tone('ring')
    const id = p.id
    timer = window.setTimeout(() => call?.id === id && !call.joined && finish('Missed'), 45_000)
    return
  }
  if (call?.id !== p.id || call.group !== gid) return
  if (p.k === 'hello') {
    present.add(key)
    if (!call.joined || gpeers.has(key) || gpeers.size + 1 >= MAX_GROUP_CALL) return
    const pcx = await groupPc(key, from, dev)
    if (!pcx) return
    await pcx.setLocalDescription(await pcx.createOffer())
    await gathered(pcx)
    if (current()?.id !== p.id) return
    fog.sendSignal(from, { id: p.id, k: 'offer', sdp: pcx.localDescription!.sdp, gc: gid, to: dev, video: call.video }).catch(() => dropPeer(key))
    if (call.sharing) sharing(true)
    return
  }
  if (p.k === 'offer' && call.joined && typeof p.sdp === 'string' && p.sdp.length <= 30_000) {
    present.add(key)
    const pcx = await groupPc(key, from, dev)
    if (!pcx) return
    await pcx.setRemoteDescription({ type: 'offer', sdp: p.sdp })
    await pcx.setLocalDescription(await pcx.createAnswer())
    await gathered(pcx)
    if (current()?.id !== p.id) return
    fog.sendSignal(from, { id: p.id, k: 'answer', sdp: pcx.localDescription!.sdp, gc: gid, to: dev }).catch(() => dropPeer(key))
    if (call.sharing) sharing(true)
    return
  }
  if (p.k === 'answer' && typeof p.sdp === 'string' && p.sdp.length <= 30_000) {
    gpeers.get(key)?.pc.setRemoteDescription({ type: 'answer', sdp: p.sdp }).catch(() => dropPeer(key))
    return
  }
  if (p.k === 'screen') return setPeer(key, { sharing: p.on === true })
  if (p.k === 'leave') {
    present.delete(key)
    if (gpeers.has(key)) return dropPeer(key)
    // Still ringing here and everyone has gone: stop ringing.
    if (!call.joined && !present.size) finish('Missed')
  }
}

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
