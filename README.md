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

Fog is a self-hostable, end-to-end encrypted messenger built on Signal's Rust `libsignal` crate (compiled to WebAssembly for the browser, the apps and bots). The server is a minimal Rust relay that stores prekeys and queued ciphertext — it holds no user keys and never sees plaintext.

## Features

- **Identity without PII:** Accounts are generated locally from a 24-word BIP39 recovery phrase. Claim an optional `@username`, share QR codes or invite links, and restore your identity on a new device from your phrase.
- **Rich messaging:** Replies (swipe or menu), reactions, edit, delete for everyone, forward, multi-select, polls, pinned messages, disappearing messages (timer starts on read), drafts, mark unread, mute, archive, `@mentions`, in-chat and global search (on this device; accents ignored, all words matched, covers links and polls), message info, Saved Messages (local notes), a built-in Fog Guide chat for new accounts (scripted, on the device only), and inline text formatting.
- **Media & files:** Photos, video, round video messages, voice notes (with waveform and 1.5&times;/2&times; playback), audio, personal sticker packs (animated GIF/WebP/APNG too), a private saved-GIF collection (no GIF service involved), opt-in link previews, and any file type up to 2 GB (big ones upload in resumable chunks) with an inline plain-text/code viewer.
- **Voice & video calls:** End-to-end encrypted 1:1 and group calls (up to 8 people) with screen sharing (fitted, zoomable, tap to hide the controls). Calls are relayed through your own server's TURN by default, so the people you call never see your IP address; group calls always are. On phones, an incoming call rings even when the app is closed.
- **Private groups:** Up to 50 members over pairwise Signal sessions with signed group state and fork detection.
- **Encrypted profiles & privacy controls:** Display name and avatar are shared end-to-end encrypted only with people you message. Includes Message Requests for strangers, silent blocking, safety number verification (numbers + QR scan), and an optional App Lock (passcode and/or passkey).
- **Bots and AI agents:** Run any Fog account as a bot with [`fog-bot`](bot/README.md), which keeps the keys on your machine and gives your bot a local HTTP API (there's also a [skill](bot/skill/fog-bot/SKILL.md) that teaches AI agents to build on it). Bots get a badge, a `/` command menu (with choices and live suggestions), buttons, dropdowns, forms, cards, Markdown (tables, code, lists), replies that stream in as they're written, and messages only one group member sees. [Hermes Agent](https://github.com/NousResearch/hermes-agent) connects with the [hermes-fog](https://github.com/0xGingi/hermes-fog) plugin. The server can't tell a bot from a person.
- **Installable web app:** Progressive Web App (PWA) with light/dark themes, adjustable text size, notification sounds, keyboard and screen-reader accessibility, long-press touch menus, and paged rendering for long histories.

## Security Model

| Property | Implementation |
| --- | --- |
| **Account Identity** | BIP39 24-word phrase &rarr; HKDF-SHA256 &rarr; Curve25519 Signal identity key. Your account ID is the base64url-encoded 32-byte public key. |
| **No Key Swaps (No TOFU)** | Clients trust an identity only if it matches the peer's account ID verbatim — no "safety number changed" warnings to click through. The remaining risk is the server lying about which ID a `@username` belongs to: chat info shows a safety number and a scannable safety code (Signal's fingerprint format); scanning or comparing it marks the contact **Verified**. |
| **Message Encryption** | Signal Protocol directly from [`signalapp/libsignal`](https://github.com/signalapp/libsignal): **PQXDH** (X25519 + Kyber-1024) and the **Double Ratchet with SPQR**. One-time post-quantum prekeys are preferred before falling back to the last-resort key, and signed prekeys rotate weekly (old keys kept 30 days for in-flight messages). |
| **Authentication** | Challenge-response login using an XEdDSA signature over a server nonce bound to the connected host, preventing cross-server challenge relay. |
| **Multiple Devices** | Up to five devices per account: the **main device** (the one with your recovery phrase) plus linked browsers or desktop apps. Each device has its own device ID, prekeys and Signal sessions; senders encrypt a separate copy for every device, and the server rejects a send that doesn't cover exactly the recipient's current devices, so a stale device list gets corrected instead of a device being skipped. Every device's prekeys are signed by the account's identity key, so the server can't slip in a device of its own. Linking is a QR code: the main device sends the identity key and your chat history to the new device, end-to-end encrypted (X25519 + HKDF + AES-256-GCM; history as an encrypted blob). Linked devices never receive the recovery phrase. Device 1 must also sign in with a key derived from the phrase, so only the main device can link or unlink devices, and unlinking takes effect on the server immediately. Restoring the phrase on a new device makes it the main device and signs out every linked one. |
| **Sealed Sender** | Once two accounts are contacts, messages, receipts, typing indicators, and reactions are sent to a login-free `/sealed` endpoint gated by an E2EE-shared access key, using short-lived sender certificates. The server stores no sender for sealed traffic. First messages to strangers are unsealed (as in Signal). |
| **Metadata Padding** | Every message is padded to a multiple of 160 bytes before encryption, so the server can't tell a "k" from a sentence, or a receipt from a reaction, by size. |
| **Attachments** | Any file up to 2 GB, padded to ~5% size buckets (Signal's scheme) and encrypted client-side with a fresh **AES-256-GCM** key per file. Files over 32 MB are sealed in 4 MB chunks (the chunk index is the nonce, and an end-of-file flag is authenticated), so reordered, swapped or truncated chunks fail to decrypt, only one chunk is in memory at a time, and uploads resume where they stopped. Only ciphertext is uploaded; the blob ID and key travel inside the Signal message. Non-inline MIME types are served as `application/octet-stream` so attached `.html` or `.svg` files cannot run script on the app origin. |
| **Groups** | Encrypted pairwise to every member so the server sees ordinary 1:1 traffic and learns nothing about group membership. Group state (members, name, photo) is versioned and XEdDSA-signed by the owner; clients detect and warn on owner equivocation (forked member lists). |
| **Voice & Video Calls** | WebRTC DTLS-SRTP media encryption with SDP offers/answers (including DTLS fingerprints) carried inside the Signal session so the server cannot MITM keys. Self-hosted STUN/TURN means no third-party STUN provider learns who is calling; **Relay all calls** (on by default) hides your IP from the people you call. Group calls are a mesh of the same encrypted connections, always relayed: a group can include people you've never met. Their signalling (ring, join, leave) travels as end-to-end encrypted group messages, so the server doesn't learn who's in a call. |
| **Chat Backup** | On the main device, once a day when something changed, the chat history (messages, contacts, groups, profile; attachments as their encrypted pointers) is gzipped and encrypted with **AES-256-GCM** under a key derived from the recovery phrase (HKDF-SHA256, `fog/backup/v1`), then uploaded like an attachment. The server keeps only the latest one and sees only its size. Restoring the account from the phrase on a new device downloads and decrypts it. Only an upload the account reserved as a backup can become one. Turning backups off deletes the server's copy. |
| **Push Notifications** | Phone apps only. When a message or call arrives while Fog is closed or in the background, the server sends a push through Apple (APNs) or Google (FCM) that says only "New message": no sender, chat or content, which still travel only over the encrypted connection once Fog opens. Senders mark which messages are worth a push (messages and incoming calls, not receipts or typing), so the server learns that one bit about sealed messages, as in Signal. Apple or Google learn that your device got something, and when. Turn notifications off in Settings and the token is deleted from the server. Incoming calls ring: on iPhone a time-sensitive "Incoming call" notification with a ringtone the app generates on the device; on Android a full-screen ringing screen over the lock screen. Answering always needs the phone unlocked first, so nothing of Fog shows on a locked phone. (CallKit isn't used: Fog's calls run in the web view, whose microphone iOS cuts while the phone is locked.) |
| **Bots** | A bot is an ordinary account: `fog-bot` runs the same client engine as the app, with the keys on the bot owner's machine, so bot chats are end-to-end encrypted like any other. Its badge, description and commands travel in its encrypted profile. Taps on its buttons and form answers are end-to-end encrypted messages to the bot alone, and the bot only receives taps on buttons it really sent. Its local API listens on 127.0.0.1 behind a token. The badge, commands, buttons and "to you" marks are what the sender's account says about itself: any account can set them, so they aren't a verified role or a delivery guarantee. Bot Markdown is drawn without HTML and with a nesting limit, form answers must match the form the bot sent (once), and taps only count on buttons the bot sent. |
| **Link Previews** | **Off by default** in Privacy settings. When enabled, fetched by the sender's Fog server with SSRF hardening (public IPs only, DNS-pinned resolution, re-checked redirects, 512 KB / 6 s limits) and embedded inside the encrypted message so recipients never contact the target site. |
| **App Lock (At Rest)** | Optional encryption of all local IndexedDB data (keys, chats, cached attachments) under a random AES-256-GCM data key wrapped by your passcode (**Argon2id**, 64 MiB / 3 passes) and/or a **WebAuthn PRF passkey** (HKDF-SHA256). Auto-lock reloads the page to clear all keys from memory. |
| **Web Hardening** | Strict Content Security Policy (as a header and in the page), reproducible builds you can check against the live site (see [Verifying the web app](#verifying-the-web-app)), a desktop app that ships the client instead of downloading it each visit, self-hosted fonts (zero third-party requests), single-tab key ownership via Web Locks, and atomic persistence of ratchet state before acknowledging messages. |
| **Abuse Limits** | Every request except signup needs a registered (proof-of-work) account; per-account limits plus per-network limits (IPv6 counted per /64) on lookups and prekey fetches; signup proof-of-work + per-IP signup burst cap, 10,000 queued messages / 256 MB per recipient, 2 GB/day upload quota, automatic expiry (30 days for undelivered messages, 45 days for encrypted blobs), Message Requests quarantine, blocking, and in-app reporting. |

> **What the server still sees:** Claimed `@username`s, the IP address you connect from (a sealed message still arrives from your IP — hiding that requires Tor, a VPN, or a mixnet), who sends unsealed first-contact messages to strangers, and rough timing and volume of traffic.
>
> **Limits we can't fully close:**
> - *Web delivery.* A web app is only as trustworthy as the server that serves it. A compromised server could ship modified JavaScript. Mitigations: the desktop app, and reproducible builds anyone can compare with the live site.
> - *Key directory.* There's no key transparency log (a separate, large project). Instead, verify safety numbers with people who matter.
> - *Linked devices hold the identity key.* As in Signal, so a stolen linked device can read what it already has and, if it also had the server's cooperation, could be re-added. Unlinking stops it receiving anything new; restoring your phrase on a new device signs out everything else.

## Desktop App

The desktop app ([Tauri](https://tauri.app)) wraps the same client in a native window and talks to `https://getfog.org`. It loads only files bundled at build time, and the page can call exactly two native commands: show a notification, and set the unread count (shown next to the menu bar icon and on the Dock). No other Tauri APIs are granted. Closing the window keeps Fog running in the menu bar (system tray on Windows and Linux) so messages and calls keep arriving; quit from its menu.

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

**Auto-updates.** The desktop app checks for a newer release at launch and every 6 hours, installs it in the background, and offers to restart. Updates are signed: each release publishes `latest.json` (from `uploadUpdaterJson`) and the app only installs files whose signature matches the public key in [`tauri.conf.json`](web/src-tauri/tauri.conf.json). Checking happens in the app's Rust layer, so the web page still has no native access. The private key lives in the `TAURI_SIGNING_PRIVATE_KEY` repository secret. **Keep a backup of it**: without it you can't ship updates to existing installs. Linux updates apply to the AppImage; `.deb`/`.rpm` installs update through a new download.

## Mobile Apps

The same client also builds for **Android** (an APK attached to every release as `Fog-Android.apk`) and **iOS** (uploaded to TestFlight; [join the public beta](https://testflight.apple.com/join/A5GN8ENf)), from [`web/src-tauri`](web/src-tauri) with Tauri 2. The phone apps use their own bundle ID, `org.getfog.app`.

**Build locally:**

```sh
cd web && bun install && bun run core
bunx tauri android build --apk     # needs Java 17, the Android SDK and NDK (NDK_HOME)
bunx tauri ios build               # needs Xcode
```

**App icons.** The iPhone icon must be a full square with no transparency (iOS rounds the corners itself), so it comes from [`icons/ios-icon.svg`](web/src-tauri/icons/ios-icon.svg) rather than the rounded `public/icon.svg`. After running `tauri icon`, regenerate the iOS set from that file and save the PNGs without an alpha channel, or App Store uploads are rejected.

**Notifications** come through Apple's and Google's push services when the server is configured for them (see [Push notifications](#push-notifications)). A push says only "New message"; open Fog to see what it is. Android needs Google Play services for push; without them Fog notifies only while it's open.

**Updates.** iPhones update through TestFlight. The Android app checks the latest release at launch and offers to download and install a newer APK; Android installs it only if it's signed with the same key as the installed app.

**Not there yet:** passkey unlock isn't available in the phone apps (passcode lock works). Muted chats still get the generic "New message" push, since the server can't know which chat a message belongs to.

**Release secrets.** The release workflow builds the phone apps when these repository secrets exist:

| Secret | What it is |
| --- | --- |
| `FOG_ANDROID_KEYSTORE_B64`, `FOG_ANDROID_KEYSTORE_PASSWORD` | Android signing keystore (base64) and its password. **Keep a backup**: Android only installs updates signed with the same key. |
| `IOS_CERTIFICATE`, `IOS_CERTIFICATE_PASSWORD` | Apple Distribution certificate (`.p12`, base64) and its password |
| `IOS_MOBILE_PROVISION` | App Store provisioning profile for `org.getfog.app` (base64) |
| `APPSTORE_API_KEY_ID`, `APPSTORE_API_ISSUER_ID`, `APPSTORE_API_KEY` | App Store Connect API key (Key ID, Issuer ID, contents of the `.p8`), for uploading to TestFlight |
| `GOOGLE_SERVICES_JSON` | The Firebase project's `google-services.json` for `org.getfog.app` (Android push). Optional: without it the APK can't get pushes. |

### Push notifications

The phone apps register a push token with the server; the server needs credentials to use them. Both are optional, and each platform works on its own.

- **Apple:** in the developer portal, Keys &rarr; **+** &rarr; *Apple Push Notifications service (APNs)*. Download the `.p8`, then set `FOG_APNS_KEY` (path to it), `FOG_APNS_KEY_ID` and `FOG_APNS_TEAM`. The App ID needs the Push Notifications capability.
- **Google:** create a Firebase project and add an Android app with package `org.getfog.app`. Its `google-services.json` goes in the `GOOGLE_SERVICES_JSON` secret (the app side). For the server, Project settings &rarr; Service accounts &rarr; *Generate new private key*, and point `FOG_FCM_ACCOUNT` at that file.

With Docker Compose, put the key files in `./push/` next to `compose.yaml` (it's mounted at `/push`) and set the variables in `.env`, e.g. `FOG_APNS_KEY=/push/AuthKey_XXXXXXXXXX.p8`.

## Architecture

```text
.
├── core/     Rust crypto core (fog-core) wrapping libsignal.
│             Compiles to WebAssembly for the web client and native Rust for bots/desktop/mobile.
├── server/   Rust relay (fog-server) built with axum + SQLite.
│             Handles WebSocket auth, prekey bundles, sealed delivery, encrypted blobs,
│             SSRF-hardened link previews, built-in dev STUN, and serving the web bundle.
├── bot/      fog-bot: runs an account as a bot with the client engine (Bun) and a local HTTP API.
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
| `FOG_APNS_KEY`, `FOG_APNS_KEY_ID`, `FOG_APNS_TEAM` | *(unset)* | iPhone push: path to the APNs `.p8` key, its Key ID, and your Apple team ID. See [Push notifications](#push-notifications). |
| `FOG_APNS_TOPIC` | `org.getfog.app` | The iOS app's bundle ID. |
| `FOG_FCM_ACCOUNT` | *(unset)* | Android push: path to the Firebase service account `.json`. |
| `FOG_LEGACY_MAIN_LOGIN` | *(unset)* | Set only if this server has accounts from before main-device keys that never signed in since (`SELECT count(*) FROM accounts WHERE main IS NULL`). It lets each of them record its key on its next sign-in; without it they're refused. Unset it once that count is 0. |

## Roadmap

Deliberate architectural shortcuts are marked `ponytail:` in the source code so they are easy to find and revisit.

**Next up**
- Signal Sender Keys for larger groups (>50 members) and multi-admin permissions

*Not planned: GIF search from a catalog. Tenor's API is gone, and GIPHY and KLIPY require each device to contact them directly (no proxy), which would hand users' IPs and searches to an ad/tracking company. Fog has saved GIFs instead.*

**Agents & bots**
- Threads in groups (so an agent can keep one conversation per topic, like Discord threads)
- Bots in group voice calls (listen and speak)
- An OpenClaw channel plugin over the same API

## License

Licensed under the [GNU Affero General Public License v3.0](LICENSE) (`AGPL-3.0-only`), as required by linking `libsignal` in both the client core and the relay server.
