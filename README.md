<p align="center">
  <img src="web/public/icon.svg" width="84" height="84" alt="Fog icon" />
</p>

<h1 align="center">Fog</h1>

<p align="center">
  <strong>End-to-end encrypted messaging with no phone number, email, or password.</strong><br />
  Your account is a cryptographic key derived from a 24-word recovery phrase.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue.svg" alt="License: AGPL-3.0" /></a>
  <img src="https://img.shields.io/badge/protocol-Signal%20PQXDH%20%2B%20SPQR-orange.svg" alt="Signal PQXDH + SPQR" />
  <img src="https://img.shields.io/badge/stack-Rust%20%C2%B7%20WASM%20%C2%B7%20React-black.svg" alt="Rust, WebAssembly, React" />
</p>

<p align="center">
  <a href="#features">Features</a> &middot;
  <a href="#security-model">Security Model</a> &middot;
  <a href="#architecture">Architecture</a> &middot;
  <a href="#local-development">Local Development</a> &middot;
  <a href="#self-hosting">Self-Hosting</a> &middot;
  <a href="#roadmap">Roadmap</a>
</p>

---

Fog is a self-hostable, end-to-end encrypted messenger built on Signal's Rust `libsignal` crate (compiled to WebAssembly for the browser and native Rust for future bots/clients). The server is a minimal Rust relay that stores prekeys and queued ciphertext — it holds no user keys and never sees plaintext.

## Features

- **Identity without PII:** Accounts are generated locally from a 24-word BIP39 recovery phrase. Claim an optional `@username`, share QR codes or invite links, and restore your identity on a new device from your phrase.
- **Rich messaging:** Replies (swipe or menu), reactions, edit, delete for everyone, forward, multi-select, polls, pinned messages, disappearing messages (timer starts on read), drafts, mark unread, mute, archive, `@mentions`, in-chat and global search, message info, Saved Messages (local notes), and inline text formatting.
- **Media & files:** Photos, video, round video messages, voice notes (with waveform and 1.5&times;/2&times; playback), audio, personal sticker packs, opt-in link previews, and any file type up to 100 MB with an inline plain-text/code viewer.
- **1:1 Voice & video calls:** End-to-end encrypted WebRTC calls with screen sharing, built-in STUN/TURN support, and a "Relay all calls" option to hide your IP address from peers.
- **Private groups:** Up to 50 members over pairwise Signal sessions with signed group state and fork detection.
- **Encrypted profiles & privacy controls:** Display name and avatar are shared end-to-end encrypted only with people you message. Includes Message Requests for strangers, silent blocking, safety number verification (numbers + QR scan), and an optional App Lock (passcode and/or passkey).
- **Installable web app:** Progressive Web App (PWA) with light/dark themes, adjustable text size, notification sounds, keyboard and screen-reader accessibility, long-press touch menus, and paged rendering for long histories.

## Security Model

| Property | Implementation |
| --- | --- |
| **Account Identity** | BIP39 24-word phrase &rarr; HKDF-SHA256 &rarr; Curve25519 Signal identity key. Your account ID is the base64url-encoded 32-byte public key. |
| **No Key Swaps (No TOFU)** | Clients trust an identity only if it matches the peer's account ID verbatim — no "safety number changed" warnings to click through. The remaining risk is the server lying about which ID a `@username` belongs to: chat info shows a safety number and a scannable safety code (Signal's fingerprint format); scanning or comparing it marks the contact **Verified**. |
| **Message Encryption** | Signal Protocol directly from [`signalapp/libsignal`](https://github.com/signalapp/libsignal): **PQXDH** (X25519 + Kyber-1024) and the **Double Ratchet with SPQR**. One-time post-quantum prekeys are preferred before falling back to the last-resort key, and signed prekeys rotate weekly (old keys kept 30 days for in-flight messages). |
| **Authentication** | Challenge-response login using an XEdDSA signature over a server nonce bound to the connected host, preventing cross-server challenge relay. |
| **Sealed Sender** | Once two accounts are contacts, messages, receipts, typing indicators, and reactions are sent to a login-free `/sealed` endpoint gated by an E2EE-shared access key, using short-lived sender certificates. The server stores no sender for sealed traffic. First messages to strangers are unsealed (as in Signal). |
| **Metadata Padding** | Every message is padded to a multiple of 160 bytes before encryption, so the server can't tell a "k" from a sentence, or a receipt from a reaction, by size. |
| **Attachments** | Any file up to 100 MB, padded to ~5% size buckets (Signal's scheme) and encrypted client-side with a fresh **AES-256-GCM** key per file. Only ciphertext is uploaded; the blob ID and key travel inside the Signal message. Non-inline MIME types are served as `application/octet-stream` so attached `.html` or `.svg` files cannot run script on the app origin. |
| **Groups** | Encrypted pairwise to every member so the server sees ordinary 1:1 traffic and learns nothing about group membership. Group state (members, name, photo) is versioned and XEdDSA-signed by the owner; clients detect and warn on owner equivocation (forked member lists). |
| **Voice & Video Calls** | WebRTC DTLS-SRTP media encryption with SDP offers/answers (including DTLS fingerprints) carried inside the Signal session so the server cannot MITM keys. Self-hosted STUN/TURN means no third-party STUN provider learns who is calling; enabling **Relay all calls** hides your IP from peers. |
| **Link Previews** | **Off by default** in Privacy settings. When enabled, fetched by the sender's Fog server with SSRF hardening (public IPs only, DNS-pinned resolution, re-checked redirects, 512 KB / 6 s limits) and embedded inside the encrypted message so recipients never contact the target site. |
| **App Lock (At Rest)** | Optional encryption of all local IndexedDB data (keys, chats, cached attachments) under a random AES-256-GCM data key wrapped by your passcode (**Argon2id**, 64 MiB / 3 passes) and/or a **WebAuthn PRF passkey** (HKDF-SHA256). Auto-lock reloads the page to clear all keys from memory. |
| **Web Hardening** | Strict Content Security Policy (as a header and in the page), reproducible builds you can check against the live site (see [Verifying the web app](#verifying-the-web-app)), a desktop app that ships the client instead of downloading it each visit, self-hosted fonts (zero third-party requests), single-tab key ownership via Web Locks, and atomic persistence of ratchet state before acknowledging messages. |
| **Abuse Limits** | Every request except signup needs a registered (proof-of-work) account; per-account limits plus per-network limits (IPv6 counted per /64) on lookups and prekey fetches; signup proof-of-work + per-IP signup burst cap, 10,000 queued messages / 256 MB per recipient, 2 GB/day upload quota, automatic expiry (30 days for undelivered messages, 45 days for encrypted blobs), Message Requests quarantine, blocking, and in-app reporting. |

> **What the server still sees:** Claimed `@username`s, the IP address you connect from (a sealed message still arrives from your IP — hiding that requires Tor, a VPN, or a mixnet), who sends unsealed first-contact messages to strangers, and rough timing and volume of traffic.
>
> **Limits we can't fully close:**
> - *Web delivery.* A web app is only as trustworthy as the server that serves it. A compromised server could ship modified JavaScript. Mitigations: the desktop app, and reproducible builds anyone can compare with the live site.
> - *Key directory.* There's no key transparency log (a separate, large project). Instead, verify safety numbers with people who matter.

## Desktop App

The desktop app ([Tauri](https://tauri.app)) wraps the same client in a native window. It loads only files bundled at build time, grants the page no native commands, and talks to `https://getfog.org`.

**Download:** [latest release](https://github.com/0xGingi/fog/releases/latest) for macOS (Apple silicon), Windows (x64) and Linux (x64, arm64; AppImage, deb, rpm).

**Build it yourself:**

```sh
cd web && bun install && bun run core
bun run desktop                  # point it elsewhere: VITE_FOG_SERVER=https://example.com bun run desktop
```

On macOS the bundle includes camera/microphone usage descriptions and entitlements for calls. Passkey unlock isn't available inside the desktop webview yet; passcode lock works.

### Releasing

[`release.yml`](.github/workflows/release.yml) builds every platform when you push a version tag:

```sh
git tag v0.2.0 && git push origin v0.2.0
```

The tag sets the app version, and the release is published with the installers as soon as every platform has built. Installers have version-free names (`Fog-macOS-arm64.dmg`, `Fog-Windows-x64-setup.exe`, `Fog-Linux-x64.AppImage`, …), so the landing page's download buttons (`releases/latest/download/<file>`) always serve the newest release. Running the workflow by hand from the Actions tab builds everything as workflow artifacts without making a release.

The crypto core is compiled to WebAssembly once and shared by every platform build. [`ci.yml`](.github/workflows/ci.yml) runs the Rust tests, the web build and the end-to-end protocol test on every push and pull request.

**macOS signing.** Without Apple credentials the app is ad-hoc signed: it runs, but macOS says it can't verify the developer on first open (right-click → Open, or `xattr -dr com.apple.quarantine /Applications/Fog.app`). To sign and notarize, add these repository secrets and the workflow uses them automatically:

| Secret | What it is |
| --- | --- |
| `APPLE_CERTIFICATE` | Developer ID Application certificate, exported as `.p12` and base64-encoded |
| `APPLE_CERTIFICATE_PASSWORD` | Password for that `.p12` |
| `APPLE_SIGNING_IDENTITY` | e.g. `Developer ID Application: Your Name (TEAMID)` |
| `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` | Apple ID, an app-specific password, and your team ID, for notarization |

Windows builds are unsigned for now, so SmartScreen warns on first run until a code-signing certificate is added.

## Architecture

```text
.
├── core/     Rust crypto core (fog-core) wrapping libsignal.
│             Compiles to WebAssembly for the web client and native Rust for bots/desktop/mobile.
├── server/   Rust relay (fog-server) built with axum + SQLite.
│             Handles WebSocket auth, prekey bundles, sealed delivery, encrypted blobs,
│             SSRF-hardened link previews, built-in dev STUN, and serving the web bundle.
├── web/      React 19 + TypeScript + Vite + Tailwind CSS 4 client (managed with Bun).
│             index.html is the getfog.org landing page; app/index.html is the app.
│             src-tauri/ holds the desktop shell.
└── deploy/   Production Caddyfile (automatic HTTPS, no access logs) and coturn config.
```

## Local Development

### Prerequisites

- **Rust** toolchain (`rustup`) with the WASM target:
  ```sh
  rustup target add wasm32-unknown-unknown
  cargo install wasm-bindgen-cli --version 0.2.130 --locked
  ```
- **Protocol Buffers compiler** (`protoc`), required to build `libsignal`:
  ```sh
  # macOS
  brew install protobuf
  # Debian / Ubuntu
  sudo apt install protobuf-compiler
  ```
- **[Bun](https://bun.sh/)** for the web client.

### Run locally

1. Install web dependencies and build the WASM crypto core:
   ```sh
   cd web && bun install && bun run core
   ```
2. Start the relay server (terminal 1 — listens on `127.0.0.1:8787` and STUN on `127.0.0.1:3478`):
   ```sh
   cargo run -p fog-server
   ```
3. Start the Vite dev server (terminal 2 — serves the landing page at `http://localhost:5173` and the app at `http://localhost:5173/app/`, and proxies `/ws`, `/blob`, and `/sealed`):
   ```sh
   cd web && bun run dev
   ```

To test chatting or calling yourself, open a second browser profile or a private/incognito window.

### Tests

```sh
# Rust unit tests: crypto roundtrips, spoofing/replay rejection, key rotation,
# sealed sender, Argon2id, safety QR codes, XEdDSA auth, STUN, TURN HMAC, PoW, rate limits
cargo test

# End-to-end protocol test against a running fog-server on 127.0.0.1:8787
cd web && bun e2e.ts
```

## Self-Hosting

Everything runs from [`compose.yaml`](compose.yaml):

- **`fog`** — single Rust binary serving the API, WebSocket relay, and built web app.
- **`caddy`** — automatic HTTPS via Let's Encrypt with HSTS and **no access logs**.
- **`turn`** — `coturn` STUN/TURN relay for WebRTC calls (refuses relaying into private/loopback networks; short-lived HMAC credentials are minted per user by `fog-server`).

### Setup

1. **DNS:** Create `A`/`AAAA` records for `<your-domain>` and `www.<your-domain>` pointing to your host.
2. **Firewall:** Open the following ports:

   | Port | Protocol | Purpose |
   | --- | --- | --- |
   | `80` | TCP | HTTP / ACME challenge |
   | `443` | TCP + UDP | HTTPS + HTTP/3 |
   | `3478` | TCP + UDP | STUN / TURN |
   | `49160–49260` | UDP | TURN media relay ports |

3. **Configure environment:**
   ```sh
   cp .env.example .env
   ```
   Edit `.env`:
   ```env
   FOG_DOMAIN=example.com
   FOG_TURN_SECRET=<output of: openssl rand -hex 32>
   ```
   If your host sits behind 1:1 NAT (AWS, GCP, many VPS providers), uncomment and set `external-ip` in [`deploy/turnserver.conf`](deploy/turnserver.conf).

4. **Build & launch:**
   ```sh
   docker compose up -d --build
   ```
   *(The first build compiles `libsignal` from source and takes several minutes.)*

5. **Move the sealed-sender trust root offline:**
   On first startup, `fog-server` writes `trust-root.key` next to `fog.db` (inside the `fog-data` volume) and never stores that private key in SQLite. Copy `trust-root.key` to offline storage (password manager or hardware backup) and remove it from the server. You only need it if you ever rotate the server certificate:
   ```sh
   fog-server rotate-server-cert /path/to/trust-root.key
   ```

6. **Verify:** Visit `https://<your-domain>` (landing page; the app is at `/app/`), create two accounts in two browser profiles, and test messaging and calling between them.

Persistent data (SQLite database and encrypted attachment blobs) lives in the `fog-data` Docker volume. It contains no user keys and no plaintext.

### Verifying the Web App

Build images are pinned to exact versions, so the web app builds byte-for-byte the same from the same commit. To check what a server is actually serving:

```sh
git checkout <deployed commit>
docker build -t fog . && docker create --name fogv fog
docker cp fogv:/srv/web ./my-build && docker rm fogv
bun web/verify.ts https://getfog.org ./my-build
```

Every file must match. `index.html` names each script by its content hash, so a full match means your browser runs exactly this code.

### Server Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `FOG_ADDR` | `127.0.0.1:8787` | Listen address (`0.0.0.0:8787` in Docker). |
| `FOG_DB` | `fog.db` | Path to the SQLite database file (`/data/fog.db` in Docker). |
| `FOG_BLOBS` | `blobs` | Directory for encrypted attachment blobs (`/data/blobs` in Docker). |
| `FOG_WEB` | *(unset)* | Directory containing the built web app to serve statically (`/srv/web` in Docker). |
| `FOG_STUN` | `127.0.0.1:3478` | Built-in STUN listener address, or `off` when using `coturn` in production. |
| `FOG_HOST` | *(required in production)* | Your domain. Logins are bound to it and WebSocket requests for any other Host are refused, so a malicious server can't relay a login challenge to yours. The server won't start without it when listening beyond localhost or serving the web app; without it (local development) only `localhost` / `127.0.0.1` / `[::1]` Host names are accepted. Set by `compose.yaml`. |
| `FOG_ICE_HOST` | *(request Host)* | Public hostname advertised for STUN/TURN ICE servers. |
| `FOG_TURN_SECRET` | *(unset)* | Shared HMAC secret matching `coturn`'s `--static-auth-secret`. |
| `FOG_TRUST_PROXY` | *(unset)* | Set to any non-empty value behind a reverse proxy (e.g. Caddy) to read client IPs from `X-Forwarded-For`. |
| `FOG_POW_BITS` | `20` | Leading zero bits required for signup proof-of-work. |
| `FOG_SIGNUP_BURST` | `10` | New accounts allowed per IP in a burst (refills at 1/min). |
| `FOG_CORS_ORIGINS` | `tauri://localhost,http://tauri.localhost` | Comma-separated origins allowed to call `/blob` and `/sealed` cross-origin (the desktop app). |

## Roadmap

Deliberate architectural shortcuts are marked `ponytail:` in the source code so they are easy to find and revisit.

**Next up**
- Multi-device support: linked devices sharing the identity key (as in Signal), each with its own device ID and prekeys
- Signal Sender Keys for larger groups (>50 members) and multi-admin permissions
- Streaming/chunked encryption and resumable uploads for files over 100 MB
- Group calls, animated stickers, and privacy-preserving GIF search (via proxy)

**First-class Agents & Bots (Hermes, OpenClaw)**
In Fog, a bot is just a regular account with its own identity key, so it automatically gets full E2EE and every client feature:
1. **`fog-bot` daemon:** Native Rust daemon built on `fog-core` holding bot keys and exposing a local HTTP API shaped like the Telegram Bot API (`getUpdates`, webhooks, `sendMessage`, `editMessageText`, `sendChatAction`, inline keyboards) for drop-in compatibility with existing Telegram adapters.
2. **Native plugins:** Thin channel/platform plugins for OpenClaw and Hermes over the daemon.
3. **Client UX:** Bot badges, interactive buttons, Markdown rendering, streamed edits for token-by-token replies, and QR/link "add an agent" onboarding.

## License

Licensed under the [GNU Affero General Public License v3.0](LICENSE) (`AGPL-3.0-only`), as required by linking `libsignal` in both the client core and the relay server.
