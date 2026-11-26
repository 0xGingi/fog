// A complete fog-bot bot in TypeScript (Bun, Deno or Node 18+; no dependencies).
//
//   FOG_BOT_TOKEN=$(fog-bot token) bun bot.ts
//
// It shows the whole loop: commands in the / menu, a streamed reply, buttons, a dropdown, a form, and
// files both ways. Replace `reply()` with your agent.
const API = process.env.FOG_BOT_URL ?? 'http://127.0.0.1:8790'
const TOKEN = process.env.FOG_BOT_TOKEN!
const auth = { authorization: `Bearer ${TOKEN}` }
const q = encodeURIComponent // chat and message ids go in URLs; group ids contain ':'

async function call<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(API + path, { method, headers: { ...auth, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${await r.text()}`)
  return r.json() as Promise<T>
}
const send = async (chat: string, text: string, extra: object = {}) => (await call('POST', `/v1/chats/${q(chat)}/messages`, { text, ...extra })).message
const edit = (chat: string, id: string, fields: object) => call('PATCH', `/v1/chats/${q(chat)}/messages/${q(id)}`, fields)

/** Your agent goes here. This one just talks back. */
const reply = (text: string) => `You said: **${text}**\n\nTry \`/buttons\`, \`/form\` or send me a file.`

/** Show a reply as it's being written: send it `live`, edit it, then finish with live: false. */
async function stream(chat: string, text: string, where: object) {
  const words = text.split(' ')
  const msg = await send(chat, words[0], { live: true, ...where })
  for (let i = 1; i <= words.length; i += 3) {
    await edit(chat, msg.id, { text: words.slice(0, i).join(' ') })
    await new Promise((r) => setTimeout(r, 150))
  }
  await edit(chat, msg.id, { text, live: false })
}

async function onMessage(m: any) {
  const chat = m.chat.id
  const thread = m.thread?.id
  const where = thread ? { thread_id: thread } : {}
  // In groups, only answer when mentioned (or inside a thread).
  if (m.chat.type === 'group' && !m.mentions_me && !thread) return
  await call('POST', `/v1/chats/${q(chat)}/typing`)
  if (m.text?.startsWith('/buttons')) {
    await send(chat, 'Deploy to production?', {
      ...where,
      card: { title: 'Approval needed', color: '#e0a030' },
      buttons: [
        [
          { text: 'Deploy', data: 'deploy:yes', style: 'primary' },
          { text: 'Cancel', data: 'deploy:no', style: 'danger' },
        ],
        { select: { id: 'env', placeholder: 'Or pick an environment', options: [{ label: 'Staging', value: 'staging' }, { label: 'Production', value: 'prod' }] } },
      ],
    })
  } else if (m.text?.startsWith('/form')) {
    await send(chat, 'I need a code to continue.', { ...where, buttons: [[{ text: 'Enter code', data: 'ask:code' }]] })
  } else if (m.attachment) {
    const a = m.attachment
    const data = await (await fetch(`${API}/v1/files/${q(a.file_id)}`, { headers: auth })).arrayBuffer()
    const up = await (await fetch(`${API}/v1/files?name=${q('copy-' + a.name)}&kind=${a.kind}`, { method: 'POST', headers: { ...auth, 'content-type': a.mime }, body: data })).json()
    await send(chat, `Got **${a.name}** (${data.byteLength} bytes). Here it is back:`, { ...where, file_id: up.file.file_id, reply_to: m.id })
  } else {
    await stream(chat, reply(m.text ?? ''), where)
  }
  await call('POST', `/v1/chats/${q(chat)}/read`)
}

async function onButton(e: any) {
  const answer = (a: object) => call('POST', `/v1/buttons/${q(e.query_id)}/answer`, a)
  if (e.data.startsWith('deploy:')) {
    const go = e.data === 'deploy:yes'
    await answer({ text: go ? 'Deploying…' : 'Cancelled' })
    // Settle the card so it can't be tapped twice.
    await edit(e.chat.id, e.message_id, { buttons: null, card: { title: go ? 'Deployed' : 'Cancelled', color: go ? '#2e9d5b' : '#888888' } })
  } else if (e.data === 'env') {
    await answer({ text: `Environment: ${e.values[0]}` })
  } else if (e.data === 'ask:code') {
    await answer({ form: { id: 'code', title: 'One-time code', fields: [{ id: 'code', label: 'Code', placeholder: '6 digits', secret: true, required: true, min_length: 6, max_length: 6 }] } })
  } else if (e.data === 'code') {
    // the form came back: e.fields.code
    await answer({ text: 'Thanks, code received.', alert: true })
  }
}

await call('PATCH', '/v1/me', { about: 'Example bot: try /buttons or /form' })
await call('PUT', '/v1/commands', {
  commands: [
    { name: 'buttons', description: 'Show buttons and a dropdown' },
    { name: 'form', description: 'Ask for a code in a form' },
  ],
})
// Start from now: don't replay old events (taps in them would have expired anyway).
let offset: number = (await call('GET', '/v1/events?offset=-1')).next
console.log('listening…')
for (;;) {
  let r: { events: any[]; next: number }
  try {
    r = await call('GET', `/v1/events?offset=${offset}&timeout=30`)
  } catch (err) {
    console.log('waiting for fog-bot:', (err as Error).message) // fog-bot restarting: try again shortly
    await new Promise((res) => setTimeout(res, 3000))
    continue
  }
  for (const e of r.events) {
    try {
      if (e.type === 'message') await onMessage(e.message)
      else if (e.type === 'button') await onButton(e)
    } catch (err) {
      console.log('API error:', (err as Error).message)
    }
  }
  offset = r.next // confirms everything handled so far
}
