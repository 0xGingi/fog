// Telegram text + entities -> Fog Markdown. Everything that isn't formatting is backslash-escaped, so
// "2*3*4" or "# not a heading" arrive exactly as written.

export type Entity = { kind: string; offset: number; length: number; params: { url?: string; language?: string } }

const ESC = new Set(['\\', '`', '*', '_', '~', '|', '[', ']'])
const LINE_MARK = /^ *(?:([#>+-])|\d{1,9}([.)]))/ // what would start a heading, quote, list or rule
const URL_RE = /https?:\/\/[^\s<]+/g
const longestRun = (s: string, c: string) => Math.max(0, ...(s.match(new RegExp(`\\${c}+`, 'g')) ?? []).map((r) => r.length))
const wordChar = (c: string | undefined) => !!c && /[\p{L}\p{N}_]/u.test(c)

export function toMarkdown(text: string, entities: readonly Entity[] = []): string {
  // At each position: what closes there, then what opens. [length, order, text]
  const ins = new Map<number, { open: [number, number, string][]; close: [number, number, string][] }>()
  const at = (n: number) => ins.get(n) ?? (ins.set(n, { open: [], close: [] }), ins.get(n)!)
  const literal = new Uint8Array(text.length) // code and addresses aren't escaped
  for (const u of text.matchAll(URL_RE)) literal.fill(1, u.index, u.index + u[0].length)
  let order = 0
  const pair = (s: number, e: number, open: string, close: string) => {
    const n = order++
    at(s).open.push([e - s, n, open])
    at(e).close.push([e - s, n, close])
  }

  for (const ent of entities) {
    const s0 = Math.max(0, ent.offset)
    const e0 = Math.min(text.length, ent.offset + ent.length)
    if (e0 <= s0) continue
    const body = text.slice(s0, e0)
    if (ent.kind === 'pre') {
      literal.fill(1, s0, e0)
      const fence = '`'.repeat(Math.max(3, longestRun(body, '`') + 1))
      const lang = /^[\w+#.-]{1,32}$/.test(ent.params.language ?? '') ? ent.params.language : ''
      pair(s0, e0, `${s0 && text[s0 - 1] !== '\n' ? '\n' : ''}${fence}${lang}\n`, `\n${fence}${e0 < text.length && text[e0] !== '\n' ? '\n' : ''}`)
      continue
    }
    if (ent.kind === 'blockquote') {
      at(s0).open.push([Infinity, order++, `${s0 && text[s0 - 1] !== '\n' ? '\n' : ''}> `])
      for (let i = s0; i < e0 - 1; i++) if (text[i] === '\n') at(i + 1).open.push([Infinity, order++, '> '])
      if (e0 < text.length && text[e0] !== '\n') at(e0).close.push([-1, order++, '\n'])
      continue
    }
    // Inline formatting stops at line ends in Fog, so each line gets its own markers.
    for (let s = s0; s < e0; ) {
      const nl = text.indexOf('\n', s)
      let e = nl < 0 || nl > e0 ? e0 : nl
      const next = e + 1
      // Markers can't sit against whitespace: move it outside.
      while (s < e && /\s/.test(text[s]!)) s++
      while (e > s && /\s/.test(text[e - 1]!)) e--
      if (e > s) {
        const seg = text.slice(s, e)
        if (ent.kind === 'bold') pair(s, e, '**', '**')
        else if (ent.kind === 'strikethrough') pair(s, e, '~~', '~~')
        else if (ent.kind === 'spoiler') pair(s, e, '||', '||')
        // Fog only reads _italic_ between non-letters, so mid-word italic stays plain.
        else if (ent.kind === 'italic' && !wordChar(text[s - 1]) && !wordChar(text[e])) pair(s, e, '_', '_')
        else if (ent.kind === 'code') {
          literal.fill(1, s, e)
          const ticks = '`'.repeat(longestRun(seg, '`') + 1)
          const pad = seg.startsWith('`') || seg.endsWith('`') ? ' ' : ''
          pair(s, e, ticks + pad, pad + ticks)
        } else if (ent.kind === 'text_link' && ent.params.url && /^https?:\/\//i.test(ent.params.url)) {
          const url = ent.params.url
          if (/^[^()\s<>]+$/.test(url) && !/[[\]]/.test(seg)) pair(s, e, '[', `](${url})`)
          else if (seg !== url) pair(s, e, '', ` (${url})`)
        }
      }
      s = next
    }
  }

  const escAt = new Set<number>()
  for (let l = 0; l < text.length; l = text.indexOf('\n', l) + 1 || text.length) {
    const m = LINE_MARK.exec(text.slice(l, l + 12))
    if (m) escAt.add(l + m[0].length - 1)
  }
  let out = ''
  for (let i = 0; i <= text.length; i++) {
    const x = ins.get(i)
    if (x) {
      out += x.close.sort((a, b) => a[0] - b[0] || b[1] - a[1]).map((c) => c[2]).join('')
      out += x.open.sort((a, b) => b[0] - a[0] || a[1] - b[1]).map((o) => o[2]).join('')
    }
    if (i === text.length) break
    const c = text[i]!
    out += !literal[i] && (ESC.has(c) || escAt.has(i)) ? `\\${c}` : c
  }
  return out
}

if (import.meta.main) {
  const e = (kind: string, offset: number, length: number, params = {}): Entity => ({ kind, offset, length, params })
  const eq = (a: string, b: string) => {
    if (a !== b) throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`)
  }
  eq(toMarkdown('2*3*4 [x] a_b_c'), '2\\*3\\*4 \\[x\\] a\\_b\\_c')
  eq(toMarkdown('# no\n- no\n1. no\n> no'), '\\# no\n\\- no\n1\\. no\n\\> no')
  eq(toMarkdown('see https://x.com/a_b_c ok'), 'see https://x.com/a_b_c ok')
  eq(toMarkdown('hello world', [e('bold', 0, 6)]), '**hello** world') // trailing space moved out
  eq(toMarkdown('both', [e('bold', 0, 4), e('italic', 0, 4)]), '**_both_**')
  eq(toMarkdown('one\ntwo', [e('bold', 0, 7)]), '**one**\n**two**')
  eq(toMarkdown('unbelievable', [e('italic', 2, 6)]), 'unbelievable')
  eq(toMarkdown('run a*b now', [e('code', 4, 3)]), 'run `a*b` now')
  eq(toMarkdown('x`y', [e('code', 0, 3)]), '``x`y``')
  eq(toMarkdown('code:\nlet a_b = 1', [e('pre', 6, 11, { language: 'js' })]), 'code:\n```js\nlet a_b = 1\n```')
  eq(toMarkdown('site here', [e('text_link', 0, 4, { url: 'https://a.example/p' })]), '[site](https://a.example/p) here')
  eq(toMarkdown('bad', [e('text_link', 0, 3, { url: 'javascript:alert(1)' })]), 'bad')
  eq(toMarkdown('said\nquote me\nok', [e('blockquote', 5, 8)]), 'said\n> quote me\nok')
  eq(toMarkdown('a secret', [e('spoiler', 2, 6), e('strikethrough', 0, 1)]), '~~a~~ ||secret||')
  console.log('markdown ok')
}
