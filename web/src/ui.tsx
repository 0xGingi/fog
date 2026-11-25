// Shared UI primitives: icons, avatar, buttons, menus, dialogs, drawers, toasts.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { toast, useFog } from './fog'

const paths: Record<string, string> = {
  menu: 'M4 7h16M4 12h16M4 17h16',
  back: 'M15 5l-7 7 7 7',
  pencil: 'M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4',
  send: 'M5 12l14-7-5 15-2.5-6.5L5 12z',
  search: 'M11 18a7 7 0 100-14 7 7 0 000 14zM20 20l-4-4',
  lock: 'M7 11V8a5 5 0 0110 0v3M6 11h12v9H6z',
  info: 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 11v6M12 7.5v.5',
  copy: 'M9 9h10v10H9zM5 15V5h10',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  close: 'M6 6l12 12M18 6L6 18',
  eye: 'M2.5 12S6 5 12 5s9.5 7 9.5 7-3.5 7-9.5 7-9.5-7-9.5-7zM12 15a3 3 0 100-6 3 3 0 000 6z',
  key: 'M7.5 15.5a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM11 12h10M18 12v3M15 12v2',
  bell: 'M6 16V11a6 6 0 0112 0v5l1.5 2h-15L6 16zM10 20.5a2 2 0 004 0',
  out: 'M14 5h5v14h-5M10 8l-4 4 4 4M6 12h10',
  reply: 'M10 7L5 12l5 5M5 12h9a5 5 0 015 5v1',
  trash: 'M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12M10 11v5M14 11v5',
  pin: 'M9 4h6l-1 6 4 3H6l4-3-1-6zM12 13v7',
  unpin: 'M9 4h6l-1 6 4 3H6l4-3-1-6zM12 13v7M4 4l16 16',
  smile: 'M12 21a9 9 0 100-18 9 9 0 000 18zM8.5 14.5s1.2 2 3.5 2 3.5-2 3.5-2M9 10h.01M15 10h.01',
  clip: 'M20 11.5l-7.8 7.8a5 5 0 01-7.1-7.1l8.5-8.5a3.3 3.3 0 014.7 4.7l-8.5 8.5a1.7 1.7 0 01-2.4-2.4l7.8-7.8',
  down: 'M6 9l6 6 6-6',
  download: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  unread: 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 12h.01',
  sun: 'M12 16a4 4 0 100-8 4 4 0 000 8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  text: 'M5 7V5h14v2M12 5v14M9 19h6',
  camera: 'M4 8h3l2-3h6l2 3h3v11H4zM12 16.5a3.5 3.5 0 100-7 3.5 3.5 0 000 7z',
  user: 'M12 12a4 4 0 100-8 4 4 0 000 8zM4 21a8 8 0 0116 0',
  at: 'M16 12a4 4 0 11-8 0 4 4 0 018 0zM16 12v1.5a2.5 2.5 0 005 0V12a9 9 0 10-3.5 7.1',
  image: 'M4 5h16v14H4zM4 16l5-5 4 4 2-2 5 5M15 9.5h.01',
  next: 'M9 5l7 7-7 7',
  up: 'M6 15l6-6 6 6',
  laptop: 'M5 5h14a1 1 0 011 1v9H4V6a1 1 0 011-1zM2 18h20',
  shield: 'M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6zM9 12l2 2 4-4',
  block: 'M12 21a9 9 0 100-18 9 9 0 000 18zM5.6 5.6l12.8 12.8',
  flag: 'M5 21V4h11l-1.5 4L16 12H5',
  inbox: 'M3 13h5l1.5 3h5l1.5-3h5M5 5h14l2 8v6H3v-6z',
  lockOn: 'M7 11V8a5 5 0 0110 0v3M5 11h14v10H5zM12 15v2',
  screen: 'M3 5h18v11H3zM8 20h8M12 16v4',
  muted: 'M4 10v4h3l4 4V6L7 10zM15.5 9.5l5 5M20.5 9.5l-5 5',
  sticker: 'M14 3H7a4 4 0 00-4 4v10a4 4 0 004 4h6l8-8V7a4 4 0 00-4-4h-3zM13 21v-4a4 4 0 014-4h4',
  videonote: 'M12 21a9 9 0 100-18 9 9 0 000 18zM10 9v6l5-3z',
  phone: 'M6.6 10.8a15 15 0 006.6 6.6l2.2-2.2a1 1 0 011-.3 11 11 0 003.6.6 1 1 0 011 1V20a1 1 0 01-1 1A17 17 0 013 4a1 1 0 011-1h3.5a1 1 0 011 1 11 11 0 00.6 3.6 1 1 0 01-.3 1z',
  video: 'M3 7h12v10H3zM15 10.5l6-3.5v10l-6-3.5',
  poll: 'M5 20V10M12 20V4M19 20v-7',
  qr: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 14h2v2h-2zM14 18h2v2h-2zM18 18h2v2h-2zM6.5 6.5h1v1h-1zM16.5 6.5h1v1h-1zM6.5 16.5h1v1h-1z',
  link: 'M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1',
  bookmark: 'M7 4h10v16l-5-4-5 4z',
  bellOff: 'M6 16V11a6 6 0 019.5-4.9M18 11v5l1.5 2H8M10 20.5a2 2 0 004 0M4 4l16 16',
  archive: 'M4 5h16v4H4zM5 9v10h14V9M10 13h4',
  timer: 'M12 21a8 8 0 100-16 8 8 0 000 16zM12 9v4l2.5 2M10 3h4',
  mic: 'M12 15a3 3 0 003-3V6a3 3 0 00-6 0v6a3 3 0 003 3zM6 11a6 6 0 0012 0M12 17v4',
  forward: 'M14 7l5 5-5 5M19 12h-9a5 5 0 00-5 5v1',
  select: 'M12 21a9 9 0 100-18 9 9 0 000 18zM8 12.5l2.5 2.5L16 9.5',
  users: 'M9 11a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM2.5 20a6.5 6.5 0 0113 0M16 4.5a3.5 3.5 0 010 6.5M18 14a6 6 0 013.5 6',
  plus: 'M12 5v14M5 12h14',
  file: 'M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8zM14 3v5h5',
  volume: 'M5 10v4h3l4 4V6L8 10zM16 9a4 4 0 010 6M18.5 6.5a8 8 0 010 11',
}
export function Icon({ name, className = 'size-6' }: { name: string; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d={paths[name]} />
    </svg>
  )
}

const tones = [
  ['#7c93b5', '#4f6a92'],
  ['#8fa892', '#5c7a62'],
  ['#c09a6c', '#8a6d4d'],
  ['#a58bb5', '#755d8a'],
  ['#7fa7aa', '#4d7d82'],
  ['#c08484', '#8a5a5a'],
  ['#9a9fb0', '#686e82'],
]
export function Avatar({ id, name, src, size = 48 }: { id: string; name?: string | null; src?: string; size?: number }) {
  let h = 0
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0
  const [a, b] = tones[h % tones.length]
  const initials = (name ?? '?')
    .replace(/^@/, '')
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => [...w][0] ?? '')
    .join('')
    .toUpperCase()
  if (src) return <img src={src} alt="" width={size} height={size} className="shrink-0 rounded-full object-cover" style={{ width: size, height: size }} />
  if (id === 'saved')
    return (
      <div className="grid shrink-0 place-items-center rounded-full bg-gradient-to-br from-[#f3bd52] to-[#d98d14] text-[#2a1d04]" style={{ width: size, height: size }} aria-hidden>
        <Icon name="bookmark" className="w-[45%]" />
      </div>
    )
  return (
    <div
      className="grid shrink-0 place-items-center rounded-full font-semibold text-white select-none"
      style={{ width: size, height: size, fontSize: size * (initials.length > 1 ? 0.36 : 0.42), background: `linear-gradient(160deg, ${a}, ${b})` }}
      aria-hidden
    >
      {initials || '?'}
    </div>
  )
}

export function Button({ children, kind = 'primary', className = '', ...p }: React.ButtonHTMLAttributes<HTMLButtonElement> & { kind?: 'primary' | 'ghost' | 'danger' | 'soft' }) {
  const k = {
    primary: 'bg-lamp text-lamp-ink hover:brightness-105 active:brightness-95',
    ghost: 'text-ink hover:bg-hover',
    soft: 'bg-raised text-ink hover:bg-hover',
    danger: 'text-danger hover:bg-danger/10',
  }[kind]
  return (
    <button {...p} className={`h-12 rounded-xl px-5 font-semibold transition disabled:pointer-events-none disabled:opacity-40 ${k} ${className}`}>
      {children}
    </button>
  )
}

export function IconButton({ icon, label, onClick, className = '' }: { icon: string; label: string; onClick?: (e: React.MouseEvent) => void; className?: string }) {
  return (
    <button onClick={onClick} aria-label={label} title={label} className={`grid size-10 shrink-0 place-items-center rounded-full text-muted transition hover:bg-hover hover:text-ink ${className}`}>
      <Icon name={icon} />
    </button>
  )
}

export function Spinner({ className = 'size-4' }: { className?: string }) {
  return <span className={`inline-block animate-spin rounded-full border-2 border-current border-r-transparent ${className}`} aria-hidden />
}

export function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)} className={`relative h-6 w-10 shrink-0 rounded-full transition-colors ${on ? 'bg-lamp' : 'bg-line'}`}>
      <span className={`absolute top-0.5 size-5 rounded-full bg-white shadow transition-all ${on ? 'left-[18px]' : 'left-0.5'}`} />
    </button>
  )
}

export const copy = (t: string, what = 'Copied') =>
  navigator.clipboard.writeText(t).then(
    () => toast(what),
    () => toast("Couldn't copy. Your browser blocked clipboard access."),
  )

// ---------- toasts ----------
export function Toaster() {
  const t = useFog((s) => s.toast)
  const [shown, setShown] = useState<typeof t>(null)
  useEffect(() => {
    if (!t) return
    setShown(t)
    const h = setTimeout(() => setShown(null), 2600)
    return () => clearTimeout(h)
  }, [t])
  if (!shown) return null
  return (
    <div role="status" className="pointer-events-none fixed inset-x-0 bottom-24 z-50 flex justify-center px-4">
      <span key={shown.at} className="rise rounded-full bg-[#1c242d]/95 px-4 py-2.5 text-sm font-medium text-white shadow-xl">
        {shown.text}
      </span>
    </div>
  )
}

// ---------- context menu ----------
export type MenuAt = { x: number; y: number }

/** A floating menu at the pointer, kept inside the viewport. Closes on outside press, Esc, scroll. */
/** `below`: keep clear of this rect (a long-pressed bubble), opening under it or else above it. */
export function Menu({ at, onClose, children, header, below }: { at: MenuAt; onClose: () => void; children: ReactNode; header?: ReactNode; below?: DOMRect }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: at.x, top: at.y, origin: 'top left' })
  useLayoutEffect(() => {
    const el = ref.current!
    const { width: w, height: h } = el.getBoundingClientRect()
    if (below) {
      const left = Math.min(Math.max(8, below.left), innerWidth - w - 8)
      const under = below.bottom + 10 + h < innerHeight - 8
      const top = under ? below.bottom + 10 : below.top - h - 10 > 8 ? below.top - h - 10 : Math.max(8, innerHeight - h - 8)
      setPos({ left, top, origin: `${under ? 'top' : 'bottom'} left` })
      el.querySelector<HTMLElement>('[role=menuitem]')?.focus({ preventScroll: true })
      return
    }
    const flipX = at.x + w > innerWidth - 8
    const flipY = at.y + h > innerHeight - 8
    setPos({
      left: Math.max(8, flipX ? at.x - w : at.x),
      top: Math.max(8, flipY ? at.y - h : at.y),
      origin: `${flipY ? 'bottom' : 'top'} ${flipX ? 'right' : 'left'}`,
    })
    el.querySelector<HTMLElement>('[role=menuitem]')?.focus({ preventScroll: true })
  }, [at.x, at.y])
  useEffect(() => {
    const down = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && onClose()
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') (e.stopPropagation(), onClose())
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const items = [...ref.current!.querySelectorAll<HTMLElement>('[role=menuitem]')]
        const i = items.indexOf(document.activeElement as HTMLElement)
        items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus()
      }
    }
    const t = setTimeout(() => document.addEventListener('pointerdown', down), 0)
    window.addEventListener('keydown', key, true)
    window.addEventListener('resize', onClose)
    document.addEventListener('scroll', onClose, true)
    return () => {
      clearTimeout(t)
      document.removeEventListener('pointerdown', down)
      window.removeEventListener('keydown', key, true)
      window.removeEventListener('resize', onClose)
      document.removeEventListener('scroll', onClose, true)
    }
  }, [onClose])
  return (
    <div
      ref={ref}
      role="menu"
      className="menu-in fixed z-50 min-w-52 rounded-2xl bg-panel/95 p-1.5 shadow-[0_12px_40px_-8px_rgba(0,0,0,0.35)] ring-1 ring-black/5 backdrop-blur-xl dark:ring-white/10"
      style={{ left: pos.left, top: pos.top, transformOrigin: pos.origin }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {header}
      {children}
    </div>
  )
}

export function MenuItem({ icon, label, onClick, danger }: { icon: string; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      className={`flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-[15px] outline-none hover:bg-hover focus-visible:bg-hover ${danger ? 'text-danger' : ''}`}
    >
      <Icon name={icon} className={`size-5 ${danger ? '' : 'text-muted'}`} />
      {label}
    </button>
  )
}

/** Long-press (touch) or right-click opens a menu at the pointer. */
export function usePressMenu(open: (at: MenuAt, touch: boolean) => void) {
  const timer = useRef(0)
  const start = useRef<MenuAt | null>(null)
  const cancel = () => (clearTimeout(timer.current), (start.current = null))
  return {
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault()
      open({ x: e.clientX, y: e.clientY }, false)
    },
    onPointerDown: (e: React.PointerEvent) => {
      if (e.pointerType !== 'touch') return
      start.current = { x: e.clientX, y: e.clientY }
      timer.current = window.setTimeout(() => {
        navigator.vibrate?.(10)
        open(start.current!, true)
        start.current = null
      }, 450)
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (start.current && Math.hypot(e.clientX - start.current.x, e.clientY - start.current.y) > 10) cancel()
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
  }
}

// ---------- focus management ----------
const FOCUSABLE = 'button:not([disabled]),[href],input:not([disabled]),textarea:not([disabled]),select,[tabindex]:not([tabindex="-1"])'

/** Move focus into a modal surface, keep Tab inside it, and give focus back on close. */
export function useFocusTrap(ref: React.RefObject<HTMLElement | null>, trap = true) {
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const prev = document.activeElement as HTMLElement | null
    requestAnimationFrame(() => !el.contains(document.activeElement) && el.querySelector<HTMLElement>(FOCUSABLE)?.focus({ preventScroll: true }))
    const key = (e: KeyboardEvent) => {
      if (!trap || e.key !== 'Tab') return
      const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.offsetParent !== null)
      if (!items.length) return
      const [first, last] = [items[0], items[items.length - 1]]
      if (e.shiftKey && document.activeElement === first) (e.preventDefault(), last.focus())
      else if (!e.shiftKey && document.activeElement === last) (e.preventDefault(), first.focus())
    }
    el.addEventListener('keydown', key)
    return () => {
      el.removeEventListener('keydown', key)
      if (prev?.isConnected) prev.focus({ preventScroll: true })
    }
  }, [])
}

// ---------- dialog ----------
export function Dialog({ title, children, onClose, actions }: { title: string; children?: ReactNode; onClose: () => void; actions: ReactNode }) {
  const box = useRef<HTMLDivElement>(null)
  useFocusTrap(box)
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && (e.stopPropagation(), onClose())
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [onClose])
  return (
    <div className="fade-in fixed inset-0 z-50 grid place-items-center bg-scrim p-4" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={box} role="dialog" aria-modal aria-label={title} className="pop w-full max-w-sm rounded-3xl bg-panel p-6 shadow-2xl">
        <h2 className="text-lg font-semibold">{title}</h2>
        {children && <div className="mt-2 text-[15px] text-muted">{children}</div>}
        <div className="mt-6 flex justify-end gap-2">{actions}</div>
      </div>
    </div>
  )
}

// ---------- drawer ----------
/** Side panel with enter and exit animations. `close()` from the render prop animates out first. */
export function Drawer({ title, onClose, children, side = 'left', actions }: { title: string; onClose: () => void; children: ReactNode | ((close: () => void) => ReactNode); side?: 'left' | 'right'; actions?: ReactNode }) {
  const [leaving, setLeaving] = useState(false)
  const box = useRef<HTMLElement>(null)
  useFocusTrap(box, false)
  const close = () => {
    if (leaving) return
    setLeaving(true)
    setTimeout(onClose, 190)
  }
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && !document.querySelector('[role=menu],[role=dialog]') && (e.stopPropagation(), close())
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  })
  const anim = side === 'left' ? (leaving ? 'slide-out' : 'slide-in') : leaving ? 'slide-out-right' : 'slide-in-right'
  return (
    <section
      ref={box}
      data-drawer
      className={`${anim} ${side === 'left' ? 'absolute inset-0' : 'fixed inset-0 md:static md:w-[360px] md:border-l md:border-line'} z-20 flex flex-col bg-panel`}
      aria-label={title}
    >
      <header className="flex h-16 shrink-0 items-center gap-2 px-3">
        <IconButton icon={side === 'left' ? 'back' : 'close'} label="Close" onClick={close} />
        <h2 className="flex-1 text-lg font-semibold">{title}</h2>
        {actions}
      </header>
      <div className="scroll-thin flex-1 overflow-y-auto px-3 pb-8">{typeof children === 'function' ? children(close) : children}</div>
    </section>
  )
}

export function Row({ icon, title, sub, onClick, right }: { icon: string; title: ReactNode; sub?: ReactNode; onClick?: () => void; right?: ReactNode }) {
  const Tag = onClick ? 'button' : 'div'
  return (
    <Tag onClick={onClick} className={`flex w-full items-center gap-4 rounded-xl px-3 py-3 text-left ${onClick ? 'transition hover:bg-hover' : ''}`}>
      <Icon name={icon} className="size-6 shrink-0 text-muted" />
      <div className="min-w-0 flex-1">
        <div className="truncate">{title}</div>
        {sub && <div className="text-sm text-muted">{sub}</div>}
      </div>
      {right}
    </Tag>
  )
}

export const Section = ({ title, children }: { title: string; children: ReactNode }) => (
  <section className="mt-6">
    <h3 className="mb-1 px-3 text-sm font-semibold text-lamp">{title}</h3>
    {children}
  </section>
)
