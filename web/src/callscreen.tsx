// Full-screen call UI: incoming ring, outgoing ringback, in-call controls.
import { useEffect, useRef, useState } from 'react'
import { accept, decline, hangup, toggleCam, toggleMute, toggleScreen, useCall } from './call'
import { chatTitle, useFog } from './fog'
import { fmtDur } from './media'
import { Avatar, Icon } from './ui'

function Media({ stream, muted, className, mirror }: { stream?: MediaStream; muted?: boolean; className: string; mirror?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    if (ref.current && ref.current.srcObject !== (stream ?? null)) ref.current.srcObject = stream ?? null
  }, [stream])
  return <video ref={ref} autoPlay playsInline muted={muted} className={`${className} ${mirror ? '-scale-x-100' : ''}`} />
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

const phone = (
  <svg viewBox="0 0 24 24" className="size-7" fill="currentColor" aria-hidden>
    <path d="M6.6 10.8a15.1 15.1 0 006.6 6.6l2.2-2.2a1 1 0 011-.25 11.4 11.4 0 003.6.57 1 1 0 011 1V20a1 1 0 01-1 1A17 17 0 013 4a1 1 0 011-1h3.5a1 1 0 011 1c0 1.25.2 2.45.57 3.57a1 1 0 01-.25 1z" />
  </svg>
)

export function CallScreen() {
  const c = useCall()
  const chat = useFog((s) => (c ? s.chats[c.peer] : undefined))
  const person = useFog((s) => (c ? s.people[c.peer] : undefined))
  const [, tick] = useState(0)
  useEffect(() => {
    if (c?.phase !== 'active') return
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [c?.phase])
  if (!c) return null
  const title = chat ? chatTitle(chat, person) : (person?.name ?? 'Unknown')
  const avatar = person?.avatar
  const remoteVideo = c.video && c.remote?.getVideoTracks().length && c.phase === 'active'
  const status =
    c.phase === 'ended'
      ? c.ended
      : c.phase === 'active'
        ? fmtDur((Date.now() - (c.started ?? Date.now())) / 1000)
        : c.phase === 'connecting'
          ? 'Connecting…'
          : c.out
            ? 'Ringing…'
            : `Incoming ${c.video ? 'video' : 'voice'} call`

  return (
    <div className="fade-in fixed inset-0 z-[60] flex flex-col overflow-hidden bg-[#0b1016] text-white" role="dialog" aria-label={`Call with ${title}`}>
      {remoteVideo ? (
        <Media stream={c.remote} className="absolute inset-0 size-full object-cover" />
      ) : (
        <>
          {avatar && <img src={avatar} alt="" className="absolute inset-0 size-full scale-125 object-cover opacity-35 blur-3xl" />}
          <div className="absolute inset-0 bg-gradient-to-b from-[#0b1016]/40 via-transparent to-[#0b1016]/80" />
          {/* Voice calls still need an element to play the remote audio. */}
          {c.remote && <Media stream={c.remote} className="hidden" />}
        </>
      )}

      <header className={`relative z-10 flex flex-col items-center px-6 pt-[max(3rem,env(safe-area-inset-top))] text-center ${remoteVideo ? 'bg-gradient-to-b from-black/50 to-transparent pb-10' : ''}`}>
        {!remoteVideo && (
          <div className={`mb-6 rounded-full ${c.phase === 'ringing' ? 'animate-[ringpulse_1.8s_ease-out_infinite]' : ''}`}>
            <Avatar id={c.peer} name={title} src={avatar} size={128} />
          </div>
        )}
        <h2 className="text-2xl font-semibold drop-shadow">{title}</h2>
        <p className="mt-1 text-white/80 tabular-nums drop-shadow">{status}</p>
        <p className="mt-3 flex items-center gap-1.5 text-xs text-white/60">
          <Icon name="lock" className="size-3.5" /> End-to-end encrypted
        </p>
      </header>

      {c.video && c.local && !c.camOff && c.phase !== 'ended' && (
        <Media stream={c.local} muted mirror className="absolute right-4 bottom-36 z-10 aspect-[3/4] w-28 rounded-2xl object-cover shadow-2xl ring-1 ring-white/20 sm:w-40" />
      )}

      <div className="relative z-10 mt-auto flex items-end justify-center gap-8 pb-[max(2.5rem,env(safe-area-inset-bottom))]">
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
            {c.video && 'getDisplayMedia' in (navigator.mediaDevices ?? {}) && (
              <Round label={c.sharing ? 'Stop sharing' : 'Share screen'} on={c.sharing} onClick={toggleScreen} icon={<Icon name="screen" className="size-7" />} />
            )}
            <Round label="End" tone="red" big onClick={hangup} icon={<span className="rotate-[135deg]">{phone}</span>} />
          </>
        )}
      </div>
      <style>{`@keyframes ringpulse{0%{box-shadow:0 0 0 0 rgba(243,184,74,.45)}100%{box-shadow:0 0 0 36px rgba(243,184,74,0)}}`}</style>
    </div>
  )
}
