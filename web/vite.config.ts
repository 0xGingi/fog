import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig(({ mode }) => {
  // `--mode desktop` reads .env.desktop (VITE_FOG_SERVER=https://getfog.org); a real env var wins.
  const env = loadEnv(mode, import.meta.dirname, 'VITE_')
  const desktop = mode === 'desktop'

  // Strict CSP for production builds (dev needs inline scripts for HMR). XSS here would mean stolen keys.
  // Native builds talk to a remote server, so it joins connect-src.
  const server = env.VITE_FOG_SERVER ? new URL(env.VITE_FOG_SERVER) : null
  const connect = server ? `'self' ${server.origin} ${server.protocol === 'https:' ? 'wss' : 'ws'}://${server.host}` : "'self'"
  const csp: Plugin = {
    name: 'csp',
    apply: 'build',
    transformIndexHtml: (html) =>
      html.replace(
        '<head>',
        `<head>\n    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src ${connect}; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'" />`,
      ),
  }

  return {
    plugins: [react(), tailwindcss(), csp],
    // getfog.org/ is the landing page and the app lives at /app/. The desktop app only needs the app.
    build: desktop
      ? { outDir: 'dist-desktop', rollupOptions: { input: { app: 'app/index.html' } } }
      : { rollupOptions: { input: { landing: 'index.html', app: 'app/index.html' } } },
    server: { proxy: { '/ws': { target: 'ws://127.0.0.1:8787', ws: true }, '/blob': 'http://127.0.0.1:8787', '/sealed': 'http://127.0.0.1:8787' } },
  }
})
