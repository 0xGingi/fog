// Checks that a Fog server serves exactly the web app you built yourself.
//   docker build -t fog . && docker create --name fogv fog && docker cp fogv:/srv/web ./served-build && docker rm fogv
//   bun web/verify.ts https://getfog.org ./served-build
// Every file must match byte-for-byte. index.html pins every script by hashed name, so a match on all
// files means the code your browser runs is the code in this repo at that commit.
import { readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'

const [origin, dir = join(import.meta.dir, 'dist')] = process.argv.slice(2)
if (!origin) throw new Error('usage: bun verify.ts <https://server> [dist dir]')
const sha = async (b: ArrayBuffer) => Buffer.from(await crypto.subtle.digest('SHA-256', b)).toString('hex')

let bad = 0
const files = (await readdir(dir, { recursive: true, withFileTypes: true })).filter((f) => f.isFile())
for (const f of files) {
  const path = relative(dir, join(f.parentPath, f.name)).split('\\').join('/')
  const local = await sha(await Bun.file(join(dir, path)).arrayBuffer())
  const res = await fetch(`${origin}/${path === 'index.html' ? '' : path}`)
  const remote = res.ok ? await sha(await res.arrayBuffer()) : `HTTP ${res.status}`
  const ok = local === remote
  if (!ok) bad++
  console.log(`${ok ? 'match   ' : 'MISMATCH'} ${local.slice(0, 16)} ${path}`)
}
console.log(bad ? `\n${bad} of ${files.length} files differ. Don't trust this server's web app.` : `\nAll ${files.length} files match.`)
process.exit(bad ? 1 : 0)
