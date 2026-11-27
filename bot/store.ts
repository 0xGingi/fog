// Where the bot keeps what the app keeps in IndexedDB: one SQLite file for records, and a folder for
// attachment files (they can be up to 2 GB, so they never sit in memory or in the database).
import { Database } from 'bun:sqlite'
import { serialize, deserialize } from 'bun:jsc'
import { mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Store } from '../web/src/db'

/** `gate`: whether an attachment may be written to disk (by its `att:` key); unset, anything may. */
export function openStore(dir: string): Store & { db: Database; gate?: (key: string) => boolean } {
  const files = join(dir, 'files')
  mkdirSync(files, { recursive: true, mode: 0o700 })
  const db = new Database(join(dir, 'fog.db'), { create: true, strict: true })
  db.run('PRAGMA journal_mode = WAL')
  db.run('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v BLOB NOT NULL)')
  const get = db.query<{ v: Uint8Array }, [string]>('SELECT v FROM kv WHERE k = ?')
  const put = db.query('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)')
  const del = db.query('DELETE FROM kv WHERE k = ?')
  // Attachment keys are uuids or blob-id.key-prefix: safe as file names once the key itself can't escape.
  const path = (k: string) => join(files, k.slice(4).replace(/[^A-Za-z0-9._-]/g, '_'))
  const isFile = (k: string) => k.startsWith('att:')
  const store: Store & { db: Database; gate?: (key: string) => boolean } = {
    db,
    async get(k) {
      if (isFile(k)) {
        const f = Bun.file(path(k))
        if (!(await f.exists())) return undefined
        const type = get.get(`type:${k}`)
        return type ? f.slice(0, f.size, new TextDecoder().decode(type.v)) : f
      }
      const r = get.get(k)
      return r ? deserialize(r.v) : undefined
    },
    async put(k, v) {
      if (isFile(k)) {
        if (store.gate && !store.gate(k)) throw new Error('not_allowed')
        await Bun.write(path(k), v as Blob)
        put.run(`type:${k}`, new TextEncoder().encode((v as Blob).type))
        return
      }
      put.run(k, serialize(v, { binaryType: 'nodebuffer' }))
    },
    async del(k) {
      if (isFile(k)) {
        rmSync(path(k), { force: true })
        del.run(`type:${k}`)
        return
      }
      del.run(k)
    },
    async keys() {
      return [...db.query<{ k: string }, []>("SELECT k FROM kv WHERE k NOT LIKE 'type:att:%'").all().map((r) => r.k), ...(existsSync(files) ? readdirSync(files).map((f) => `att:${f}`) : [])]
    },
    async clear() {
      db.run('DELETE FROM kv')
      rmSync(files, { recursive: true, force: true })
      mkdirSync(files, { recursive: true, mode: 0o700 })
    },
  }
  return store
}
