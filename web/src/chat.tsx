// The conversation view: header, message list, composer (text, emoji, files, voice), dialogs.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import * as fog from './fog'
import { chatAvatar, chatTitle, msgStatus, others, personName, SAVED, timerLabel, useFog, type Chat, type LinkPreview, type Msg, type Poll } from './fog'
import { MAX_GROUP_CALL, startCall, startGroupCall } from './call'
import { fmtDur, fmtSize, MAX_FILE, MAX_NOTE, previewThumb, record, recordVideoNote, type Att, type Recording, type VideoNoteRec } from './media'
import { Bubble, dayLabel, fullDate, MediaViewer, snippet, Sticker, sysText, Ticks, TextViewer } from './bubble'
import { Avatar, BotBadge, Button, copy, Dialog, Icon, IconButton, Menu, MenuItem, Spinner, type MenuAt } from './ui'

const REACTIONS = ['❤️', '👍', '😂', '😮', '😢', '🙏', '🔥']
const PAGE = 80

// ---------- chat pane ----------
export function ChatPane({ id, onInfo }: { id: string; onInfo: () => void }) {
  const chat = useFog((s) => s.chats[id])
  const person = useFog((s) => s.people[id])
  const people = useFog((s) => s.people)
  const conn = useFog((s) => s.conn)
  const jump = useFog((s) => s.jump)
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const mountedAt = useRef(Date.now())
  const [firstUnread] = useState(() => {
    const c = fog.getState().chats[id]
    return c?.unread ? c.messages[c.messages.length - c.unread]?.id ?? null : null
  })
  // Long chats render a window of recent messages; scrolling up loads older ones.
  const [limit, setLimit] = useState(() => Math.max(PAGE, (fog.getState().chats[id]?.unread ?? 0) + 20))
  const anchor = useRef<number | null>(null)
  const [atBottom, setAtBottom] = useState(true)
  const [missed, setMissed] = useState(0)
  const [reply, setReply] = useState<Msg | null>(null)
  const [editing, setEditing] = useState<Msg | null>(null)
  const [menu, setMenu] = useState<{ at: MenuAt; m: Msg; touch: boolean; rect?: DOMRect } | null>(null)
  const [deleting, setDeleting] = useState<Msg[] | null>(null)
  const [forwarding, setForwarding] = useState<string[] | null>(null)
  const [selected, setSelected] = useState<Set<string> | null>(null)
  const [viewing, setViewing] = useState<string | null>(null)
  const [textFile, setTextFile] = useState<Msg | null>(null)
  const [files, setFiles] = useState<File[] | null>(null)
  const [flash, setFlash] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [search, setSearch] = useState<{ q: string; i: number } | null>(null)
  const [info, setInfo] = useState<Msg | null>(null)
  const [pinIdx, setPinIdx] = useState(0)
  const typing = chat?.typing && chat.typing.until > Date.now() ? chat.typing : null
  // Threads: the open one replaces the main conversation; its messages never show in the main one.
  const thread = useFog((s) => s.thread)
  const th = thread ? chat?.threads?.[thread] : undefined
  const msgs = useMemo(() => (chat ? chat.messages.filter((m) => (thread ? m.th === thread : !m.th)) : []), [chat?.messages, thread])
  const threadStats = useMemo(() => {
    const st = new Map<string, { n: number; last: number }>()
    for (const m of chat?.messages ?? []) if (m.th) st.set(m.th, { n: (st.get(m.th)?.n ?? 0) + 1, last: m.ts })
    return st
  }, [chat?.messages])
  const [naming, setNaming] = useState<{ root?: Msg; rename?: string } | null>(null)
  const [threadList, setThreadList] = useState<MenuAt | null>(null)
  const me = fog.getState().me?.id
  const canRename = !!th && (th.by === me || chat?.group?.owner === me)
  // Mesh calls get heavy past a handful of people: everyone sends to everyone.
  const groupCall = (video: boolean) =>
    (chat?.group?.members.length ?? 0) > MAX_GROUP_CALL ? fog.toast(`Group calls are for up to ${MAX_GROUP_CALL} people`) : startGroupCall(id, video)
  const count = msgs.length
  const prevCount = useRef(count)

  useLayoutEffect(() => {
    const el = scroller.current!
    const divider = el.querySelector('[data-unread]')
    if (divider) {
      divider.scrollIntoView({ block: 'center' })
      stick.current = false
      setAtBottom(false)
    } else el.scrollTop = el.scrollHeight
  }, [])
  useLayoutEffect(() => {
    const el = scroller.current
    const added = count - prevCount.current
    prevCount.current = count
    if (!el) return
    if (stick.current) el.scrollTop = el.scrollHeight
    else if (added > 0 && !chat?.messages.at(-1)?.mine) setMissed((n) => n + added)
  }, [count, typing?.until])
  // The list gets shorter when the keyboard opens: stay on the newest messages if that's where we were.
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const ro = new ResizeObserver(() => stick.current && (el.scrollTop = el.scrollHeight))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  // Keep the view steady when older messages are prepended.
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && anchor.current !== null) {
      el.scrollTop += el.scrollHeight - anchor.current
      anchor.current = null
    }
  }, [limit])
  useEffect(() => {
    fog.markRead(id)
  }, [id, count])
  useEffect(() => {
    if (!jump || jump.at < mountedAt.current - 2000 || !chat) return
    const target = chat.messages.find((m) => m.id === jump.id)
    if (!target) return fog.toast('That message is no longer here')
    if ((target.th ?? null) !== thread) return fog.openThread(target.th ?? null)
    const idx = msgs.findIndex((m) => m.id === jump.id)
    if (idx < msgs.length - limit) return setLimit(msgs.length - idx + 20)
    const el = scroller.current?.querySelector(`[data-mid="${CSS.escape(jump.id)}"]`)
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    setFlash(jump.id)
    const t = setTimeout(() => setFlash(null), 1500)
    return () => clearTimeout(t)
  }, [jump, limit, thread])
  useEffect(() => {
    if (!selected) return
    const key = (e: KeyboardEvent) => e.key === 'Escape' && (e.stopPropagation(), setSelected(null))
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [selected])

  const matches = useMemo(() => {
    const terms = fog.searchTerms(search?.q ?? '')
    return terms.length ? (chat?.messages ?? []).filter((m) => fog.msgMatches(m, terms)) : []
  }, [search?.q, chat?.messages])
  useEffect(() => {
    const m = matches[matches.length - 1 - (search?.i ?? 0)]
    if (m) fog.jumpTo(m.id)
  }, [matches.length, search?.i, search?.q])

  const toBottom = () => {
    setLimit(PAGE)
    requestAnimationFrame(() => scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' }))
    setMissed(0)
  }
  const toggle = (mid: string) =>
    setSelected((s) => {
      const n = new Set(s)
      n.has(mid) ? n.delete(mid) : n.add(mid)
      return n.size ? n : null
    })
  if (!chat) return null
  const title = chatTitle(chat, person)
  const left = !!chat.group?.left
  const shown = msgs.slice(-limit)
  const hidden = msgs.length - shown.length
  const byId = (mid?: string) => (mid ? chat.messages.find((x) => x.id === mid) : undefined)
  const rootOf = (mid: string) => Object.values(chat.threads ?? {}).find((t) => t.root === mid)
  const sel = selected ? chat.messages.filter((m) => selected.has(m.id)) : []
  const subtitle =
    conn !== 'online'
      ? 'Connecting…'
      : typing
        ? chat.group
          ? `${personName(typing.by, people[typing.by])} is typing…`
          : 'typing…'
        : id === SAVED
          ? 'Notes to yourself, on this device'
          : id === fog.GUIDE
            ? 'A built-in guide, on this device only'
          : person?.bot
            ? `bot${person.username ? ` · @${person.username}` : ''}`
          : chat.group
          ? `${chat.group.members.length} members`
          : person?.name && person.username
            ? `@${person.username}`
            : 'End-to-end encrypted'

  return (
    <div
      className="chat-enter relative flex h-full flex-col bg-panel"
      onDragOver={(e) => {
        if (!left && e.dataTransfer.types.includes('Files')) (e.preventDefault(), setDragging(true))
      }}
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setDragging(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        if (e.dataTransfer.files.length && !left) setFiles([...e.dataTransfer.files])
      }}
    >
      {selected ? (
        <header className="fade-in z-10 flex h-16 shrink-0 items-center gap-1 border-b border-line bg-panel px-2">
          <IconButton icon="close" label="Cancel selection" onClick={() => setSelected(null)} />
          <p className="flex-1 px-2 text-lg font-semibold">{selected.size} selected</p>
          <IconButton
            icon="copy"
            label="Copy"
            onClick={() => {
              const text = sel.filter((m) => m.text).map((m) => (sel.length > 1 ? `${m.mine ? 'You' : chat.group ? personName(m.from ?? '') : title}: ${m.text}` : m.text))
              if (text.length) copy(text.join('\n'))
              setSelected(null)
            }}
          />
          <IconButton icon="forward" label="Forward" onClick={() => setForwarding([...selected])} />
          <IconButton icon="trash" label="Delete" onClick={() => setDeleting(sel)} className="hover:!text-danger" />
        </header>
      ) : search ? (
        <header className="fade-in z-10 flex h-16 shrink-0 items-center gap-1 border-b border-line bg-panel px-2">
          <IconButton icon="close" label="Close search" onClick={() => setSearch(null)} />
          <input
            autoFocus
            value={search.q}
            onChange={(e) => setSearch({ q: e.target.value, i: 0 })}
            onKeyDown={(e) => {
              if (e.key === 'Escape') (e.stopPropagation(), setSearch(null))
              if (e.key === 'Enter') setSearch((s) => s && { ...s, i: Math.min(matches.length - 1, s.i + (e.shiftKey ? -1 : 1)) })
            }}
            placeholder="Search this chat"
            aria-label="Search this chat"
            className="h-10 min-w-0 flex-1 rounded-full bg-raised px-4 text-base outline-none focus:ring-2 focus:ring-lamp/40"
          />
          <span className="w-16 shrink-0 text-center text-sm text-muted tabular-nums">{search.q.trim() ? (matches.length ? `${search.i + 1} of ${matches.length}` : 'None') : ''}</span>
          <IconButton icon="up" label="Older match" onClick={() => setSearch((s) => s && { ...s, i: Math.min(matches.length - 1, s.i + 1) })} />
          <IconButton icon="down" label="Newer match" onClick={() => setSearch((s) => s && { ...s, i: Math.max(0, s.i - 1) })} />
        </header>
      ) : th ? (
        <header className="z-10 flex h-16 shrink-0 items-center gap-1 border-b border-line bg-panel px-2">
          <IconButton icon="back" label={`Back to ${title}`} onClick={() => fog.openThread(null)} />
          <div className="min-w-0 flex-1 px-2">
            <p className="flex items-center gap-1.5 truncate leading-tight font-semibold">
              <Icon name="thread" className="size-4 shrink-0 text-muted" />
              <span className="truncate">{th.name}</span>
            </p>
            <p className="truncate text-sm text-muted">{typing ? 'typing…' : `Thread in ${title}`}</p>
          </div>
          {canRename && !left && <IconButton icon="pencil" label="Rename thread" onClick={() => setNaming({ rename: th.id })} />}
          <IconButton icon="search" label="Search this chat" onClick={() => setSearch({ q: '', i: 0 })} />
        </header>
      ) : (
        <header className="z-10 flex h-16 shrink-0 items-center gap-1 border-b border-line bg-panel px-2">
          <IconButton icon="back" label="Back to chats" onClick={() => fog.openChat(null)} className="md:hidden" />
          <button onClick={onInfo} className="flex min-w-0 flex-1 items-center gap-3 rounded-xl px-2 py-1 text-left transition hover:bg-hover">
            <span className="relative">
              <Avatar id={id} name={title} src={chatAvatar(chat, person)} size={42} />
              {chat.timer && (
                <span className="absolute -right-1 -bottom-1 grid size-5 place-items-center rounded-full bg-lamp text-lamp-ink ring-2 ring-panel" title={`Disappearing after ${timerLabel(chat.timer)}`}>
                  <Icon name="timer" className="size-3.5" />
                </span>
              )}
            </span>
            <div className="min-w-0">
              <p className="flex items-center gap-1 truncate leading-tight font-semibold">
                <span className="truncate">{title}</span>
                {person?.bot && <BotBadge />}
                {person?.verified && (
                  <span title="Verified safety number">
                    <Icon name="shield" className="size-4 shrink-0 text-emerald-500" />
                    <span className="sr-only">Verified</span>
                  </span>
                )}
              </p>
              <p className={`truncate text-sm ${typing ? 'text-lamp' : 'text-muted'}`}>{subtitle}</p>
            </div>
          </button>
          {!chat.group && !fog.isLocalChat(id) && (
            <>
              <IconButton icon="video" label="Video call" onClick={() => startCall(id, true)} />
              <IconButton icon="phone" label="Voice call" onClick={() => startCall(id, false)} />
            </>
          )}
          {chat.group && !chat.group.left && !chat.request && (
            <>
              <IconButton icon="video" label="Group video call" onClick={() => groupCall(true)} />
              <IconButton icon="phone" label="Group voice call" onClick={() => groupCall(false)} className="max-sm:hidden" />
            </>
          )}
          {!!chat.threads && Object.keys(chat.threads).length > 0 && (
            <IconButton
              icon="thread"
              label="Threads"
              onClick={(e) => {
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                setThreadList({ x: r.right - 260, y: r.bottom + 4 })
              }}
            />
          )}
          <IconButton icon="search" label="Search this chat" onClick={() => setSearch({ q: '', i: 0 })} className={!chat.group && !fog.isLocalChat(id) ? 'max-sm:hidden' : ''} />
          <IconButton icon="info" label="Chat info" onClick={onInfo} className="max-sm:hidden" />
        </header>
      )}
      {!!chat.pins?.length && !selected && !th && (
        <PinnedBar
          chat={chat}
          idx={pinIdx}
          onOpen={(mid) => {
            fog.jumpTo(mid)
            setPinIdx((i) => (i + 1) % chat.pins!.length)
          }}
        />
      )}

      <div data-slide className="fogbank relative min-h-0 flex-1">
        <div
          ref={scroller}
          onScroll={(e) => {
            const el = e.currentTarget
            const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100
            stick.current = bottom
            setAtBottom(bottom)
            if (bottom) setMissed(0)
            if (el.scrollTop < 300 && hidden > 0 && anchor.current === null) {
              anchor.current = el.scrollHeight
              setLimit((l) => l + PAGE)
            }
          }}
          className="scroll-thin absolute inset-0 overflow-x-hidden overflow-y-auto"
        >
          <div role="log" aria-live="polite" aria-label="Messages" className="flex min-h-full flex-col justify-end px-2 py-3 sm:px-4 lg:px-5">
            {th?.root && byId(th.root) && (
              <button onClick={() => fog.jumpTo(th.root!)} className="mb-3 self-center rounded-2xl bg-black/20 px-4 py-2 text-left text-[13.5px] text-white backdrop-blur-md transition hover:bg-black/30 dark:bg-white/10">
                <span className="block opacity-75">Thread started from</span>
                <span className="line-clamp-2">{snippet(byId(th.root)!)}</span>
              </button>
            )}
            {count === 0 && !th && (id === SAVED ? <SavedIntro /> : <Intro title={title} group={!!chat.group} />)}
            {hidden > 0 && (
              <p className="my-2 flex justify-center">
                <Spinner className="size-5 text-muted" />
              </p>
            )}
            {shown.map((m, i) => {
              const prev = shown[i - 1]
              const next = shown[i + 1]
              const sameDay = (a?: Msg) => a && new Date(a.ts).toDateString() === new Date(m.ts).toDateString()
              const near = (a?: Msg) => a && !a.sys && !m.sys && a.mine === m.mine && a.from === m.from && Math.abs(a.ts - m.ts) < 5 * 60e3 && sameDay(a)
              return (
                <div key={m.id} className="flex flex-col">
                  {!sameDay(prev) && (
                    <span className="sticky top-2 z-[1] my-3 self-center rounded-full bg-black/25 px-3 py-1 text-[13px] font-medium text-white backdrop-blur-md dark:bg-white/10">
                      {dayLabel(m.ts)}
                    </span>
                  )}
                  {m.id === firstUnread && (
                    <div data-unread className="-mx-6 my-3 bg-black/10 py-1.5 text-center text-sm font-medium text-ink/70 dark:bg-white/[0.06]">
                      Unread messages
                    </div>
                  )}
                  {m.sys?.k === 'call' ? (
                    <button
                      onClick={() => (m.sys!.call!.group ? groupCall(!!m.sys!.call!.video) : startCall(id, !!m.sys!.call!.video))}
                      title="Call back"
                      className={`my-2 flex items-center gap-2 self-center rounded-full px-3 py-1 text-[13px] backdrop-blur-md transition hover:brightness-110 ${m.sys.call!.missed ? 'bg-danger/80 text-white' : 'bg-black/25 text-white dark:bg-white/10'}`}
                    >
                      <Icon name={m.sys.call!.video ? 'video' : 'phone'} className="size-4" />
                      {sysText(m)}
                      <span className="opacity-70">· {new Date(m.ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
                    </button>
                  ) : m.sys?.k === 'thread' && m.sys.th ? (
                    <ThreadLink name={chat.threads?.[m.sys.th]?.name ?? m.sys.name ?? 'Thread'} stats={threadStats.get(m.sys.th)} by={m.sys.by} onOpen={() => fog.openThread(m.sys!.th!)} />
                  ) : m.sys ? (
                    <span className="my-2 max-w-[85%] self-center rounded-full bg-black/25 px-3 py-1 text-center text-[13px] text-white backdrop-blur-md dark:bg-white/10">{sysText(m)}</span>
                  ) : (
                    <Bubble
                      m={m}
                      chat={chat}
                      replied={byId(m.reply)}
                      joinPrev={!!near(prev) && m.id !== firstUnread}
                      joinNext={!!near(next) && next?.id !== firstUnread}
                      fresh={m.ts > mountedAt.current}
                      flash={flash === m.id}
                      lifted={menu?.touch === true && menu.m.id === m.id}
                      selecting={!!selected}
                      selected={!!selected?.has(m.id)}
                      onSelect={() => toggle(m.id)}
                      onMenu={(at, touch) => setMenu({ at, m, touch, rect: touch ? scroller.current?.querySelector(`[data-mid="${CSS.escape(m.id)}"] [data-bubble]`)?.getBoundingClientRect() : undefined })}
                      onReply={() => !left && (setEditing(null), setReply(m))}
                      onOpenMedia={() => setViewing(m.id)}
                      onOpenText={() => setTextFile(m)}
                    />
                  )}
                  {!thread && rootOf(m.id) && <ThreadLink name={rootOf(m.id)!.name} stats={threadStats.get(rootOf(m.id)!.id)} onOpen={() => fog.openThread(rootOf(m.id)!.id)} mine={m.mine} />}
                </div>
              )
            })}
            {typing && (
              <div className="fade-in tail-in relative mt-2 self-start rounded-[18px] rounded-bl-[4px] bg-in px-4 py-3.5 shadow-[0_1px_1px_rgba(0,0,0,0.08)]">
                <span className="dots flex gap-1">
                  {[0, 1, 2].map((i) => (
                    <span key={i} className="size-2 rounded-full bg-muted" />
                  ))}
                </span>
              </div>
            )}
          </div>
        </div>
        {!atBottom && (
          <button
            onClick={toBottom}
            aria-label="Scroll to latest"
            className="pop absolute right-4 bottom-4 z-10 grid size-11 place-items-center rounded-full bg-panel text-muted shadow-lg ring-1 ring-black/5 transition hover:text-ink sm:right-8 dark:ring-white/10"
          >
            <Icon name="down" />
            {missed > 0 && <span className="pop absolute -top-2 grid h-5 min-w-5 place-items-center rounded-full bg-lamp px-1.5 text-xs font-bold text-lamp-ink">{missed}</span>}
          </button>
        )}
      </div>

      {chat.request ? (
        <RequestBar chat={chat} title={title} />
      ) : !chat.group && fog.isBlocked(id) ? (
        <div data-slide className="flex shrink-0 items-center justify-center gap-3 border-t border-line bg-panel px-4 py-3 pb-[max(0.75rem,var(--safe-bottom))] text-sm text-muted">
          You blocked {title}.
          <Button kind="soft" className="h-9 px-3 text-sm" onClick={() => fog.unblock(id)}>
            Unblock
          </Button>
        </div>
      ) : left ? (
        <div data-slide className="flex shrink-0 items-center justify-center gap-3 border-t border-line bg-panel px-4 py-3 pb-[max(0.75rem,var(--safe-bottom))] text-sm text-muted">
          You're no longer a member of this group.
          <Button kind="danger" className="h-9 px-3 text-sm" onClick={() => fog.deleteChat(id)}>
            Delete chat
          </Button>
        </div>
      ) : (
        <Composer
          id={id}
          title={title}
          reply={reply}
          editing={editing}
          onCancel={() => (setReply(null), setEditing(null))}
          onSent={() => {
            stick.current = true
            setReply(null)
            setEditing(null)
          }}
          onEditLast={() => {
            const last = [...msgs].reverse().find((x) => x.mine && x.text && !x.sys)
            if (last) (setReply(null), setEditing(last))
          }}
          onFiles={setFiles}
          onVoice={(att) => {
            stick.current = true
            fog.sendAtt(id, att, '', reply?.id, thread ?? undefined)
            setReply(null)
          }}
        />
      )}

      {dragging && (
        <div className="fade-in pointer-events-none absolute inset-3 z-30 grid place-items-center rounded-3xl border-2 border-dashed border-lamp bg-panel/85 backdrop-blur-sm">
          <p className="flex items-center gap-2 text-lg font-semibold">
            <Icon name="clip" /> Drop files to send
          </p>
        </div>
      )}

      {/* Long-press on touch: dim and blur everything except the pressed bubble, like Telegram. */}
      {menu?.touch && <div className="fade-in fixed inset-0 z-40 bg-black/35 backdrop-blur-[3px]" />}
      {menu && (
        <Menu
          at={menu.at}
          below={menu.rect}
          onClose={() => setMenu(null)}
          header={
            !left && (
              <div className="mb-1 flex gap-0.5 border-b border-line px-1 pb-1.5">
                {REACTIONS.map((e) => (
                  <button
                    key={e}
                    onClick={() => (fog.react(id, menu.m.id, menu.m.re?.me === e ? null : e), setMenu(null))}
                    className={`grid size-9 place-items-center rounded-full text-[22px] transition hover:scale-125 hover:bg-hover ${menu.m.re?.me === e ? 'bg-lamp/25' : ''}`}
                    aria-label={`React ${e}`}
                  >
                    {e}
                  </button>
                ))}
              </div>
            )
          }
        >
          {!left && <MenuItem icon="reply" label="Reply" onClick={() => (setEditing(null), setReply(menu.m), setMenu(null))} />}
          {menu.m.text && <MenuItem icon="copy" label="Copy text" onClick={() => (copy(menu.m.text), setMenu(null))} />}
          {!thread && !left && !fog.isLocalChat(id) && !menu.m.sys && (
            <MenuItem
              icon="thread"
              label={rootOf(menu.m.id) ? 'Open thread' : 'Start thread'}
              onClick={() => (rootOf(menu.m.id) ? fog.openThread(rootOf(menu.m.id)!.id) : setNaming({ root: menu.m }), setMenu(null))}
            />
          )}
          {menu.m.mine && menu.m.text && !left && <MenuItem icon="pencil" label="Edit" onClick={() => (setReply(null), setEditing(menu.m), setMenu(null))} />}
          {menu.m.att?.id && fog.isGif(menu.m.att) && menu.m.att.kind !== 'sticker' && <MenuItem icon="image" label="Save GIF" onClick={() => (fog.saveGif(menu.m.att!), setMenu(null))} />}
          {menu.m.att?.id && (menu.m.att.kind === 'sticker' || menu.m.att.kind === 'photo') && (
            <MenuItem icon="sticker" label={menu.m.att.kind === 'sticker' ? 'Save sticker' : 'Add to stickers'} onClick={() => (fog.saveSticker(menu.m.att!), setMenu(null))} />
          )}
          {!left && (
            <MenuItem
              icon={chat.pins?.includes(menu.m.id) ? 'unpin' : 'pin'}
              label={chat.pins?.includes(menu.m.id) ? 'Unpin' : 'Pin'}
              onClick={() => (fog.pinMessage(id, menu.m.id, !chat.pins?.includes(menu.m.id)), setMenu(null))}
            />
          )}
          <MenuItem icon="forward" label="Forward" onClick={() => (setForwarding([menu.m.id]), setMenu(null))} />
          {menu.m.mine && !fog.isLocalChat(id) && <MenuItem icon="info" label="Info" onClick={() => (setInfo(menu.m), setMenu(null))} />}
          <MenuItem icon="select" label="Select" onClick={() => (setSelected(new Set([menu.m.id])), setMenu(null))} />
          <MenuItem icon="trash" label="Delete" danger onClick={() => (setDeleting([menu.m]), setMenu(null))} />
        </Menu>
      )}
      {naming && (
        <NameThread
          initial={naming.rename ? (chat.threads?.[naming.rename]?.name ?? '') : naming.root ? snippet(naming.root).slice(0, 60) : ''}
          rename={!!naming.rename}
          onClose={() => setNaming(null)}
          onDone={async (name) => {
            const n = naming
            setNaming(null)
            if (n.rename) return void fog.renameThread(id, n.rename, name).catch(() => fog.toast("Couldn't rename the thread. Check your connection."))
            const tid = await fog.createThread(id, name, n.root?.id).catch(() => null)
            if (tid) fog.openThread(tid)
            else fog.toast("Couldn't start the thread. Check your connection.")
          }}
        />
      )}
      {threadList && (
        <Menu at={threadList} onClose={() => setThreadList(null)}>
          {Object.values(chat.threads ?? {})
            .sort((a, b) => (threadStats.get(b.id)?.last ?? b.ts) - (threadStats.get(a.id)?.last ?? a.ts))
            .map((t) => (
              <MenuItem key={t.id} icon="thread" label={`${t.name}${threadStats.get(t.id) ? ` · ${threadStats.get(t.id)!.n}` : ''}`} onClick={() => (fog.openThread(t.id), setThreadList(null))} />
            ))}
          {!left && <MenuItem icon="plus" label="New thread" onClick={() => (setNaming({}), setThreadList(null))} />}
        </Menu>
      )}
      {deleting && <DeleteDialog msgs={deleting} chat={chat} title={title} onClose={() => setDeleting(null)} onDone={() => setSelected(null)} />}
      {forwarding && (
        <ForwardDialog
          onClose={() => setForwarding(null)}
          onSend={(targets) => {
            fog.forward(id, forwarding, targets)
            setForwarding(null)
            setSelected(null)
          }}
        />
      )}
      {viewing && <MediaViewer chat={chat} start={viewing} onClose={() => setViewing(null)} />}
      {info && <MessageInfo chat={chat} m={info} onClose={() => setInfo(null)} />}
      {textFile?.att && <TextViewer a={textFile.att} onClose={() => setTextFile(null)} />}
      {files && (
        <AttachDialog
          files={files}
          onClose={() => setFiles(null)}
          onSend={(caption, asFile) => {
            fog.sendFiles(id, files, { caption, reply: reply?.id, asFile, th: thread ?? undefined })
            stick.current = true
            setReply(null)
            setFiles(null)
          }}
        />
      )}
    </div>
  )
}

/** The way into a thread: under the message it started from, or where it was started. */
function ThreadLink({ name, stats, by, mine, onOpen }: { name: string; stats?: { n: number; last: number }; by?: string; mine?: boolean; onOpen: () => void }) {
  return (
    <button
      onClick={onOpen}
      className={`mt-1 mb-1 flex max-w-[85%] items-center gap-2 rounded-full bg-black/20 px-3 py-1 text-[13px] text-white backdrop-blur-md transition hover:bg-black/30 dark:bg-white/10 ${mine ? 'self-end' : by ? 'self-center' : 'self-start sm:ml-11'}`}
    >
      <Icon name="thread" className="size-4 shrink-0" />
      <span className="truncate">{by ? `${personName(by)} started “${name}”` : name}</span>
      <span className="shrink-0 opacity-75">{stats ? `${stats.n} ${stats.n === 1 ? 'message' : 'messages'}` : 'No messages yet'}</span>
    </button>
  )
}

function NameThread({ initial, rename, onClose, onDone }: { initial: string; rename: boolean; onClose: () => void; onDone: (name: string) => void }) {
  const [name, setName] = useState(initial)
  const ok = !!name.trim()
  return (
    <Dialog
      title={rename ? 'Rename thread' : 'New thread'}
      onClose={onClose}
      actions={
        <>
          <Button kind="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!ok} onClick={() => onDone(name)}>
            {rename ? 'Rename' : 'Start thread'}
          </Button>
        </>
      }
    >
      <input
        autoFocus
        value={name}
        maxLength={100}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && ok && onDone(name)}
        placeholder="Thread name"
        aria-label="Thread name"
        className="h-11 w-full rounded-xl bg-raised px-3.5 text-base outline-none ring-1 ring-transparent focus:ring-lamp/50"
      />
    </Dialog>
  )
}

/** Shown instead of the composer for message requests (like Signal). */
function RequestBar({ chat, title }: { chat: Chat; title: string }) {
  const sender = chat.group ? chat.group.owner : chat.id
  return (
    <div data-slide className="shrink-0 border-t border-line bg-panel px-4 pt-3 pb-[max(0.75rem,var(--safe-bottom))]">
      <p className="mx-auto max-w-xl text-center text-sm text-muted">
        {chat.group ? `${personName(sender)} added you to “${title}”.` : `${title} wants to message you.`} They won't know you've seen their messages until you accept.
      </p>
      <div className="mx-auto mt-3 flex max-w-xl gap-2">
        <Button kind="soft" className="flex-1 !text-danger" onClick={() => fog.block(sender)}>
          Block
        </Button>
        <Button kind="soft" className="flex-1" onClick={() => fog.deleteChat(chat.id)}>
          Delete
        </Button>
        <Button className="flex-1" onClick={() => fog.acceptRequest(chat.id)}>
          Accept
        </Button>
      </div>
    </div>
  )
}

function SavedIntro() {
  return (
    <div className="fade-in m-auto max-w-xs rounded-3xl bg-black/25 p-6 text-center text-white backdrop-blur-md dark:bg-white/[0.07]">
      <Icon name="bookmark" className="mx-auto size-8" />
      <p className="mt-3 font-semibold">Saved Messages</p>
      <p className="mt-1 text-sm text-white/80">Forward messages here, or jot down notes, links and files. They stay on this device and are never sent anywhere.</p>
    </div>
  )
}

function PinnedBar({ chat, idx, onOpen }: { chat: Chat; idx: number; onOpen: (id: string) => void }) {
  const pins = chat.pins!
  const i = pins.length - 1 - (idx % pins.length)
  const m = chat.messages.find((x) => x.id === pins[i])
  if (!m) return null
  return (
    <div className="rise z-[5] flex shrink-0 items-center gap-1 border-b border-line bg-panel/95 px-3 py-1.5 backdrop-blur">
      <button onClick={() => onOpen(m.id)} className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-1 py-0.5 text-left transition hover:bg-hover">
        <span className="flex h-9 w-[3px] flex-col gap-0.5">
          {pins.length > 1 ? pins.map((p, k) => <span key={p} className={`flex-1 rounded-full ${k === i ? 'bg-lamp' : 'bg-lamp/30'}`} />) : <span className="flex-1 rounded-full bg-lamp" />}
        </span>
        {m.att?.thumb && <img src={m.att.thumb} alt="" className="size-8 rounded object-cover" />}
        <span className="min-w-0">
          <span className="block text-sm font-semibold text-lamp">{pins.length > 1 ? `Pinned message ${i + 1} of ${pins.length}` : 'Pinned message'}</span>
          <span className="block truncate text-sm">{snippet(m)}</span>
        </span>
      </button>
      {!chat.group?.left && <IconButton icon="close" label="Unpin" onClick={() => fog.pinMessage(chat.id, m.id, false)} className="size-9" />}
    </div>
  )
}

function MessageInfo({ chat, m, onClose }: { chat: Chat; m: Msg; onClose: () => void }) {
  const people = useFog((s) => s.people)
  const status = msgStatus(chat, m)
  const label = { sending: 'Sending', sent: 'Sent to server', delivered: 'Delivered', read: 'Read', failed: 'Not sent' }
  return (
    <Dialog title="Message info" onClose={onClose} actions={<Button onClick={onClose}>Done</Button>}>
      <p className="mt-1 rounded-xl bg-raised px-3 py-2 text-ink">
        <span className="line-clamp-3">{snippet(m)}</span>
      </p>
      <p className="mt-3 text-sm">Sent {fullDate(m.ts)}</p>
      {m.ttl && <p className="text-sm">Disappears {timerLabel(m.ttl)} after it's read</p>}
      {!chat.group ? (
        <p className="mt-2 flex items-center gap-2 text-ink">
          <Ticks status={status} /> {label[status ?? 'sent']}
        </p>
      ) : (
        <div className="mt-3 space-y-1">
          {others(chat).map((p) => (
            <div key={p} className="flex items-center gap-3 text-ink">
              <Avatar id={p} name={personName(p, people[p])} src={people[p]?.avatar} size={32} />
              <span className="min-w-0 flex-1 truncate">{personName(p, people[p])}</span>
              <span className="flex items-center gap-1 text-sm text-muted">
                <Ticks status={m.rc?.[p] ?? (m.status === 'sent' ? 'sent' : m.status)} />
                {m.rc?.[p] === 'read' ? 'Read' : m.rc?.[p] === 'delivered' ? 'Delivered' : 'Sent'}
              </span>
            </div>
          ))}
        </div>
      )}
    </Dialog>
  )
}

function Intro({ title, group }: { title: string; group: boolean }) {
  return (
    <div className="fade-in m-auto max-w-xs rounded-3xl bg-black/25 p-6 text-center text-white backdrop-blur-md dark:bg-white/[0.07]">
      <Icon name="lock" className="mx-auto size-8" />
      <p className="mt-3 font-semibold">No messages here yet</p>
      <p className="mt-1 text-sm text-white/80">
        Messages are end-to-end encrypted with the Signal protocol. {group ? 'Only members of this group' : `Only you and ${title}`} can read them.
      </p>
      {!group && <p className="mt-2 text-xs text-white/70">To be sure it's really them, verify the safety number in chat info.</p>}
    </div>
  )
}

// ---------- dialogs ----------
function DeleteDialog({ msgs, chat, title, onClose, onDone }: { msgs: Msg[]; chat: Chat; title: string; onClose: () => void; onDone: () => void }) {
  const canEveryone = !chat.group?.left && msgs.every((m) => m.mine && m.status !== 'failed' && m.status !== 'sending')
  const [everyone, setEveryone] = useState(true)
  const n = msgs.length
  return (
    <Dialog
      title={n === 1 ? 'Delete message?' : `Delete ${n} messages?`}
      onClose={onClose}
      actions={
        <>
          <Button kind="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            kind="danger"
            onClick={() => {
              fog.deleteMessages(
                chat.id,
                msgs.map((m) => m.id),
                canEveryone && everyone,
              )
              onClose()
              onDone()
            }}
          >
            Delete
          </Button>
        </>
      }
    >
      {canEveryone ? (
        <label className="mt-2 flex cursor-pointer items-center gap-3 text-ink">
          <input type="checkbox" checked={everyone} onChange={(e) => setEveryone(e.target.checked)} className="size-5 accent-[var(--lamp)]" />
          Also delete for {chat.group ? 'everyone' : title}
        </label>
      ) : (
        'This removes them from this device only.'
      )}
    </Dialog>
  )
}

export function ForwardDialog({ onClose, onSend }: { onClose: () => void; onSend: (targets: string[]) => void }) {
  const chats = useFog((s) => s.chats)
  const people = useFog((s) => s.people)
  const [q, setQ] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const all = chats[SAVED] ? Object.values(chats) : [{ id: SAVED, messages: [], unread: 0 } as Chat, ...Object.values(chats)]
  const list = all
    .filter((c) => !c.group?.left && chatTitle(c, people[c.id]).toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => Number(b.id === SAVED) - Number(a.id === SAVED) || (b.messages.at(-1)?.ts ?? 0) - (a.messages.at(-1)?.ts ?? 0))
  return (
    <Dialog
      title="Forward to…"
      onClose={onClose}
      actions={
        <>
          <Button kind="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!picked.length} onClick={() => onSend(picked)}>
            Send{picked.length > 1 ? ` (${picked.length})` : ''}
          </Button>
        </>
      }
    >
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        autoFocus
        placeholder="Search chats"
        className="mt-2 h-11 w-full rounded-xl border border-line bg-raised px-3 text-base text-ink outline-none focus:border-lamp"
      />
      <div className="scroll-thin -mx-2 mt-2 max-h-[50vh] overflow-y-auto">
        {list.map((c) => {
          const on = picked.includes(c.id)
          return (
            <button
              key={c.id}
              onClick={() => setPicked((p) => (on ? p.filter((x) => x !== c.id) : [...p, c.id]))}
              className="flex w-full items-center gap-3 rounded-xl p-2 text-left text-ink transition hover:bg-hover"
            >
              <Avatar id={c.id} name={chatTitle(c, people[c.id])} src={chatAvatar(c, people[c.id])} size={40} />
              <span className="min-w-0 flex-1 truncate font-medium">{chatTitle(c, people[c.id])}</span>
              <span className={`grid size-6 place-items-center rounded-full border-2 transition ${on ? 'border-lamp bg-lamp text-lamp-ink' : 'border-muted/50'}`}>{on && <Icon name="check" className="size-4" />}</span>
            </button>
          )
        })}
        {!list.length && <p className="p-3 text-sm">No chats match.</p>}
      </div>
    </Dialog>
  )
}

function AttachDialog({ files, onClose, onSend }: { files: File[]; onClose: () => void; onSend: (caption: string, asFile: boolean) => void }) {
  const [caption, setCaption] = useState('')
  const [asFile, setAsFile] = useState(false)
  const previews = useMemo(() => files.map((f) => (f.type.startsWith('image/') || f.type.startsWith('video/') ? URL.createObjectURL(f) : null)), [files])
  useEffect(() => () => previews.forEach((u) => u && URL.revokeObjectURL(u)), [previews])
  const visual = files.some((f) => f.type.startsWith('image/') || f.type.startsWith('video/'))
  return (
    <Dialog
      title={files.length === 1 ? (visual && !asFile ? (files[0].type.startsWith('video/') ? 'Send video' : 'Send photo') : 'Send file') : `Send ${files.length} items`}
      onClose={onClose}
      actions={
        <>
          <Button kind="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => onSend(caption.trim(), asFile)}>Send</Button>
        </>
      }
    >
      <div className={`scroll-thin mt-2 grid max-h-[50vh] gap-1.5 overflow-y-auto ${files.length > 1 && visual && !asFile ? 'grid-cols-3' : ''}`}>
        {files.map((f, i) =>
          previews[i] && !asFile ? (
            f.type.startsWith('video/') ? (
              <video key={i} src={previews[i]!} muted className={`w-full rounded-xl bg-black object-cover ${files.length > 1 ? 'aspect-square' : 'max-h-[45vh]'}`} />
            ) : (
              <img key={i} src={previews[i]!} alt="" className={`w-full rounded-xl bg-black/5 ${files.length > 1 ? 'aspect-square object-cover' : 'max-h-[45vh] object-contain'}`} />
            )
          ) : (
            <div key={i} className="flex items-center gap-3 rounded-xl bg-raised p-2.5 text-ink">
              <span className="grid size-10 place-items-center rounded-lg bg-slate-500 text-white">
                <Icon name="file" className="size-5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{f.name}</span>
                <span className="text-xs text-muted">{fmtSize(f.size)}</span>
              </span>
            </div>
          ),
        )}
      </div>
      {visual && (
        <label className="mt-3 flex cursor-pointer items-center gap-2 text-sm text-ink">
          <input type="checkbox" checked={asFile} onChange={(e) => setAsFile(e.target.checked)} className="size-4 accent-[var(--lamp)]" />
          Send without compression
        </label>
      )}
      {files.some((f) => f.size > MAX_FILE) && <p className="mt-2 text-sm text-danger">Files over 2 GB will be skipped.</p>}
      <input
        value={caption}
        onChange={(e) => setCaption(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && onSend(caption.trim(), asFile)}
        autoFocus
        placeholder="Add a caption"
        className="mt-4 h-12 w-full rounded-xl border border-line bg-raised px-4 text-base text-ink outline-none focus:border-lamp"
      />
    </Dialog>
  )
}

// ---------- composer ----------
const EMOJI: [string, string][] = [
  ['Smileys', '😀 😃 😄 😁 😆 😅 🤣 😂 🙂 😉 😊 😇 🥰 😍 🤩 😘 😗 😚 😋 😛 😜 🤪 😝 🤑 🤗 🤭 🤫 🤔 🤐 🤨 😐 😑 😶 😏 😒 🙄 😬 😮‍💨 🤥 😌 😔 😪 🤤 😴 😷 🤒 🤕 🤢 🤮 🥵 🥶 🥴 😵 🤯 🤠 🥳 😎 🤓 🧐 😕 😟 🙁 😮 😯 😲 😳 🥺 😦 😧 😨 😰 😥 😢 😭 😱 😖 😣 😞 😓 😩 😫 🥱 😤 😡 😠 🤬 😈 💀 💩 🤡 👻 👽 🤖'],
  ['Gestures', '👋 🤚 🖐️ ✋ 🖖 👌 🤌 🤏 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ 👍 👎 ✊ 👊 🤛 🤜 👏 🙌 👐 🤲 🤝 🙏 ✍️ 💪 🦾 🧠 👀 👁️ 👅 👄 🫶'],
  ['Hearts', '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 ❤️‍🔥 💯 💢 💥 💫 💦 💨 🕳️ 💬 💭 💤'],
  ['Nature', '🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🐔 🐧 🐦 🦆 🦉 🐺 🐴 🦄 🐝 🦋 🐌 🐢 🐍 🐙 🐬 🐳 🌵 🌲 🌴 🌱 🍀 🍁 🍄 🌸 🌹 🌻 🌙 ⭐ 🌟 ✨ ⚡ 🔥 🌈 ☀️ ☁️ 🌫️ ❄️ 🌊'],
  ['Food', '🍏 🍎 🍐 🍊 🍋 🍌 🍉 🍇 🍓 🍒 🍑 🥭 🍍 🥥 🥝 🍅 🥑 🌶️ 🌽 🥕 🥐 🍞 🧀 🍳 🥓 🍔 🍟 🍕 🌭 🌮 🌯 🍜 🍣 🍱 🍩 🍪 🎂 🍰 🍫 🍿 ☕ 🍵 🍺 🍻 🥂 🍷 🍸'],
  ['Activity', '⚽ 🏀 🏈 ⚾ 🎾 🏐 🎱 🏓 🥊 🎯 🎮 🎲 🧩 🎸 🎹 🥁 🎧 🎤 🎬 🎨 🏆 🥇 🎉 🎊 🎁 🎈 ✈️ 🚀 🚗 🚲 ⛵ 🏠 🏔️ 🏖️ 🗺️'],
  ['Objects', '⌚ 📱 💻 ⌨️ 🖥️ 🖨️ 🕹️ 💾 📷 🎥 📺 📻 ⏰ 🔋 💡 🔦 💰 💳 💎 🔧 🔨 🛠️ 🔑 🗝️ 🔒 🔓 🛡️ 📦 ✉️ 📎 📌 📝 📚 📖 🔗 🧪 💊'],
  ['Symbols', '✅ ☑️ ✔️ ❌ ❎ ➕ ➖ ❓ ❗ ‼️ ⁉️ ⚠️ 🚫 ⛔ 🔴 🟠 🟡 🟢 🔵 🟣 ⚫ ⚪ 🔺 🔻 ▶️ ⏸️ ⏹️ 🔁 🔀 ♻️ 🆗 🆒 🆕 🔝 💲 ©️ ®️ ™️'],
]
const RECENT_KEY = 'fog-recent-emoji'
const readRecent = (): string[] => {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')
  } catch {
    return []
  }
}

function EmojiPanel({ onPick, onClose, onSticker }: { onPick: (e: string) => void; onClose: () => void; onSticker?: (a: Att) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const stickers = useFog((s) => s.stickers)
  const gifs = useFog((s) => s.gifs)
  const [gifQ, setGifQ] = useState('')
  const addInput = useRef<HTMLInputElement>(null)
  const addGif = useRef<HTMLInputElement>(null)
  const [recent] = useState(readRecent)
  const groups: [string, string[]][] = [...(recent.length ? [['Recent', recent] as [string, string[]]] : []), ...EMOJI.map(([n, s]) => [n, s.split(' ')] as [string, string[]])]
  const [tab, setTab] = useState(onSticker && stickers.length ? 'Stickers' : groups[0][0])
  useEffect(() => {
    const down = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && !(e.target as Element).closest?.('[data-emoji-toggle]') && onClose()
    const key = (e: KeyboardEvent) => e.key === 'Escape' && (e.stopPropagation(), onClose())
    document.addEventListener('pointerdown', down)
    window.addEventListener('keydown', key, true)
    return () => (document.removeEventListener('pointerdown', down), window.removeEventListener('keydown', key, true))
  }, [onClose])
  const pick = (e: string) => {
    const next = [e, ...readRecent().filter((x) => x !== e)].slice(0, 24)
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(next))
    } catch {}
    onPick(e)
  }
  return (
    <div ref={ref} className="menu-in absolute bottom-full left-0 z-30 mb-2 w-[min(352px,calc(100vw-24px))] origin-bottom-left overflow-hidden rounded-2xl bg-panel shadow-[0_12px_40px_-8px_rgba(0,0,0,0.35)] ring-1 ring-black/5 dark:ring-white/10">
      <div className="scroll-thin flex gap-1 overflow-x-auto border-b border-line p-1.5">
        {onSticker && (
          <button onClick={() => setTab('Stickers')} title="Stickers" aria-label="Stickers" className={`grid size-9 shrink-0 place-items-center rounded-lg transition ${tab === 'Stickers' ? 'bg-lamp/25 text-lamp' : 'text-muted hover:bg-hover'}`}>
            <Icon name="sticker" className="size-5" />
          </button>
        )}
        {onSticker && (
          <button onClick={() => setTab('GIFs')} title="GIFs" aria-label="GIFs" className={`grid h-9 shrink-0 place-items-center rounded-lg px-2 text-xs font-bold transition ${tab === 'GIFs' ? 'bg-lamp/25 text-lamp' : 'text-muted hover:bg-hover'}`}>
            GIF
          </button>
        )}
        {groups.map(([name, list]) => (
          <button key={name} onClick={() => setTab(name)} title={name} className={`grid size-9 shrink-0 place-items-center rounded-lg text-xl transition ${tab === name ? 'bg-lamp/25' : 'hover:bg-hover'}`}>
            {name === 'Recent' ? '🕘' : list[0]}
          </button>
        ))}
      </div>
      <p className="px-3 pt-2 text-xs font-semibold text-muted">{tab === 'Stickers' ? 'Your stickers' : tab === 'GIFs' ? 'Your GIFs' : tab}</p>
      {tab === 'GIFs' ? (
        <div className="flex h-56 flex-col">
          {gifs.length > 3 && (
            <input
              value={gifQ}
              onChange={(e) => setGifQ(e.target.value)}
              placeholder="Search your GIFs"
              aria-label="Search your GIFs"
              className="mx-1.5 mt-1.5 rounded-lg bg-raised px-3 py-1.5 text-base text-ink outline-none placeholder:text-muted sm:text-sm"
            />
          )}
          <div className="scroll-thin grid min-h-0 flex-1 grid-cols-3 content-start gap-1 overflow-y-auto p-1.5">
            <button onClick={() => addGif.current?.click()} className="grid aspect-square place-items-center rounded-xl border-2 border-dashed border-line text-muted transition hover:border-lamp hover:text-lamp" aria-label="Add a GIF">
              <Icon name="plus" />
            </button>
            <input ref={addGif} type="file" accept="image/gif" hidden onChange={(e) => (e.target.files?.[0] && fog.addGif(e.target.files[0]), (e.target.value = ''))} />
            {gifs
              .filter((g) => fog.searchTerms(gifQ).every((t) => fog.fold(g.name).includes(t)))
              .map((g) => (
                <div key={g.lid} className="group relative">
                  <button onClick={() => onSticker!(g)} className="grid aspect-square w-full place-items-center overflow-hidden rounded-xl bg-raised transition hover:brightness-95" aria-label={`Send GIF ${g.name}`} title={g.name}>
                    <Sticker a={g} size={104} />
                  </button>
                  <button onClick={() => fog.removeGif(g.lid)} aria-label="Remove GIF" className="absolute -top-1 -right-1 hidden size-5 place-items-center rounded-full bg-panel text-muted shadow group-hover:grid">
                    <Icon name="close" className="size-3" />
                  </button>
                </div>
              ))}
            {!gifs.length && <p className="col-span-2 self-center px-2 text-xs text-muted">Add GIFs from your device, or save one someone sends you from its menu. They stay private: no GIF service is involved.</p>}
          </div>
        </div>
      ) : tab === 'Stickers' ? (
        <div className="scroll-thin grid h-56 grid-cols-4 content-start gap-1 overflow-y-auto p-1.5">
          <button onClick={() => addInput.current?.click()} className="grid aspect-square place-items-center rounded-xl border-2 border-dashed border-line text-muted transition hover:border-lamp hover:text-lamp" aria-label="Add a sticker">
            <Icon name="plus" />
          </button>
          <input ref={addInput} type="file" accept="image/*" hidden onChange={(e) => (e.target.files?.[0] && fog.addSticker(e.target.files[0]), (e.target.value = ''))} />
          {stickers.map((s) => (
            <div key={s.lid} className="group relative">
              <button onClick={() => onSticker!(s)} className="grid aspect-square w-full place-items-center rounded-xl transition hover:bg-hover" aria-label="Send sticker">
                <Sticker a={s} size={72} />
              </button>
              <button onClick={() => fog.removeSticker(s.lid)} aria-label="Remove sticker" className="absolute -top-1 -right-1 hidden size-5 place-items-center rounded-full bg-panel text-muted shadow group-hover:grid">
                <Icon name="close" className="size-3" />
              </button>
            </div>
          ))}
          {!stickers.length && <p className="col-span-3 self-center px-2 text-xs text-muted">Add images as stickers, or right-click a sticker or photo in a chat to save it.</p>}
        </div>
      ) : (
      <div className="scroll-thin grid h-56 grid-cols-8 content-start overflow-y-auto p-1.5">
        {groups
          .find(([n]) => n === tab)![1]
          .map((e, i) => (
            <button key={i} onClick={() => pick(e)} className="grid aspect-square place-items-center rounded-lg text-[26px] transition hover:scale-110 hover:bg-hover">
              {e}
            </button>
          ))}
      </div>
      )}
    </div>
  )
}

/** Video message recorder: rounded preview, 60 s max, linear progress, then send or discard. */
function VideoNoteRecorder({ rec, onCancel, onSend }: { rec: VideoNoteRec; onCancel: () => void; onSend: (v: HTMLVideoElement) => void }) {
  const v = useRef<HTMLVideoElement>(null)
  const [, tick] = useState(0)
  useEffect(() => {
    v.current!.srcObject = rec.stream
    const t = setInterval(() => {
      tick((n) => n + 1)
      if ((performance.now() - rec.started) / 1000 >= MAX_NOTE) onSend(v.current!)
    }, 100)
    const key = (e: KeyboardEvent) => e.key === 'Escape' && (e.stopPropagation(), onCancel())
    window.addEventListener('keydown', key, true)
    return () => (clearInterval(t), window.removeEventListener('keydown', key, true))
  }, [rec])
  const el = (performance.now() - rec.started) / 1000
  return (
    <div className="fade-in fixed inset-0 z-50 grid place-items-center bg-scrim p-4 backdrop-blur-sm" role="dialog" aria-label="Recording video message">
      <div className="pop w-full max-w-sm overflow-hidden rounded-3xl bg-panel shadow-2xl">
        <div className="relative aspect-square bg-black">
          <video ref={v} autoPlay muted playsInline className="size-full -scale-x-100 object-cover" />
          <span className="absolute top-3 left-3 flex items-center gap-2 rounded-full bg-black/50 px-2.5 py-1 text-sm font-medium text-white tabular-nums backdrop-blur-sm">
            <span className="size-2 animate-pulse rounded-full bg-[#e5484d]" />
            {fmtDur(el)}
          </span>
          <span className="absolute inset-x-0 bottom-0 h-1 bg-white/20">
            <span className="block h-full bg-lamp transition-[width] duration-100" style={{ width: `${Math.min(100, (el / MAX_NOTE) * 100)}%` }} />
          </span>
        </div>
        <div className="flex items-center justify-between gap-2 p-3">
          <span className="pl-2 text-sm text-muted">Up to {fmtDur(MAX_NOTE)}</span>
          <div className="flex gap-2">
            <Button kind="ghost" onClick={onCancel}>
              Discard
            </Button>
            <Button onClick={() => onSend(v.current!)}>Send</Button>
          </div>
        </div>
      </div>
    </div>
  )
}

function PollDialog({ onClose, onSend }: { onClose: () => void; onSend: (p: Poll) => void }) {
  const [q, setQ] = useState('')
  const [opts, setOpts] = useState(['', ''])
  const [multi, setMulti] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const filled = opts.map((o) => o.trim()).filter(Boolean)
  const same = new Set(filled.map((o) => fog.fold(o))).size !== filled.length
  const ok = q.trim() && filled.length >= 2 && !same
  const setOpt = (i: number, v: string) =>
    setOpts((os) => {
      const next = os.map((o, k) => (k === i ? v.slice(0, 100) : o))
      // Always keep one empty row at the end to type the next option (max 10).
      if (next.at(-1)?.trim() && next.length < 10) next.push('')
      return next
    })
  // Enter moves on to the next field, like a form you fill in top to bottom.
  const next = (e: React.KeyboardEvent, i: number) => {
    if (e.key !== 'Enter') return
    e.preventDefault()
    const fields = [...box.current!.querySelectorAll('input[type=text]')] as HTMLInputElement[]
    fields[i + 1]?.focus()
  }
  const field = 'h-11 w-full rounded-xl border border-line bg-raised px-3.5 text-base text-ink outline-none placeholder:text-muted focus:border-lamp'
  return (
    <Dialog
      title="New poll"
      onClose={onClose}
      actions={
        <>
          <Button kind="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!ok} onClick={() => onSend({ q: q.trim(), o: filled, multi })}>
            Create poll
          </Button>
        </>
      }
    >
      <div ref={box}>
        <label className="mt-1 mb-1.5 block text-sm font-semibold text-lamp" htmlFor="poll-q">
          Question
        </label>
        <input id="poll-q" type="text" value={q} onChange={(e) => setQ(e.target.value.slice(0, 300))} onKeyDown={(e) => next(e, 0)} autoFocus placeholder="Ask a question" className={`${field} font-medium`} />
        <p className="mt-4 mb-1.5 text-sm font-semibold text-lamp">Options</p>
        <div className="space-y-1.5">
          {opts.map((o, i) => (
            <div key={i} className="relative">
              <input type="text" value={o} onChange={(e) => setOpt(i, e.target.value)} onKeyDown={(e) => next(e, i + 1)} placeholder={`Option ${i + 1}`} aria-label={`Option ${i + 1}`} className={`${field} pr-10`} />
              {opts.length > 2 && o && (
                <button type="button" onClick={() => setOpts((os) => os.filter((_, k) => k !== i))} aria-label={`Remove option ${i + 1}`} className="absolute top-1/2 right-1.5 grid size-8 -translate-y-1/2 place-items-center rounded-lg text-muted transition hover:bg-hover hover:text-ink">
                  <Icon name="close" className="size-4" />
                </button>
              )}
            </div>
          ))}
        </div>
        {same && <p className="mt-2 text-sm text-danger">Each option needs to be different.</p>}
        <label className="mt-4 flex cursor-pointer items-center gap-2 text-sm text-ink">
          <input type="checkbox" checked={multi} onChange={(e) => setMulti(e.target.checked)} className="size-4 accent-[var(--lamp)]" />
          Allow multiple answers
        </label>
      </div>
    </Dialog>
  )
}

function Recorder({ rec, onCancel, onSend }: { rec: Recording; onCancel: () => void; onSend: () => void }) {
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 100)
    return () => clearInterval(t)
  }, [])
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') (e.stopPropagation(), onCancel())
      if (e.key === 'Enter') (e.preventDefault(), onSend())
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [onCancel, onSend])
  const bars = rec.levels.slice(-36)
  return (
    <div className="fade-in flex min-h-12 flex-1 items-center gap-3 rounded-[24px] bg-raised pr-1 pl-4">
      <span className="size-2.5 shrink-0 animate-pulse rounded-full bg-danger" />
      <span className="w-11 shrink-0 font-medium tabular-nums">{fmtDur((performance.now() - rec.started) / 1000)}</span>
      <span className="flex h-8 flex-1 items-center justify-end gap-[2px] overflow-hidden">
        {bars.map((v, i) => (
          <span key={i} className="w-[3px] shrink-0 rounded-full bg-lamp" style={{ height: `${Math.max(10, v * 100)}%` }} />
        ))}
      </span>
      <IconButton icon="trash" label="Discard recording" onClick={onCancel} className="hover:!text-danger" />
    </div>
  )
}

function Composer(props: {
  id: string
  title: string
  reply: Msg | null
  editing: Msg | null
  onCancel: () => void
  onSent: () => void
  onEditLast: () => void
  onFiles: (f: File[]) => void
  onVoice: (a: Att) => void
}) {
  const { id, title, reply, editing, onCancel, onSent, onEditLast, onFiles, onVoice } = props
  const chat = useFog((s) => s.chats[id])
  const people = useFog((s) => s.people)
  const thread = useFog((s) => s.thread)
  const [text, setText] = useState(() => fog.getState().chats[id]?.draft ?? '')
  const [mention, setMention] = useState<{ q: string; i: number } | null>(null)
  const members = chat?.group ? others(chat) : []
  const handle = (p: string) => (people[p]?.username ? `@${people[p]!.username}` : people[p]?.name ? `@${people[p]!.name}` : null)
  const candidates = mention
    ? members.filter((p) => handle(p) && (personName(p, people[p]).toLowerCase().includes(mention.q) || people[p]?.username?.includes(mention.q))).slice(0, 6)
    : []
  // Bot commands: type "/" in a chat with a bot (or tap its menu button).
  const bots = (chat?.group ? members : [id]).filter((p) => people[p]?.bot?.cmds?.length)
  const allCmds = bots.flatMap((b) => people[b]!.bot!.cmds!.map((c) => ({ bot: b, c })))
  const [cmdOff, setCmdOff] = useState(false)
  const [ci, setCi] = useState(0)
  const [cmdBot, setCmdBot] = useState<string | null>(null)
  const slash = !editing && !cmdOff && allCmds.length ? /^\/([a-z0-9_-]*)$/i.exec(text) : null
  const argM = !editing && !cmdOff && allCmds.length ? /^\/([a-z0-9_-]+)\s+([\s\S]*)$/i.exec(text) : null
  const argCmd = argM ? allCmds.find((x) => x.c.n === argM[1].toLowerCase() && (!cmdBot || x.bot === cmdBot)) : undefined
  const argWords = argM ? argM[2].split(/\s+/) : []
  // Options are filled in order; past the last one there's nothing more to suggest.
  const opt = argCmd?.c.o?.[argWords.length - 1]
  const val = argWords.at(-1) ?? ''
  const [sugg, setSugg] = useState<{ l: string; v: string }[]>([])
  useEffect(() => {
    setSugg([])
    if (!opt?.auto || !argCmd) return
    const t = setTimeout(async () => setSugg(await fog.suggest(id, argCmd.bot, argCmd.c.n, opt.n, val, argM?.[2] ?? val)), 250)
    return () => clearTimeout(t)
  }, [opt?.auto, opt?.n, argCmd?.bot, argCmd?.c.n, val, id])
  const cmdItems = slash ? allCmds.filter((x) => x.c.n.startsWith(slash[1].toLowerCase())).concat(allCmds.filter((x) => !x.c.n.startsWith(slash[1].toLowerCase()) && x.c.n.includes(slash[1].toLowerCase()))).slice(0, 60) : []
  const choiceItems = opt ? (opt.ch ? opt.ch.filter((ch) => !val || ch.l.toLowerCase().includes(val.toLowerCase()) || ch.v.toLowerCase().startsWith(val.toLowerCase())) : sugg) : []
  const picker = cmdItems.length ? cmdItems.length : choiceItems.length
  const [emoji, setEmoji] = useState(false)
  const [attachMenu, setAttachMenu] = useState<MenuAt | null>(null)
  const [rec, setRec] = useState<Recording | null>(null)
  const [polling, setPolling] = useState(false)
  const [note, setNote] = useState<VideoNoteRec | null>(null)
  const linkPreviews = useFog((s) => s.settings.linkPreviews)
  const [link, setLink] = useState<LinkPreview | 'loading' | null>(null)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const typedUrl = linkPreviews && !editing && !fog.isLocalChat(id) ? (/https?:\/\/[^\s<]+[^\s<.,:;"')\]!?]/.exec(text)?.[0] ?? null) : null
  useEffect(() => {
    if (!typedUrl || typedUrl === dismissed) return setLink(null)
    setLink('loading')
    let live = true
    const t = setTimeout(async () => {
      const p = await fog.fetchPreview(typedUrl)
      if (!live) return
      if (!p) return setLink(null)
      const img = p.image ? await previewThumb(p.image) : undefined
      // The card points at the URL as typed and is labelled with its real host (receivers check both).
      if (live) setLink({ url: typedUrl, title: p.title, desc: p.desc, site: URL.parse(typedUrl)?.hostname.replace(/^www\./, ''), img })
    }, 500)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [typedUrl, dismissed])
  const ref = useRef<HTMLTextAreaElement>(null)
  const media = useRef<HTMLInputElement>(null)
  const anyFile = useRef<HTMLInputElement>(null)
  const textRef = useRef(text)
  textRef.current = text
  const editingRef = useRef(editing)
  editingRef.current = editing
  const recRef = useRef(rec)
  recRef.current = rec
  const saved = useRef('')

  // Where the caret goes after a programmatic insert (emoji, mention). Applied in the same commit,
  // so keystrokes typed right after can't land before it.
  const caret = useRef<number | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
    if (caret.current !== null) {
      el.focus()
      el.setSelectionRange(caret.current, caret.current)
      caret.current = null
    }
  }, [text, rec])
  // Drafts persist per chat (shown in the chat list), saved on pause and when leaving.
  useEffect(() => {
    if (editing) return
    const t = setTimeout(() => fog.setDraft(id, text), 600)
    return () => clearTimeout(t)
  }, [text, id, editing])
  useEffect(
    () => () => {
      if (!editingRef.current) fog.setDraft(id, textRef.current)
      recRef.current?.cancel()
    },
    [id],
  )
  useEffect(() => {
    if (editing) {
      saved.current = textRef.current
      setText(editing.text)
    } else if (saved.current) {
      setText(saved.current)
      saved.current = ''
    }
    if (editing || reply) ref.current?.focus()
  }, [editing, reply])
  useEffect(() => {
    if (matchMedia('(pointer: fine)').matches) ref.current?.focus()
  }, [id])

  const send = () => {
    const t = text.trim()
    if (editing) {
      if (t) fog.editMessage(id, editing.id, t)
      setText(saved.current)
      saved.current = ''
      onSent()
      return
    }
    if (!t) return
    sendText(t)
  }
  const sendText = (t: string, toBot = cmdBot) => {
    setText('')
    fog.setDraft(id, '')
    setMention(null)
    setCmdBot(null)
    onSent()
    // In a group, a command is addressed to its bot (bots there may only answer when mentioned).
    const men = members.filter((p) => (handle(p) && t.includes(handle(p)!)) || (t.startsWith('/') && p === toBot))
    fog.sendMessage(id, t, { reply: reply?.id, men, link: link && link !== 'loading' ? link : undefined, th: thread ?? undefined })
    setLink(null)
    setDismissed(null)
  }
  const pickCmd = (x: (typeof allCmds)[number]) => {
    if (!x.c.o?.length) return sendText(`/${x.c.n}`, x.bot)
    setCmdBot(x.bot)
    caret.current = x.c.n.length + 2
    setText(`/${x.c.n} `)
    setCi(0)
  }
  const pickChoice = (v: string) => {
    const head = text.slice(0, text.length - val.length)
    caret.current = head.length + v.length + 1
    setText(`${head}${v} `)
    setCi(0)
  }
  const pickMention = (p: string) => {
    const el = ref.current!
    const at = el.selectionStart ?? text.length
    const start = text.slice(0, at).lastIndexOf('@')
    const token = `${handle(p)} `
    caret.current = start + token.length
    setText(text.slice(0, start) + token + text.slice(at))
    setMention(null)
  }
  const insert = (e: string) => {
    const el = ref.current!
    const [a, b] = [el.selectionStart ?? text.length, el.selectionEnd ?? text.length]
    caret.current = a + e.length
    setText(text.slice(0, a) + e + text.slice(b))
  }
  const startRec = async () => {
    try {
      setRec(await record())
    } catch {
      fog.toast('Fog needs microphone access to record voice messages')
    }
  }
  const stopRec = async () => {
    const r = rec
    setRec(null)
    const att = await r?.stop()
    if (att) onVoice(att)
    else fog.toast('Record for at least a second to send a voice message')
  }
  const bar = reply ?? editing
  const canSend = !!text.trim()
  const who = (m: Msg) => (m.mine ? 'yourself' : chat?.group ? personName(m.from ?? '') : title)

  return (
    <div data-slide className="shrink-0 border-t border-line/60 bg-panel px-2 pt-2 pb-[max(0.6rem,var(--safe-bottom))] sm:px-4 lg:px-5">
      <div className="relative">
        {bar && !rec && (
          <div key={bar.id + (editing ? 'e' : 'r')} className="rise mb-2 flex items-center gap-3 rounded-xl px-2">
            <Icon name={editing ? 'pencil' : 'reply'} className="size-5 shrink-0 text-lamp" />
            <div className="min-w-0 flex-1 border-l-[3px] border-lamp pl-2.5">
              <p className="text-sm font-semibold text-lamp">{editing ? 'Edit message' : `Reply to ${who(bar)}`}</p>
              <p className="truncate text-sm text-muted">{snippet(bar)}</p>
            </div>
            <IconButton icon="close" label="Cancel" onClick={onCancel} />
          </div>
        )}
        {emoji && (
          <EmojiPanel
            onPick={insert}
            onClose={() => setEmoji(false)}
            onSticker={
              editing
                ? undefined
                : (a) => {
                    setEmoji(false)
                    onSent()
                    fog.sendAtt(id, a, '', reply?.id, thread ?? undefined)
                  }
            }
          />
        )}
        {link && !rec && !bar && (
          <div className="rise mb-2 flex items-center gap-3 rounded-xl px-2">
            <Icon name="link" className="size-5 shrink-0 text-lamp" />
            {link !== 'loading' && link.img && <img src={link.img} alt="" className="size-10 shrink-0 rounded-md object-cover" />}
            <div className="min-w-0 flex-1 border-l-[3px] border-lamp pl-2.5">
              {link === 'loading' ? (
                <p className="text-sm text-muted">Loading preview…</p>
              ) : (
                <>
                  <p className="truncate text-sm font-semibold text-lamp">{link.site ?? link.title}</p>
                  <p className="truncate text-sm text-muted">{link.title && link.site ? link.title : link.desc}</p>
                </>
              )}
            </div>
            <IconButton icon="close" label="Remove link preview" onClick={() => setDismissed(typedUrl)} />
          </div>
        )}
        {picker > 0 && !rec && (
          <div role="listbox" aria-label={cmdItems.length ? 'Bot commands' : `Choices for ${opt?.n}`} className="menu-in scroll-thin absolute bottom-full left-0 z-30 mb-2 max-h-[min(360px,50dvh)] w-[min(420px,100%)] origin-bottom-left overflow-y-auto rounded-2xl bg-panel p-1.5 shadow-[0_12px_40px_-8px_rgba(0,0,0,0.35)] ring-1 ring-black/5 dark:ring-white/10">
            {!cmdItems.length && opt && (
              <p className="px-2 pt-1 pb-1.5 text-[13px] text-muted">
                <span className="font-semibold text-ink">{opt.n}</span>
                {opt.d && ` · ${opt.d}`}
              </p>
            )}
            {cmdItems.length
              ? cmdItems.map((x, k) => (
                  <button
                    key={`${x.bot}/${x.c.n}`}
                    role="option"
                    aria-selected={k === ci % picker}
                    onMouseDown={(e) => (e.preventDefault(), pickCmd(x))}
                    className={`flex w-full items-center gap-3 rounded-xl px-2 py-1.5 text-left ${k === ci % picker ? 'bg-hover' : ''}`}
                  >
                    {bots.length > 1 && <Avatar id={x.bot} name={personName(x.bot, people[x.bot])} src={people[x.bot]?.avatar} size={28} />}
                    <span className="min-w-0 flex-1">
                      <span className="font-semibold">/{x.c.n}</span>
                      {x.c.o?.map((o) => (
                        <span key={o.n} className="ml-1.5 font-mono text-[13px] text-muted">
                          {o.req ? `<${o.n}>` : `[${o.n}]`}
                        </span>
                      ))}
                      {x.c.d && <span className="block truncate text-[13.5px] text-muted">{x.c.d}</span>}
                    </span>
                  </button>
                ))
              : choiceItems.map((ch, k) => (
                  <button
                    key={ch.v}
                    role="option"
                    aria-selected={k === ci % picker}
                    onMouseDown={(e) => (e.preventDefault(), pickChoice(ch.v))}
                    className={`flex w-full items-center gap-3 rounded-xl px-2 py-1.5 text-left ${k === ci % picker ? 'bg-hover' : ''}`}
                  >
                    <span className="min-w-0 flex-1 truncate">{ch.l}</span>
                    {ch.l !== ch.v && <span className="truncate font-mono text-[13px] text-muted">{ch.v}</span>}
                  </button>
                ))}
          </div>
        )}
        {candidates.length > 0 && (
          <div role="listbox" aria-label="Mention someone" className="menu-in absolute bottom-full left-0 z-30 mb-2 w-[min(320px,100%)] origin-bottom-left overflow-hidden rounded-2xl bg-panel p-1.5 shadow-[0_12px_40px_-8px_rgba(0,0,0,0.35)] ring-1 ring-black/5 dark:ring-white/10">
            {candidates.map((p, k) => (
              <button
                key={p}
                role="option"
                aria-selected={k === mention!.i}
                onMouseDown={(e) => (e.preventDefault(), pickMention(p))}
                className={`flex w-full items-center gap-3 rounded-xl px-2 py-1.5 text-left ${k === mention!.i ? 'bg-hover' : ''}`}
              >
                <Avatar id={p} name={personName(p, people[p])} src={people[p]?.avatar} size={32} />
                <span className="min-w-0 flex-1 truncate font-medium">{personName(p, people[p])}</span>
                {people[p]?.username && people[p]?.name && <span className="text-sm text-muted">@{people[p]!.username}</span>}
              </button>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2">
          {rec ? (
            <Recorder rec={rec} onCancel={() => (rec.cancel(), setRec(null))} onSend={stopRec} />
          ) : (
            <div className="flex min-h-12 flex-1 items-end rounded-[24px] bg-raised ring-1 ring-transparent transition focus-within:ring-lamp/40">
              <button
                data-emoji-toggle
                onClick={() => setEmoji((v) => !v)}
                aria-label="Emoji"
                title="Emoji"
                className={`grid size-12 shrink-0 place-items-center rounded-full transition ${emoji ? 'text-lamp' : 'text-muted hover:text-ink'}`}
              >
                <Icon name="smile" />
              </button>
              {bots.length > 0 && !editing && (
                <button
                  onClick={() => (setCmdOff(false), setText(text.startsWith('/') ? '' : '/'), ref.current?.focus())}
                  aria-label="Bot commands"
                  title="Bot commands"
                  className={`-ml-2 grid size-12 shrink-0 place-items-center rounded-full font-mono text-[20px] font-semibold transition ${slash ? 'text-lamp' : 'text-muted hover:text-ink'}`}
                >
                  /
                </button>
              )}
              <textarea
                ref={ref}
                value={text}
                rows={1}
                onChange={(e) => {
                  setText(e.target.value)
                  if (!e.target.value.startsWith('/')) (setCmdOff(false), setCmdBot(null))
                  setCi(0)
                  if (!editing) fog.typing(id)
                  const at = chat?.group && /(?:^|\s)@([\p{L}\p{N}_]*)$/u.exec(e.target.value.slice(0, e.target.selectionStart ?? undefined))
                  setMention(at ? { q: at[1].toLowerCase(), i: 0 } : null)
                }}
                onKeyDown={(e) => {
                  if (picker && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
                    e.preventDefault()
                    setCi((i) => (i + (e.key === 'ArrowDown' ? 1 : picker - 1)) % picker)
                    return
                  }
                  if (picker && e.key === 'Tab') {
                    e.preventDefault()
                    if (cmdItems.length) pickCmd(cmdItems[ci % picker])
                    else pickChoice(choiceItems[ci % picker].v)
                    return
                  }
                  if (picker && e.key === 'Enter' && !e.shiftKey && (choiceItems.length ? !cmdItems.length && val !== choiceItems[ci % picker].v : cmdItems[ci % picker].c.n !== slash?.[1].toLowerCase())) {
                    e.preventDefault()
                    if (cmdItems.length) pickCmd(cmdItems[ci % picker])
                    else pickChoice(choiceItems[ci % picker].v)
                    return
                  }
                  if (picker && e.key === 'Escape') {
                    e.stopPropagation()
                    setCmdOff(true)
                    return
                  }
                  if (candidates.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
                    e.preventDefault()
                    setMention((m) => m && { ...m, i: (m.i + (e.key === 'ArrowDown' ? 1 : candidates.length - 1)) % candidates.length })
                  } else if (candidates.length && (e.key === 'Enter' || e.key === 'Tab')) {
                    e.preventDefault()
                    pickMention(candidates[mention!.i] ?? candidates[0])
                  } else if (candidates.length && e.key === 'Escape') {
                    e.stopPropagation()
                    setMention(null)
                  } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault()
                    send()
                  } else if (e.key === 'Escape' && (reply || editing)) {
                    e.stopPropagation()
                    onCancel()
                  } else if (e.key === 'ArrowUp' && !text && !editing) {
                    e.preventDefault()
                    onEditLast()
                  }
                }}
                onPaste={(e) => {
                  const fs = [...e.clipboardData.files]
                  if (fs.length) (e.preventDefault(), onFiles(fs))
                }}
                placeholder={editing ? 'Edit message' : 'Message'}
                aria-label="Message"
                className="scroll-thin max-h-[200px] flex-1 resize-none bg-transparent py-3 text-[16px] leading-6 outline-none placeholder:text-muted md:text-[15.5px]"
              />
              {!editing && (
                <button
                  onClick={(e) => {
                    const r = e.currentTarget.getBoundingClientRect()
                    setAttachMenu({ x: r.right, y: r.top - 8 })
                  }}
                  aria-label="Attach"
                  title="Attach"
                  className="grid size-12 shrink-0 place-items-center rounded-full text-muted transition hover:text-ink"
                >
                  <Icon name="clip" />
                </button>
              )}
            </div>
          )}
          <input ref={media} type="file" accept="image/*,video/*" multiple hidden onChange={(e) => (e.target.files?.length && onFiles([...e.target.files]), (e.target.value = ''))} />
          <input ref={anyFile} type="file" multiple hidden onChange={(e) => (e.target.files?.length && onFiles([...e.target.files]), (e.target.value = ''))} />
          {rec || canSend || editing ? (
            <button
              key="send"
              onClick={rec ? stopRec : send}
              disabled={!rec && !canSend}
              aria-label={editing ? 'Save edit' : rec ? 'Send voice message' : 'Send'}
              className="pop grid size-12 shrink-0 place-items-center rounded-full bg-lamp text-lamp-ink transition hover:brightness-105 active:scale-90 disabled:opacity-50"
            >
              <Icon name={editing ? 'check' : 'send'} className="size-6 translate-x-px" />
            </button>
          ) : (
            <button key="mic" onClick={startRec} aria-label="Record voice message" title="Record voice message" className="pop grid size-12 shrink-0 place-items-center rounded-full bg-raised text-muted transition hover:text-ink active:scale-90">
              <Icon name="mic" />
            </button>
          )}
        </div>
      </div>
      {attachMenu && (
        <Menu at={attachMenu} onClose={() => setAttachMenu(null)}>
          <MenuItem icon="image" label="Photo or video" onClick={() => (setAttachMenu(null), media.current?.click())} />
          <MenuItem icon="file" label="File" onClick={() => (setAttachMenu(null), anyFile.current?.click())} />
          <MenuItem
            icon="videonote"
            label="Video message"
            onClick={async () => {
              setAttachMenu(null)
              try {
                setNote(await recordVideoNote())
              } catch {
                fog.toast('Fog needs camera and microphone access to record a video message')
              }
            }}
          />
          {!fog.isLocalChat(id) && <MenuItem icon="poll" label="Poll" onClick={() => (setAttachMenu(null), setPolling(true))} />}
        </Menu>
      )}
      {note && (
        <VideoNoteRecorder
          rec={note}
          onCancel={() => (note.cancel(), setNote(null))}
          onSend={async (v) => {
            const r = note
            setNote(null)
            const att = await r.stop(v)
            if (att) onVoice(att)
          }}
        />
      )}
      {polling && (
        <PollDialog
          onClose={() => setPolling(false)}
          onSend={(poll) => {
            setPolling(false)
            onSent()
            fog.sendMessage(id, '', { poll, reply: reply?.id, th: thread ?? undefined })
          }}
        />
      )}
    </div>
  )
}
