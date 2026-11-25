//! fog-server: authenticates accounts by key, stores prekeys, relays opaque ciphertext.
//! It never sees plaintext and holds no secrets. It does see who messages whom (see README: sealed sender).

mod preview;
mod push;

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::Router;
use axum::body::Body;
use axum::extract::ws::{Message, Utf8Bytes, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, DefaultBodyLimit, Path, State};
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode, header};
use hmac::{Hmac, KeyInit, Mac};
use tower_http::services::{ServeDir, ServeFile};
use tower_http::set_header::SetResponseHeaderLayer;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use futures_util::StreamExt;
use tokio::io::AsyncWriteExt;
use base64::Engine;
use base64::engine::general_purpose::{STANDARD as B64, URL_SAFE_NO_PAD as B64URL};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::mpsc;

const MAX_BODY: usize = 256 * 1024;
const MAX_PREKEYS: usize = 200;
/// Attachments are encrypted client-side (AES-256-GCM, key inside the E2EE message); we only store ciphertext.
const MAX_BLOB: u64 = 110 * 1024 * 1024; // 100 MB files plus up to ~5% size-bucket padding
/// Abuse limits.
const UPLOAD_BYTES_PER_DAY: u64 = 2 * 1024 * 1024 * 1024;
const MAX_QUEUED_PER_RECIPIENT: i64 = 10_000;
/// Bytes of undelivered messages per recipient.
const MAX_QUEUED_BYTES: i64 = 256 * 1024 * 1024;
const MESSAGE_TTL_DAYS: i64 = 30;
/// Devices per account: the main device plus up to four linked ones.
const MAX_DEVICES: i64 = 5;
const MAIN_DEVICE: u32 = 1;
/// A new device's link code is good for this long; the app then shows a fresh one.
const LINK_CHANNEL_LIFE: Duration = Duration::from_secs(180);
/// Sender certificates (sealed sender). Short, so a device that's been unlinked can't keep using one.
const CERT_LIFE_MS: i64 = 6 * 3_600_000;
const BLOB_TTL_DAYS: u64 = 45;

struct App {
    // ponytail: one global SQLite connection behind a mutex. Fine for thousands of users;
    // move to a pool / Postgres when write contention shows up.
    db: Mutex<Connection>,
    /// Connected devices, keyed "<account>.<device>".
    online: Mutex<HashMap<String, Online>>,
    /// Linking: an approved device slot waiting for the new device's first login (one per account).
    links: Mutex<HashMap<String, Link>>,
    /// Linking: the new device's anonymous socket, waiting for the encrypted transfer.
    channels: Mutex<HashMap<String, (mpsc::UnboundedSender<String>, Instant)>>,
    blobs: PathBuf,
    /// Upload slots handed out over the authenticated socket: id -> (max size, expiry).
    uploads: Mutex<HashMap<String, (u64, Instant)>>,
    /// Public hostname for STUN/TURN (defaults to the Host the client connected to).
    ice_host: Option<String>,
    /// Shared secret with coturn (`use-auth-secret`) for short-lived TURN credentials.
    turn_secret: Option<String>,
    limits: Limiter,
    /// Leading zero bits of proof-of-work required to create an account.
    pow_bits: u32,
    /// Behind a reverse proxy (Caddy): take the client IP from X-Forwarded-For.
    trust_proxy: bool,
    /// Canonical host logins are bound to (FOG_HOST). Unset (dev): the request's Host header.
    host: Option<String>,
    /// New accounts allowed per IP in a burst (then one per minute).
    signup_burst: f64,
    /// Sealed sender: trust root public key (sent to clients) and the server certificate + key
    /// that sign sender certificates.
    trust_root: Vec<u8>,
    server_cert: Vec<u8>,
    server_key: Vec<u8>,
    /// Push notifications (APNs / FCM), and the queue of devices to wake.
    pusher: push::Pusher,
    wakes: mpsc::UnboundedSender<(String, u32)>,
}

/// Token buckets keyed by e.g. "send:<account>" or "signup:<ip>".
// ponytail: in-memory, per process. Move to Redis if fog-server ever runs as several replicas.
#[derive(Default)]
struct Limiter(Mutex<HashMap<String, (f64, Instant)>>);

impl Limiter {
    /// Allow one event at `rate` per second with bursts up to `burst`.
    fn allow(&self, key: &str, rate: f64, burst: f64) -> bool {
        self.take(key, rate, burst, 1.0)
    }
    fn take(&self, key: &str, rate: f64, burst: f64, n: f64) -> bool {
        let mut m = self.0.lock().unwrap();
        let now = Instant::now();
        let (tokens, at) = m.entry(key.to_owned()).or_insert((burst, now));
        *tokens = (*tokens + now.duration_since(*at).as_secs_f64() * rate).min(burst);
        *at = now;
        if *tokens >= n {
            *tokens -= n;
            true
        } else {
            false
        }
    }
    fn prune(&self) {
        let cutoff = Instant::now() - Duration::from_secs(86_400);
        self.0.lock().unwrap().retain(|_, (_, at)| *at > cutoff);
    }
}

/// Proof-of-work for signup: sha256("fog-pow-v1|<nonce>|<counter>") must start with `bits` zero bits.
fn pow_ok(nonce: &str, counter: u64, bits: u32) -> bool {
    use sha2::Digest;
    let h = sha2::Sha256::digest(format!("fog-pow-v1|{nonce}|{counter}").as_bytes());
    let mut left = bits;
    for byte in h {
        if left == 0 {
            return true;
        }
        let z = byte.leading_zeros().min(left);
        if z < 8 && z < left {
            return false;
        }
        left -= z;
    }
    left == 0
}

/// A connected device: its outbox, and a switch that ends the connection (unlink, or a newer login).
struct Online {
    tx: mpsc::UnboundedSender<String>,
    end: tokio_util::sync::CancellationToken,
    /// A phone app in the background: its socket may linger, but nobody's looking, so push too.
    away: bool,
}

struct Link {
    device: u32,
    token: String,
    expires: Instant,
}

/// Who's asking, for rate limits and signup proof-of-work.
struct Ctx<'a> {
    me: &'a str,
    device: u32,
    /// Device 1's verified main-device key, saved when this login creates the account.
    main: Option<&'a str>,
    host: &'a str,
    nonce: &'a str,
    ip: IpAddr,
}

/// Same policy as the <meta> tag in index.html, sent as a real header in production.
const CSP: &str = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

type Shared = Arc<App>;

#[tokio::main]
async fn main() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let db_path = std::env::var("FOG_DB").unwrap_or("fog.db".into());
    let db = Connection::open(&db_path).expect("open db");
    // `fog-server rotate-server-cert <trust-root.key>`: issue a new sealed-sender server certificate.
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("rotate-server-cert") {
        return rotate_server_cert(&db, args.get(2).expect("usage: fog-server rotate-server-cert <trust-root.key>"));
    }
    db.execute_batch(
        "PRAGMA journal_mode=WAL;
         CREATE TABLE IF NOT EXISTS accounts(
           id TEXT PRIMARY KEY, username TEXT UNIQUE COLLATE NOCASE, keys TEXT NOT NULL, created INTEGER NOT NULL);
         CREATE TABLE IF NOT EXISTS prekeys(
           account TEXT NOT NULL, id INTEGER NOT NULL, key TEXT NOT NULL, PRIMARY KEY(account, id));
         CREATE TABLE IF NOT EXISTS messages(
           id INTEGER PRIMARY KEY AUTOINCREMENT, recipient TEXT NOT NULL, sender TEXT NOT NULL,
           body TEXT NOT NULL, ts INTEGER NOT NULL);
         CREATE INDEX IF NOT EXISTS messages_recipient ON messages(recipient, id);
         CREATE TABLE IF NOT EXISTS kyber_prekeys(
           account TEXT NOT NULL, id INTEGER NOT NULL, key TEXT NOT NULL, sig TEXT NOT NULL, PRIMARY KEY(account, id));
         CREATE TABLE IF NOT EXISTS reports(
           reporter TEXT NOT NULL, reported TEXT NOT NULL, ts INTEGER NOT NULL);
         CREATE TABLE IF NOT EXISTS server_keys(name TEXT PRIMARY KEY, value BLOB NOT NULL);
         CREATE TABLE IF NOT EXISTS devices(
           account TEXT NOT NULL, id INTEGER NOT NULL, keys TEXT, name TEXT, created INTEGER NOT NULL,
           seen INTEGER NOT NULL, PRIMARY KEY(account, id));
         CREATE TABLE IF NOT EXISTS push_tokens(
           account TEXT NOT NULL, device INTEGER NOT NULL, kind TEXT NOT NULL, token TEXT NOT NULL,
           PRIMARY KEY(account, device));",
    )
    .expect("migrate");
    migrate_devices(&db);
    let blobs = PathBuf::from(std::env::var("FOG_BLOBS").unwrap_or("blobs".into()));
    std::fs::create_dir_all(&blobs).expect("blob dir");
    // Accounts may register an access key that gates sealed (sender-less) delivery to them.
    let _ = db.execute("ALTER TABLE accounts ADD COLUMN access TEXT", []);
    let (trust_root, server_cert, server_key) = sealed_keys(&db, &std::path::Path::new(&db_path).with_file_name("trust-root.key"));
    let env = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
    let (wakes, wake_rx) = mpsc::unbounded_channel();
    let app = Arc::new(App {
        db: Mutex::new(db),
        online: Mutex::default(),
        links: Mutex::default(),
        channels: Mutex::default(),
        blobs,
        uploads: Mutex::default(),
        ice_host: env("FOG_ICE_HOST"),
        turn_secret: env("FOG_TURN_SECRET"),
        limits: Limiter::default(),
        pow_bits: env("FOG_POW_BITS").and_then(|b| b.parse().ok()).unwrap_or(20),
        trust_proxy: env("FOG_TRUST_PROXY").is_some(),
        host: env("FOG_HOST").map(|h| h.to_ascii_lowercase()),
        signup_burst: env("FOG_SIGNUP_BURST").and_then(|b| b.parse().ok()).unwrap_or(10.0),
        trust_root,
        server_cert,
        server_key,
        pusher: push::Pusher::from_env(),
        wakes,
    });
    tokio::spawn(sweep(app.clone()));
    tokio::spawn(wake_loop(app.clone(), wake_rx));
    let addr = std::env::var("FOG_ADDR").unwrap_or("127.0.0.1:8787".into());
    let listener = tokio::net::TcpListener::bind(&addr).await.expect("bind");
    // Logins are bound to the server's name. Without FOG_HOST that name comes from the request's
    // Host header, which a relaying server can forge, so only a loopback dev server may go without.
    let public = listener.local_addr().is_ok_and(|a| !a.ip().is_loopback()) || env("FOG_WEB").is_some();
    if app.host.is_none() && public {
        eprintln!("fog-server: set FOG_HOST to your domain (e.g. FOG_HOST=getfog.org). It's required when listening beyond localhost or serving the web app.");
        std::process::exit(1);
    }
    eprintln!("fog-server listening on {addr}");
    // Built-in STUN for development; in production coturn serves STUN and TURN (set FOG_STUN=off).
    let stun = std::env::var("FOG_STUN").unwrap_or("127.0.0.1:3478".into());
    if stun != "off" {
        tokio::spawn(stun_server(stun));
    }
    let mut router = Router::new()
        .route("/ws", get(upgrade))
        .route("/link", get(link_upgrade))
        .route("/blob/{id}", get(get_blob).put(put_blob).layer(DefaultBodyLimit::max(MAX_BLOB as usize)))
        .route("/sealed", post(post_sealed).layer(DefaultBodyLimit::max(MAX_BODY * 2)));
    // Production: serve the built web app: landing page at /, app at /app/, hashed assets cached
    // forever, unknown paths a 404 with the landing page.
    if let Some(dir) = env("FOG_WEB").map(PathBuf::from) {
        let assets = Router::new()
            .fallback_service(ServeDir::new(dir.join("assets")))
            .layer(SetResponseHeaderLayer::overriding(header::CACHE_CONTROL, HeaderValue::from_static("public, max-age=31536000, immutable")));
        // Lets the phone apps open invite links. Apple fetches this extensionless file and wants JSON.
        let aasa = Router::new()
            .route_service("/.well-known/apple-app-site-association", ServeFile::new(dir.join(".well-known/apple-app-site-association")))
            .layer(SetResponseHeaderLayer::overriding(header::CONTENT_TYPE, HeaderValue::from_static("application/json")));
        router = router.merge(aasa).nest("/assets", assets).fallback_service(ServeDir::new(&dir).not_found_service(ServeFile::new(dir.join("index.html"))));
    }
    let h = |k: &'static str, v: &'static str| SetResponseHeaderLayer::if_not_present(HeaderName::from_static(k), HeaderValue::from_static(v));
    let router = router
        // index.html and friends revalidate on every load so a deploy never strands old asset names.
        .layer(SetResponseHeaderLayer::if_not_present(header::CACHE_CONTROL, HeaderValue::from_static("no-cache")))
        .layer(h("content-security-policy", CSP))
        .layer(h("x-content-type-options", "nosniff"))
        .layer(h("referrer-policy", "no-referrer"))
        .layer(h("cross-origin-opener-policy", "same-origin"))
        .layer(h("permissions-policy", "camera=(self), microphone=(self), display-capture=(self), geolocation=(), browsing-topics=()"))
        .layer(cors())
        .with_state(app);
    axum::serve(listener, router.into_make_service_with_connect_info::<SocketAddr>()).await.unwrap();
}

/// Native apps (Tauri) load from their own origin and call /blob and /sealed cross-origin. No cookies
/// exist, so CORS isn't an auth boundary here; it just lets those origins read responses.
fn cors() -> tower_http::cors::CorsLayer {
    use tower_http::cors::{AllowOrigin, CorsLayer};
    let list = std::env::var("FOG_CORS_ORIGINS").ok().unwrap_or("tauri://localhost,http://tauri.localhost".into());
    let origins: Vec<HeaderValue> = list.split(',').filter_map(|o| o.trim().parse().ok()).collect();
    CorsLayer::new()
        .allow_origin(AllowOrigin::list(origins))
        .allow_methods([axum::http::Method::GET, axum::http::Method::PUT, axum::http::Method::POST])
        .allow_headers([header::CONTENT_TYPE])
}

/// Multi-device schema: per-device keys, prekeys and queues. Older databases had one device per
/// account; everything they hold becomes device 1.
fn migrate_devices(db: &Connection) {
    let has = |table: &str, col: &str| db.prepare(&format!("SELECT {col} FROM {table} LIMIT 0")).is_ok();
    let _ = db.execute("ALTER TABLE accounts ADD COLUMN main TEXT", []);
    let _ = db.execute("ALTER TABLE accounts ADD COLUMN next_device INTEGER NOT NULL DEFAULT 2", []);
    // Linked devices' own login keys (the identity key is shared, so it can't tell devices apart).
    let _ = db.execute("ALTER TABLE devices ADD COLUMN key TEXT", []);
    if !has("messages", "device") {
        db.execute_batch(
            "ALTER TABLE messages ADD COLUMN device INTEGER NOT NULL DEFAULT 1;
             ALTER TABLE messages ADD COLUMN sender_device INTEGER NOT NULL DEFAULT 1;",
        )
        .expect("migrate messages");
    }
    db.execute("CREATE INDEX IF NOT EXISTS messages_device ON messages(recipient, device, id)", []).expect("index");
    for (table, cols) in [("prekeys", "id, key"), ("kyber_prekeys", "id, key, sig")] {
        if has(table, "device") {
            continue;
        }
        let def = if table == "prekeys" { "id INTEGER NOT NULL, key TEXT NOT NULL" } else { "id INTEGER NOT NULL, key TEXT NOT NULL, sig TEXT NOT NULL" };
        db.execute_batch(&format!(
            "BEGIN;
             CREATE TABLE {table}_v2(account TEXT NOT NULL, device INTEGER NOT NULL, {def}, PRIMARY KEY(account, device, id));
             INSERT INTO {table}_v2(account, device, {cols}) SELECT account, 1, {cols} FROM {table};
             DROP TABLE {table};
             ALTER TABLE {table}_v2 RENAME TO {table};
             COMMIT;"
        ))
        .expect("migrate prekeys");
    }
    db.execute(
        "INSERT OR IGNORE INTO devices(account, id, keys, name, created, seen) SELECT id, 1, keys, NULL, created, created FROM accounts",
        [],
    )
    .expect("migrate devices");
}

/// Devices that can receive messages (they've uploaded keys).
fn active_devices(db: &Connection, account: &str) -> Vec<u32> {
    let mut st = db.prepare_cached("SELECT id FROM devices WHERE account=? AND keys IS NOT NULL ORDER BY id").expect("query");
    st.query_map([account], |r| r.get(0)).and_then(|rows| rows.collect()).unwrap_or_default()
}

/// Remove a device: its keys, queue and connection. Its owner's other devices refresh their lists.
fn remove_device(app: &App, db: &Connection, account: &str, device: u32) -> Result<(), String> {
    let e = |e: rusqlite::Error| e.to_string();
    db.execute("DELETE FROM devices WHERE account=? AND id=?", params![account, device]).map_err(e)?;
    db.execute("DELETE FROM prekeys WHERE account=? AND device=?", params![account, device]).map_err(e)?;
    db.execute("DELETE FROM kyber_prekeys WHERE account=? AND device=?", params![account, device]).map_err(e)?;
    db.execute("DELETE FROM messages WHERE recipient=? AND device=?", params![account, device]).map_err(e)?;
    db.execute("DELETE FROM push_tokens WHERE account=? AND device=?", params![account, device]).map_err(e)?;
    let key = format!("{account}.{device}");
    if let Some(c) = app.online.lock().unwrap().remove(&key) {
        let _ = c.tx.send(json!({"t": "unlinked"}).to_string());
        c.end.cancel();
    }
    let mut links = app.links.lock().unwrap();
    if links.get(account).is_some_and(|l| l.device == device) {
        links.remove(account);
    }
    Ok(())
}

/// Device-management calls need the main-device key on record (older accounts get it at first login).
fn has_main_key(db: &Connection, account: &str) -> bool {
    db.query_row("SELECT main IS NOT NULL FROM accounts WHERE id=?", [account], |r| r.get(0)).unwrap_or(false)
}

/// The device is still on the account. Checked on every request, so an unlinked device can't carry on.
fn device_exists(app: &App, account: &str, device: u32) -> bool {
    device == MAIN_DEVICE || app.db.lock().unwrap().query_row("SELECT 1 FROM devices WHERE account=? AND id=?", params![account, device], |_| Ok(())).optional().ok().flatten().is_some()
}

fn push_all(app: &App, account: &str, v: Value) {
    let prefix = format!("{account}.");
    let msg = v.to_string();
    for (k, c) in app.online.lock().unwrap().iter() {
        if k.starts_with(&prefix) {
            let _ = c.tx.send(msg.clone());
        }
    }
}

#[derive(Deserialize)]
struct DeviceMsg {
    device: u32,
    body: String,
}

/// A send must cover exactly the recipient's current devices (minus the sender's own device when
/// writing to yourself), so a stale device list is corrected instead of silently missing a device.
fn check_devices(db: &Connection, to: &str, skip: Option<u32>, msgs: &[DeviceMsg]) -> Result<(), Value> {
    let want: Vec<u32> = active_devices(db, to).into_iter().filter(|d| Some(*d) != skip).collect();
    let got: Vec<u32> = msgs.iter().map(|m| m.device).collect();
    let missing: Vec<u32> = want.iter().copied().filter(|d| !got.contains(d)).collect();
    let extra: Vec<u32> = got.iter().copied().filter(|d| !want.contains(d)).collect();
    let dup = (1..got.len()).any(|i| got[..i].contains(&got[i]));
    if missing.is_empty() && extra.is_empty() && !dup {
        Ok(())
    } else {
        Err(json!({"error": "devices", "missing": missing, "extra": extra}))
    }
}

/// Linking, new-device side: an anonymous socket that receives one end-to-end encrypted transfer
/// from the main device (which scanned this channel's id from a QR code), then closes.
async fn link_upgrade(ws: WebSocketUpgrade, headers: HeaderMap, ConnectInfo(peer): ConnectInfo<SocketAddr>, State(app): State<Shared>) -> Response {
    let ip = client_ip(&app, &headers, peer);
    if !app.limits.allow(&format!("link:{}", ip_key(ip)), 0.1, 10.0) || !app.limits.allow(&format!("link48:{}", ip_key48(ip)), 0.5, 50.0) {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    }
    ws.max_message_size(1024).on_upgrade(move |mut sock| async move {
        let id: String = rand::random::<[u8; 16]>().iter().map(|b| format!("{b:02x}")).collect();
        let (tx, mut rx) = mpsc::unbounded_channel::<String>();
        {
            let mut ch = app.channels.lock().unwrap();
            ch.retain(|_, (_, at)| at.elapsed() < LINK_CHANNEL_LIFE);
            if ch.len() >= 10_000 {
                return;
            }
            ch.insert(id.clone(), (tx, Instant::now()));
        }
        if send(&mut sock, json!({"t": "channel", "id": id})).await.is_ok() {
            if let Ok(Some(body)) = tokio::time::timeout(LINK_CHANNEL_LIFE, rx.recv()).await {
                let _ = send(&mut sock, json!({"t": "provision", "body": body})).await;
            }
        }
        app.channels.lock().unwrap().remove(&id);
    })
}

/// Hourly: expire undelivered messages and old attachment blobs, forget stale rate-limit buckets.
async fn sweep(app: Shared) {
    loop {
        {
            let db = app.db.lock().unwrap();
            let cutoff = now_ms() - MESSAGE_TTL_DAYS * 86_400_000;
            if let Err(e) = db.execute("DELETE FROM messages WHERE ts < ?", [cutoff]) {
                eprintln!("sweep: {e}");
            }
        }
        if let Ok(dir) = std::fs::read_dir(&app.blobs) {
            let max_age = Duration::from_secs(BLOB_TTL_DAYS * 86_400);
            for f in dir.flatten() {
                let old = f.metadata().and_then(|m| m.modified()).map(|t| t.elapsed().unwrap_or_default() > max_age).unwrap_or(false);
                if old {
                    let _ = std::fs::remove_file(f.path());
                }
            }
        }
        app.limits.prune();
        tokio::time::sleep(Duration::from_secs(3600)).await;
    }
}

/// Load (or create on first run) the sealed-sender trust root and server certificate.
///
/// The trust root's private key is never kept in the database: on first run it's written once to
/// `trust_file` for you to move offline. The running server only needs the server certificate + key;
/// if those leak, rotate them with `fog-server rotate-server-cert <trust-root.key>`.
fn sealed_keys(db: &Connection, trust_file: &std::path::Path) -> (Vec<u8>, Vec<u8>, Vec<u8>) {
    let get = |n: &str| db.query_row("SELECT value FROM server_keys WHERE name=?", [n], |r| r.get::<_, Vec<u8>>(0)).optional().ok().flatten();
    // Older databases stored the trust root private key; move it out.
    if let Some(old) = get("trust_priv") {
        write_secret(trust_file, &old);
        db.execute("DELETE FROM server_keys WHERE name='trust_priv'", []).expect("remove trust root from db");
    }
    if let (Some(t), Some(c), Some(k)) = (get("trust_pub"), get("server_cert"), get("server_key")) {
        return (t, c, k);
    }
    let (trust_priv, trust_pub) = fog_core::sealed::new_trust_root();
    let (cert, key) = fog_core::sealed::server_certificate(&trust_priv, 1).expect("server certificate");
    write_secret(trust_file, &trust_priv);
    for (n, v) in [("trust_pub", &trust_pub), ("server_cert", &cert), ("server_key", &key), ("server_key_id", &1u32.to_be_bytes().to_vec())] {
        db.execute("INSERT OR REPLACE INTO server_keys(name, value) VALUES(?, ?)", params![n, v]).expect("store server keys");
    }
    (trust_pub, cert, key)
}

fn write_secret(path: &std::path::Path, bytes: &[u8]) {
    use std::io::Write;
    #[cfg(unix)]
    use std::os::unix::fs::OpenOptionsExt;
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    opts.mode(0o600);
    opts.open(path).and_then(|mut f| f.write_all(bytes)).expect("write trust root key");
    eprintln!(
        "\n  Sealed-sender trust root private key written to {}.\n  Move it OFFLINE (password manager / USB) and delete it from this server.\n  You only need it to run `fog-server rotate-server-cert <file>`.\n",
        path.display()
    );
}

fn rotate_server_cert(db: &Connection, trust_file: &str) {
    let trust_priv = std::fs::read(trust_file).expect("read trust root key");
    let id = db
        .query_row("SELECT value FROM server_keys WHERE name='server_key_id'", [], |r| r.get::<_, Vec<u8>>(0))
        .ok()
        .and_then(|v| v.try_into().ok().map(u32::from_be_bytes))
        .unwrap_or(1)
        + 1;
    let (cert, key) = fog_core::sealed::server_certificate(&trust_priv, id).expect("server certificate");
    for (n, v) in [("server_cert", &cert), ("server_key", &key), ("server_key_id", &id.to_be_bytes().to_vec())] {
        db.execute("INSERT OR REPLACE INTO server_keys(name, value) VALUES(?, ?)", params![n, v]).expect("store server keys");
    }
    println!("Issued server certificate #{id}. Restart fog-server to use it.");
}

#[derive(Deserialize)]
struct SealedSend {
    to: String,
    /// One copy per recipient device. (`body` alone: older clients, delivered to device 1.)
    #[serde(default)]
    msgs: Vec<DeviceMsg>,
    #[serde(default)]
    body: Option<String>,
    access: String,
    /// A message worth a push notification (not a receipt or typing). See `wake`.
    #[serde(default)]
    urgent: bool,
}

/// Sealed delivery: no login and no sender. Gated by the recipient's access key, which they only
/// share (end-to-end encrypted) with people they've accepted, so strangers can't use it to spam.
// ponytail: the request still arrives from the sender's IP; a mixnet or relay would hide that too.
async fn post_sealed(State(app): State<Shared>, headers: HeaderMap, ConnectInfo(peer): ConnectInfo<SocketAddr>, body: String) -> Response {
    let ip = client_ip(&app, &headers, peer);
    if !app.limits.allow(&format!("sealed:{}", ip_key(ip)), 20.0, 300.0) {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    }
    let Ok(req) = serde_json::from_str::<SealedSend>(&body) else { return StatusCode::BAD_REQUEST.into_response() };
    if !valid_id(&req.to) || req.access.len() > 64 {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let msgs = match req.body {
        Some(body) if req.msgs.is_empty() => vec![DeviceMsg { device: MAIN_DEVICE, body }],
        _ => req.msgs,
    };
    if msgs.iter().map(|m| m.body.len()).sum::<usize>() > MAX_BODY * MAX_DEVICES as usize || msgs.iter().any(|m| m.body.len() > MAX_BODY) {
        return StatusCode::PAYLOAD_TOO_LARGE.into_response();
    }
    let ts = now_ms();
    let ids = {
        let db = app.db.lock().unwrap();
        let access: Option<Option<String>> = db.query_row("SELECT access FROM accounts WHERE id=?", [&req.to], |r| r.get(0)).optional().ok().flatten();
        let ok = access.flatten().is_some_and(|a| a.len() == req.access.len() && a.bytes().zip(req.access.bytes()).fold(0u8, |d, (x, y)| d | (x ^ y)) == 0);
        if !ok {
            return StatusCode::UNAUTHORIZED.into_response();
        }
        // Charged only after the access key checks out, so strangers can't drain a contact's bucket.
        if !app.limits.allow(&format!("sealed-to:{}", req.to), 20.0, 300.0) {
            return StatusCode::TOO_MANY_REQUESTS.into_response();
        }
        if let Err(mismatch) = check_devices(&db, &req.to, None, &msgs) {
            return (StatusCode::CONFLICT, axum::Json(mismatch)).into_response();
        }
        if queue_full(&db, &req.to) {
            return StatusCode::INSUFFICIENT_STORAGE.into_response();
        }
        let mut ids = vec![];
        for m in &msgs {
            if db.execute("INSERT INTO messages(recipient, device, sender, sender_device, body, ts) VALUES(?, ?, '', 0, ?, ?)", params![req.to, m.device, m.body, ts]).is_err() {
                return StatusCode::INTERNAL_SERVER_ERROR.into_response();
            }
            ids.push(db.last_insert_rowid());
        }
        ids
    };
    for (m, id) in msgs.iter().zip(&ids) {
        push(&app, &req.to, m.device, json!({"t": "msg", "id": id, "from": null, "sealed": true, "body": m.body, "ts": ts}));
        if req.urgent {
            wake(&app, &req.to, m.device);
        }
    }
    (StatusCode::CREATED, axum::Json(json!({"ts": ts}))).into_response()
}

fn client_ip(app: &App, headers: &HeaderMap, peer: SocketAddr) -> IpAddr {
    if app.trust_proxy {
        let fwd = headers.get("x-forwarded-for").and_then(|h| h.to_str().ok()).and_then(|v| v.split(',').next()).and_then(|v| v.trim().parse().ok());
        if let Some(ip) = fwd {
            return ip;
        }
    }
    peer.ip()
}

/// Rate-limit key for an address. IPv6 users typically get a whole /64, so limits apply per /64.
fn ip_key(ip: IpAddr) -> String {
    match ip {
        IpAddr::V6(v6) if v6.to_ipv4_mapped().is_none() => {
            let s = v6.segments();
            format!("{:x}:{:x}:{:x}:{:x}::/64", s[0], s[1], s[2], s[3])
        }
        IpAddr::V6(v6) => v6.to_ipv4_mapped().unwrap().to_string(),
        v4 => v4.to_string(),
    }
}

/// Coarser key for limits that a whole IPv6 allocation (/48) shares.
fn ip_key48(ip: IpAddr) -> String {
    match ip {
        IpAddr::V6(v6) if v6.to_ipv4_mapped().is_none() => {
            let s = v6.segments();
            format!("{:x}:{:x}:{:x}::/48", s[0], s[1], s[2])
        }
        other => ip_key(other),
    }
}

/// localhost / 127.0.0.1 / [::1], with or without a port.
fn is_local_host(host: &str) -> bool {
    let name = if host.starts_with('[') { host.split_inclusive(']').next().unwrap_or("") } else { host.rsplit_once(':').map_or(host, |(h, _)| h) };
    matches!(name, "localhost" | "127.0.0.1" | "[::1]")
}

fn is_registered(app: &App, id: &str) -> bool {
    app.db.lock().unwrap().query_row("SELECT 1 FROM accounts WHERE id=?", [id], |_| Ok(())).optional().ok().flatten().is_some()
}

fn valid_id(id: &str) -> bool {
    id.len() == 43 && id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}

/// Minimal STUN (RFC 5389) binding responder so call setup can learn its public address without
/// asking a third party (e.g. Google's STUN). Media still flows peer to peer.
// In production coturn takes over STUN and adds TURN relaying (see compose.yaml); this is for dev.
async fn stun_server(addr: String) {
    let Ok(sock) = tokio::net::UdpSocket::bind(&addr).await else { return eprintln!("stun: can't bind {addr}") };
    eprintln!("stun listening on {addr}");
    let mut buf = [0u8; 1500];
    loop {
        let Ok((n, from)) = sock.recv_from(&mut buf).await else { continue };
        if let Some(resp) = stun_response(&buf[..n], from) {
            let _ = sock.send_to(&resp, from).await;
        }
    }
}

const STUN_COOKIE: u32 = 0x2112_A442;

fn stun_response(req: &[u8], from: std::net::SocketAddr) -> Option<Vec<u8>> {
    // Binding request: type 0x0001, magic cookie, 12-byte transaction id.
    if req.len() < 20 || req[0..2] != [0, 1] || req[4..8] != STUN_COOKIE.to_be_bytes() {
        return None;
    }
    let txid = &req[8..20];
    let port = from.port() ^ (STUN_COOKIE >> 16) as u16;
    let mut attr = vec![0u8];
    match from.ip() {
        std::net::IpAddr::V4(ip) => {
            attr.push(1);
            attr.extend_from_slice(&port.to_be_bytes());
            attr.extend_from_slice(&(u32::from(ip) ^ STUN_COOKIE).to_be_bytes());
        }
        std::net::IpAddr::V6(ip) => {
            attr.push(2);
            attr.extend_from_slice(&port.to_be_bytes());
            let key: Vec<u8> = STUN_COOKIE.to_be_bytes().iter().chain(txid).copied().collect();
            attr.extend(ip.octets().iter().zip(key).map(|(a, k)| a ^ k));
        }
    }
    let mut out = vec![0x01, 0x01];
    out.extend_from_slice(&((attr.len() + 4) as u16).to_be_bytes());
    out.extend_from_slice(&STUN_COOKIE.to_be_bytes());
    out.extend_from_slice(txid);
    out.extend_from_slice(&[0x00, 0x20]); // XOR-MAPPED-ADDRESS
    out.extend_from_slice(&(attr.len() as u16).to_be_bytes());
    out.extend(attr);
    Some(out)
}

fn blob_id_ok(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

/// Store an encrypted attachment. The id must come from an `upload` RPC (single use, 10 min).
// Blobs expire after BLOB_TTL_DAYS (see `sweep`). ponytail: local disk; object storage when it outgrows one host.
async fn put_blob(Path(id): Path<String>, State(app): State<Shared>, body: Body) -> StatusCode {
    let slot = app.uploads.lock().unwrap().remove(&id);
    let Some((max, _)) = slot.filter(|(_, e)| *e > Instant::now()) else { return StatusCode::FORBIDDEN };
    let part = app.blobs.join(format!("{id}.part"));
    let Ok(mut file) = tokio::fs::File::create(&part).await else { return StatusCode::INTERNAL_SERVER_ERROR };
    let mut stream = body.into_data_stream();
    let mut written = 0u64;
    while let Some(chunk) = stream.next().await {
        let Ok(chunk) = chunk else {
            let _ = tokio::fs::remove_file(&part).await;
            return StatusCode::BAD_REQUEST;
        };
        written += chunk.len() as u64;
        if written > max || file.write_all(&chunk).await.is_err() {
            let _ = tokio::fs::remove_file(&part).await;
            return StatusCode::PAYLOAD_TOO_LARGE;
        }
    }
    if file.flush().await.is_err() || tokio::fs::rename(&part, app.blobs.join(&id)).await.is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR;
    }
    StatusCode::CREATED
}

/// Anyone with the id can fetch the ciphertext; without the key from the message it's useless.
async fn get_blob(Path(id): Path<String>, State(app): State<Shared>) -> Response {
    if !blob_id_ok(&id) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let Ok(file) = tokio::fs::File::open(app.blobs.join(&id)).await else { return StatusCode::NOT_FOUND.into_response() };
    let len = file.metadata().await.map(|m| m.len()).unwrap_or(0);
    (
        [
            (header::CONTENT_TYPE, "application/octet-stream".to_string()),
            (header::CONTENT_LENGTH, len.to_string()),
            (header::CACHE_CONTROL, "private, max-age=31536000, immutable".to_string()),
        ],
        Body::from_stream(tokio_util::io::ReaderStream::new(file)),
    )
        .into_response()
}

async fn upgrade(ws: WebSocketUpgrade, headers: HeaderMap, ConnectInfo(peer): ConnectInfo<SocketAddr>, State(app): State<Shared>) -> Response {
    let host = headers.get("host").and_then(|h| h.to_str().ok()).unwrap_or("").to_ascii_lowercase();
    // Logins sign the server's host so a malicious server can't relay our challenge to another
    // one. That only holds if this server decides its own name rather than trusting the header.
    let host = match &app.host {
        Some(canon) if *canon != host => return StatusCode::MISDIRECTED_REQUEST.into_response(),
        Some(canon) => canon.clone(),
        // Dev mode (no FOG_HOST): only local names, so a proxy that forwards any Host can't make
        // us accept a login signed for some other server.
        None if is_local_host(&host) => host,
        None => return StatusCode::MISDIRECTED_REQUEST.into_response(),
    };
    let ip = client_ip(&app, &headers, peer);
    if !app.limits.allow(&format!("conn:{}", ip_key(ip)), 1.0, 30.0) {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    }
    ws.max_message_size(MAX_BODY * 2).on_upgrade(move |sock| async move {
        if let Err(e) = conn(app, sock, host, ip).await {
            eprintln!("conn closed: {e}");
        }
    })
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as i64
}

/// Verify a libsignal XEdDSA signature: convert the X25519 key to its Ed25519 form (sign bit is
/// carried in the top bit of the signature) and run a strict Ed25519 verification.
fn verify(id: &str, msg: &[u8], sig: &[u8]) -> bool {
    let (Ok(Ok(pk)), Ok(mut sig)) = (B64URL.decode(id).map(<[u8; 32]>::try_from), <[u8; 64]>::try_from(sig)) else {
        return false;
    };
    let Some(ed) = curve25519_dalek::MontgomeryPoint(pk).to_edwards(sig[63] >> 7) else {
        return false;
    };
    sig[63] &= 0x7f;
    ed25519_dalek::VerifyingKey::from_bytes(&ed.compress().0)
        .and_then(|vk| vk.verify_strict(msg, &ed25519_dalek::Signature::from_bytes(&sig)))
        .is_ok()
}

/// Bytes the client signs to log in. Binding the Host it connected to stops a malicious
/// server from relaying our challenge to log in elsewhere as the user.
fn auth_message(host: &str, nonce: &str) -> Vec<u8> {
    format!("fog-auth-v1|{host}|{nonce}").into_bytes()
}

#[derive(Deserialize)]
struct Auth {
    id: String,
    sig: String,
    #[serde(default = "main_device")]
    device: u32,
    /// Device 1: the main-device public key and a signature with it over the same challenge.
    #[serde(default)]
    main: Option<String>,
    #[serde(default)]
    msig: Option<String>,
    /// A new linked device's first login: the token the main device got from `link_begin`.
    #[serde(default)]
    token: Option<String>,
    #[serde(default)]
    name: Option<String>,
    /// Linked devices: their own login key (registered with the link token) and a signature with it.
    #[serde(default)]
    dkey: Option<String>,
    #[serde(default)]
    dsig: Option<String>,
}

fn main_device() -> u32 {
    MAIN_DEVICE
}

/// Which devices may log in. Every device holds the identity key, so that alone can't tell them
/// apart: device 1 must also sign with the main-device key (derived from the recovery phrase, which
/// linked devices never get), and linked devices must be on the account's device list.
fn authorize(app: &App, me: &str, auth: &Auth, challenge: &[u8]) -> Result<(), &'static str> {
    let db = app.db.lock().unwrap();
    if !(1..=127).contains(&auth.device) {
        return Err("bad_auth");
    }
    let main: Option<Option<String>> = db.query_row("SELECT main FROM accounts WHERE id=?", [me], |r| r.get(0)).optional().map_err(|_| "bad_auth")?;
    if auth.device == MAIN_DEVICE {
        let signed = |key: &str| auth.msig.as_ref().and_then(|s| B64.decode(s).ok()).is_some_and(|s| verify(key, challenge, &s));
        return match main.flatten() {
            Some(key) => signed(&key).then_some(()).ok_or("bad_auth"),
            // First login since multi-device (or a new account): remember the main-device key.
            None => match &auth.main {
                Some(key) if signed(key) => {
                    // Existing account: record it now (a brand-new one gets it when it's created).
                    db.execute("UPDATE accounts SET main=? WHERE id=? AND main IS NULL", params![key, me]).map_err(|_| "bad_auth")?;
                    Ok(())
                }
                Some(_) => Err("bad_auth"),
                // ponytail: older clients log in without it until they reload; drop once they're gone.
                None => Ok(()),
            },
        };
    }
    // Linked devices sign with their own login key, so knowing the identity key isn't enough to
    // sign in as one (for instance, from a device that's been unlinked).
    let device_signed = |key: &str| auth.dsig.as_ref().and_then(|s| B64.decode(s).ok()).is_some_and(|s| verify(key, challenge, &s));
    let known: Option<Option<String>> = db.query_row("SELECT key FROM devices WHERE account=? AND id=?", params![me, auth.device], |r| r.get(0)).optional().map_err(|_| "bad_auth")?;
    if let Some(key) = known {
        return match key {
            Some(key) if device_signed(&key) => Ok(()),
            _ => Err("unlinked"),
        };
    }
    let mut links = app.links.lock().unwrap();
    let ok = links.get(me).is_some_and(|l| l.device == auth.device && l.expires > Instant::now() && auth.token.as_deref() == Some(l.token.as_str()));
    let Some(dkey) = auth.dkey.as_ref().filter(|k| ok && valid_id(k) && device_signed(k)) else { return Err("unlinked") };
    links.remove(me);
    let name: Option<String> = auth.name.as_ref().map(|n| n.chars().take(64).collect());
    db.execute("INSERT INTO devices(account, id, keys, name, created, seen, key) VALUES(?, ?, NULL, ?, ?, ?, ?)", params![me, auth.device, name, now_ms(), now_ms(), dkey])
        .map_err(|_| "bad_auth")?;
    Ok(())
}

async fn conn(app: Shared, mut sock: WebSocket, host: String, ip: IpAddr) -> Result<(), String> {
    let nonce = B64.encode(rand::random::<[u8; 32]>());
    send(&mut sock, json!({"t": "challenge", "nonce": nonce})).await?;

    let first = tokio::time::timeout(Duration::from_secs(15), sock.recv()).await.map_err(|_| "auth timeout")?;
    let Some(Ok(Message::Text(text))) = first else { return Err("no auth".into()) };
    let auth: Auth = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let sig = B64.decode(&auth.sig).map_err(|e| e.to_string())?;
    let challenge = auth_message(&host, &nonce);
    if !verify(&auth.id, &challenge, &sig) {
        send(&mut sock, json!({"t": "error", "error": "bad_auth"})).await?;
        return Err("bad auth".into());
    }
    if let Err(why) = authorize(&app, &auth.id, &auth, &challenge) {
        send(&mut sock, json!({"t": "error", "error": why})).await?;
        return Err(why.into());
    }
    let me = auth.id.clone();
    let device = auth.device;
    // Devices name themselves ("Chrome on macOS") so the device list is readable.
    if let Some(name) = auth.name.as_ref().map(|n| n.chars().take(64).collect::<String>()) {
        let _ = app.db.lock().unwrap().execute("UPDATE devices SET name=? WHERE account=? AND id=?", params![name, me, device]);
    }
    // authorize() checked msig against `main` for device 1.
    let main_key = if device == MAIN_DEVICE { auth.main.clone().filter(|_| auth.msig.is_some()) } else { None };
    let key = format!("{me}.{device}");

    // A newer connection for the same device replaces this one.
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let end = tokio_util::sync::CancellationToken::new();
    if let Some(old) = app.online.lock().unwrap().insert(key.clone(), Online { tx: tx.clone(), end: end.clone(), away: false }) {
        old.end.cancel();
    }

    let (username, registered, prekeys, kyber, queued) = {
        let db = app.db.lock().unwrap();
        let username: Option<Option<String>> = db
            .query_row("SELECT username FROM accounts WHERE id=?", [&me], |r| r.get(0))
            .optional()
            .map_err(|e| e.to_string())?;
        let prekeys: i64 = db
            .query_row("SELECT count(*) FROM prekeys WHERE account=? AND device=?", params![me, device], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        let kyber: i64 = db
            .query_row("SELECT count(*) FROM kyber_prekeys WHERE account=? AND device=?", params![me, device], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        let _ = db.execute("UPDATE devices SET seen=? WHERE account=? AND id=?", params![now_ms(), me, device]);
        let mut stmt = db
            .prepare("SELECT id, sender, sender_device, body, ts FROM messages WHERE recipient=? AND device=? ORDER BY id")
            .map_err(|e| e.to_string())?;
        let queued: Vec<Value> = stmt
            .query_map(params![me, device], |r| {
                let from: String = r.get(1)?;
                let sealed = from.is_empty();
                Ok(json!({"t": "msg", "id": r.get::<_, i64>(0)?, "from": if sealed { Value::Null } else { from.into() },
                          "dev": r.get::<_, u32>(2)?, "sealed": sealed, "body": r.get::<_, String>(3)?, "ts": r.get::<_, i64>(4)?}))
            })
            .and_then(|rows| rows.collect())
            .map_err(|e| e.to_string())?;
        (username.clone().flatten(), username.is_some(), prekeys, kyber, queued)
    };
    send(&mut sock, json!({"t": "ready", "registered": registered, "device": device, "username": username, "prekeys": prekeys, "kyber": kyber, "pow": app.pow_bits, "trust": B64.encode(&app.trust_root)})).await?;
    for m in queued {
        send(&mut sock, m).await?;
    }

    let result = loop {
        tokio::select! {
            incoming = sock.recv() => match incoming {
                Some(Ok(Message::Text(text))) => {
                    // Link previews do network IO, so they run off the socket loop and reply via the outbox.
                    if let Ok(p) = serde_json::from_str::<PreviewReq>(&text) {
                        if p.t == "preview" && p.url.len() <= 2048 {
                            if !app.limits.allow(&format!("preview:{me}"), 0.5, 20.0) || !is_registered(&app, &me) {
                                let _ = tx.send(json!({ "rid": p.rid, "error": "slow_down" }).to_string());
                                continue;
                            }
                            let tx = tx.clone();
                            tokio::spawn(async move {
                                let mut out = preview::fetch(&p.url).await.map(|v| json!({ "preview": v })).unwrap_or_else(|e| json!({ "error": e }));
                                out["rid"] = p.rid.into();
                                let _ = tx.send(out.to_string());
                            });
                            continue;
                        }
                    }
                    let reply = handle(&app, &Ctx { me: &me, device, main: main_key.as_deref(), host: &host, nonce: &nonce, ip }, &text);
                    if let Err(e) = send(&mut sock, reply).await { break Err(e) }
                }
                Some(Ok(Message::Close(_))) | None => break Ok(()),
                Some(Ok(_)) => {}
                Some(Err(e)) => break Err(e.to_string()),
            },
            out = rx.recv() => match out {
                Some(text) => if let Err(e) = sock.send(Message::Text(text.into())).await { break Err(e.to_string()) },
                None => break Ok(()),
            },
            // Unlinked, or replaced by a newer login: deliver what's queued (e.g. "unlinked"), then go.
            _ = end.cancelled() => {
                while let Ok(text) = rx.try_recv() {
                    let _ = sock.send(Message::Text(text.into())).await;
                }
                break Ok(());
            }
        }
    };
    drop(rx);
    let mut online = app.online.lock().unwrap();
    if online.get(&key).is_some_and(|c| c.tx.same_channel(&tx)) {
        online.remove(&key);
    }
    result
}

async fn send(sock: &mut WebSocket, v: Value) -> Result<(), String> {
    sock.send(Message::Text(Utf8Bytes::from(v.to_string()))).await.map_err(|e| e.to_string())
}

#[derive(Deserialize)]
struct SignedKey {
    id: u32,
    #[serde(rename = "pub")]
    key: String,
    sig: String,
}

#[derive(Deserialize)]
struct OneTimeKey {
    id: u32,
    #[serde(rename = "pub")]
    key: String,
}

#[derive(Deserialize)]
struct KeysUp {
    reg: u32,
    spk: SignedKey,
    kpk: SignedKey,
    #[serde(default)]
    pks: Vec<OneTimeKey>,
    /// One-time post-quantum prekeys, used before the last-resort `kpk`.
    #[serde(default)]
    kpks: Vec<SignedKey>,
}

#[derive(Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
enum Req {
    /// Upload identity-signed prekeys. `replace` wipes old one-time keys (new device / restore).
    Keys {
        keys: KeysUp,
        #[serde(default)]
        replace: bool,
        /// Proof-of-work counter, required when this call creates the account.
        #[serde(default)]
        pow: Option<u64>,
    },
    Username { name: String },
    Lookup { name: String },
    Profile { id: String },
    /// One device's prekey bundle (device 1 if omitted).
    Bundle {
        id: String,
        #[serde(default)]
        device: Option<u32>,
    },
    /// Every device's bundle (yours: all but this device).
    Bundles { id: String },
    /// One copy per recipient device. (`body` alone: older clients, delivered to device 1.)
    Send {
        to: String,
        #[serde(default)]
        msgs: Vec<DeviceMsg>,
        #[serde(default)]
        body: Option<String>,
        /// Worth a push notification (a message or a call, not a receipt or typing).
        #[serde(default)]
        urgent: bool,
    },
    Ack { id: i64 },
    /// Reserve a one-time slot to upload an encrypted attachment of at most `size` bytes.
    Upload { size: u64 },
    /// STUN/TURN servers for calls, with short-lived TURN credentials.
    Ice,
    /// Flag an account for abuse review.
    Report { id: String },
    /// A sender certificate for sealed sending (valid 24h).
    Cert,
    /// Register the access key that gates sealed delivery to us.
    Access { key: String },
    /// Your devices.
    Devices,
    /// Main device: approve linking one new device. Returns its device id and a one-time token.
    LinkBegin,
    /// Main device: hand the encrypted transfer to the new device's link channel.
    Provision { channel: String, body: String },
    /// Main device: remove any linked device. Linked devices: remove themselves.
    Unlink { device: u32 },
    /// Phone apps: where to send push notifications for this device ("apns", "apns-dev" or "fcm";
    /// an empty token turns them off).
    Push { kind: String, token: String },
    /// Phone apps: the app went to the background (or came back).
    Away { away: bool },
}

#[derive(Deserialize)]
struct PreviewReq {
    rid: u64,
    t: String,
    url: String,
}

#[derive(Deserialize)]
struct Rpc {
    rid: u64,
    #[serde(flatten)]
    req: Req,
}

fn handle(app: &App, cx: &Ctx, text: &str) -> Value {
    let me = cx.me;
    let rpc: Rpc = match serde_json::from_str(text) {
        Ok(r) => r,
        Err(e) => return json!({"error": format!("bad request: {e}")}),
    };
    // (bucket, events per second, burst). Generous for people, tight for scripts.
    let (bucket, rate, burst) = match &rpc.req {
        Req::Send { .. } => ("send", 20.0, 200.0),
        Req::Lookup { .. } | Req::Profile { .. } => ("lookup", 1.0, 60.0),
        Req::Bundle { .. } | Req::Bundles { .. } => ("bundle", 1.0, 100.0),
        Req::Devices => ("devices", 1.0, 30.0),
        Req::LinkBegin | Req::Provision { .. } | Req::Unlink { .. } => ("link", 0.05, 10.0),
        Req::Upload { .. } => ("upload", 0.5, 60.0),
        Req::Keys { .. } => ("keys", 0.2, 10.0),
        Req::Username { .. } => ("username", 0.1, 10.0),
        Req::Report { .. } => ("report", 0.05, 5.0),
        Req::Ice => ("ice", 0.2, 10.0),
        Req::Cert => ("cert", 0.1, 10.0),
        Req::Access { .. } => ("access", 0.1, 10.0),
        Req::Ack { .. } => ("ack", 50.0, 2000.0),
        Req::Push { .. } => ("push", 0.2, 10.0),
        Req::Away { .. } => ("away", 1.0, 60.0),
    };
    if !app.limits.allow(&format!("{bucket}:{me}"), rate, burst) {
        return json!({"rid": rpc.rid, "error": "slow_down"});
    }
    // Keys are free to make, so everything but signing up needs a registered (proof-of-work) account,
    // and the lookups worth scripting (usernames, prekey bundles) are also capped per network.
    if !matches!(rpc.req, Req::Keys { .. } | Req::Ack { .. }) && !is_registered(app, me) {
        return json!({"rid": rpc.rid, "error": "not_registered"});
    }
    if !device_exists(app, me, cx.device) {
        return json!({"rid": rpc.rid, "error": "unlinked"});
    }
    if matches!(rpc.req, Req::Username { .. }) && cx.device != MAIN_DEVICE {
        return json!({"rid": rpc.rid, "error": "main_only"});
    }
    if matches!(rpc.req, Req::Lookup { .. } | Req::Profile { .. } | Req::Bundle { .. } | Req::Bundles { .. }) && !app.limits.allow(&format!("{bucket}-ip:{}", ip_key(cx.ip)), 3.0, 300.0) {
        return json!({"rid": rpc.rid, "error": "slow_down"});
    }
    if let Req::Send { to, .. } = &rpc.req {
        if !app.limits.allow(&format!("send-to:{me}:{to}"), 5.0, 100.0) {
            return json!({"rid": rpc.rid, "error": "slow_down"});
        }
    }
    let mut out = match rpc.req {
        Req::Send { to, msgs, body, urgent } => {
            let msgs = match body {
                Some(body) if msgs.is_empty() => vec![DeviceMsg { device: MAIN_DEVICE, body }],
                _ => msgs,
            };
            send_msg(app, cx, &to, &msgs, urgent)
        }
        Req::Away { away } => {
            if let Some(c) = app.online.lock().unwrap().get_mut(&format!("{me}.{}", cx.device)) {
                c.away = away;
            }
            Ok(json!({}))
        }
        Req::Ice => Ok(ice(app, me, cx.host)),
        Req::Provision { channel, body } => {
            if cx.device != MAIN_DEVICE || !has_main_key(&app.db.lock().unwrap(), me) {
                Err("main_only".into())
            } else if body.len() > MAX_BODY {
                Err("too_large".into())
            } else {
                match app.channels.lock().unwrap().remove(&channel) {
                    Some((tx, _)) => tx.send(body).map(|_| json!({})).map_err(|_| "gone".to_string()),
                    None => Err("gone".into()),
                }
            }
        }
        Req::Cert => fog_core::sealed::sender_certificate(&app.server_cert, &app.server_key, me, cx.device, (now_ms() + CERT_LIFE_MS) as u64)
            .map(|c| json!({ "cert": B64.encode(c), "expires": now_ms() + CERT_LIFE_MS })),
        req => {
            let db = app.db.lock().unwrap();
            rpc_db(&db, app, cx, req)
        }
    }
    .unwrap_or_else(|e| json!({"error": e}));
    out["rid"] = rpc.rid.into();
    out
}

/// TURN REST API credentials (what coturn's `use-auth-secret` expects): valid for 24h, tied to the account.
fn turn_credential(secret: &str, user: &str) -> String {
    let mut mac = Hmac::<sha1::Sha1>::new_from_slice(secret.as_bytes()).expect("any key length");
    mac.update(user.as_bytes());
    B64.encode(mac.finalize().into_bytes())
}

fn ice(app: &App, me: &str, host: &str) -> Value {
    let h = app.ice_host.clone().unwrap_or_else(|| host.rsplit_once(':').map_or(host, |(h, _)| h).to_owned());
    match &app.turn_secret {
        Some(secret) => {
            let user = format!("{}:{me}", now_ms() / 1000 + 86400);
            let credential = turn_credential(secret, &user);
            json!({ "servers": [
                { "urls": [format!("stun:{h}:3478")] },
                { "urls": [format!("turn:{h}:3478?transport=udp"), format!("turn:{h}:3478?transport=tcp")], "username": user, "credential": credential }
            ]})
        }
        None => json!({ "servers": [{ "urls": [format!("stun:{h}:3478")] }] }),
    }
}

fn valid_username(n: &str) -> bool {
    let b = n.as_bytes();
    (3..=32).contains(&b.len())
        && b[0].is_ascii_lowercase()
        && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'_')
}

fn small_b64(s: &str, max: usize) -> Result<(), String> {
    if s.len() > max || B64.decode(s).is_err() { Err("bad key".into()) } else { Ok(()) }
}

fn rpc_db(db: &Connection, app: &App, cx: &Ctx, req: Req) -> Result<Value, String> {
    let me = cx.me;
    let e = |e: rusqlite::Error| e.to_string();
    match req {
        Req::Keys { keys, replace, pow } => {
            small_b64(&keys.spk.key, 64)?;
            small_b64(&keys.spk.sig, 128)?;
            small_b64(&keys.kpk.key, 2200)?; // Kyber1024 public key: 1569 bytes
            small_b64(&keys.kpk.sig, 128)?;
            if keys.pks.len() > MAX_PREKEYS {
                return Err("too many prekeys".into());
            }
            for k in &keys.pks {
                small_b64(&k.key, 64)?;
            }
            if keys.kpks.len() > 100 {
                return Err("too many prekeys".into());
            }
            for k in &keys.kpks {
                small_b64(&k.key, 2200)?;
                small_b64(&k.sig, 128)?;
            }
            // New accounts cost a little CPU (proof-of-work) and are capped per IP.
            let exists = db.query_row("SELECT 1 FROM accounts WHERE id=?", [me], |_| Ok(())).optional().map_err(e)?.is_some();
            if !exists && cx.device != MAIN_DEVICE {
                return Err("not_registered".into());
            }
            if !exists {
                if !pow.is_some_and(|c| pow_ok(cx.nonce, c, app.pow_bits)) {
                    return Err("pow_required".into());
                }
                if !app.limits.allow(&format!("signup:{}", ip_key(cx.ip)), 1.0 / 60.0, app.signup_burst) {
                    return Err("signup_limit".into());
                }
            }
            let stored = json!({"reg": keys.reg,
                "spk": {"id": keys.spk.id, "pub": keys.spk.key, "sig": keys.spk.sig},
                "kpk": {"id": keys.kpk.id, "pub": keys.kpk.key, "sig": keys.kpk.sig}});
            if !exists {
                db.execute("INSERT INTO accounts(id, keys, created, main) VALUES(?1, '{}', ?2, ?3)", params![me, now_ms(), cx.main]).map_err(e)?;
            }
            if cx.device == MAIN_DEVICE {
                db.execute(
                    "INSERT INTO devices(account, id, keys, created, seen) VALUES(?1, ?2, ?3, ?4, ?4)
                     ON CONFLICT(account, id) DO UPDATE SET keys=excluded.keys",
                    params![me, cx.device, stored.to_string(), now_ms()],
                )
                .map_err(e)?;
            // A linked device only updates its own row: once unlinked it can't put itself back.
            } else if db.execute("UPDATE devices SET keys=? WHERE account=? AND id=?", params![stored.to_string(), me, cx.device]).map_err(e)? == 0 {
                return Err("unlinked".into());
            }
            if replace {
                db.execute("DELETE FROM prekeys WHERE account=? AND device=?", params![me, cx.device]).map_err(e)?;
                db.execute("DELETE FROM kyber_prekeys WHERE account=? AND device=?", params![me, cx.device]).map_err(e)?;
                // A fresh main device (new account, or restored from the recovery phrase) signs out
                // every linked device, as in Signal: that's how you recover a lost or stolen one.
                if cx.device == MAIN_DEVICE {
                    app.links.lock().unwrap().remove(me);
                    let others: Vec<u32> = active_devices(db, me).into_iter().chain(pending_devices(db, me)).filter(|d| *d != MAIN_DEVICE).collect();
                    for d in others {
                        remove_device(app, db, me, d)?;
                    }
                }
            }
            for k in keys.pks {
                db.execute("INSERT OR REPLACE INTO prekeys(account, device, id, key) VALUES(?, ?, ?, ?)", params![me, cx.device, k.id, k.key])
                    .map_err(e)?;
            }
            for k in keys.kpks {
                db.execute("INSERT OR REPLACE INTO kyber_prekeys(account, device, id, key, sig) VALUES(?, ?, ?, ?, ?)", params![me, cx.device, k.id, k.key, k.sig])
                    .map_err(e)?;
            }
            push_all(app, me, json!({"t": "devices"}));
            Ok(json!({}))
        }
        Req::Username { name } => {
            let name = name.to_lowercase();
            if !valid_username(&name) {
                return Err("invalid_username".into());
            }
            match db.execute("UPDATE accounts SET username=? WHERE id=?", params![name, me]) {
                Ok(0) => Err("not_registered".into()),
                Ok(_) => Ok(json!({"username": name})),
                Err(rusqlite::Error::SqliteFailure(f, _)) if f.code == rusqlite::ErrorCode::ConstraintViolation => {
                    Err("taken".into())
                }
                Err(x) => Err(x.to_string()),
            }
        }
        Req::Lookup { name } => db
            .query_row("SELECT id, username FROM accounts WHERE username=?", [name.trim_start_matches('@')], |r| {
                Ok(json!({"id": r.get::<_, String>(0)?, "username": r.get::<_, String>(1)?}))
            })
            .optional()
            .map_err(e)?
            .ok_or_else(|| "not_found".into()),
        Req::Profile { id } => db
            .query_row("SELECT username FROM accounts WHERE id=?", [&id], |r| r.get::<_, Option<String>>(0))
            .optional()
            .map_err(e)?
            .map(|u| json!({"id": id, "username": u}))
            .ok_or_else(|| "not_found".into()),
        Req::Bundle { id, device } => Ok(json!({"bundle": bundle(app, db, &id, device.unwrap_or(MAIN_DEVICE))?})),
        Req::Bundles { id } => {
            let devices: Vec<u32> = active_devices(db, &id).into_iter().filter(|d| !(id == me && *d == cx.device)).collect();
            if devices.is_empty() && id != me {
                return Err("not_found".into());
            }
            let bundles: Result<Vec<Value>, String> = devices.into_iter().map(|d| Ok(json!({"device": d, "bundle": bundle(app, db, &id, d)?}))).collect();
            Ok(json!({"bundles": bundles?}))
        }
        Req::Ack { id } => {
            db.execute("DELETE FROM messages WHERE id=? AND recipient=? AND device=?", params![id, me, cx.device]).map_err(e)?;
            Ok(json!({}))
        }
        Req::Devices => {
            let mut st = db.prepare("SELECT id, name, created, seen, keys IS NOT NULL FROM devices WHERE account=? ORDER BY id").map_err(e)?;
            let list: Vec<Value> = st
                .query_map([me], |r| Ok(json!({"id": r.get::<_, u32>(0)?, "name": r.get::<_, Option<String>>(1)?, "created": r.get::<_, i64>(2)?, "seen": r.get::<_, i64>(3)?, "ready": r.get::<_, bool>(4)?})))
                .and_then(|rows| rows.collect())
                .map_err(e)?;
            Ok(json!({"devices": list, "me": cx.device}))
        }
        Req::LinkBegin => {
            if cx.device != MAIN_DEVICE || !has_main_key(db, me) {
                return Err("main_only".into());
            }
            let count: i64 = db.query_row("SELECT count(*) FROM devices WHERE account=?", [me], |r| r.get(0)).map_err(e)?;
            if count >= MAX_DEVICES {
                return Err("too_many_devices".into());
            }
            // Device ids aren't reused: contacts may still hold a session with an unlinked one.
            let device: u32 = db.query_row("SELECT next_device FROM accounts WHERE id=?", [me], |r| r.get(0)).map_err(e)?;
            if device > 127 {
                return Err("too_many_devices".into());
            }
            db.execute("UPDATE accounts SET next_device=? WHERE id=?", params![device + 1, me]).map_err(e)?;
            let token = B64URL.encode(rand::random::<[u8; 24]>());
            app.links.lock().unwrap().insert(me.to_owned(), Link { device, token: token.clone(), expires: Instant::now() + Duration::from_secs(600) });
            Ok(json!({"device": device, "token": token}))
        }
        Req::Unlink { device } => {
            if device == MAIN_DEVICE || (cx.device != MAIN_DEVICE && device != cx.device) || (cx.device == MAIN_DEVICE && !has_main_key(db, me)) {
                return Err("not_allowed".into());
            }
            remove_device(app, db, me, device)?;
            push_all(app, me, json!({"t": "devices"}));
            Ok(json!({}))
        }
        Req::Upload { size } => {
            if size == 0 || size > MAX_BLOB {
                return Err("too_large".into());
            }
            let day = now_ms() / 86_400_000;
            if !app.limits.take(&format!("bytes:{me}:{day}"), 0.0, UPLOAD_BYTES_PER_DAY as f64, size as f64) {
                return Err("quota".into());
            }
            let id: String = rand::random::<[u8; 16]>().iter().map(|b| format!("{b:02x}")).collect();
            let mut slots = app.uploads.lock().unwrap();
            slots.retain(|_, (_, e)| *e > Instant::now());
            slots.insert(id.clone(), (size, Instant::now() + Duration::from_secs(600)));
            Ok(json!({"id": id}))
        }
        Req::Report { id } => {
            if id.len() <= 64 {
                db.execute("INSERT INTO reports(reporter, reported, ts) VALUES(?, ?, ?)", params![me, id, now_ms()]).map_err(e)?;
            }
            Ok(json!({}))
        }
        Req::Access { key } => {
            if key.len() > 64 || B64.decode(&key).map_or(true, |k| k.len() < 16) {
                return Err("bad key".into());
            }
            db.execute("UPDATE accounts SET access=? WHERE id=?", params![key, me]).map_err(e)?;
            Ok(json!({}))
        }
        Req::Push { kind, token } => {
            if token.is_empty() {
                db.execute("DELETE FROM push_tokens WHERE account=? AND device=?", params![me, cx.device]).map_err(e)?;
                return Ok(json!({}));
            }
            if !push::valid_token(&kind, &token) {
                return Err("bad token".into());
            }
            // A token belongs to one install: if it moved (a reinstall that kept it), the old row goes.
            db.execute("DELETE FROM push_tokens WHERE kind=? AND token=?", params![kind, token]).map_err(e)?;
            db.execute("INSERT OR REPLACE INTO push_tokens(account, device, kind, token) VALUES(?, ?, ?, ?)", params![me, cx.device, kind, token]).map_err(e)?;
            Ok(json!({}))
        }
        Req::Send { .. } | Req::Ice | Req::Cert | Req::Provision { .. } | Req::Away { .. } => unreachable!("handled in handle()"),
    }
}

/// Devices approved but not yet set up (no keys uploaded).
fn pending_devices(db: &Connection, account: &str) -> Vec<u32> {
    let mut st = db.prepare_cached("SELECT id FROM devices WHERE account=? AND keys IS NULL").expect("query");
    st.query_map([account], |r| r.get(0)).and_then(|rows| rows.collect()).unwrap_or_default()
}

/// A device's prekey bundle, consuming one one-time EC and one one-time Kyber prekey if available.
fn bundle(app: &App, db: &Connection, id: &str, device: u32) -> Result<Value, String> {
    let e = |e: rusqlite::Error| e.to_string();
    let keys: String = db
        .query_row("SELECT keys FROM devices WHERE account=? AND id=? AND keys IS NOT NULL", params![id, device], |r| r.get(0))
        .optional()
        .map_err(e)?
        .ok_or("not_found")?;
    let mut bundle: Value = serde_json::from_str(&keys).map_err(|x| x.to_string())?;
    let pk: Option<(u32, String)> = db
        .query_row(
            "DELETE FROM prekeys WHERE rowid = (SELECT rowid FROM prekeys WHERE account=? AND device=? LIMIT 1) RETURNING id, key",
            params![id, device],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(e)?;
    if let Some((pid, key)) = pk {
        bundle["pk"] = json!({"id": pid, "pub": key});
    }
    // Prefer a one-time post-quantum prekey; fall back to the signed last-resort one.
    let kpk: Option<(u32, String, String)> = db
        .query_row(
            "DELETE FROM kyber_prekeys WHERE rowid = (SELECT rowid FROM kyber_prekeys WHERE account=? AND device=? LIMIT 1) RETURNING id, key, sig",
            params![id, device],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(e)?;
    if let Some((kid, key, sig)) = kpk {
        bundle["kpk"] = json!({"id": kid, "pub": key, "sig": sig});
    }
    let left: i64 = db.query_row("SELECT count(*) FROM prekeys WHERE account=? AND device=?", params![id, device], |r| r.get(0)).map_err(e)?;
    let kleft: i64 = db.query_row("SELECT count(*) FROM kyber_prekeys WHERE account=? AND device=?", params![id, device], |r| r.get(0)).map_err(e)?;
    if left < 20 || kleft < 10 {
        push(app, id, device, json!({"t": "prekeys", "count": left, "kyber": kleft}));
    }
    Ok(bundle)
}

/// A recipient's offline queue is capped by count and bytes, so nobody can fill it to lock them out.
fn queue_full(db: &Connection, to: &str) -> bool {
    db.query_row("SELECT count(*), coalesce(sum(length(body)), 0) FROM messages WHERE recipient=?", [to], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)))
        .map_or(true, |(n, bytes)| n >= MAX_QUEUED_PER_RECIPIENT || bytes >= MAX_QUEUED_BYTES)
}

fn send_msg(app: &App, cx: &Ctx, to: &str, msgs: &[DeviceMsg], urgent: bool) -> Result<Value, String> {
    if msgs.iter().any(|m| m.body.len() > MAX_BODY) {
        return Err("too_large".into());
    }
    let me = cx.me;
    let ts = now_ms();
    let ids = {
        let db = app.db.lock().unwrap();
        let exists: bool = db
            .query_row("SELECT 1 FROM accounts WHERE id=?", [to], |_| Ok(true))
            .optional()
            .map_err(|e| e.to_string())?
            .is_some();
        if !exists {
            return Err("not_found".into());
        }
        if let Err(mismatch) = check_devices(&db, to, (to == me).then_some(cx.device), msgs) {
            return Ok(mismatch);
        }
        if queue_full(&db, to) {
            return Err("recipient_full".into());
        }
        let mut ids = vec![];
        for m in msgs {
            db.execute("INSERT INTO messages(recipient, device, sender, sender_device, body, ts) VALUES(?, ?, ?, ?, ?, ?)", params![to, m.device, me, cx.device, m.body, ts])
                .map_err(|e| e.to_string())?;
            ids.push(db.last_insert_rowid());
        }
        ids
    };
    for (m, id) in msgs.iter().zip(&ids) {
        push(app, to, m.device, json!({"t": "msg", "id": id, "from": me, "dev": cx.device, "body": m.body, "ts": ts}));
        if urgent {
            wake(app, to, m.device);
        }
    }
    Ok(json!({"ts": ts}))
}

fn push(app: &App, to: &str, device: u32, v: Value) {
    if let Some(c) = app.online.lock().unwrap().get(&format!("{to}.{device}")) {
        let _ = c.tx.send(v.to_string());
    }
}

/// A message or call for a device that isn't looking (offline, or a phone app in the background):
/// if it's a phone with push turned on, wake it. Senders mark what's urgent, so receipts and typing
/// don't buzz anyone; at most one push every 30 seconds per device (each replaces the last anyway).
fn wake(app: &App, to: &str, device: u32) {
    let away = app.online.lock().unwrap().get(&format!("{to}.{device}")).is_none_or(|c| c.away);
    if away && app.pusher.enabled() && app.limits.allow(&format!("wake:{to}.{device}"), 1.0 / 30.0, 2.0) {
        let _ = app.wakes.send((to.to_owned(), device));
    }
}

async fn wake_loop(app: Shared, mut rx: mpsc::UnboundedReceiver<(String, u32)>) {
    while let Some((account, device)) = rx.recv().await {
        let token = app.db.lock().unwrap().query_row("SELECT kind, token FROM push_tokens WHERE account=? AND device=?", params![account, device], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))).optional().ok().flatten();
        let Some((kind, token)) = token else { continue };
        let app = app.clone();
        tokio::spawn(async move {
            if app.pusher.wake(&kind, &token).await.is_err() {
                let _ = app.db.lock().unwrap().execute("DELETE FROM push_tokens WHERE kind=? AND token=?", params![kind, token]);
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_device_database_migrates_to_device_1() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(
            "CREATE TABLE accounts(id TEXT PRIMARY KEY, username TEXT UNIQUE, keys TEXT NOT NULL, created INTEGER NOT NULL, access TEXT);
             CREATE TABLE prekeys(account TEXT NOT NULL, id INTEGER NOT NULL, key TEXT NOT NULL, PRIMARY KEY(account, id));
             CREATE TABLE kyber_prekeys(account TEXT NOT NULL, id INTEGER NOT NULL, key TEXT NOT NULL, sig TEXT NOT NULL, PRIMARY KEY(account, id));
             CREATE TABLE messages(id INTEGER PRIMARY KEY AUTOINCREMENT, recipient TEXT NOT NULL, sender TEXT NOT NULL, body TEXT NOT NULL, ts INTEGER NOT NULL);
             CREATE TABLE devices(account TEXT NOT NULL, id INTEGER NOT NULL, keys TEXT, name TEXT, created INTEGER NOT NULL, seen INTEGER NOT NULL, PRIMARY KEY(account, id));
             INSERT INTO accounts(id, keys, created) VALUES('alice', '{\"reg\":1}', 5);
             INSERT INTO prekeys VALUES('alice', 7, 'pk'); INSERT INTO kyber_prekeys VALUES('alice', 9, 'kk', 'sig');
             INSERT INTO messages(recipient, sender, body, ts) VALUES('alice', 'bob', 'hi', 6);",
        )
        .unwrap();
        migrate_devices(&db);
        migrate_devices(&db); // idempotent
        assert_eq!(active_devices(&db, "alice"), vec![1]);
        let keys: String = db.query_row("SELECT keys FROM devices WHERE account='alice' AND id=1", [], |r| r.get(0)).unwrap();
        assert_eq!(keys, "{\"reg\":1}");
        let pk: (u32, u32) = db.query_row("SELECT device, id FROM prekeys", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!(pk, (1, 7));
        let k: u32 = db.query_row("SELECT device FROM kyber_prekeys", [], |r| r.get(0)).unwrap();
        assert_eq!(k, 1);
        let m: (u32, u32) = db.query_row("SELECT device, sender_device FROM messages", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!(m, (1, 1));

        // A send must name exactly the recipient's current devices.
        db.execute("INSERT INTO devices(account, id, keys, created, seen) VALUES('alice', 2, '{}', 0, 0), ('alice', 3, NULL, 0, 0)", []).unwrap();
        let msgs = |ds: &[u32]| ds.iter().map(|d| DeviceMsg { device: *d, body: String::new() }).collect::<Vec<_>>();
        assert!(check_devices(&db, "alice", None, &msgs(&[1, 2])).is_ok(), "device 3 hasn't set up keys yet");
        let err = check_devices(&db, "alice", None, &msgs(&[1, 4])).unwrap_err();
        assert_eq!((err["missing"].clone(), err["extra"].clone()), (json!([2]), json!([4])));
        assert!(check_devices(&db, "alice", None, &msgs(&[1, 2, 2])).is_err(), "duplicates");
        assert!(check_devices(&db, "alice", Some(2), &msgs(&[1])).is_ok(), "writing to yourself skips this device");
    }

    #[test]
    fn dev_mode_accepts_only_local_hosts() {
        for h in ["localhost", "localhost:5173", "127.0.0.1:8787", "[::1]:8787", "[::1]"] {
            assert!(is_local_host(h), "{h}");
        }
        for h in ["getfog.org", "evil.example:8787", "localhost.evil.example", "127.0.0.1.nip.io", "[::2]:80", ""] {
            assert!(!is_local_host(h), "{h}");
        }
    }

    #[test]
    fn ip_keys_group_ipv6_by_64() {
        let k = |s: &str| ip_key(s.parse().unwrap());
        assert_eq!(k("2001:db8:1:2:aaaa::1"), k("2001:db8:1:2:bbbb::9"));
        assert_ne!(k("2001:db8:1:2::1"), k("2001:db8:1:3::1"));
        assert_eq!(k("::ffff:1.2.3.4"), "1.2.3.4");
        assert!(valid_id(&"a".repeat(43)) && !valid_id(&"a".repeat(44)) && !valid_id(&format!("{}/", "a".repeat(42))));
    }

    #[test]
    fn xeddsa_from_libsignal_verifies() {
        let acct = fog_core::Account::create(&fog_core::new_mnemonic(), 0.0).unwrap();
        let msg = auth_message("fog.example", "nonce");
        let sig = acct.sign(&msg).unwrap();
        assert!(verify(&acct.id(), &msg, &sig));
        assert!(!verify(&acct.id(), &auth_message("evil.example", "nonce"), &sig));
        let other = fog_core::Account::create(&fog_core::new_mnemonic(), 0.0).unwrap();
        assert!(!verify(&other.id(), &msg, &sig));
        assert!(!verify("garbage", &msg, &sig));
    }

    #[test]
    fn stun_binding() {
        let mut req = vec![0, 1, 0, 0];
        req.extend_from_slice(&STUN_COOKIE.to_be_bytes());
        req.extend_from_slice(&[7u8; 12]);
        let from: std::net::SocketAddr = "203.0.113.9:54321".parse().unwrap();
        let resp = stun_response(&req, from).unwrap();
        assert_eq!(&resp[0..2], &[1, 1]);
        assert_eq!(&resp[8..20], &[7u8; 12]);
        assert_eq!(&resp[20..22], &[0, 0x20]);
        let port = u16::from_be_bytes([resp[26], resp[27]]) ^ (STUN_COOKIE >> 16) as u16;
        let ip = u32::from_be_bytes(resp[28..32].try_into().unwrap()) ^ STUN_COOKIE;
        assert_eq!(port, 54321);
        assert_eq!(std::net::Ipv4Addr::from(ip).to_string(), "203.0.113.9");
        assert!(stun_response(&[0u8; 10], from).is_none());
    }

    #[test]
    fn turn_credentials_match_coturn() {
        // RFC 2104 HMAC-SHA1 test vector: key "key", message "The quick brown fox jumps over the lazy dog".
        assert_eq!(turn_credential("key", "The quick brown fox jumps over the lazy dog"), "3nybhbi3iqa8ino29wqQcBydtNk=");
    }

    #[test]
    fn pow_and_limits() {
        let n = "nonce";
        let c = (0u64..).find(|c| pow_ok(n, *c, 12)).unwrap();
        assert!(pow_ok(n, c, 12));
        assert!(!pow_ok("other", c, 12) || pow_ok("other", c, 12)); // different nonce: usually fails, never panics
        assert!(!(0u64..64).all(|c| pow_ok(n, c, 12)));
        let l = Limiter::default();
        assert!((0..5).all(|_| l.allow("k", 0.0, 5.0)));
        assert!(!l.allow("k", 0.0, 5.0));
        assert!(l.allow("other", 0.0, 5.0));
    }

    #[test]
    fn usernames() {
        assert!(valid_username("alice_99"));
        assert!(!valid_username("al"));
        assert!(!valid_username("9lives"));
        assert!(!valid_username("Alice"));
        assert!(!valid_username("a-b-c"));
    }
}
