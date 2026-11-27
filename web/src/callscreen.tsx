// Call UI: incoming ring, outgoing ringback, in-call controls (full screen), and a small floating
// card while the call is minimized, so the rest of Fog (chats, sending) can be used meanwhile.
import { useEffect, useRef, useState } from 'react'
import { accept, decline, flipCamera, hangup, minimize, toggleCam, toggleMute, toggleScreen, useCall, type Call } from './call'
import { chatAvatar, chatTitle, personName, useFog, type Person } from './fog'
import { fmtDur } from './media'
import { Avatar, Icon, Zoomable } from './ui'

/** Video only, always muted: the sound plays through <Sound>, which stays put whatever's on screen. */
function Media({ stream, className, mirror }: { stream?: MediaStream; className: string; mirror?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    if (ref.current && ref.current.srcObject !== (stream ?? null)) ref.current.srcObject = stream ?? null
  }, [stream])
  return <video ref={ref} autoPlay playsInline muted className={`${className} ${mirror ? '-scale-x-100' : ''}`} />
}

/**
 * The other side's voice. Its own element, separate from the (muted) video, so it keeps playing with
 * the call minimized, and when a phone pauses video in the background.
 */
function Sound({ stream }: { stream: MediaStream }) {
  const ref = useRef<HTMLAudioElement>(null)
  useEffect(() => {
    if (ref.current && ref.current.srcObject !== stream) ref.current.srcObject = stream
  }, [stream])
  return <audio ref={ref} autoPlay />
}
function Sounds({ c }: { c: Call }) {
  if (c.phase === 'ended') return null
  if (c.group) return <>{Object.entries(c.peers ?? {}).map(([key, p]) => p.stream && <Sound key={key} stream={p.stream} />)}</>
  return c.remote ? <Sound stream={c.remote} /> : null
}

const hasVideo = (s?: MediaStream) => !!s?.getVideoTracks().some((t) => t.enabled && t.readyState === 'live')
/** Phones and tablets have a front and a back camera (a touch-screen laptop isn't one). */
const touch = navigator.maxTouchPoints > 1 && matchMedia('(pointer: coarse)').matches
/** Flip camera: once the cameras are counted, only with two or more; until then, on phones. Not while sharing the screen. */
const canFlip = (c: Call) => c.video && !c.sharing && (c.cams !== undefined ? c.cams > 1 : touch)

function statusOf(c: Call, people: Record<string, Person>) {
  const since = (Date.now() - (c.started ?? Date.now())) / 1000
  if (c.phase === 'ended') return c.ended
  if (c.group)
    return c.started
      ? `${fmtDur(since)} · ${Object.keys(c.peers ?? {}).length + 1} in the call`
      : c.joined
        ? c.out
          ? 'Ringing the group…'
          : 'Joining…'
        : `Group ${c.video ? 'video' : 'voice'} call${c.from ? ` from ${personName(c.from, people[c.from])}` : ''}`
  return c.phase === 'active' ? fmtDur(since) : c.phase === 'connecting' ? 'Connecting…' : c.out ? 'Ringing…' : `Incoming ${c.video ? 'video' : 'voice'} call`
}

/** Shrink the call to a floating card (top left of the call screen); it keeps going. */
function Shrink({ className = '' }: { className?: string }) {
  return (
    <button
      onClick={() => minimize(true)}
      aria-label="Minimize call"
      title="Minimize: keep talking while you use Fog"
      className={`absolute top-[max(0.75rem,env(safe-area-inset-top))] left-[max(0.75rem,env(safe-area-inset-left))] z-20 grid size-11 place-items-center rounded-full bg-white/15 text-white backdrop-blur-md transition hover:bg-white/25 active:scale-90 ${className}`}
    >
      <Icon name="down" className="size-6" />
    </button>
  )
}

function Round({ label, onClick, tone = 'glass', icon, on, big }: { label: string; onClick: () => void; tone?: 'glass' | 'red' | 'green'; icon: React.ReactNode; on?: boolean; big?: boolean }) {
  const c = { glass: on ? 'bg-white text-[#0b1016]' : 'bg-white/15 text-white hover:bg-white/25', red: 'bg-[#e5484d] text-white hover:brightness-110', green: 'bg-[#30a46c] text-white hover:brightness-110' }[tone]
  return (
    <div className="flex flex-col items-center gap-2">
      <button onClick={onClick} aria-label={label} title={label} className={`grid place-items-center rounded-full backdrop-blur-md transition active:scale-90 ${big ? 'size-[72px]' : 'size-16'} ${c}`}>
        {icon}
      </button>
      <span className="text-xs text-white/80">{label}</span>
    </div>
  )
}

const phoneIcon = (className = 'size-7') => (
  <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden>
    <path d="M6.6 10.8a15.1 15.1 0 006.6 6.6l2.2-2.2a1 1 0 011-.25 11.4 11.4 0 003.6.57 1 1 0 011 1V20a1 1 0 01-1 1A17 17 0 013 4a1 1 0 011-1h3.5a1 1 0 011 1c0 1.25.2 2.45.57 3.57a1 1 0 01-.25 1z" />
  </svg>
)
const phone = phoneIcon()

export function CallScreen() {
  const c = useCall()
  const chat = useFog((s) => (c ? s.chats[c.peer] : undefined))
  const person = useFog((s) => (c ? s.people[c.peer] : undefined))
  const people = useFog((s) => s.people)
  const [, tick] = useState(0)
  useEffect(() => {
    if (c?.phase !== 'active') return
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [c?.phase])
  // Over video, the controls get out of the way after a few seconds; a tap brings them back.
  const [chrome, setChrome] = useState(true)
  // Moving the mouse brings them back too, and keeps them up while it moves.
  const [poke, setPoke] = useState(0)
  const lastPoke = useRef(0)
  const nudge = (e: React.PointerEvent) => {
    if (e.pointerType !== 'mouse' || Date.now() - lastPoke.current < 500) return
    lastPoke.current = Date.now()
    setChrome(true)
    setPoke((n) => n + 1)
  }
  const remoteVideo = !!(c?.video && c.remote?.getVideoTracks().length && c.phase === 'active')
  const autoHide = remoteVideo || !!(c?.group && c.joined && c.started && c.video)
  useEffect(() => {
    if (!autoHide || !chrome) return
    const t = setTimeout(() => setChrome(false), 4000)
    return () => clearTimeout(t)
  }, [autoHide, chrome, poke])
  useEffect(() => setChrome(true), [c?.peerSharing, remoteVideo, c?.minimized])
  if (!c) return null
  // The sound comes first in every layout, so React keeps the same <audio> when you minimize or expand.
  const sounds = <Sounds c={c} />
  if (c.minimized) return (<>{sounds}<MiniCall c={c} /></>)
  if (c.group) return (<>{sounds}<GroupCall c={c} chrome={chrome} setChrome={setChrome} nudge={nudge} /></>)
  const title = chat ? chatTitle(chat, person) : (person?.name ?? 'Unknown')
  const avatar = person?.avatar
  const hidden = remoteVideo && !chrome
  const fade = `transition-opacity duration-300 ${hidden ? 'pointer-events-none opacity-0' : 'opacity-100'}`
  const status = statusOf(c, people)
  const inCall = c.phase !== 'ended' && (c.out || c.phase !== 'ringing')

  return (
    <>
    {sounds}
    <div className="fade-in fixed inset-0 z-[60] flex flex-col overflow-hidden bg-[#0b1016] text-white" role="dialog" aria-label={`Call with ${title}`} onPointerMove={nudge}>
      {remoteVideo ? (
        // A shared screen is shown whole (fitted, and zoomable to read the small print); a face fills the frame.
        <Zoomable className="absolute inset-0" reset={c.peerSharing} onTap={() => setChrome((x) => !x)}>
          <Media stream={c.remote} className={`size-full ${c.peerSharing ? 'object-contain' : 'object-cover'}`} />
        </Zoomable>
      ) : (
        <>
          {avatar && <img src={avatar} alt="" className="absolute inset-0 size-full scale-125 object-cover opacity-35 blur-3xl" />}
          <div className="absolute inset-0 bg-gradient-to-b from-[#0b1016]/40 via-transparent to-[#0b1016]/80" />
        </>
      )}
      {inCall && <Shrink className={fade} />}

      <header className={`relative z-10 flex flex-col items-center px-6 text-center ${remoteVideo ? `pointer-events-none bg-gradient-to-b from-black/60 to-transparent pt-[max(1rem,env(safe-area-inset-top))] pb-10 ${fade}` : 'pt-[max(3rem,env(safe-area-inset-top))]'}`}>
        {!remoteVideo && (
          <div className={`mb-6 rounded-full ${c.phase === 'ringing' ? 'animate-[ringpulse_1.8s_ease-out_infinite]' : ''}`}>
            <Avatar id={c.peer} name={title} src={avatar} size={128} />
          </div>
        )}
        <h2 className="text-2xl font-semibold drop-shadow">{title}</h2>
        <p className="mt-1 text-white/80 tabular-nums drop-shadow">{status}</p>
        {c.peerSharing && remoteVideo ? (
          <p className="mt-2 flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1 text-xs backdrop-blur-md">
            <Icon name="screen" className="size-3.5" /> Sharing their screen · pinch to zoom
          </p>
        ) : (
          <p className="mt-3 flex items-center gap-1.5 text-xs text-white/60">
            <Icon name="lock" className="size-3.5" /> End-to-end encrypted
          </p>
        )}
      </header>

      {/* Our own picture: the screen we're sending while sharing, otherwise the camera. With the
          controls hidden it moves down to the corner, out of the way of what's being shown. */}
      {c.video && c.phase !== 'ended' && (c.sharing && c.screen ? (
        <div className={`pointer-events-none absolute right-4 z-10 w-36 overflow-hidden rounded-2xl bg-black shadow-2xl ring-1 ring-white/20 transition-all duration-300 sm:w-52 ${hidden ? 'bottom-[max(1rem,var(--safe-bottom))]' : 'bottom-36'} ${c.peerSharing && hidden ? 'opacity-0' : ''}`}>
          <Media stream={c.screen} className="aspect-video w-full object-contain" />
          <p className="bg-black/60 px-2 py-1 text-center text-[11px] text-white/85">You're sharing your screen</p>
        </div>
      ) : c.local && !c.camOff ? (
        <Media stream={c.local} mirror={c.facing !== 'environment'} className={`pointer-events-none absolute right-4 z-10 aspect-[3/4] w-28 rounded-2xl object-cover shadow-2xl ring-1 ring-white/20 transition-all duration-300 sm:w-40 ${hidden ? 'bottom-[max(1rem,var(--safe-bottom))]' : 'bottom-36'} ${c.peerSharing && hidden ? 'opacity-0' : ''}`} />
      ) : null)}

      <div className={`relative z-10 mt-auto flex items-end justify-center gap-5 pb-[max(2.5rem,var(--safe-bottom))] sm:gap-8 ${remoteVideo ? `bg-gradient-to-t from-black/60 to-transparent pt-10 ${fade}` : ''}`}>
        {c.phase === 'ended' ? null : !c.out && c.phase === 'ringing' ? (
          <>
            <Round label="Decline" tone="red" big onClick={decline} icon={<span className="rotate-[135deg]">{phone}</span>} />
            {c.video && <Round label="Voice only" onClick={() => accept(false)} icon={<Icon name="mic" className="size-7" />} />}
            <Round label="Accept" tone="green" big onClick={() => accept()} icon={c.video ? <Icon name="camera" className="size-7" /> : phone} />
          </>
        ) : (
          <>
            <Round label={c.muted ? 'Unmute' : 'Mute'} on={c.muted} onClick={toggleMute} icon={<Icon name="mic" className="size-7" />} />
            {c.video && <Round label={c.camOff ? 'Camera on' : 'Camera off'} on={c.camOff} onClick={toggleCam} icon={<Icon name="camera" className="size-7" />} />}
            {canFlip(c) && <Round label="Flip camera" onClick={flipCamera} icon={<Icon name="flip" className="size-7" />} />}
            {c.video && 'getDisplayMedia' in (navigator.mediaDevices ?? {}) && (
              <Round label={c.sharing ? 'Stop sharing' : 'Share screen'} on={c.sharing} onClick={toggleScreen} icon={<Icon name="screen" className="size-7" />} />
            )}
            <Round label="End" tone="red" big onClick={hangup} icon={<span className="rotate-[135deg]">{phone}</span>} />
          </>
        )}
      </div>
      <style>{`@keyframes ringpulse{0%{box-shadow:0 0 0 0 rgba(243,184,74,.45)}100%{box-shadow:0 0 0 36px rgba(243,184,74,0)}}`}</style>
    </div>
    </>
  )
}

/** One person in a group call: their video, or their avatar while the camera's off. */
function Tile({ stream, name, id, avatar, mirror, fit, label }: { stream?: MediaStream; name: string; id: string; avatar?: string; mirror?: boolean; fit?: boolean; label?: string }) {
  const video = hasVideo(stream)
  return (
    <div className="relative grid min-h-0 place-items-center overflow-hidden rounded-2xl bg-white/[0.06]">
      {stream && <Media stream={stream} mirror={mirror} className={`absolute inset-0 size-full ${video ? '' : 'opacity-0'} ${fit ? 'object-contain' : 'object-cover'}`} />}
      {!video && <Avatar id={id} name={name} src={avatar} size={72} />}
      <span className="absolute bottom-2 left-2 max-w-[80%] truncate rounded-full bg-black/45 px-2 py-0.5 text-xs backdrop-blur-md">{label ?? name}</span>
    </div>
  )
}

/**
 * Group call: a grid of everyone (up to 8), or, when someone shares their screen, that screen big
 * (fitted and zoomable) with the others in a strip. Controls fade over video like 1:1 calls.
 */
function GroupCall({ c, chrome, setChrome, nudge }: { c: Call; chrome: boolean; setChrome: (f: (x: boolean) => boolean) => void; nudge: (e: React.PointerEvent) => void }) {
  const chat = useFog((s) => s.chats[c.group!])
  const people = useFog((s) => s.people)
  const me = useFog((s) => s.me)
  const profile = useFog((s) => s.profile)
  const title = chat ? chatTitle(chat) : 'Group'
  const peers = Object.entries(c.peers ?? {})
  const sharer = peers.find(([, p]) => p.sharing && p.stream)
  const joined = c.joined && c.phase !== 'ended'
  const hidden = joined && c.video && !!c.started && !chrome
  const fade = `transition-opacity duration-300 ${hidden ? 'pointer-events-none opacity-0' : 'opacity-100'}`
  const status = statusOf(c, people)
  const mine = <Tile key="me" stream={c.sharing && c.screen ? c.screen : c.local} mirror={!c.sharing && c.facing !== 'environment'} fit={c.sharing} id={me?.id ?? ''} name="You" avatar={profile.avatar} label={c.muted ? 'You (muted)' : 'You'} />
  const tiles = peers.map(([key, p]) => <Tile key={key} stream={p.stream} id={p.who} name={personName(p.who, people[p.who])} avatar={people[p.who]?.avatar} label={p.connected ? undefined : `${personName(p.who, people[p.who])} · connecting…`} />)
  const n = tiles.length + 1
  const cols = n <= 1 ? 'grid-cols-1' : n <= 4 ? 'grid-cols-2' : 'grid-cols-2 sm:grid-cols-3'
  return (
    <div className="fade-in fixed inset-0 z-[60] flex flex-col overflow-hidden bg-[#0b1016] text-white" role="dialog" aria-label={`Group call in ${title}`} onPointerMove={nudge}>
      {joined && <Shrink className={fade} />}
      <header className={`relative z-10 flex flex-col items-center px-6 pt-[max(1rem,env(safe-area-inset-top))] pb-3 text-center ${fade}`}>
        {!joined && (
          <div className={`mt-10 mb-6 rounded-full ${c.phase === 'ringing' ? 'animate-[ringpulse_1.8s_ease-out_infinite]' : ''}`}>
            <Avatar id={c.group!} name={title} src={chat ? chatAvatar(chat) : undefined} size={128} />
          </div>
        )}
        <h2 className="text-xl font-semibold">{title}</h2>
        <p className="mt-0.5 text-sm text-white/80 tabular-nums">{status}</p>
        <p className="mt-2 flex items-center gap-1.5 text-xs text-white/60">
          <Icon name="lock" className="size-3.5" /> End-to-end encrypted · relayed, so nobody sees your IP
        </p>
      </header>

      {joined && (
        <div className="relative min-h-0 flex-1 px-2 pb-2">
          {sharer ? (
            <div className="flex size-full flex-col gap-2">
              <Zoomable className="min-h-0 flex-1 rounded-2xl bg-black" reset={sharer[0]} onTap={() => setChrome((x) => !x)}>
                <Media stream={sharer[1].stream} className="size-full object-contain" />
              </Zoomable>
              <div className={`grid h-28 shrink-0 auto-cols-[9rem] grid-flow-col gap-2 overflow-x-auto ${fade}`}>
                {mine}
                {tiles.filter((t) => t.key !== sharer[0])}
              </div>
            </div>
          ) : (
            <div className={`grid size-full auto-rows-fr gap-2 ${cols}`} onClick={() => setChrome((x) => !x)}>
              {mine}
              {tiles}
            </div>
          )}
        </div>
      )}

      <div className={`relative z-10 flex items-end justify-center gap-5 pt-3 pb-[max(2rem,var(--safe-bottom))] sm:gap-8 ${joined ? fade : 'mt-auto'}`}>
        {c.phase === 'ended' ? null : !joined ? (
          <>
            <Round label="Decline" tone="red" big onClick={decline} icon={<span className="rotate-[135deg]">{phone}</span>} />
            {c.video && <Round label="Voice only" onClick={() => accept(false)} icon={<Icon name="mic" className="size-7" />} />}
            <Round label="Join" tone="green" big onClick={() => accept()} icon={c.video ? <Icon name="camera" className="size-7" /> : phone} />
          </>
        ) : (
          <>
            <Round label={c.muted ? 'Unmute' : 'Mute'} on={c.muted} onClick={toggleMute} icon={<Icon name="mic" className="size-7" />} />
            {c.video && <Round label={c.camOff ? 'Camera on' : 'Camera off'} on={c.camOff} onClick={toggleCam} icon={<Icon name="camera" className="size-7" />} />}
            {canFlip(c) && <Round label="Flip camera" onClick={flipCamera} icon={<Icon name="flip" className="size-7" />} />}
            {c.video && 'getDisplayMedia' in (navigator.mediaDevices ?? {}) && <Round label={c.sharing ? 'Stop sharing' : 'Share screen'} on={c.sharing} onClick={toggleScreen} icon={<Icon name="screen" className="size-7" />} />}
            <Round label="Leave" tone="red" big onClick={hangup} icon={<span className="rotate-[135deg]">{phone}</span>} />
          </>
        )}
      </div>
      <style>{`@keyframes ringpulse{0%{box-shadow:0 0 0 0 rgba(243,184,74,.45)}100%{box-shadow:0 0 0 36px rgba(243,184,74,0)}}`}</style>
    </div>
  )
}

/** A small round button on the minimized card. */
function Small({ label, onClick, on, red, children }: { label: string; onClick: () => void; on?: boolean; red?: boolean; children: React.ReactNode }) {
  const c = red ? 'bg-[#e5484d] text-white hover:brightness-110' : on ? 'bg-white text-[#0b1016]' : 'bg-white/15 text-white hover:bg-white/25'
  return (
    <button onClick={onClick} aria-label={label} title={label} className={`pointer-events-auto grid size-9 shrink-0 place-items-center rounded-full transition active:scale-90 ${c}`}>
      {children}
    </button>
  )
}

/** Where the minimized card sits (it snaps to a corner after a drag); remembered until Fog reloads. */
type Corner = { x: 'left' | 'right'; y: 'top' | 'bottom' }
let lastCorner: Corner = { x: 'right', y: 'top' }

/**
 * The call, minimized: a floating card over the rest of Fog, out of the way of the chat header and
 * the message box (and draggable to any corner). Their video if there is any, otherwise who and how
 * long; mute and hang up; tap it to go back to the full call screen. The sound carries on (<Sounds>).
 */
function MiniCall({ c }: { c: Call }) {
  const chat = useFog((s) => s.chats[c.peer])
  const people = useFog((s) => s.people)
  const [corner, setCorner] = useState(lastCorner)
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null)
  const from = useRef<{ x: number; y: number; id: number } | null>(null)
  const dragged = useRef(false)
  const title = chat ? chatTitle(chat, c.group ? undefined : people[c.peer]) : c.group ? 'Group' : personName(c.peer, people[c.peer])
  const avatar = c.group ? (chat ? chatAvatar(chat) : undefined) : people[c.peer]?.avatar
  const ended = c.phase === 'ended'
  // 1:1: their camera. Group: whoever's sharing their screen, otherwise the first camera that's on.
  const peers = Object.values(c.peers ?? {})
  const shown = ended || !c.video ? undefined : c.group ? (peers.find((p) => p.sharing && hasVideo(p.stream)) ?? peers.find((p) => hasVideo(p.stream))) : undefined
  const picture = ended || !c.video ? undefined : c.group ? shown?.stream : c.phase === 'active' && hasVideo(c.remote) ? c.remote : undefined
  const fit = c.group ? !!shown?.sharing : !!c.peerSharing
  const open = () => !dragged.current && minimize(false)

  // Drag (mouse, finger or pen) to move it; let go and it snaps to the nearest corner.
  const down = (e: React.PointerEvent) => {
    from.current = { x: e.clientX, y: e.clientY, id: e.pointerId }
    dragged.current = false
  }
  const move = (e: React.PointerEvent<HTMLDivElement>) => {
    const f = from.current
    if (!f || f.id !== e.pointerId) return
    const x = e.clientX - f.x
    const y = e.clientY - f.y
    if (!dragged.current) {
      if (Math.hypot(x, y) < 8) return
      dragged.current = true
      e.currentTarget.setPointerCapture(e.pointerId)
    }
    setDrag({ x, y })
  }
  const up = (e: React.PointerEvent<HTMLDivElement>) => {
    const f = from.current
    from.current = null
    if (!f || !dragged.current) return
    const r = e.currentTarget.getBoundingClientRect()
    const next: Corner = { x: r.left + r.width / 2 < innerWidth / 2 ? 'left' : 'right', y: r.top + r.height / 2 < innerHeight / 2 ? 'top' : 'bottom' }
    lastCorner = next
    setCorner(next)
    setDrag(null)
  }
  const style: React.CSSProperties = {
    // Below the chat header (4rem) at the top; above the message box at the bottom, and above the keyboard.
    [corner.y]: corner.y === 'top' ? 'calc(env(safe-area-inset-top) + 4.75rem)' : 'calc(var(--keyboard-lift, 0px) + var(--safe-bottom) + 5.5rem)',
    [corner.x]: `calc(env(safe-area-inset-${corner.x}) + 0.75rem)`,
    transform: drag ? `translate(${drag.x}px, ${drag.y}px)` : undefined,
  }
  const handlers = { onPointerDown: down, onPointerMove: move, onPointerUp: up, onPointerCancel: up }
  const shell = 'fade-in fixed z-[45] touch-none text-white shadow-[0_14px_40px_-12px_rgba(0,0,0,0.65)] ring-1 ring-white/15 select-none'
  const controls = !ended && (
    <>
      <Small label={c.muted ? 'Unmute' : 'Mute'} on={c.muted} onClick={toggleMute}>
        <Icon name="mic" className="size-[18px]" />
      </Small>
      <Small label={c.group ? 'Leave' : 'End'} red onClick={hangup}>
        <span className="rotate-[135deg]">{phoneIcon('size-[18px]')}</span>
      </Small>
    </>
  )
  const label = `Back to the call ${c.group ? 'in' : 'with'} ${title}`

  if (picture)
    return (
      <div role="group" aria-label={`Call ${c.group ? 'in' : 'with'} ${title}`} className={`${shell} w-32 overflow-hidden rounded-2xl bg-[#0b1016] sm:w-44`} style={style} {...handlers}>
        <button onClick={open} aria-label={label} title={label} className="block aspect-[3/4] w-full">
          <Media stream={picture} className={`size-full ${fit ? 'object-contain' : 'object-cover'}`} />
        </button>
        <p className="pointer-events-none absolute inset-x-0 top-0 truncate bg-gradient-to-b from-black/65 to-transparent px-2.5 pt-1.5 pb-5 text-[11px] text-white/90 tabular-nums">{statusOf(c, people)}</p>
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center gap-2 bg-gradient-to-t from-black/65 to-transparent pt-6 pb-2">{controls}</div>
      </div>
    )
  return (
    <div role="group" aria-label={`Call ${c.group ? 'in' : 'with'} ${title}`} className={`${shell} flex max-w-[calc(100vw-1.5rem)] items-center gap-1.5 rounded-full bg-[#0b1016]/95 p-1.5 backdrop-blur-md`} style={style} {...handlers}>
      <button onClick={open} aria-label={label} title={label} className="flex min-w-0 items-center gap-2.5 rounded-full pr-1.5 text-left">
        <span className="relative shrink-0">
          <Avatar id={c.peer} name={title} src={avatar} size={36} />
          {!ended && <span className={`absolute -right-0.5 -bottom-0.5 size-3 rounded-full bg-lamp ring-2 ring-[#0b1016] ${c.started ? '' : 'animate-pulse'}`} />}
        </span>
        <span className="min-w-0">
          <span className="block max-w-[9rem] truncate text-sm leading-tight font-semibold">{title}</span>
          <span className="block truncate text-xs leading-tight text-white/70 tabular-nums">{statusOf(c, people)}</span>
        </span>
      </button>
      {controls}
    </div>
  )
}
