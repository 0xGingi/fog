// The app's engine (web/src/fog.ts) was written for a browser tab. This gives it the few browser things
// it touches, as a tab that is always open and in front: no page, no theme, no notifications.
// Imported before anything from web/src.
const g = globalThis as any
const noop = () => {}
const server = process.env.FOG_SERVER || 'https://getfog.org'
// media.ts reads the server from here (vite's name for it).
process.env.VITE_FOG_SERVER = server

g.window = g
const el = () => ({ dataset: {}, style: { setProperty: noop }, setAttribute: noop })
g.document = {
  visibilityState: 'visible',
  hidden: false,
  hasFocus: () => true,
  addEventListener: noop,
  documentElement: el(),
  querySelector: () => null,
}
g.matchMedia = () => ({ matches: false, addEventListener: noop })
g.location = { origin: server, protocol: new URL(server).protocol, hostname: 'fog-bot', host: 'fog-bot', hash: '', pathname: '/', reload: () => process.exit(75) }
g.history = { replaceState: noop }
const mem = new Map<string, string>()
g.sessionStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => mem.set(k, v), removeItem: (k: string) => mem.delete(k) }
// One process per account (the data folder is locked in store.ts), so the tab lock is always ours.
Object.defineProperty(navigator, 'locks', { value: { request: (_: string, f: () => unknown) => f() } })
Object.defineProperty(navigator, 'userAgent', { value: 'fog-bot' })
Object.defineProperty(navigator, 'maxTouchPoints', { value: 0 })
