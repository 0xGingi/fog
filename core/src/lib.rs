//! fog-core: the client crypto core. Wraps libsignal for wasm (web) and native (bots, desktop, mobile).
//!
//! Identity model: an account IS its Signal identity key. The key is derived from a BIP39 phrase,
//! and the account id is the base64url of the 32-byte public key. A peer's identity is therefore
//! fixed by its address, so the server cannot swap keys for a known contact.

use std::collections::{BTreeMap, BTreeSet};
use std::time::{Duration, SystemTime};

use base64::Engine;
use base64::engine::general_purpose::{STANDARD as B64, URL_SAFE_NO_PAD as B64URL};
use futures_util::FutureExt;
use libsignal_protocol::*;
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

/// The main device (the one holding the recovery phrase) is always device 1; linked devices get 2..=MAX.
const MAIN_DEVICE: u32 = 1;
const ID_INFO: &[u8] = b"fog/identity/v1";
/// Main-device key: also derived from the phrase, never given to linked devices. The server only
/// lets device 1 log in (and link or unlink devices) with a signature from it.
const MAIN_INFO: &[u8] = b"fog/main-device/v1";
/// Saved-state format marker. State saved before multi-device has no prefix (and is device 1).
const STATE_V2: &[u8] = b"\xF0FG2";

type R<T> = std::result::Result<T, Error>;
type LResult<T> = std::result::Result<T, SignalProtocolError>;

/// Plain error; becomes a JS `Error` only at the wasm boundary (JsError panics on native).
#[derive(Debug)]
pub struct Error(pub String);

impl From<Error> for JsValue {
    fn from(e: Error) -> JsValue {
        js_sys_error(&e.0)
    }
}

fn js_sys_error(msg: &str) -> JsValue {
    JsError::new(msg).into()
}

fn err(e: impl std::fmt::Display) -> Error {
    Error(e.to_string())
}

/// libsignal takes `now` as an argument; SystemTime::now() panics on wasm32, so JS passes the clock.
fn time(ms: f64) -> SystemTime {
    SystemTime::UNIX_EPOCH + Duration::from_millis(ms as u64)
}

fn device_id(device: u32) -> R<DeviceId> {
    DeviceId::try_from(device).map_err(|_| err("bad device id"))
}

fn addr(id: &str, device: u32) -> R<ProtocolAddress> {
    Ok(ProtocolAddress::new(id.to_owned(), device_id(device)?))
}

/// Phrase -> 32-byte seed for one purpose (identity, main-device key).
fn phrase_seed(phrase: &str, info: &[u8]) -> R<(bip39::Mnemonic, [u8; 32])> {
    let m = bip39::Mnemonic::parse_normalized(phrase.trim()).map_err(err)?;
    let mut seed = [0u8; 32];
    hkdf::Hkdf::<sha2::Sha256>::new(None, &m.to_seed("")).expand(info, &mut seed).map_err(err)?;
    Ok((m, seed))
}

/// Linking: a throwaway X25519 key pair for the new device, as 32-byte private ++ 32-byte public.
#[wasm_bindgen]
pub fn link_keypair() -> Vec<u8> {
    let kp = KeyPair::generate(&mut rand::rng());
    let mut out = kp.private_key.serialize().to_vec();
    out.extend_from_slice(kp.public_key.public_key_bytes());
    out
}

/// Linking: X25519 shared secret between our private key and their 32-byte public key.
/// (The caller runs it through HKDF before using it as a key.)
#[wasm_bindgen]
pub fn link_agree(private: &[u8], their_public: &[u8]) -> R<Vec<u8>> {
    let private = PrivateKey::deserialize(private).map_err(err)?;
    let public = PublicKey::from_djb_public_key_bytes(their_public).map_err(err)?;
    Ok(private.calculate_agreement(&public).map_err(err)?.into())
}

/// Our stores are in memory, so libsignal's async calls resolve on first poll.
fn sync<F: std::future::Future>(f: F) -> F::Output {
    f.now_or_never().expect("in-memory store never pends")
}

/// Identity key for an account id. Rejects anything that is not exactly 32 bytes.
fn id_key(id: &str) -> LResult<IdentityKey> {
    let raw = B64URL
        .decode(id)
        .map_err(|_| SignalProtocolError::InvalidArgument("bad account id".into()))?;
    if raw.len() != 32 {
        return Err(SignalProtocolError::InvalidArgument("bad account id".into()));
    }
    Ok(IdentityKey::new(PublicKey::from_djb_public_key_bytes(&raw)?))
}

#[wasm_bindgen]
pub fn new_mnemonic() -> String {
    let entropy: [u8; 32] = rand::random();
    bip39::Mnemonic::from_entropy(&entropy).expect("32 bytes is valid entropy").to_string()
}

/// Signup proof-of-work: smallest counter where sha256("fog-pow-v1|<nonce>|<counter>") has `bits`
/// leading zero bits. Returned as f64 for JS (counters stay far below 2^53).
#[wasm_bindgen]
pub fn solve_pow(nonce: &str, bits: u32) -> f64 {
    use sha2::Digest;
    let zeros = |h: &[u8]| {
        let mut n = 0;
        for b in h {
            n += b.leading_zeros();
            if *b != 0 {
                break;
            }
        }
        n
    };
    (0u64..).find(|c| zeros(&sha2::Sha256::digest(format!("fog-pow-v1|{nonce}|{c}").as_bytes())) >= bits).unwrap() as f64
}

const DAY_MS: u64 = 86_400_000;

/// App-lock key derivation: Argon2id (64 MiB, 3 passes) — memory-hard, so guessing a passcode from a
/// copied device costs real hardware time per attempt, unlike PBKDF2 on GPUs.
#[wasm_bindgen]
pub fn argon2id(password: &str, salt: &[u8]) -> R<Vec<u8>> {
    use argon2::{Algorithm, Argon2, Params, Version};
    let params = Params::new(64 * 1024, 3, 1, Some(32)).map_err(err)?;
    let mut out = vec![0u8; 32];
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params).hash_password_into(password.as_bytes(), salt, &mut out).map_err(err)?;
    Ok(out)
}

/// Verify a peer's XEdDSA signature (their account id is their identity key). Used for signed group state.
#[wasm_bindgen]
pub fn verify(id: &str, msg: &[u8], sig: &[u8]) -> bool {
    id_key(id).is_ok_and(|k| k.public_key().verify_signature(msg, sig))
}

#[wasm_bindgen]
pub fn valid_mnemonic(phrase: &str) -> bool {
    bip39::Mnemonic::parse_normalized(phrase.trim()).is_ok()
}

/// One field per libsignal store trait, so each can be borrowed `&mut` independently.
#[derive(Serialize, Deserialize)]
struct State {
    /// Empty on linked devices: they get the identity key, never the recovery phrase.
    phrase: String,
    next_pk: u32,
    /// Next id for rotated signed + last-resort Kyber prekeys, and for one-time Kyber prekeys.
    #[serde(default)]
    next_signed: u32,
    #[serde(default)]
    next_kpk: u32,
    ids: Ids,
    prekeys: PreKeys,
    signed: Signed,
    kyber: Kyber,
    sessions: Sessions,
}

#[derive(Serialize, Deserialize)]
struct Ids {
    pair: Vec<u8>,
    reg_id: u32,
}
#[derive(Serialize, Deserialize, Default)]
struct PreKeys(BTreeMap<u32, Vec<u8>>);
#[derive(Serialize, Deserialize, Default)]
struct Signed(BTreeMap<u32, Vec<u8>>);
#[derive(Serialize, Deserialize, Default)]
struct Kyber {
    keys: BTreeMap<u32, Vec<u8>>,
    seen: BTreeSet<(u32, u32, Vec<u8>)>,
    /// Ids of signed last-resort keys (reusable). Everything else is one-time and deleted on use.
    #[serde(default)]
    last_resort: BTreeSet<u32>,
}
/// Keyed "<account id>.<device>".
#[derive(Serialize, Deserialize, Default)]
struct Sessions(BTreeMap<String, Vec<u8>>);

fn session_key(id: &str, device: u32) -> String {
    format!("{id}.{device}")
}

#[derive(Serialize, Deserialize)]
struct SignedKey {
    id: u32,
    #[serde(rename = "pub")]
    key: String,
    sig: String,
}

#[derive(Serialize, Deserialize)]
struct OneTimeKey {
    id: u32,
    #[serde(rename = "pub")]
    key: String,
}

/// Upload format (`pks`) and the bundle the server hands to peers (one `pk`, maybe none).
#[derive(Serialize, Deserialize)]
struct Keys {
    reg: u32,
    spk: SignedKey,
    kpk: SignedKey,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pks: Vec<OneTimeKey>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    kpks: Vec<SignedKey>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pk: Option<OneTimeKey>,
}

#[wasm_bindgen]
pub struct Account {
    st: State,
    id: String,
    device: u32,
    /// Linked devices: this device's own login key (the identity key is shared by every device, so it
    /// can't tell them apart). Empty on the main device, which proves the main-device key instead.
    device_key: Vec<u8>,
}

#[wasm_bindgen]
impl Account {
    /// Create (or restore) an account from a recovery phrase. Prekeys are fresh every time:
    /// a restored device starts new sessions while the identity stays the same.
    pub fn create(phrase: &str, now_ms: f64) -> R<Account> {
        let (m, seed) = phrase_seed(phrase, ID_INFO)?;
        let private = PrivateKey::deserialize(&seed).map_err(err)?;
        let pair = IdentityKeyPair::new(IdentityKey::new(private.public_key().map_err(err)?), private);
        Account::new(m.to_string(), pair, MAIN_DEVICE, now_ms)
    }

    /// A linked device: the identity key arrives from the main device (see `link_identity`).
    pub fn create_linked(identity: &[u8], device: u32, now_ms: f64) -> R<Account> {
        if device == MAIN_DEVICE {
            return Err(err("linked devices can't be device 1"));
        }
        device_id(device)?;
        let pair = IdentityKeyPair::try_from(identity).map_err(err)?;
        let mut acct = Account::new(String::new(), pair, device, now_ms)?;
        acct.device_key = KeyPair::generate(&mut rand::rng()).private_key.serialize().to_vec();
        Ok(acct)
    }

    fn new(phrase: String, pair: IdentityKeyPair, device: u32, now_ms: f64) -> R<Account> {
        let private = *pair.private_key();
        let rng = &mut rand::rng();

        let spk = KeyPair::generate(rng);
        let spk_sig = private.calculate_signature(&spk.public_key.serialize(), rng).map_err(err)?;
        let kpk = kem::KeyPair::generate(kem::KeyType::Kyber1024, rng);
        let kpk_sig = private.calculate_signature(&kpk.public_key.serialize(), rng).map_err(err)?;
        let ts = Timestamp::from_epoch_millis(now_ms as u64);

        let mut st = State {
            phrase,
            next_pk: 1,
            next_signed: 2,
            next_kpk: 100_000,
            ids: Ids { pair: pair.serialize().into(), reg_id: (rand::random::<u32>() & 0x3fff) | 1 },
            prekeys: PreKeys::default(),
            signed: Signed::default(),
            kyber: Kyber::default(),
            sessions: Sessions::default(),
        };
        st.signed.0.insert(1, SignedPreKeyRecord::new(1.into(), ts, &spk, &spk_sig).serialize().map_err(err)?);
        st.kyber.keys.insert(1, KyberPreKeyRecord::new(1.into(), ts, &kpk, &kpk_sig).serialize().map_err(err)?);
        st.kyber.last_resort.insert(1);
        Account::from_state(st, device)
    }

    pub fn load(bytes: &[u8]) -> R<Account> {
        match bytes.strip_prefix(STATE_V2) {
            Some(rest) => {
                let (device, device_key, st): (u32, Vec<u8>, State) = postcard::from_bytes(rest).map_err(err)?;
                let mut acct = Account::from_state(st, device)?;
                acct.device_key = device_key;
                Ok(acct)
            }
            None => Account::from_state(postcard::from_bytes(bytes).map_err(err)?, MAIN_DEVICE),
        }
    }

    fn from_state(mut st: State, device: u32) -> R<Account> {
        // Sessions saved before multi-device are keyed by account id alone: they're with device 1.
        if st.sessions.0.keys().any(|k| !k.contains('.')) {
            st.sessions.0 = std::mem::take(&mut st.sessions.0).into_iter().map(|(k, v)| if k.contains('.') { (k, v) } else { (session_key(&k, MAIN_DEVICE), v) }).collect();
        }
        // State saved before one-time Kyber keys existed: everything it holds is last-resort.
        if st.kyber.last_resort.is_empty() {
            st.kyber.last_resort = st.kyber.keys.keys().copied().collect();
        }
        if st.next_signed == 0 {
            st.next_signed = st.signed.0.keys().max().copied().unwrap_or(1) + 1;
        }
        if st.next_kpk == 0 {
            st.next_kpk = 100_000;
        }
        let pair = IdentityKeyPair::try_from(&st.ids.pair[..]).map_err(err)?;
        let id = B64URL.encode(pair.public_key().public_key_bytes());
        device_id(device)?;
        Ok(Account { st, id, device, device_key: vec![] })
    }

    fn pair(&self) -> IdentityKeyPair {
        IdentityKeyPair::try_from(&self.st.ids.pair[..]).expect("validated in from_state")
    }

    /// Serialized state. Persist after every mutating call, before acking anything to the server.
    pub fn save(&self) -> Vec<u8> {
        let mut out = STATE_V2.to_vec();
        out.extend(postcard::to_allocvec(&(self.device, &self.device_key, &self.st)).expect("state serializes"));
        out
    }

    #[wasm_bindgen(getter)]
    pub fn id(&self) -> String {
        self.id.clone()
    }

    /// The recovery phrase. Empty on linked devices.
    #[wasm_bindgen(getter)]
    pub fn phrase(&self) -> String {
        self.st.phrase.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn device(&self) -> u32 {
        self.device
    }

    /// The main device holds the recovery phrase; only it can link and unlink devices.
    #[wasm_bindgen(getter)]
    pub fn is_main(&self) -> bool {
        !self.st.phrase.is_empty()
    }

    fn main_key(&self) -> R<PrivateKey> {
        if !self.is_main() {
            return Err(err("only the main device has this key"));
        }
        PrivateKey::deserialize(&phrase_seed(&self.st.phrase, MAIN_INFO)?.1).map_err(err)
    }

    /// Public half of the main-device key (base64url, same format as an account id).
    pub fn main_public(&self) -> R<String> {
        Ok(B64URL.encode(self.main_key()?.public_key().map_err(err)?.public_key_bytes()))
    }

    /// XEdDSA signature with the main-device key (device-1 login).
    pub fn main_sign(&self, msg: &[u8]) -> R<Vec<u8>> {
        Ok(self.main_key()?.calculate_signature(msg, &mut rand::rng()).map_err(err)?.into())
    }

    fn device_private(&self) -> R<PrivateKey> {
        PrivateKey::deserialize(&self.device_key).map_err(|_| err("only linked devices have a device key"))
    }

    /// Linked devices: public half of this device's login key (base64url).
    pub fn device_public(&self) -> R<String> {
        Ok(B64URL.encode(self.device_private()?.public_key().map_err(err)?.public_key_bytes()))
    }

    /// Linked devices: XEdDSA signature with this device's login key.
    pub fn device_sign(&self, msg: &[u8]) -> R<Vec<u8>> {
        Ok(self.device_private()?.calculate_signature(msg, &mut rand::rng()).map_err(err)?.into())
    }

    /// The identity key pair, for handing to a device being linked (end-to-end encrypted). Main only.
    pub fn link_identity(&self) -> R<Vec<u8>> {
        self.main_key()?;
        Ok(self.st.ids.pair.clone())
    }

    /// Unused one-time prekeys still held locally.
    #[wasm_bindgen(getter)]
    pub fn prekey_count(&self) -> u32 {
        self.st.prekeys.0.len() as u32
    }

    /// XEdDSA signature with the identity key (server login challenge).
    pub fn sign(&self, msg: &[u8]) -> R<Vec<u8>> {
        let sig = self.pair().private_key().calculate_signature(msg, &mut rand::rng()).map_err(err)?;
        Ok(sig.into())
    }

    /// Key upload JSON including `n` fresh one-time EC prekeys and `nk` one-time Kyber prekeys.
    pub fn keys(&mut self, n: u32, nk: u32) -> R<String> {
        let rng = &mut rand::rng();
        let identity = self.pair();
        let mut kpks = vec![];
        for _ in 0..nk {
            let id = self.st.next_kpk;
            self.st.next_kpk = self.st.next_kpk.wrapping_add(1).max(100_000);
            let kp = kem::KeyPair::generate(kem::KeyType::Kyber1024, rng);
            let sig = identity.private_key().calculate_signature(&kp.public_key.serialize(), rng).map_err(err)?;
            let rec = KyberPreKeyRecord::new(id.into(), Timestamp::from_epoch_millis(0), &kp, &sig);
            self.st.kyber.keys.insert(id, rec.serialize().map_err(err)?);
            kpks.push(SignedKey { id, key: B64.encode(kp.public_key.serialize()), sig: B64.encode(sig) });
        }
        let mut pks = vec![];
        for _ in 0..n {
            let id = self.st.next_pk;
            self.st.next_pk = self.st.next_pk % 0xff_fffe + 1;
            let kp = KeyPair::generate(rng);
            self.st.prekeys.0.insert(id, PreKeyRecord::new(id.into(), &kp).serialize().map_err(err)?);
            pks.push(OneTimeKey { id, key: B64.encode(kp.public_key.serialize()) });
        }
        let (&sid, raw) = self.st.signed.0.last_key_value().ok_or_else(|| err("no signed prekey"))?;
        let s = SignedPreKeyRecord::deserialize(raw).map_err(err)?;
        let kid = *self.st.kyber.last_resort.last().ok_or_else(|| err("no kyber prekey"))?;
        let k = KyberPreKeyRecord::deserialize(&self.st.kyber.keys[&kid]).map_err(err)?;
        let keys = Keys {
            reg: self.st.ids.reg_id,
            spk: SignedKey {
                id: sid,
                key: B64.encode(s.public_key().map_err(err)?.serialize()),
                sig: B64.encode(s.signature().map_err(err)?),
            },
            kpk: SignedKey {
                id: kid,
                key: B64.encode(k.public_key().map_err(err)?.serialize()),
                sig: B64.encode(k.signature().map_err(err)?),
            },
            pks,
            kpks,
            pk: None,
        };
        serde_json::to_string(&keys).map_err(err)
    }

    /// Weekly rotation of the signed prekey and last-resort Kyber key. Old ones are kept for 30
    /// days so messages already in flight still decrypt. Returns true if new keys need uploading.
    pub fn rotate(&mut self, now_ms: f64) -> R<bool> {
        let now = now_ms as u64;
        let newest = self.st.signed.0.last_key_value().and_then(|(_, r)| SignedPreKeyRecord::deserialize(r).ok()).and_then(|r| r.timestamp().ok());
        if newest.is_some_and(|t| now.saturating_sub(t.epoch_millis()) < 7 * DAY_MS) {
            return Ok(false);
        }
        let rng = &mut rand::rng();
        let identity = self.pair();
        let id = self.st.next_signed;
        self.st.next_signed += 1;
        let ts = Timestamp::from_epoch_millis(now);
        let spk = KeyPair::generate(rng);
        let spk_sig = identity.private_key().calculate_signature(&spk.public_key.serialize(), rng).map_err(err)?;
        let kpk = kem::KeyPair::generate(kem::KeyType::Kyber1024, rng);
        let kpk_sig = identity.private_key().calculate_signature(&kpk.public_key.serialize(), rng).map_err(err)?;
        self.st.signed.0.insert(id, SignedPreKeyRecord::new(id.into(), ts, &spk, &spk_sig).serialize().map_err(err)?);
        self.st.kyber.keys.insert(id, KyberPreKeyRecord::new(id.into(), ts, &kpk, &kpk_sig).serialize().map_err(err)?);
        self.st.kyber.last_resort.insert(id);
        // Drop rotated keys older than 30 days (never the newest).
        let old = |raw: &Vec<u8>| SignedPreKeyRecord::deserialize(raw).ok().and_then(|r| r.timestamp().ok()).is_some_and(|t| now.saturating_sub(t.epoch_millis()) > 30 * DAY_MS);
        self.st.signed.0.retain(|k, r| *k == id || !old(r));
        let expired: Vec<u32> = self.st.kyber.last_resort.iter().copied().filter(|k| *k != id && self.st.kyber.keys.get(k).is_some_and(|r| KyberPreKeyRecord::deserialize(r).ok().and_then(|r| r.timestamp().ok()).is_some_and(|t| now.saturating_sub(t.epoch_millis()) > 30 * DAY_MS))).collect();
        for k in expired {
            self.st.kyber.keys.remove(&k);
            self.st.kyber.last_resort.remove(&k);
            self.st.kyber.seen.retain(|(kid, _, _)| *kid != k);
        }
        Ok(true)
    }

    /// Unused one-time Kyber prekeys held locally.
    #[wasm_bindgen(getter)]
    pub fn kyber_count(&self) -> u32 {
        (self.st.kyber.keys.len() - self.st.kyber.last_resort.len()) as u32
    }

    pub fn has_session(&self, peer: &str, device: u32) -> bool {
        self.st.sessions.0.contains_key(&session_key(peer, device))
    }

    /// Devices of `peer` we have sessions with.
    pub fn session_devices(&self, peer: &str) -> Vec<u32> {
        let prefix = format!("{peer}.");
        self.st.sessions.0.keys().filter_map(|k| k.strip_prefix(&prefix)?.parse().ok()).collect()
    }

    /// Forget a session (the peer unlinked that device).
    pub fn drop_session(&mut self, peer: &str, device: u32) {
        self.st.sessions.0.remove(&session_key(peer, device));
    }

    /// PQXDH from a peer's prekey bundle (JSON from the server). libsignal verifies the bundle
    /// signatures against the identity implied by `peer`, so a server-substituted bundle fails.
    pub fn start_session(&mut self, peer: &str, device: u32, bundle: &str, now_ms: f64) -> R<()> {
        let b: Keys = serde_json::from_str(bundle).map_err(err)?;
        let dec = |s: &str| B64.decode(s).map_err(err);
        let pk = match &b.pk {
            Some(k) => Some((k.id.into(), PublicKey::deserialize(&dec(&k.key)?).map_err(err)?)),
            None => None,
        };
        let bundle = PreKeyBundle::new(
            b.reg,
            device_id(device)?,
            pk,
            b.spk.id.into(),
            PublicKey::deserialize(&dec(&b.spk.key)?).map_err(err)?,
            dec(&b.spk.sig)?,
            b.kpk.id.into(),
            kem::PublicKey::deserialize(&dec(&b.kpk.key)?).map_err(err)?,
            dec(&b.kpk.sig)?,
            id_key(peer).map_err(err)?,
        )
        .map_err(err)?;
        let (me, them) = (addr(&self.id, self.device)?, addr(peer, device)?);
        let st = &mut self.st;
        sync(process_prekey_bundle(&them, &me, &mut st.sessions, &mut st.ids, &bundle, time(now_ms), &mut rand::rng()))
            .map_err(err)
    }

    /// Encrypt to a peer with an existing session. Output: [message type byte] ++ ciphertext.
    pub fn encrypt(&mut self, peer: &str, device: u32, plaintext: &[u8], now_ms: f64) -> R<Vec<u8>> {
        let (me, them) = (addr(&self.id, self.device)?, addr(peer, device)?);
        let st = &mut self.st;
        let msg = sync(message_encrypt(plaintext, &them, &me, &mut st.sessions, &mut st.ids, time(now_ms), &mut rand::rng()))
            .map_err(err)?;
        let mut out = vec![msg.message_type() as u8];
        out.extend_from_slice(msg.serialize());
        Ok(out)
    }

    /// Decrypt an envelope from `peer` (the sender as claimed by the server; a false claim fails).
    pub fn decrypt(&mut self, peer: &str, device: u32, envelope: &[u8]) -> R<Vec<u8>> {
        let (&ty, body) = envelope.split_first().ok_or_else(|| err("empty envelope"))?;
        let msg = match CiphertextMessageType::try_from(ty).map_err(|_| err("bad message type"))? {
            CiphertextMessageType::Whisper => CiphertextMessage::SignalMessage(body.try_into().map_err(err)?),
            CiphertextMessageType::PreKey => CiphertextMessage::PreKeySignalMessage(body.try_into().map_err(err)?),
            _ => return Err(err("unsupported message type")),
        };
        let (me, them) = (addr(&self.id, self.device)?, addr(peer, device)?);
        let st = &mut self.st;
        sync(message_decrypt(
            &msg,
            &them,
            &me,
            &mut st.sessions,
            &mut st.ids,
            &mut st.prekeys,
            &st.signed,
            &mut st.kyber,
            &mut rand::rng(),
        ))
        .map_err(err)
    }

    /// Scannable safety code (for a QR). Scanning theirs and comparing proves you have each other's real keys.
    pub fn safety_qr(&self, peer: &str) -> R<Vec<u8>> {
        let theirs = id_key(peer).map_err(err)?;
        let f = Fingerprint::new(2, 5200, self.id.as_bytes(), self.pair().identity_key(), peer.as_bytes(), &theirs).map_err(err)?;
        f.scannable.serialize().map_err(err)
    }

    /// Compare a scanned safety code with ours for this peer.
    pub fn safety_compare(&self, peer: &str, scanned: &[u8]) -> R<bool> {
        let theirs = id_key(peer).map_err(err)?;
        let f = Fingerprint::new(2, 5200, self.id.as_bytes(), self.pair().identity_key(), peer.as_bytes(), &theirs).map_err(err)?;
        f.scannable.compare(scanned).map_err(err)
    }

    /// 60-digit Signal safety number for this pair (same string on both sides).
    pub fn safety_number(&self, peer: &str) -> R<String> {
        let theirs = id_key(peer).map_err(err)?;
        Fingerprint::new(2, 5200, self.id.as_bytes(), self.pair().identity_key(), peer.as_bytes(), &theirs)
            .map_err(err)?
            .display_string()
            .map_err(err)
    }
}

/// Sealed sender, server side: the server holds a trust root and a server certificate, and issues
/// short-lived sender certificates. (Used by fog-server; not exported to JS.)
pub mod sealed {
    use super::*;

    /// (private, public) trust root key pair.
    pub fn new_trust_root() -> (Vec<u8>, Vec<u8>) {
        let kp = KeyPair::generate(&mut rand::rng());
        (kp.private_key.serialize().to_vec(), kp.public_key.serialize().to_vec())
    }

    /// (server certificate, server private key), signed by the trust root.
    pub fn server_certificate(trust_root_private: &[u8], key_id: u32) -> Result<(Vec<u8>, Vec<u8>), String> {
        let rng = &mut rand::rng();
        let trust = PrivateKey::deserialize(trust_root_private).map_err(|e| e.to_string())?;
        let kp = KeyPair::generate(rng);
        let cert = ServerCertificate::new(key_id, kp.public_key, &trust, rng).map_err(|e| e.to_string())?;
        Ok((cert.serialized().map_err(|e| e.to_string())?.to_vec(), kp.private_key.serialize().to_vec()))
    }

    /// A sender certificate binding an account id (= its identity key) until `expires_ms`.
    pub fn sender_certificate(server_cert: &[u8], server_private: &[u8], sender_id: &str, device: u32, expires_ms: u64) -> Result<Vec<u8>, String> {
        let signer = ServerCertificate::deserialize(server_cert).map_err(|e| e.to_string())?;
        let key = PrivateKey::deserialize(server_private).map_err(|e| e.to_string())?;
        let identity = id_key(sender_id).map_err(|e| e.to_string())?;
        let cert = SenderCertificate::new(
            sender_id.to_owned(),
            None,
            *identity.public_key(),
            DeviceId::try_from(device).map_err(|_| "bad device id".to_string())?,
            Timestamp::from_epoch_millis(expires_ms),
            signer,
            &key,
            &mut rand::rng(),
        )
        .map_err(|e| e.to_string())?;
        Ok(cert.serialized().map_err(|e| e.to_string())?.to_vec())
    }
}

#[wasm_bindgen]
impl Account {
    /// Sealed sender: encrypt so the server can't see who sent it. Needs an existing session.
    pub fn seal(&mut self, peer: &str, device: u32, plaintext: &[u8], sender_cert: &[u8], now_ms: f64) -> R<Vec<u8>> {
        let cert = SenderCertificate::deserialize(sender_cert).map_err(err)?;
        let them = addr(peer, device)?;
        let st = &mut self.st;
        sync(sealed_sender_encrypt(&them, &cert, plaintext, &mut st.sessions, &mut st.ids, time(now_ms), &mut rand::rng())).map_err(err)
    }

    /// Open a sealed message: verifies the sender certificate against the pinned trust root,
    /// decrypts, and returns [43-byte sender id] ++ [sender device] ++ plaintext. Our identity store still checks that
    /// the sender's identity key equals their account id, so a forged certificate can't impersonate.
    pub fn unseal(&mut self, data: &[u8], trust_root: &[u8], now_ms: f64) -> R<Vec<u8>> {
        let trust = PublicKey::deserialize(trust_root).map_err(err)?;
        let me = self.id.clone();
        let st = &mut self.st;
        let out = sync(sealed_sender_decrypt(
            data,
            &trust,
            Timestamp::from_epoch_millis(now_ms as u64),
            None,
            me,
            device_id(self.device)?,
            &mut st.ids,
            &mut st.sessions,
            &mut st.prekeys,
            &st.signed,
            &mut st.kyber,
        ))
        .map_err(err)?;
        if out.sender_uuid.len() != 43 {
            return Err(err("bad sender"));
        }
        let mut v = out.sender_uuid.into_bytes();
        v.push(u8::from(out.device_id));
        v.extend_from_slice(&out.message);
        Ok(v)
    }
}

fn same_identity(address: &ProtocolAddress, identity: &IdentityKey) -> bool {
    id_key(address.name()).is_ok_and(|k| &k == identity)
}

#[async_trait::async_trait(?Send)]
impl IdentityKeyStore for Ids {
    async fn get_identity_key_pair(&self) -> LResult<IdentityKeyPair> {
        IdentityKeyPair::try_from(&self.pair[..])
    }
    async fn get_local_registration_id(&self) -> LResult<u32> {
        Ok(self.reg_id)
    }
    async fn save_identity(&mut self, address: &ProtocolAddress, identity: &IdentityKey) -> LResult<IdentityChange> {
        if !same_identity(address, identity) {
            return Err(SignalProtocolError::UntrustedIdentity(address.clone()));
        }
        Ok(IdentityChange::NewOrUnchanged)
    }
    /// The account id is the identity key, so trust is exact equality: no TOFU, no key changes.
    async fn is_trusted_identity(&self, address: &ProtocolAddress, identity: &IdentityKey, _: Direction) -> LResult<bool> {
        Ok(same_identity(address, identity))
    }
    async fn get_identity(&self, address: &ProtocolAddress) -> LResult<Option<IdentityKey>> {
        Ok(id_key(address.name()).ok())
    }
}

#[async_trait::async_trait(?Send)]
impl PreKeyStore for PreKeys {
    async fn get_pre_key(&self, id: PreKeyId) -> LResult<PreKeyRecord> {
        PreKeyRecord::deserialize(self.0.get(&id.into()).ok_or(SignalProtocolError::InvalidPreKeyId)?)
    }
    async fn save_pre_key(&mut self, id: PreKeyId, record: &PreKeyRecord) -> LResult<()> {
        self.0.insert(id.into(), record.serialize()?);
        Ok(())
    }
    async fn remove_pre_key(&mut self, id: PreKeyId) -> LResult<()> {
        self.0.remove(&id.into());
        Ok(())
    }
}

#[async_trait::async_trait(?Send)]
impl SignedPreKeyStore for Signed {
    async fn get_signed_pre_key(&self, id: SignedPreKeyId) -> LResult<SignedPreKeyRecord> {
        SignedPreKeyRecord::deserialize(self.0.get(&id.into()).ok_or(SignalProtocolError::InvalidSignedPreKeyId)?)
    }
    async fn save_signed_pre_key(&mut self, id: SignedPreKeyId, record: &SignedPreKeyRecord) -> LResult<()> {
        self.0.insert(id.into(), record.serialize()?);
        Ok(())
    }
}

#[async_trait::async_trait(?Send)]
impl KyberPreKeyStore for Kyber {
    async fn get_kyber_pre_key(&self, id: KyberPreKeyId) -> LResult<KyberPreKeyRecord> {
        KyberPreKeyRecord::deserialize(self.keys.get(&id.into()).ok_or(SignalProtocolError::InvalidKyberPreKeyId)?)
    }
    async fn save_kyber_pre_key(&mut self, id: KyberPreKeyId, record: &KyberPreKeyRecord) -> LResult<()> {
        self.keys.insert(id.into(), record.serialize()?);
        Ok(())
    }
    /// One-time keys are deleted on use. Last-resort keys get reused, so a replayed
    /// (kyber, signed, base key) triple is rejected; that log is pruned when keys rotate out.
    async fn mark_kyber_pre_key_used(&mut self, kid: KyberPreKeyId, sid: SignedPreKeyId, base: &PublicKey) -> LResult<()> {
        let kid: u32 = kid.into();
        if !self.last_resort.contains(&kid) {
            self.keys.remove(&kid);
            return Ok(());
        }
        if !self.seen.insert((kid, sid.into(), base.serialize().into())) {
            return Err(SignalProtocolError::InvalidMessage(CiphertextMessageType::PreKey, "reused base key".into()));
        }
        Ok(())
    }
}

#[async_trait::async_trait(?Send)]
impl SessionStore for Sessions {
    async fn load_session(&self, address: &ProtocolAddress) -> LResult<Option<SessionRecord>> {
        self.0.get(&session_key(address.name(), address.device_id().into())).map(|r| SessionRecord::deserialize(r)).transpose()
    }
    async fn store_session(&mut self, address: &ProtocolAddress, record: &SessionRecord) -> LResult<()> {
        self.0.insert(session_key(address.name(), address.device_id().into()), record.serialize()?);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const T: f64 = 1_790_000_000_000.0;

    fn bundle(acct: &mut Account) -> String {
        let mut k: serde_json::Value = serde_json::from_str(&acct.keys(2, 2).unwrap()).unwrap();
        k["pk"] = k["pks"][0].clone();
        k["kpk"] = k["kpks"][0].clone();
        k.to_string()
    }

    #[test]
    fn roundtrip() {
        let mut alice = Account::create(&new_mnemonic(), T).unwrap();
        let mut bob = Account::create(&new_mnemonic(), T).unwrap();
        let mallory = Account::create(&new_mnemonic(), T).unwrap();
        let b = bundle(&mut bob);

        // Bob's bundle presented as someone else's: signature check fails.
        assert!(alice.start_session(&mallory.id(), 1, &b, T).is_err());

        alice.start_session(&bob.id(), 1, &b, T).unwrap();
        let m1 = alice.encrypt(&bob.id(), 1, b"hi bob", T).unwrap();
        assert_eq!(m1[0], CiphertextMessageType::PreKey as u8);

        // Server lying about the sender: rejected.
        assert!(bob.decrypt(&mallory.id(), 1, &m1).is_err());

        // State survives save/load, then decrypts; replay is rejected.
        let mut bob = Account::load(&bob.save()).unwrap();
        assert_eq!(bob.decrypt(&alice.id(), 1, &m1).unwrap(), b"hi bob");
        assert!(bob.decrypt(&alice.id(), 1, &m1).is_err());

        let m2 = bob.encrypt(&alice.id(), 1, b"hi alice", T).unwrap();
        assert_eq!(alice.decrypt(&bob.id(), 1, &m2).unwrap(), b"hi alice");
        for i in 0..5 {
            let m = alice.encrypt(&bob.id(), 1, format!("msg {i}").as_bytes(), T).unwrap();
            assert_eq!(bob.decrypt(&alice.id(), 1, &m).unwrap(), format!("msg {i}").as_bytes());
        }
        assert_eq!(alice.safety_number(&bob.id()).unwrap(), bob.safety_number(&alice.id()).unwrap());

        // Same phrase -> same account id (restore).
        assert_eq!(Account::create(&alice.phrase(), T).unwrap().id(), alice.id());

        // The one-time Kyber key was consumed; one is left.
        assert_eq!(bob.kyber_count(), 1);
    }

    #[test]
    fn rotation_keeps_old_sessions_working() {
        let mut alice = Account::create(&new_mnemonic(), T).unwrap();
        let mut bob = Account::create(&new_mnemonic(), T).unwrap();
        // Alice fetched Bob's bundle (last-resort Kyber only), then Bob rotated before her message arrived.
        let mut k: serde_json::Value = serde_json::from_str(&bob.keys(1, 0).unwrap()).unwrap();
        k["pk"] = k["pks"][0].clone();
        alice.start_session(&bob.id(), 1, &k.to_string(), T).unwrap();
        let m = alice.encrypt(&bob.id(), 1, b"late", T).unwrap();
        assert!(!bob.rotate(T + 1000.0).unwrap(), "fresh keys don't rotate");
        assert!(bob.rotate(T + 8.0 * DAY_MS as f64).unwrap());
        assert_eq!(bob.decrypt(&alice.id(), 1, &m).unwrap(), b"late");
        // New bundles advertise the new keys.
        let k2: serde_json::Value = serde_json::from_str(&bob.keys(0, 0).unwrap()).unwrap();
        assert_ne!(k2["spk"]["id"], k["spk"]["id"]);
    }

    #[test]
    fn sealed_sender_roundtrip() {
        let mut alice = Account::create(&new_mnemonic(), T).unwrap();
        let mut bob = Account::create(&new_mnemonic(), T).unwrap();
        let mallory = Account::create(&new_mnemonic(), T).unwrap();
        let (trust_priv, trust_pub) = sealed::new_trust_root();
        let (server_cert, server_priv) = sealed::server_certificate(&trust_priv, 1).unwrap();
        let exp = T as u64 + DAY_MS;
        let cert = sealed::sender_certificate(&server_cert, &server_priv, &alice.id(), 1, exp).unwrap();

        alice.start_session(&bob.id(), 1, &bundle(&mut bob), T).unwrap();
        let sealed_msg = alice.seal(&bob.id(), 1, b"no metadata", &cert, T).unwrap();
        let out = bob.unseal(&sealed_msg, &trust_pub, T).unwrap();
        assert_eq!(&out[..43], alice.id().as_bytes());
        assert_eq!(out[43], 1, "sender device");
        assert_eq!(&out[44..], b"no metadata");

        // Replies seal the other way too.
        let bob_cert = sealed::sender_certificate(&server_cert, &server_priv, &bob.id(), 1, exp).unwrap();
        let back = bob.seal(&alice.id(), 1, b"hi", &bob_cert, T).unwrap();
        assert_eq!(&alice.unseal(&back, &trust_pub, T).unwrap()[44..], b"hi");

        // A certificate claiming to be Mallory over Alice's session doesn't decrypt as Mallory.
        let forged = sealed::sender_certificate(&server_cert, &server_priv, &mallory.id(), 1, exp).unwrap();
        let fake = alice.seal(&bob.id(), 1, b"spoof", &forged, T).unwrap();
        assert!(bob.unseal(&fake, &trust_pub, T).is_err());
        // Expired certificates and wrong trust roots are rejected.
        let m2 = alice.seal(&bob.id(), 1, b"late", &cert, T).unwrap();
        assert!(bob.unseal(&m2, &trust_pub, T + 2.0 * DAY_MS as f64).is_err());
        let (_, other_root) = sealed::new_trust_root();
        let m3 = alice.seal(&bob.id(), 1, b"x", &cert, T).unwrap();
        assert!(bob.unseal(&m3, &other_root, T).is_err());
    }

    #[test]
    fn argon2_and_verify() {
        let a = argon2id("correct horse", b"0123456789abcdef").unwrap();
        assert_eq!(a.len(), 32);
        assert_eq!(a, argon2id("correct horse", b"0123456789abcdef").unwrap());
        assert_ne!(a, argon2id("correct horsf", b"0123456789abcdef").unwrap());
        let alice = Account::create(&new_mnemonic(), T).unwrap();
        let bob = Account::create(&new_mnemonic(), T).unwrap();
        let sig = alice.sign(b"group state").unwrap();
        assert!(verify(&alice.id(), b"group state", &sig));
        assert!(!verify(&bob.id(), b"group state", &sig));
        assert!(!verify(&alice.id(), b"group statf", &sig));
    }

    #[test]
    fn safety_qr_compares_both_ways() {
        let alice = Account::create(&new_mnemonic(), T).unwrap();
        let bob = Account::create(&new_mnemonic(), T).unwrap();
        let carol = Account::create(&new_mnemonic(), T).unwrap();
        assert!(bob.safety_compare(&alice.id(), &alice.safety_qr(&bob.id()).unwrap()).unwrap());
        // A code for a different pair doesn't verify.
        assert!(!bob.safety_compare(&alice.id(), &carol.safety_qr(&bob.id()).unwrap()).unwrap_or(false));
    }

    #[test]
    fn linked_device_shares_identity_with_its_own_sessions() {
        let mut alice = Account::create(&new_mnemonic(), T).unwrap();
        let mut bob = Account::create(&new_mnemonic(), T).unwrap();
        // Linking: the new device's throwaway key and the main device agree on a transfer key.
        let lk = link_keypair();
        let main_side = link_agree(&link_keypair()[..32], &lk[32..]).unwrap();
        assert_eq!(main_side.len(), 32);
        let other = link_keypair();
        assert_eq!(link_agree(&other[..32], &lk[32..]).unwrap(), link_agree(&lk[..32], &other[32..]).unwrap());

        let mut laptop = Account::create_linked(&alice.link_identity().unwrap(), 2, T).unwrap();
        assert_eq!(laptop.id(), alice.id());
        assert_eq!((laptop.device(), laptop.is_main(), laptop.phrase().as_str()), (2, false, ""));
        assert!(laptop.main_sign(b"x").is_err() && laptop.link_identity().is_err(), "only the main device holds the main key");
        assert!(Account::create_linked(&alice.link_identity().unwrap(), 1, T).is_err());
        // Each linked device has its own login key; the main device doesn't.
        let tablet = Account::create_linked(&alice.link_identity().unwrap(), 3, T).unwrap();
        assert_ne!(laptop.device_public().unwrap(), tablet.device_public().unwrap());
        assert!(verify(&laptop.device_public().unwrap(), b"c", &laptop.device_sign(b"c").unwrap()));
        assert!(!verify(&tablet.device_public().unwrap(), b"c", &laptop.device_sign(b"c").unwrap()));
        assert!(alice.device_public().is_err());
        // The main-device key comes from the phrase: a restore gets the same one.
        let sig = alice.main_sign(b"login").unwrap();
        assert!(verify(&alice.main_public().unwrap(), b"login", &sig));
        assert!(!verify(&alice.id(), b"login", &sig), "main key differs from the identity key");
        assert_eq!(Account::create(&alice.phrase(), T).unwrap().main_public().unwrap(), alice.main_public().unwrap());

        // Bob talks to both of Alice's devices; each has its own session.
        bob.start_session(&alice.id(), 1, &bundle(&mut alice), T).unwrap();
        bob.start_session(&alice.id(), 2, &bundle(&mut laptop), T).unwrap();
        let mut devs = bob.session_devices(&alice.id());
        devs.sort();
        assert_eq!(devs, vec![1, 2]);
        let to_phone = bob.encrypt(&alice.id(), 1, b"hi phone", T).unwrap();
        let to_laptop = bob.encrypt(&alice.id(), 2, b"hi laptop", T).unwrap();
        assert!(laptop.decrypt(&bob.id(), 1, &to_phone).is_err(), "a device can't read another device's copy");
        assert_eq!(alice.decrypt(&bob.id(), 1, &to_phone).unwrap(), b"hi phone");
        assert_eq!(laptop.decrypt(&bob.id(), 1, &to_laptop).unwrap(), b"hi laptop");
        // Replies come from a specific device; the laptop's state survives save/load.
        let key = laptop.device_public().unwrap();
        let mut laptop = Account::load(&laptop.save()).unwrap();
        assert_eq!((laptop.device(), laptop.device_public().unwrap()), (2, key), "device key survives save/load");
        let reply = laptop.encrypt(&bob.id(), 1, b"from laptop", T).unwrap();
        assert!(bob.decrypt(&alice.id(), 1, &reply).is_err(), "wrong device claimed");
        assert_eq!(bob.decrypt(&alice.id(), 2, &reply).unwrap(), b"from laptop");

        // Sealed sender reports the sending device.
        let (trust_priv, trust_pub) = sealed::new_trust_root();
        let (sc, sk) = sealed::server_certificate(&trust_priv, 1).unwrap();
        let cert = sealed::sender_certificate(&sc, &sk, &laptop.id(), 2, T as u64 + DAY_MS).unwrap();
        let m = laptop.seal(&bob.id(), 1, b"sealed from laptop", &cert, T).unwrap();
        let out = bob.unseal(&m, &trust_pub, T).unwrap();
        assert_eq!((&out[..43], out[43], &out[44..]), (alice.id().as_bytes(), 2, &b"sealed from laptop"[..]));

        // Alice unlinks the laptop: Bob forgets that session.
        bob.drop_session(&alice.id(), 2);
        assert_eq!(bob.session_devices(&alice.id()), vec![1]);
    }

    #[test]
    fn state_saved_before_multi_device_still_loads() {
        let mut alice = Account::create(&new_mnemonic(), T).unwrap();
        let mut bob = Account::create(&new_mnemonic(), T).unwrap();
        alice.start_session(&bob.id(), 1, &bundle(&mut bob), T).unwrap();
        // Old format: bare postcard of State, sessions keyed by account id alone.
        alice.st.sessions.0 = std::mem::take(&mut alice.st.sessions.0).into_iter().map(|(k, v)| (k.split('.').next().unwrap().to_owned(), v)).collect();
        let legacy = postcard::to_allocvec(&alice.st).unwrap();
        let mut back = Account::load(&legacy).unwrap();
        assert_eq!((back.device(), back.id()), (1, alice.id()));
        assert!(back.has_session(&bob.id(), 1));
        let m = back.encrypt(&bob.id(), 1, b"still works", T).unwrap();
        assert_eq!(bob.decrypt(&alice.id(), 1, &m).unwrap(), b"still works");
        assert!(back.save().starts_with(STATE_V2));
    }

    #[test]
    fn pow_solves() {
        let c = solve_pow("abc", 12) as u64;
        use sha2::Digest;
        let h = sha2::Sha256::digest(format!("fog-pow-v1|abc|{c}").as_bytes());
        assert_eq!(h[0], 0);
        assert!(h[1] < 16);
    }
}
