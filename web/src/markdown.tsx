// Markdown for bot messages (headings, lists, tables, quotes, code, links), the way language models
// write it. Builds React nodes only, never HTML strings, so a message can't inject markup. Unfinished
// syntax (a reply still streaming in, an unclosed code block) renders as well as it can.
import { useState, useSyncExternalStore, type ReactNode } from 'react'
import { copy, Dialog, Button, Icon } from './ui'

// ---------- links: a link whose text isn't its address asks first, so "[mybank.com](evil.example)" can't fool anyone ----------
let asking: string | null = null
const al = new Set<() => void>()
export function openLink(url: string) {
  asking = url
  al.forEach((l) => l())
}
export function LinkCheck() {
  const url = useSyncExternalStore(
    (l) => (al.add(l), () => al.delete(l)),
    () => asking,
  )
  if (!url) return null
  const close = () => openLink(null as unknown as string)
  const host = URL.parse(url)?.host ?? url
  return (
    <Dialog
      title="Open this link?"
      onClose={close}
      actions={
        <>
          <Button kind="ghost" onClick={close}>
            Cancel
          </Button>
          <Button onClick={() => (window.open(url, '_blank', 'noopener,noreferrer'), close())}>Open {host}</Button>
        </>
      }
    >
      <p className="text-[15px] break-all text-muted">{url}</p>
    </Dialog>
  )
}
const safeUrl = (u: string) => (/^https?:\/\//i.test(u) ? u : null)
function Link({ href, children, plain }: { href: string; children: ReactNode; plain: boolean }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="[overflow-wrap:anywhere] underline decoration-current/40 underline-offset-2 hover:decoration-current"
      onClick={(e) => {
        e.stopPropagation()
        if (plain) return
        e.preventDefault()
        openLink(href)
      }}
    >
      {children}
    </a>
  )
}

// ---------- inline ----------
const INLINE =
  /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)|\*\*(.+?)\*\*|__(.+?)__|(?<![\p{L}\p{N}*])\*(?!\s)(.+?)(?<!\s)\*(?![\p{L}\p{N}*])|(?<![\p{L}\p{N}_])_(?!\s)(.+?)(?<!\s)_(?![\p{L}\p{N}_])|~~(.+?)~~|\|\|(.+?)\|\||\[([^\]\n]+)\]\(\s*<?([^)\s>]+)>?\s*\)|(https?:\/\/[^\s<]+[^\s<.,:;"')\]!?*_])|((?<![\w@])@[a-z][a-z0-9_]{2,31}\b)/gu

function Spoiler({ children }: { children: ReactNode }) {
  const [shown, setShown] = useState(false)
  return (
    <span onClick={(e) => (e.stopPropagation(), setShown(true))} className={shown ? 'rounded bg-black/[0.06] px-0.5 dark:bg-white/10' : 'cursor-pointer rounded bg-black/25 px-0.5 text-transparent select-none dark:bg-white/30'} aria-label={shown ? undefined : 'Spoiler, tap to show'}>
      {children}
    </span>
  )
}

export function inline(s: string, key: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let i = 0
  for (const m of s.matchAll(INLINE)) {
    if (m.index > last) out.push(s.slice(last, m.index))
    const k = `${key}.${i++}`
    if (m[1]) out.push(<code key={k} className="rounded-md bg-black/[0.07] px-1 py-px font-mono text-[0.88em] dark:bg-white/10">{m[2].trim() ? m[2].replace(/^ (.*) $/, '$1') : m[2]}</code>)
    else if (m[3] ?? m[4]) out.push(<strong key={k} className="font-semibold">{inline(m[3] ?? m[4], k)}</strong>)
    else if (m[5] ?? m[6]) out.push(<em key={k}>{inline(m[5] ?? m[6], k)}</em>)
    else if (m[7]) out.push(<s key={k}>{inline(m[7], k)}</s>)
    else if (m[8]) out.push(<Spoiler key={k}>{inline(m[8], k)}</Spoiler>)
    else if (m[9]) {
      const href = safeUrl(m[10])
      out.push(
        href ? (
          <Link key={k} href={href} plain={m[9] === m[10]}>
            {inline(m[9], k)}
          </Link>
        ) : (
          m[0]
        ),
      )
    } else if (m[11])
      out.push(
        <Link key={k} href={m[11]} plain>
          {m[11]}
        </Link>,
      )
    else if (m[12]) out.push(<span key={k} className="mention">{m[12]}</span>)
    last = m.index + m[0].length
  }
  if (last < s.length) out.push(s.slice(last))
  return out
}
/** Inline text keeping single line breaks (chat replies rely on them). */
const lines = (ls: string[], key: string) => ls.flatMap((l, i) => (i ? [<br key={`${key}br${i}`} />, ...inline(l, `${key}l${i}`)] : inline(l, `${key}l${i}`)))

// ---------- blocks ----------
const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)/
const HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/
const QUOTE = /^ {0,3}>\s?/
const ITEM = /^( *)([-*+]|\d{1,9}[.)])\s+(.*)$/
const TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/
const cells = (l: string) => l.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'))
const startsBlock = (l: string, next?: string) => FENCE.test(l) || HR.test(l) || HEADING.test(l) || QUOTE.test(l) || ITEM.test(l) || (l.includes('|') && next !== undefined && TABLE_SEP.test(next) && next.includes('-'))

function CodeBlock({ code, lang }: { code: string; lang: string }) {
  return (
    <div className="my-1 overflow-hidden rounded-lg bg-black/[0.07] dark:bg-white/10">
      <div className="flex items-center justify-between px-2.5 pt-1.5 text-[11px] opacity-60">
        <span className="font-mono">{lang}</span>
        <button onClick={(e) => (e.stopPropagation(), copy(code, 'Code copied'))} className="rounded p-0.5 hover:opacity-100" aria-label="Copy code">
          <Icon name="copy" className="size-3.5" />
        </button>
      </div>
      <pre className="scroll-thin overflow-x-auto px-2.5 pt-1 pb-2.5 font-mono text-[0.85em] leading-relaxed">{code}</pre>
    </div>
  )
}

function blocks(src: string[], key: string): ReactNode[] {
  const out: ReactNode[] = []
  let i = 0
  const k = () => `${key}.${out.length}`
  while (i < src.length) {
    const l = src[i]
    if (!l.trim()) {
      i++
      continue
    }
    const fence = FENCE.exec(l)
    if (fence) {
      const body: string[] = []
      i++
      while (i < src.length && !src[i].trim().startsWith(fence[1])) body.push(src[i++])
      i++ // closing fence (or the end, while it's still streaming in)
      out.push(<CodeBlock key={k()} code={body.join('\n')} lang={fence[2]} />)
      continue
    }
    if (HR.test(l)) {
      out.push(<hr key={k()} className="my-2 border-current/15" />)
      i++
      continue
    }
    const h = HEADING.exec(l)
    if (h) {
      const size = ['text-[1.3em]', 'text-[1.18em]', 'text-[1.08em]', 'text-[1em]', 'text-[0.95em]', 'text-[0.9em]'][h[1].length - 1]
      out.push(
        <p key={k()} role="heading" aria-level={h[1].length} className={`mt-1 font-semibold leading-snug ${size}`}>
          {inline(h[2], k())}
        </p>,
      )
      i++
      continue
    }
    if (l.includes('|') && i + 1 < src.length && TABLE_SEP.test(src[i + 1]) && src[i + 1].includes('-')) {
      const head = cells(l)
      const align = cells(src[i + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : 'left') as 'left')
      i += 2
      const body: string[][] = []
      while (i < src.length && src[i].includes('|') && src[i].trim()) body.push(cells(src[i++]))
      out.push(
        <div key={k()} className="scroll-thin my-1 overflow-x-auto">
          <table className="border-collapse text-[0.92em]">
            <thead>
              <tr>
                {head.map((c, j) => (
                  <th key={j} style={{ textAlign: align[j] }} className="border-b border-current/20 px-2 py-1 font-semibold first:pl-0">
                    {inline(c, `${k()}h${j}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {body.map((r, ri) => (
                <tr key={ri}>
                  {head.map((_, j) => (
                    <td key={j} style={{ textAlign: align[j] }} className="border-b border-current/10 px-2 py-1 align-top first:pl-0">
                      {inline(r[j] ?? '', `${k()}c${ri}.${j}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      )
      continue
    }
    if (QUOTE.test(l)) {
      const body: string[] = []
      while (i < src.length && QUOTE.test(src[i])) body.push(src[i++].replace(QUOTE, ''))
      out.push(
        <blockquote key={k()} className="border-l-[3px] border-current/30 pl-2.5 opacity-90">
          {blocks(body, k())}
        </blockquote>,
      )
      continue
    }
    const item = ITEM.exec(l)
    if (item) {
      const indent = item[1].length
      const ordered = /\d/.test(item[2])
      const items: { lines: string[]; start: number }[] = []
      while (i < src.length) {
        const m = ITEM.exec(src[i])
        if (m && m[1].length <= indent + 1 && /\d/.test(m[2]) === ordered) {
          items.push({ lines: [m[3]], start: parseInt(m[2]) || 1 })
          i++
        } else if (items.length && src[i].trim() && (src[i].startsWith(' '.repeat(indent + 2)) || (!startsBlock(src[i], src[i + 1]) && !ITEM.test(src[i])))) {
          // A nested list or a continuation line of this item.
          items.at(-1)!.lines.push(src[i].slice(Math.min(indent + 2, src[i].length - src[i].trimStart().length)))
          i++
        } else if (!src[i].trim() && i + 1 < src.length && (src[i + 1].startsWith(' '.repeat(indent + 2)) || (ITEM.exec(src[i + 1])?.[1].length ?? -1) === indent)) i++
        else break
      }
      const List = ordered ? 'ol' : 'ul'
      out.push(
        <List key={k()} start={ordered && items[0].start !== 1 ? items[0].start : undefined} className={`space-y-0.5 pl-5 ${ordered ? 'list-decimal' : 'list-disc'} marker:opacity-60`}>
          {items.map((it, j) => {
            const task = /^\[([ xX])\]\s+/.exec(it.lines[0])
            const first = task ? it.lines[0].slice(task[0].length) : it.lines[0]
            const rest = it.lines.slice(1)
            const nestAt = rest.findIndex((x, n) => startsBlock(x, rest[n + 1]))
            const para = nestAt < 0 ? rest : rest.slice(0, nestAt)
            const nested = nestAt < 0 ? [] : rest.slice(nestAt)
            return (
              <li key={j} className={task ? 'list-none -ml-5' : undefined}>
                {task && <input type="checkbox" checked={task[1] !== ' '} readOnly className="mr-1.5 align-middle accent-current" />}
                {lines([first, ...para], `${k()}i${j}`)}
                {nested.length > 0 && blocks(nested, `${k()}n${j}`)}
              </li>
            )
          })}
        </List>,
      )
      continue
    }
    const para: string[] = []
    while (i < src.length && src[i].trim() && (!para.length || !startsBlock(src[i], src[i + 1]))) para.push(src[i++])
    out.push(<p key={k()}>{lines(para, k())}</p>)
  }
  return out
}

/** A bot message's text as Markdown. */
export function Md({ text }: { text: string }) {
  return <div className="space-y-1.5 [&_li>p]:inline">{blocks(text.replace(/\r\n?/g, '\n').split('\n'), 'md')}</div>
}

/** Markdown down to plain text, for chat-list previews and notifications. */
export const mdPlain = (t: string) =>
  t
    .replace(/^ {0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/```[\w+#.-]*\n?|`/g, '')
    .replace(/\*\*|__|~~|\|\|/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
