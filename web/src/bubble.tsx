// Message rendering: bubbles, attachments (photo, video, voice, audio, any file), viewers.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import * as fog from './fog'
import { attLabel, chatTitle, msgStatus, personName, timerLabel, useFog, type Chat, type LinkPreview, type Msg } from './fog'
import { fmtDur as dur } from './media'
import { cycleRate, download, fmtDur, fmtSize, localBlob, posterNow, saveFile, seek, thumbIsBlank, togglePlay, useLocalUrl, usePlayer, useTransfer, type Att } from './media'
import { Avatar, Button, copy, Dialog, Icon, Menu, MenuItem, Spinner, usePressMenu, Zoomable, type MenuAt } from './ui'
import { Md, mdPlain, openLink } from './markdown'

// ---------- formatting ----------
export const fmtTime = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
export const fullDate = (ts: number) => new Date(ts).toLocaleString([], { dateStyle: 'full', timeStyle: 'short' })
export function dayLabel(ts: number) {
  const d = new Date(ts).toDateString()
  if (d === new Date().toDateString()) return 'Today'
  if (d === new Date(Date.now() - 864e5).toDateString()) return 'Yesterday'
  return new Date(ts).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: new Date(ts).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' })
}
const plain = (t: string) => t.replace(/```/g, '').replace(/(^|[^\p{L}\p{N}])([*_~`])(\S(?:.*?\S)?)\2(?![\p{L}\p{N}])/gu, '$1$3')
const flat = (m: Msg) => (m.md ? mdPlain(m.text) : plain(m.text)).replace(/\s*\n\s*/g, ' ')
export const snippet = (m: Msg) => (m.sys ? sysText(m) : m.poll ? `📊 ${m.poll.q}` : m.att ? (m.text ? `${attLabel(m.att).split(' ')[0]} ${flat(m)}` : attLabel(m.att)) : flat(m))

export function sysText(m: Msg) {
  const s = m.sys!
  const by = personName(s.by)
  const who = (s.who ?? []).map((w) => (w === fog.getState().me?.id ? 'you' : personName(w))).join(', ')
  return {
    create: `${by} created the group “${s.name}”`,
    add: `${by} added ${who}`,
    remove: `${by} removed ${who}`,
    leave: `${by === 'You' ? 'You' : by} left the group`,
    rename: `${by} renamed the group to “${s.name}”`,
    decrypt: "A message couldn't be decrypted. Ask them to send it again.",
    timer: s.secs ? `${by} set messages to disappear after ${timerLabel(s.secs)}` : `${by} turned off disappearing messages`,
    pin: `${by} pinned “${s.name}”`,
    call: s.call ? callText(s.call) : "",
    thread: `${by} started a thread “${s.name}”`,
    fork: '⚠️ Members of this group are seeing different member lists. The owner may be showing different groups to different people.',
  }[s.k]
}

function callText(c: NonNullable<Msg['sys']>['call'] & {}) {
  const kind = c.video ? 'video call' : 'voice call'
  if (c.group) return c.dur ? `Group ${kind} · ${dur(c.dur)}` : c.out ? `Group ${kind}, nobody joined` : `Missed group ${kind}`
  if (c.dur) return `${c.out ? 'Outgoing' : 'Incoming'} ${kind} · ${dur(c.dur)}`
  if (c.missed) return `Missed ${kind}`
  if (c.declined) return `Declined ${kind}`
  return c.out ? `Cancelled ${kind}` : `Missed ${kind}`
}

const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic}|\p{Emoji_Modifier})*\s*){1,3}$/u
const isEmojiOnly = (t: string) => EMOJI_ONLY.test(t.trim())

// WhatsApp-style formatting: *bold* _italic_ ~strike~ `code` ```block```, plus links.
// Builds React nodes (never HTML strings), so message text can't inject markup.
const INLINE = /(`[^`\n]+`)|((?<![\p{L}\p{N}])\*[^*\n]+\*(?![\p{L}\p{N}]))|((?<![\p{L}\p{N}])_[^_\n]+_(?![\p{L}\p{N}]))|((?<![\p{L}\p{N}])~[^~\n]+~(?![\p{L}\p{N}]))|((?<![\w@])@[a-z][a-z0-9_]{2,31}\b)|(https?:\/\/[^\s<]+[^\s<.,:;"')\]!?])/gu
function inline(s: string, key: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let i = 0
  for (const m of s.matchAll(INLINE)) {
    if (m.index > last) out.push(s.slice(last, m.index))
    const t = m[0]
    const k = `${key}-${i++}`
    if (m[1]) out.push(<code key={k} className="rounded-md bg-black/[0.07] px-1 py-px font-mono text-[0.88em] dark:bg-white/10">{t.slice(1, -1)}</code>)
    else if (m[2]) out.push(<strong key={k} className="font-semibold">{inline(t.slice(1, -1), k)}</strong>)
    else if (m[3]) out.push(<em key={k}>{inline(t.slice(1, -1), k)}</em>)
    else if (m[4]) out.push(<s key={k}>{inline(t.slice(1, -1), k)}</s>)
    else if (m[5]) out.push(<span key={k} className="mention">{t}</span>)
    else
      out.push(
        <a key={k} href={t} target="_blank" rel="noopener noreferrer" className="[overflow-wrap:anywhere] underline decoration-current/40 underline-offset-2 hover:decoration-current" onClick={(e) => e.stopPropagation()}>
          {t}
        </a>,
      )
    last = m.index + t.length
  }
  if (last < s.length) out.push(s.slice(last))
  return out
}
export function Rich({ text }: { text: string }) {
  return (
    <>
      {text.split(/(```[\s\S]+?```)/g).map((part, i) =>
        part.startsWith('```') && part.endsWith('```') && part.length > 6 ? (
          <pre key={i} className="scroll-thin my-1 overflow-x-auto rounded-lg bg-black/[0.07] p-2.5 font-mono text-[0.85em] leading-relaxed dark:bg-white/10">
            {part.slice(3, -3).replace(/^\n/, '')}
          </pre>
        ) : (
          inline(part, String(i))
        ),
      )}
    </>
  )
}

export function Ticks({ status, read = 'text-lamp' }: { status?: Msg['status']; read?: string }) {
  if (status === 'sending')
    return (
      <svg viewBox="0 0 16 16" className="size-3.5" aria-label="Sending">
        <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M8 5v3.2l2 1.3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    )
  if (status === 'failed') return <span className="font-bold text-danger" aria-label="Not sent">!</span>
  const two = status === 'delivered' || status === 'read'
  return (
    <svg viewBox="0 0 20 14" className={`h-3.5 w-5 ${status === 'read' ? read : ''}`} aria-label={status}>
      <path d="M1.5 7.5l3.5 3.5L12 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      {two && <path d="M7.5 10.5l.5.5L15 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />}
    </svg>
  )
}

const NAME_COLORS = ['text-sky-600 dark:text-sky-400', 'text-rose-600 dark:text-rose-400', 'text-emerald-600 dark:text-emerald-400', 'text-violet-600 dark:text-violet-300', 'text-orange-600 dark:text-orange-400', 'text-teal-600 dark:text-teal-300', 'text-pink-600 dark:text-pink-400']
export const nameColor = (id: string) => {
  let h = 0
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return NAME_COLORS[h % NAME_COLORS.length]
}

// ---------- attachments ----------
const TEXT_EXT = new Set(
  'txt md markdown json jsonc js mjs cjs ts tsx jsx py rs go java kt kts swift c h cpp hpp cc cs rb php sh bash zsh fish ps1 sql css scss sass less html htm xml svg yml yaml toml ini cfg conf env log csv tsv lua dart scala r pl ex exs erl hs ml clj vue svelte astro gradle tf proto graphql gql diff patch gitignore dockerfile makefile lock'.split(' '),
)
export const ext = (name: string) => (name.includes('.') ? name.split('.').pop()!.toLowerCase() : name.toLowerCase())
export const isText = (a: Att) => a.size <= 2_000_000 && (/^text\//.test(a.mime) || /json|xml|javascript|typescript|yaml|toml|x-sh|sql/.test(a.mime) || TEXT_EXT.has(ext(a.name)))

function fileStyle(a: Att) {
  const e = ext(a.name)
  if (/^(zip|rar|7z|tar|gz|tgz|bz2|xz)$/.test(e)) return 'bg-amber-700'
  if (e === 'pdf') return 'bg-red-600'
  if (/^(docx?|odt|rtf|pages)$/.test(e)) return 'bg-blue-600'
  if (/^(xlsx?|ods|numbers|csv)$/.test(e)) return 'bg-emerald-600'
  if (/^(pptx?|key|odp)$/.test(e)) return 'bg-orange-600'
  if (a.mime.startsWith('audio/')) return 'bg-pink-600'
  if (a.mime.startsWith('video/')) return 'bg-teal-600'
  if (a.mime.startsWith('image/')) return 'bg-cyan-600'
  if (isText(a)) return 'bg-violet-600'
  return 'bg-slate-500'
}

function Ring({ p, className = 'size-12' }: { p: number; className?: string }) {
  const r = 20
  const c = 2 * Math.PI * r
  return (
    <svg viewBox="0 0 48 48" className={`${className} -rotate-90`} aria-label={`${Math.round(p * 100)}%`}>
      <circle cx="24" cy="24" r={r} fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <circle cx="24" cy="24" r={r} fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - Math.max(0.03, p))} className="transition-[stroke-dashoffset] duration-200" />
    </svg>
  )
}

function MediaBox({ a, onOpen, meta, rounded }: { a: Att; onOpen: () => void; meta?: ReactNode; rounded: string }) {
  const url = useLocalUrl(a.lid)
  const t = useTransfer(a.lid)
  useEffect(() => {
    if (!url && a.kind === 'photo' && !t) download(a)
  }, [a.lid])
  const ratio = (a.w ?? 4) / (a.h ?? 3)
  const width = Math.max(180, Math.min(340, ratio * 360, a.w ?? 340))
  const video = a.kind === 'video'
  return (
    <button onClick={onOpen} className={`relative block overflow-hidden bg-black/20 ${rounded}`} style={{ width, maxWidth: '100%', aspectRatio: `${Math.max(0.5, Math.min(2.4, ratio))}` }}>
      {a.thumb && <img src={a.thumb} alt="" className={`absolute inset-0 size-full object-cover ${video ? '' : 'scale-110 blur-xl'}`} draggable={false} />}
      {url && !video && <img src={url} alt="Photo" className="fade-in absolute inset-0 size-full object-cover" draggable={false} />}
      {(t || video) && (
        <span className="absolute inset-0 grid place-items-center">
          <span className="grid size-14 place-items-center rounded-full bg-black/45 text-white backdrop-blur-sm">
            {t && !t.err ? (
              <Ring p={t.p} />
            ) : t?.err ? (
              <Icon name="download" />
            ) : (
              <svg viewBox="0 0 24 24" className="ml-1 size-7" fill="currentColor" aria-hidden>
                <path d="M7 4.5v15l12-7.5z" />
              </svg>
            )}
          </span>
        </span>
      )}
      {video && (
        <span className="absolute top-2 left-2 rounded-full bg-black/45 px-2 py-0.5 text-xs font-medium text-white backdrop-blur-sm">
          {fmtDur(a.dur)}
          {!url && ` · ${fmtSize(a.size)}`}
        </span>
      )}
      {meta && <span className="absolute right-2 bottom-2 rounded-full bg-black/45 px-2 py-0.5 backdrop-blur-sm [&_*]:!text-white">{meta}</span>}
    </button>
  )
}

function Wave({ a, mine }: { a: Att; mine: boolean }) {
  const pl = usePlayer()
  const active = pl.lid === a.lid
  const frac = active && pl.dur ? pl.t / pl.dur : 0
  const bars = a.wave?.length ? a.wave : Array(40).fill(4)
  return (
    <button
      className="flex h-7 items-center gap-[2px]"
      onClick={(e) => {
        e.stopPropagation()
        const r = e.currentTarget.getBoundingClientRect()
        active ? seek(a, (e.clientX - r.left) / r.width) : togglePlay(a)
      }}
      aria-label="Seek"
    >
      {bars.map((v, i) => (
        <span
          key={i}
          className={`w-[3px] rounded-full transition-colors ${i / bars.length < frac ? (mine ? 'bg-out-ink' : 'bg-lamp') : mine ? 'bg-out-ink/35' : 'bg-muted/45'}`}
          style={{ height: `${Math.max(12, (v / 31) * 100)}%` }}
        />
      ))}
    </button>
  )
}

function PlayButton({ a, mine }: { a: Att; mine: boolean }) {
  const pl = usePlayer()
  const t = useTransfer(a.lid)
  const active = pl.lid === a.lid
  return (
    <button
      onClick={(e) => (e.stopPropagation(), togglePlay(a))}
      aria-label={active && pl.playing ? 'Pause' : 'Play'}
      className={`relative grid size-11 shrink-0 place-items-center rounded-full transition active:scale-95 ${mine ? 'bg-out-ink text-out' : 'bg-lamp text-lamp-ink'}`}
    >
      {t && !t.err ? (
        <Ring p={t.p} className="size-11" />
      ) : active && pl.playing ? (
        <svg viewBox="0 0 24 24" className="size-5" fill="currentColor" aria-hidden>
          <path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" className="ml-0.5 size-5" fill="currentColor" aria-hidden>
          <path d="M7 4.5v15l12-7.5z" />
        </svg>
      )}
    </button>
  )
}

function Voice({ a, mine, meta }: { a: Att; mine: boolean; meta: ReactNode }) {
  const pl = usePlayer()
  const active = pl.lid === a.lid
  return (
    <div className="flex w-[min(300px,70vw)] items-center gap-3 px-2.5 pt-2 pb-1.5">
      <PlayButton a={a} mine={mine} />
      <div className="min-w-0 flex-1">
        <Wave a={a} mine={mine} />
        <div className="mt-0.5 flex items-center gap-2 text-[11.5px]">
          <span className={mine ? 'text-out-meta' : 'text-muted'}>{fmtDur(active && pl.t ? pl.t : a.dur)}</span>
          {active && (
            <button onClick={(e) => (e.stopPropagation(), cycleRate())} className={`rounded-full px-1.5 font-bold ${mine ? 'bg-out-ink/15 text-out-ink' : 'bg-lamp/20 text-lamp'}`}>
              {pl.rate}×
            </button>
          )}
          <span className="ml-auto">{meta}</span>
        </div>
      </div>
    </div>
  )
}

function AudioCard({ a, mine }: { a: Att; mine: boolean }) {
  const pl = usePlayer()
  const active = pl.lid === a.lid
  const frac = active && pl.dur ? pl.t / pl.dur : 0
  return (
    <div className="flex w-[min(320px,72vw)] items-center gap-3 px-2.5 pt-2.5 pb-1">
      <PlayButton a={a} mine={mine} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[15px] font-medium">{a.name}</p>
        <button
          onClick={(e) => {
            e.stopPropagation()
            const r = e.currentTarget.getBoundingClientRect()
            seek(a, (e.clientX - r.left) / r.width)
          }}
          className="relative mt-1.5 block h-1 w-full rounded-full bg-current/15"
          aria-label="Seek"
        >
          <span className={`absolute inset-y-0 left-0 rounded-full ${mine ? 'bg-out-ink' : 'bg-lamp'}`} style={{ width: `${frac * 100}%` }} />
        </button>
        <p className={`mt-1 text-xs ${mine ? 'text-out-meta' : 'text-muted'}`}>
          {active ? `${fmtDur(pl.t)} / ` : ''}
          {fmtDur(a.dur)} · {fmtSize(a.size)}
        </p>
      </div>
    </div>
  )
}

function FileCard({ a, mine, onOpen }: { a: Att; mine: boolean; onOpen: () => void }) {
  const url = useLocalUrl(a.lid)
  const t = useTransfer(a.lid)
  const e = ext(a.name)
  return (
    <button onClick={onOpen} className="flex w-[min(320px,72vw)] items-center gap-3 px-2.5 pt-2.5 pb-1 text-left">
      <span className={`relative grid size-12 shrink-0 place-items-center rounded-xl text-white ${fileStyle(a)}`}>
        {t && !t.err ? (
          <Ring p={t.p} className="size-10" />
        ) : !url && !mine ? (
          <Icon name="download" className="size-5" />
        ) : (
          <span className="max-w-11 truncate text-[11px] font-bold uppercase">{e.slice(0, 5)}</span>
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px] font-medium">{a.name}</span>
        <span className={`block text-xs ${mine ? 'text-out-meta' : 'text-muted'}`}>
          {t?.err ? 'Failed. Tap to retry' : t ? `${t.dir === 'up' ? 'Uploading' : 'Downloading'} ${Math.round(t.p * 100)}%` : `${fmtSize(a.size)}${isText(a) ? ' · Tap to view' : url || mine ? ' · Tap to save' : ' · Tap to download'}`}
        </span>
      </span>
    </button>
  )
}

// ---------- bubble ----------
export type BubbleProps = {
  m: Msg
  chat: Chat
  replied?: Msg
  joinPrev: boolean
  joinNext: boolean
  fresh: boolean
  flash: boolean
  lifted: boolean
  selecting: boolean
  selected: boolean
  onSelect: () => void
  onMenu: (at: MenuAt, touch: boolean) => void
  onReply: () => void
  onOpenMedia: () => void
  onOpenText: () => void
}

export function Bubble(props: BubbleProps) {
  const { m, chat, replied, joinPrev, joinNext, fresh, flash, lifted, selecting, selected, onSelect, onMenu, onReply, onOpenMedia, onOpenText } = props
  const people = useFog((s) => s.people)
  const press = usePressMenu(onMenu)
  const [dx, setDx] = useState(0)
  const swipe = useRef<{ x: number; y: number; on: boolean } | null>(null)
  const a = m.att
  const big = (!a && !m.reply && !m.fwd && !m.link && isEmojiOnly(m.text)) || (a?.kind === 'sticker' && !m.text && !m.reply)
  const counts = new Map<string, number>()
  for (const e of Object.values(m.re ?? {})) counts.set(e, (counts.get(e) ?? 0) + 1)
  // A photo/video with nothing else is shown as the media itself, shaped like a bubble (no fill, no tail).
  const mediaOnly = !!a && (a.kind === 'photo' || a.kind === 'video' || a.kind === 'videonote') && !m.text && !m.reply && !m.fwd && !(chat.group && !m.mine && !joinPrev) && !counts.size
  const tail = !joinNext && !big && !mediaOnly
  const status = m.mine ? msgStatus(chat, m) : undefined
  const groupIn = !!chat.group && !m.mine
  const media = a && (a.kind === 'photo' || a.kind === 'video' || a.kind === 'videonote')
  const myReaction = m.re?.me
  const [askOpen, setAskOpen] = useState(false)

  const handlers = selecting
    ? { onClick: onSelect }
    : {
        onPointerDown: (e: React.PointerEvent) => {
          press.onPointerDown(e)
          if (e.pointerType === 'touch') swipe.current = { x: e.clientX, y: e.clientY, on: false }
        },
        onPointerMove: (e: React.PointerEvent) => {
          press.onPointerMove(e)
          const s = swipe.current
          if (!s) return
          const ddx = e.clientX - s.x
          if (!s.on && Math.abs(ddx) > 12 && Math.abs(ddx) > Math.abs(e.clientY - s.y) * 1.5) s.on = true
          if (s.on) setDx(Math.max(-72, Math.min(0, ddx)))
        },
        onPointerUp: () => {
          press.onPointerUp()
          if (swipe.current?.on && dx <= -56) (navigator.vibrate?.(8), onReply())
          swipe.current = null
          setDx(0)
        },
        onPointerCancel: () => {
          press.onPointerCancel()
          swipe.current = null
          setDx(0)
        },
        onContextMenu: press.onContextMenu,
      }

  const shape = m.mine
    ? `${joinPrev ? 'rounded-tr-[6px]' : ''} ${tail ? 'rounded-br-[4px] tail-out' : 'rounded-br-[6px]'}`
    : `${joinPrev ? 'rounded-tl-[6px]' : ''} ${tail ? 'rounded-bl-[4px] tail-in' : 'rounded-bl-[6px]'}`
  const color = big || mediaOnly ? '' : m.mine ? 'bg-out text-out-ink' : 'bg-in text-ink'
  const meta = (
    <span className={`flex items-center gap-1 text-[11.5px] whitespace-nowrap ${m.mine ? 'text-out-meta' : 'text-muted'}`} title={fullDate(m.ts)}>
      {m.ttl && <Icon name="timer" className="size-3.5" />}
      {m.only && <span title="The sender says they sent this to you alone. Fog can't check what they sent anyone else.">to you</span>}
      {m.edited && <span>edited</span>}
      {fmtTime(m.ts)}
      {m.mine &&
        (status === 'failed' ? (
          <button onClick={(e) => (e.stopPropagation(), m.sealFail ? setAskOpen(true) : fog.retry(chat.id, m))} className="font-semibold text-danger underline" aria-label="Retry sending">
            Retry
          </button>
        ) : (
          <Ticks status={status} read="text-tick" />
        ))}
    </span>
  )
  const openFile = () => {
    if (!a) return
    if (isText(a)) onOpenText()
    else saveFile(a).then((ok) => !ok && fog.toast("Couldn't download that file"))
  }

  return (
    <div
      data-mid={m.id}
      className={`group relative flex items-end ${m.mine ? 'flex-row-reverse' : ''} ${joinPrev ? 'mt-[3px]' : 'mt-2'} ${flash ? 'flash' : ''} ${lifted ? 'z-[45]' : ''} ${selected ? 'bg-lamp/15' : ''} -mx-2 rounded-xl px-2 sm:-mx-6 sm:px-6 ${selecting ? 'cursor-pointer' : ''}`}
      style={{ touchAction: 'pan-y' }}
      {...handlers}
    >
      {selecting && (
        <span className={`mb-2 grid size-6 shrink-0 place-items-center self-center rounded-full border-2 transition ${selected ? 'border-lamp bg-lamp text-lamp-ink' : 'border-muted/60'} ${m.mine ? 'ml-2' : 'mr-2'}`}>
          {selected && <Icon name="check" className="size-4" />}
        </span>
      )}
      {groupIn && (
        <span className="mr-2 w-[34px] shrink-0">{!joinNext && <Avatar id={m.from!} name={personName(m.from!, people[m.from!])} src={people[m.from!]?.avatar} size={34} />}</span>
      )}
      <div
        data-bubble
        className={`${fresh ? 'msg-in' : ''} ${lifted ? 'lift' : ''} relative max-w-[min(85%,560px)] rounded-[18px] ${color} ${shape} ${mediaOnly ? 'overflow-hidden shadow-sm' : big ? '' : 'shadow-[0_1px_1px_rgba(0,0,0,0.08)]'}`}
        style={{ transform: dx ? `translateX(${dx}px)` : undefined, transition: dx ? 'none' : 'transform 200ms ease' }}
      >
        {groupIn && !joinPrev && !media && !big && (
          <p className={`truncate px-3 pt-1.5 text-[13.5px] font-semibold ${nameColor(m.from!)}`}>{personName(m.from!, people[m.from!])}</p>
        )}
        {m.fwd && <p className={`px-3 pt-1.5 text-[13px] italic ${m.mine ? 'text-out-meta' : 'text-muted'}`}>Forwarded</p>}
        {m.reply && <Quote m={replied} chat={chat} mine={m.mine} />}
        {a && media && (
          <div className={m.reply || m.fwd || (groupIn && !joinPrev) ? 'px-1 pt-1' : ''}>
            {groupIn && !joinPrev && <p className={`truncate px-2 pt-0.5 pb-1 text-[13.5px] font-semibold ${nameColor(m.from!)}`}>{personName(m.from!, people[m.from!])}</p>}
            {a.kind === 'videonote' ? (
              <VideoNote a={a} meta={m.text ? undefined : meta} rounded={mediaOnly ? 'rounded-none' : `${m.reply || m.fwd || (groupIn && !joinPrev) ? 'rounded-[14px]' : 'rounded-[18px]'} ${m.text ? 'rounded-b-[6px]' : ''}`} />
            ) : (
              <MediaBox
                a={a}
                onOpen={selecting ? onSelect : onOpenMedia}
                meta={m.text ? undefined : meta}
                rounded={mediaOnly ? 'rounded-none' : `${m.reply || m.fwd || (groupIn && !joinPrev) ? 'rounded-[14px]' : 'rounded-[18px]'} ${m.text ? 'rounded-b-[6px]' : ''}`}
              />
            )}
          </div>
        )}
        {m.poll && <PollView m={m} chat={chat} meta={meta} />}
        {m.link && !big && <LinkCard l={m.link} mine={m.mine} />}
        {a?.kind === 'voice' && <Voice a={a} mine={m.mine} meta={m.text ? null : meta} />}
        {a?.kind === 'audio' && <AudioCard a={a} mine={m.mine} />}
        {a?.kind === 'file' && <FileCard a={a} mine={m.mine} onOpen={selecting ? onSelect : openFile} />}
        {big ? (
          <div className="px-1">
            {a?.kind === 'sticker' ? <Sticker a={a} /> : <p className="text-[44px] leading-[1.15]">{m.text}</p>}
            <div className="mt-0.5 flex justify-end">
              <span className="rounded-full bg-black/25 px-2 py-0.5 backdrop-blur-sm [&_*]:!text-white">{meta}</span>
            </div>
          </div>
        ) : m.text || m.card ? (
          <div className={`text-msg relative px-3 pt-1.5 pb-1.5 break-words ${m.md ? '' : 'whitespace-pre-wrap'}`}>
            {m.card ? (
              <div className="my-0.5 border-l-[3px] pl-2.5" style={{ borderColor: m.card.color ?? 'currentColor' }}>
                {m.card.title && <p className="font-semibold">{m.card.title}</p>}
                {m.md ? <Md text={m.text} /> : <Rich text={m.text} />}
                {m.card.footer && <p className="mt-1 text-[12.5px] opacity-70">{m.card.footer}</p>}
              </div>
            ) : m.md ? (
              <Md text={m.text} />
            ) : (
              <Rich text={m.text} />
            )}
            {m.live && <span className="caret ml-0.5 inline-block h-[1.05em] w-[0.5em] translate-y-[0.15em] rounded-[2px] bg-current/60" aria-label="Writing" />}
            {/* Reserve room so the timestamp tucks into the last line. */}
            <span className={`inline-block ${m.mine ? (m.edited ? 'w-[7.5rem]' : 'w-[4.75rem]') : m.edited || m.only ? 'w-[6.25rem]' : 'w-[3.5rem]'}`} aria-hidden />
            <span className="absolute right-3 bottom-1">{meta}</span>
          </div>
        ) : a && (a.kind === 'audio' || a.kind === 'file') ? (
          <div className="flex justify-end px-3 pb-1.5">{meta}</div>
        ) : null}
        {m.kb && !selecting && <Keys m={m} chat={chat} />}
        {counts.size > 0 && (
          <div className={`flex flex-wrap gap-1 px-2 pb-1.5 ${big ? 'justify-end pt-1' : media && !m.text ? 'pt-1.5' : '-mt-0.5'}`}>
            {[...counts].map(([e, n]) => {
              const mineR = myReaction === e
              return (
                <button
                  key={e}
                  onClick={(ev) => (ev.stopPropagation(), fog.react(chat.id, m.id, mineR ? null : e))}
                  title={mineR ? 'Remove your reaction' : 'React'}
                  className={`pop flex h-7 items-center gap-1 rounded-full px-2 text-[15px] transition ${
                    mineR ? (m.mine ? 'bg-out-ink/15 ring-1 ring-out-ink/30' : 'bg-lamp/25 ring-1 ring-lamp/50') : m.mine ? 'bg-black/[0.08]' : 'bg-black/[0.06] dark:bg-white/10'
                  } ${big ? 'bg-panel shadow' : ''}`}
                >
                  {e}
                  {n > 1 && <span className="text-xs font-semibold opacity-70">{n}</span>}
                </button>
              )
            })}
          </div>
        )}
      </div>
      {!selecting && (
        <button
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            onMenu({ x: r.left, y: r.bottom + 4 }, false)
          }}
          aria-label="Message actions"
          className="mx-1 mb-1 grid size-8 shrink-0 place-items-center rounded-full text-muted opacity-0 transition group-hover:opacity-100 hover:bg-black/10 focus-visible:opacity-100 max-md:hidden"
        >
          <Icon name="smile" className="size-5" />
        </button>
      )}
      {askOpen && (
        <Dialog
          title="Send without hiding that it's from you?"
          onClose={() => setAskOpen(false)}
          actions={
            <>
              <Button kind="ghost" onClick={() => setAskOpen(false)}>
                Don't send
              </Button>
              <Button onClick={() => (setAskOpen(false), void fog.retry(chat.id, m, true))}>Send anyway</Button>
            </>
          }
        >
          <p className="text-[15px] text-muted">
            Fog normally sends messages so the server can't see who they're from. The server refused to deliver this one that way. That happens when the other person changed their privacy key or blocked you, but a server could also do it on purpose to find out who's writing to whom.
          </p>
          <p className="mt-2 text-[15px] text-muted">Sending anyway lets the server see this message is from you. Its contents stay end-to-end encrypted.</p>
        </Dialog>
      )}
      {dx < 0 && (
        <span className="absolute right-0 bottom-2 grid size-8 place-items-center rounded-full bg-black/25 text-white" style={{ opacity: Math.min(1, -dx / 56), transform: `scale(${-dx >= 56 ? 1.1 : 0.8})` }}>
          <Icon name="reply" className="size-4" />
        </span>
      )}
    </div>
  )
}

/** A bot's buttons and dropdowns under its message. A tap goes to the bot alone (end-to-end encrypted). */
function Keys({ m, chat }: { m: Msg; chat: Chat }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [open, setOpen] = useState<{ sel: fog.Sel; at: MenuAt; picked: string[] } | null>(null)
  const botId = m.from ?? chat.id
  const send = (key: string, d: string, v?: string[]) => {
    if (busy || m.mine) return
    setBusy(key)
    fog.tap(chat.id, m.id, botId, d, v ? { v } : {}).finally(() => setBusy(null))
  }
  const style = (s?: string) =>
    s === 'primary' ? 'bg-lamp text-lamp-ink' : s === 'danger' ? 'bg-danger/90 text-white' : s === 'success' ? 'bg-emerald-600 text-white' : m.mine ? 'bg-black/[0.08]' : 'bg-black/[0.06] dark:bg-white/10'
  return (
    <div className="flex flex-col gap-1 px-1.5 pb-1.5" onPointerDown={(e) => e.stopPropagation()} onContextMenu={(e) => e.stopPropagation()}>
      {m.kb!.map((row, r) =>
        Array.isArray(row) ? (
          <div key={r} className="flex gap-1">
            {row.map((b, i) => {
              const key = `${r}.${i}`
              return (
                <button
                  key={key}
                  disabled={!!busy && !b.u}
                  onClick={(e) => (e.stopPropagation(), b.u ? openLink(b.u) : send(key, b.d!))}
                  className={`flex min-h-9 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-[10px] px-2.5 py-1.5 text-[14px] leading-tight font-semibold transition hover:brightness-95 active:scale-[0.98] disabled:opacity-60 ${style(b.s)}`}
                >
                  {busy === key ? <Spinner className="size-4" /> : <span className="truncate">{b.l}</span>}
                  {b.u && <Icon name="link" className="size-3.5 shrink-0 opacity-70" />}
                </button>
              )
            })}
          </div>
        ) : (
          <button
            key={r}
            disabled={!!busy}
            onClick={(e) => {
              e.stopPropagation()
              const rect = e.currentTarget.getBoundingClientRect()
              setOpen({ sel: row, at: { x: rect.left, y: rect.bottom + 4 }, picked: row.o.filter((o) => o.on).map((o) => o.v) })
            }}
            className={`flex min-h-9 items-center justify-between gap-2 rounded-[10px] px-3 py-1.5 text-left text-[14px] transition hover:brightness-95 ${style()}`}
          >
            <span className="truncate opacity-80">{busy === `s${r}` ? <Spinner className="size-4" /> : (row.o.filter((o) => o.on).map((o) => o.l).join(', ') || row.ph || 'Choose…')}</span>
            <Icon name="down" className="size-4 shrink-0 opacity-70" />
          </button>
        ),
      )}
      {open && (
        <Menu at={open.at} onClose={() => setOpen(null)}>
          {open.sel.o.map((o) => {
            const multi = (open.sel.max ?? 1) > 1
            const on = open.picked.includes(o.v)
            return (
              <MenuItem
                key={o.v}
                icon={multi ? (on ? 'check' : 'plus') : on ? 'check' : 'next'}
                label={o.d ? `${o.l} · ${o.d}` : o.l}
                onClick={() => {
                  if (!multi) return (setOpen(null), send(`s${m.kb!.indexOf(open.sel)}`, open.sel.sel, [o.v]))
                  setOpen({ ...open, picked: on ? open.picked.filter((x) => x !== o.v) : [...open.picked, o.v].slice(0, open.sel.max) })
                }}
              />
            )
          })}
          {(open.sel.max ?? 1) > 1 && (
            <MenuItem
              icon="send"
              label={`Done (${open.picked.length})`}
              onClick={() => {
                if (open.picked.length < (open.sel.min ?? 1)) return fog.toast(`Choose at least ${open.sel.min ?? 1}`)
                setOpen(null)
                send(`s${m.kb!.indexOf(open.sel)}`, open.sel.sel, open.picked)
              }}
            />
          )}
        </Menu>
      )}
    </div>
  )
}

function LinkCard({ l, mine }: { l: LinkPreview; mine: boolean }) {
  return (
    <a
      href={l.url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      className={`mx-1.5 mt-1.5 flex min-w-[min(300px,68vw)] overflow-hidden rounded-[10px] transition hover:brightness-95 ${mine ? 'bg-black/[0.08]' : 'bg-lamp/10'}`}
    >
      <span className={`w-[3px] shrink-0 ${mine ? 'bg-out-accent' : 'bg-lamp'}`} />
      <span className="min-w-0 flex-1 p-2">
        {l.site && <span className={`block truncate text-[13px] font-semibold ${mine ? 'text-out-accent' : 'text-lamp'}`}>{l.site}</span>}
        {l.title && <span className="line-clamp-2 block text-sm leading-snug font-semibold">{l.title}</span>}
        {l.desc && <span className="mt-0.5 line-clamp-3 block text-[13px] leading-snug opacity-80">{l.desc}</span>}
        {l.img && <img src={l.img} alt="" className="mt-1.5 max-h-52 w-full rounded-md object-cover" />}
      </span>
    </a>
  )
}

export function Sticker({ a, size = 180 }: { a: Att; size?: number }) {
  const url = useLocalUrl(a.lid)
  const t = useTransfer(a.lid)
  useEffect(() => {
    if (!url && !t) download(a)
  }, [a.lid])
  const ratio = (a.w ?? 1) / (a.h ?? 1)
  return (
    <div className="grid place-items-center" style={{ width: ratio >= 1 ? size : size * ratio, height: ratio >= 1 ? size / ratio : size }}>
      {url ? <img src={url} alt="Sticker" className="pop size-full rounded-2xl object-contain drop-shadow-sm" draggable={false} /> : <span className="size-1/2 animate-pulse rounded-full bg-black/10" />}
    </div>
  )
}

/** Video message: plays muted inline like WhatsApp; tap for sound with a progress bar. */
function VideoNote({ a, meta, rounded }: { a: Att; meta?: ReactNode; rounded: string }) {
  const url = useLocalUrl(a.lid)
  const t = useTransfer(a.lid)
  const v = useRef<HTMLVideoElement>(null)
  const [playing, setPlaying] = useState(false)
  const [p, setP] = useState(0)
  useEffect(() => {
    if (!url && !t) download(a)
  }, [a.lid])
  const reset = (el: HTMLVideoElement) => {
    el.muted = true
    el.loop = true
    setPlaying(false)
    setP(0)
  }
  const toggle = (e: React.MouseEvent) => {
    e.stopPropagation()
    const el = v.current
    if (!el) return
    if (playing) return reset(el)
    el.currentTime = 0
    el.muted = false
    el.loop = false
    el.play()
    setPlaying(true)
  }
  return (
    <button onClick={toggle} aria-label={playing ? 'Mute video message' : 'Play video message with sound'} className={`relative block aspect-square w-64 max-w-full overflow-hidden bg-black/20 ${rounded}`}>
      {a.thumb && <img src={a.thumb} alt="" className="absolute inset-0 size-full object-cover" />}
      {url && (
        <video
          ref={v}
          src={url}
          muted
          autoPlay
          loop
          playsInline
          className="absolute inset-0 size-full object-cover"
          onTimeUpdate={(e) => playing && setP(e.currentTarget.currentTime / (e.currentTarget.duration || a.dur || 1))}
          onEnded={(e) => {
            reset(e.currentTarget)
            e.currentTarget.play()
          }}
        />
      )}
      {t && !t.err && (
        <span className="absolute inset-0 grid place-items-center">
          <span className="grid size-14 place-items-center rounded-full bg-black/45 text-white backdrop-blur-sm">
            <Ring p={t.p} />
          </span>
        </span>
      )}
      <span className="absolute top-2 left-2 flex items-center gap-1 rounded-full bg-black/45 py-0.5 pr-2 pl-1.5 text-xs font-medium text-white tabular-nums backdrop-blur-sm">
        <Icon name={playing ? 'volume' : 'muted'} className="size-3.5" />
        {fmtDur(playing ? p * (a.dur ?? 0) : a.dur)}
      </span>
      {playing && (
        <span className="absolute inset-x-0 bottom-0 h-1 bg-white/25">
          <span className="block h-full bg-lamp transition-[width] duration-200" style={{ width: `${p * 100}%` }} />
        </span>
      )}
      {meta && !playing && <span className="absolute right-2 bottom-2 rounded-full bg-black/45 px-2 py-0.5 backdrop-blur-sm [&_*]:!text-white">{meta}</span>}
    </button>
  )
}

function PollView({ m, chat, meta }: { m: Msg; chat: Chat; meta: ReactNode }) {
  const poll = m.poll!
  const votes = m.votes ?? {}
  const mine = votes.me ?? []
  const [pick, setPick] = useState<number[]>([])
  const voters = Object.keys(votes).length
  const counts = poll.o.map((_, i) => Object.values(votes).filter((v) => v.includes(i)).length)
  const voted = mine.length > 0
  const left = !!chat.group?.left
  const choose = (i: number) => {
    if (left) return
    if (voted) return
    if (!poll.multi) return fog.vote(chat.id, m.id, [i])
    setPick((p) => (p.includes(i) ? p.filter((x) => x !== i) : [...p, i]))
  }
  return (
    <div className="w-[min(340px,72vw)] px-3 pt-2.5 pb-1.5">
      <p className="text-[15.5px] leading-snug font-semibold">{poll.q}</p>
      <p className={`mt-0.5 text-xs ${m.mine ? 'text-out-meta' : 'text-muted'}`}>{poll.multi ? 'Poll · choose one or more' : 'Poll'}</p>
      <div className="mt-2 space-y-1.5">
        {poll.o.map((o, i) => {
          const pct = voters ? Math.round((counts[i] / voters) * 100) : 0
          const chosen = mine.includes(i) || pick.includes(i)
          return (
            <button key={i} onClick={(e) => (e.stopPropagation(), choose(i))} disabled={voted || left} className="relative block w-full overflow-hidden rounded-xl text-left disabled:cursor-default">
              {voted && <span className={`absolute inset-y-0 left-0 rounded-xl transition-[width] duration-500 ${m.mine ? 'bg-out-ink/15' : 'bg-lamp/25'}`} style={{ width: `${pct}%` }} />}
              <span className={`relative flex items-center gap-2.5 rounded-xl px-2.5 py-2 ${voted ? '' : m.mine ? 'bg-black/[0.06] hover:bg-black/10' : 'bg-black/[0.04] hover:bg-black/[0.08] dark:bg-white/[0.06]'}`}>
                {!voted && (
                  <span className={`grid size-5 shrink-0 place-items-center border-2 ${poll.multi ? 'rounded-md' : 'rounded-full'} ${chosen ? 'border-lamp bg-lamp text-lamp-ink' : 'border-current/40'}`}>
                    {chosen && <Icon name="check" className="size-3.5" />}
                  </span>
                )}
                <span className="min-w-0 flex-1 text-[15px]">{o}</span>
                {voted && (
                  <span className="flex shrink-0 items-center gap-1 text-sm font-semibold tabular-nums">
                    {mine.includes(i) && <Icon name="check" className="size-4" />}
                    {pct}%
                  </span>
                )}
              </span>
            </button>
          )
        })}
      </div>
      <div className="mt-2 flex items-center gap-2">
        {poll.multi && !voted && pick.length > 0 ? (
          <button onClick={(e) => (e.stopPropagation(), fog.vote(chat.id, m.id, pick), setPick([]))} className="rounded-full bg-lamp px-3 py-1 text-sm font-semibold text-lamp-ink">
            Vote
          </button>
        ) : (
          <span className={`text-xs ${m.mine ? 'text-out-meta' : 'text-muted'}`}>{voters ? `${voters} vote${voters === 1 ? '' : 's'}` : 'No votes yet'}</span>
        )}
        {voted && !left && (
          <button onClick={(e) => (e.stopPropagation(), fog.vote(chat.id, m.id, []))} className={`text-xs underline ${m.mine ? 'text-out-meta' : 'text-muted'}`}>
            Retract vote
          </button>
        )}
        {!m.text && <span className="ml-auto">{meta}</span>}
      </div>
    </div>
  )
}

export function Quote({ m, chat, mine }: { m?: Msg; chat: Chat; mine: boolean }) {
  const who = m ? (m.mine ? 'You' : chat.group ? personName(m.from ?? '') : chatTitle(chat)) : 'Message'
  return (
    <button
      onClick={(e) => (e.stopPropagation(), m && fog.jumpTo(m.id))}
      className={`mx-1.5 mt-1.5 flex max-w-full min-w-40 overflow-hidden rounded-[10px] text-left text-sm ${mine ? 'bg-black/[0.08]' : 'bg-lamp/12'} transition hover:brightness-95`}
    >
      <span className={`w-[3px] shrink-0 ${mine ? 'bg-out-accent' : 'bg-lamp'}`} />
      {m?.att?.thumb && <img src={m.att.thumb} alt="" className="my-1 ml-1.5 size-9 rounded object-cover" />}
      <span className="min-w-0 px-2 py-1">
        <span className={`block truncate font-semibold ${mine ? 'text-out-accent' : 'text-lamp'}`}>{who}</span>
        <span className="block truncate opacity-80">{m ? snippet(m) : 'Deleted message'}</span>
      </span>
    </button>
  )
}

// ---------- viewers ----------
/** Full-screen photo/video viewer with prev/next through the chat's media. */
export function MediaViewer({ chat, start, onClose }: { chat: Chat; start: string; onClose: () => void }) {
  const items = chat.messages.filter((m) => m.att && (m.att.kind === 'photo' || m.att.kind === 'video'))
  const [i, setI] = useState(() => Math.max(0, items.findIndex((m) => m.id === start)))
  const m = items[i]
  const a = m?.att
  const [url, setUrl] = useState<string | null>(null)
  // The bars over the media: tap to hide them and see it on its own.
  const [chrome, setChrome] = useState(true)
  // Moving the mouse brings the bars back (and keeps a playing video's controls up while it moves).
  const [poke, setPoke] = useState(0)
  const lastPoke = useRef(0)
  const nudge = (e: React.PointerEvent) => {
    if (e.pointerType !== 'mouse' || Date.now() - lastPoke.current < 500) return
    lastPoke.current = Date.now()
    setChrome(true)
    setPoke((n) => n + 1)
  }
  const t = useTransfer(a?.lid ?? '')
  useEffect(() => {
    setUrl(null)
    if (a) download(a).then(setUrl)
  }, [a?.lid])
  const go = (d: number) => setI((x) => Math.max(0, Math.min(items.length - 1, x + d)))
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') (e.stopPropagation(), onClose())
      if (e.key === 'ArrowLeft') go(-1)
      if (e.key === 'ArrowRight') go(1)
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [onClose, items.length])
  if (!m || !a) return null
  const fade = `transition-opacity duration-200 ${chrome ? 'opacity-100' : 'pointer-events-none opacity-0'}`
  const nav = (d: number, label: string, icon: string, side: string) =>
    items[i + d] && (
      <button onClick={() => go(d)} aria-label={label} className={`absolute top-1/2 ${side} z-10 grid size-12 -translate-y-1/2 place-items-center rounded-full bg-black/40 text-white backdrop-blur-sm hover:bg-black/60 max-sm:hidden ${fade}`}>
        <Icon name={icon} />
      </button>
    )
  return (
    <div className="fade-in fixed inset-0 z-50 overflow-hidden bg-black text-white" role="dialog" aria-label="Media viewer" onPointerMove={nudge}>
      <Zoomable className="absolute inset-0" reset={a.lid} onTap={() => setChrome((c) => !c)} onSwipe={(dir) => (dir === 'down' ? onClose() : go(dir === 'left' ? 1 : -1))}>
        {!url ? (
          <div className="grid size-full place-items-center">
            {a.thumb && <img src={a.thumb} alt="" className="absolute inset-0 size-full object-contain opacity-60 blur-md" />}
            <span className="relative">{t && !t.err ? <Ring p={t.p} className="size-16" /> : t?.err ? 'Download failed' : null}</span>
          </div>
        ) : a.kind === 'video' ? (
          <VideoPlayer key={url} src={url} chrome={chrome} setChrome={setChrome} caption={m.text} poke={poke} onFrame={(v) => fixThumb(v, chat.id, m.id, a.thumb)} />
        ) : (
          <img key={url} src={url} alt="Photo" draggable={false} className="pop size-full object-contain" />
        )}
      </Zoomable>
      {nav(-1, 'Previous', 'back', 'left-4')}
      {nav(1, 'Next', 'next', 'right-4')}
      <header className={`absolute inset-x-0 top-0 z-10 flex items-center gap-3 bg-gradient-to-b from-black/70 to-transparent p-3 pt-[max(0.75rem,env(safe-area-inset-top))] pb-8 ${fade}`}>
        <div className="min-w-0 flex-1 px-2">
          <p className="truncate font-semibold">{m.mine ? 'You' : chat.group ? personName(m.from ?? '') : chatTitle(chat)}</p>
          <p className="text-sm text-white/70">
            {fullDate(m.ts)}
            {items.length > 1 && ` · ${i + 1} of ${items.length}`}
          </p>
        </div>
        <button onClick={() => saveFile(a)} aria-label="Save" className="grid size-10 place-items-center rounded-full hover:bg-white/10">
          <Icon name="download" />
        </button>
        <button onClick={onClose} aria-label="Close" className="grid size-10 place-items-center rounded-full hover:bg-white/10">
          <Icon name="close" />
        </button>
      </header>
      {m.text && a.kind !== 'video' && (
        <p className={`absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-black/70 to-transparent px-6 pt-10 pb-[max(1.5rem,env(safe-area-inset-bottom))] text-center text-white/90 ${fade}`}>
          <Rich text={m.text} />
        </p>
      )}
    </div>
  )
}

/**
 * Video in the viewer, with Fog's own controls (the browser's are small, differ by platform, and
 * on phones only appear in fullscreen): play/pause, a scrubber, time, sound, speed and fullscreen.
 * While it plays, the controls fade out after a moment; a tap brings them back.
 */
/** Once a video plays, replace a missing or black thumbnail with a real frame (once per video). */
const fixing = new Set<string>()
async function fixThumb(v: HTMLVideoElement, chat: string, id: string, thumb?: string) {
  if (fixing.has(id)) return
  fixing.add(id)
  if (!(await thumbIsBlank(thumb))) return
  const still = await posterNow(v)
  if (still) fog.setVideoThumb(chat, id, still)
  else fixing.delete(id) // try again on a later frame
}

function VideoPlayer({ src, chrome, setChrome, caption, poke, onFrame }: { src: string; chrome: boolean; setChrome: (v: boolean) => void; caption?: string; poke: number; onFrame?: (v: HTMLVideoElement) => void }) {
  const v = useRef<HTMLVideoElement>(null)
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [len, setLen] = useState(0)
  const [muted, setMuted] = useState(false)
  const [rate, setRate] = useState(1)
  const [waiting, setWaiting] = useState(false)
  const [seeking, setSeeking] = useState(false)
  const toggle = () => {
    const el = v.current
    if (!el) return
    if (el.paused || el.ended) void el.play().catch(() => {})
    else el.pause()
  }
  useEffect(() => {
    if (!playing || !chrome || seeking) return
    const t = setTimeout(() => setChrome(false), 2500)
    return () => clearTimeout(t)
  }, [playing, chrome, seeking, time > 0, poke])
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === ' ' || e.key === 'k') (e.preventDefault(), toggle())
      if (e.key === 'm') setMuted((x) => !x)
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [])
  useEffect(() => {
    if (v.current) (v.current.muted = muted), (v.current.playbackRate = rate)
  }, [muted, rate])
  // Taps on the controls are theirs, not the viewer's (which would hide the controls).
  const own = { onPointerDown: (e: React.PointerEvent) => e.stopPropagation(), onPointerUp: (e: React.PointerEvent) => e.stopPropagation() }
  return (
    <div className="relative size-full">
      <video
        ref={v}
        src={src}
        autoPlay
        playsInline
        className="pop size-full object-contain"
        onPlay={() => setPlaying(true)}
        onPause={() => (setPlaying(false), setChrome(true))}
        onTimeUpdate={(e) => (!seeking && setTime(e.currentTarget.currentTime), e.currentTarget.currentTime > 0.4 && onFrame?.(e.currentTarget))}
        onLoadedMetadata={(e) => setLen(e.currentTarget.duration || 0)}
        onDurationChange={(e) => setLen(e.currentTarget.duration || 0)}
        onWaiting={() => setWaiting(true)}
        onPlaying={() => setWaiting(false)}
        onEnded={() => setChrome(true)}
      />
      {waiting && playing && (
        <span className="pointer-events-none absolute inset-0 grid place-items-center">
          <span className="size-12 animate-spin rounded-full border-4 border-white/25 border-t-white" />
        </span>
      )}
      {!playing && !waiting && (
        <button {...own} onClick={toggle} aria-label="Play" className={`absolute top-1/2 left-1/2 grid size-20 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-black/45 backdrop-blur-md transition hover:bg-black/60 active:scale-95 ${chrome ? '' : 'opacity-0'}`}>
          <Icon name="play" className="size-9 translate-x-0.5 fill-current" />
        </button>
      )}
      <div {...own} className={`absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-black/75 to-transparent px-3 pt-12 pb-[max(0.75rem,env(safe-area-inset-bottom))] transition-opacity duration-200 sm:px-6 ${chrome ? 'opacity-100' : 'pointer-events-none opacity-0'}`}>
        {caption && (
          <p className="mx-auto mb-2 max-w-2xl text-center text-white/90">
            <Rich text={caption} />
          </p>
        )}
        <input
          type="range"
          min={0}
          max={len || 0}
          step={0.01}
          value={Math.min(time, len || 0)}
          aria-label="Position"
          onPointerDown={() => setSeeking(true)}
          onPointerUp={() => setSeeking(false)}
          onChange={(e) => {
            const x = Number(e.target.value)
            setTime(x)
            if (v.current) v.current.currentTime = x
          }}
          className="h-6 w-full cursor-pointer accent-[var(--lamp)]"
        />
        <div className="flex items-center gap-1">
          <button onClick={toggle} aria-label={playing ? 'Pause' : 'Play'} className="grid size-11 place-items-center rounded-full hover:bg-white/10">
            <Icon name={playing ? 'pause' : 'play'} className={`size-6 ${playing ? '' : 'fill-current'}`} />
          </button>
          <span className="px-1 text-sm text-white/85 tabular-nums">
            {fmtDur(time)} / {fmtDur(len)}
          </span>
          <span className="flex-1" />
          <button onClick={() => setRate((r) => (r === 1 ? 1.5 : r === 1.5 ? 2 : 1))} aria-label="Playback speed" className="h-11 min-w-11 rounded-full px-2 text-sm font-semibold hover:bg-white/10">
            {rate}×
          </button>
          <button onClick={() => setMuted((x) => !x)} aria-label={muted ? 'Unmute' : 'Mute'} className="grid size-11 place-items-center rounded-full hover:bg-white/10">
            <Icon name={muted ? 'muted' : 'volume'} />
          </button>
          {document.fullscreenEnabled && (
            <button onClick={() => (document.fullscreenElement ? document.exitFullscreen() : v.current?.closest('[role=dialog]')?.requestFullscreen())} aria-label="Fullscreen" className="grid size-11 place-items-center rounded-full hover:bg-white/10">
              <Icon name="expand" />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

/** Plain-text preview for text and code files. Always rendered as text, never as markup. */
export function TextViewer({ a, onClose }: { a: Att; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null)
  const t = useTransfer(a.lid)
  useEffect(() => {
    download(a).then(async (u) => {
      const blob = u && (await localBlob(a.lid))
      setText(blob ? await blob.text() : '')
    })
  }, [a.lid])
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && (e.stopPropagation(), onClose())
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [onClose])
  const lines = text?.split('\n') ?? []
  return (
    <div className="fade-in fixed inset-0 z-50 grid place-items-center bg-scrim p-0 sm:p-6" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-label={a.name} className="pop flex h-full w-full max-w-4xl flex-col overflow-hidden bg-panel shadow-2xl sm:h-[85vh] sm:rounded-3xl">
        <header className="flex h-16 shrink-0 items-center gap-3 border-b border-line px-4">
          <span className={`grid size-9 place-items-center rounded-lg text-[10px] font-bold text-white uppercase ${fileStyle(a)}`}>{ext(a.name).slice(0, 4)}</span>
          <div className="min-w-0 flex-1">
            <p className="truncate font-semibold">{a.name}</p>
            <p className="text-xs text-muted">
              {fmtSize(a.size)}
              {text !== null && ` · ${lines.length} lines`}
            </p>
          </div>
          <button onClick={() => text !== null && copy(text, 'File contents copied')} aria-label="Copy contents" title="Copy" className="grid size-10 place-items-center rounded-full text-muted hover:bg-hover hover:text-ink">
            <Icon name="copy" />
          </button>
          <button onClick={() => saveFile(a)} aria-label="Save file" title="Save" className="grid size-10 place-items-center rounded-full text-muted hover:bg-hover hover:text-ink">
            <Icon name="download" />
          </button>
          <button onClick={onClose} aria-label="Close" className="grid size-10 place-items-center rounded-full text-muted hover:bg-hover hover:text-ink">
            <Icon name="close" />
          </button>
        </header>
        <div className="scroll-thin min-h-0 flex-1 overflow-auto bg-raised/60">
          {text === null ? (
            <div className="grid h-full place-items-center text-muted">{t ? <Ring p={t.p} /> : 'Loading…'}</div>
          ) : (
            <pre className="min-w-max py-3 font-mono text-[13px] leading-[1.6]">
              {lines.map((l, i) => (
                <div key={i} className="flex hover:bg-hover">
                  <span className="sticky left-0 w-12 shrink-0 bg-raised pr-3 text-right text-muted/70 select-none">{i + 1}</span>
                  <span className="pr-6 pl-3 whitespace-pre">{l || ' '}</span>
                </div>
              ))}
            </pre>
          )}
        </div>
      </div>
    </div>
  )
}
