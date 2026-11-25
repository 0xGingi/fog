//! Push notifications for phones that are asleep: a fixed "New message" through Apple (APNs) or
//! Google (FCM). No content, sender or chat goes into a push, so Apple and Google learn only that a
//! device got a message, and when.

use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use base64::engine::general_purpose::{STANDARD as B64, URL_SAFE_NO_PAD as B64URL};
use ring::rand::SystemRandom;
use ring::signature::{ECDSA_P256_SHA256_FIXED_SIGNING, EcdsaKeyPair, RSA_PKCS1_SHA256, RsaKeyPair};
use serde_json::{Value, json};

const TEXT: &str = "New message";
/// Calls: the generic text, a ringtone (made by the app at fog-ring.wav), and they get through Focus.
const CALL_TEXT: &str = "Incoming call";

pub struct Pusher {
    http: reqwest::Client,
    apns: Option<Apns>,
    fcm: Option<Fcm>,
}

struct Apns {
    key: EcdsaKeyPair,
    key_id: String,
    team: String,
    topic: String,
    /// Provider token and when it was made. Apple wants it reused for 20-60 minutes.
    jwt: Mutex<(String, u64)>,
}

struct Fcm {
    key: RsaKeyPair,
    email: String,
    project: String,
    /// OAuth access token and when it expires.
    token: Mutex<(String, u64)>,
}

/// The token no longer works (app deleted, notifications reset): forget it.
pub struct Gone;

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()
}

fn pem_der(pem: &str) -> Option<Vec<u8>> {
    B64.decode(pem.lines().filter(|l| !l.starts_with("-----")).collect::<String>().trim()).ok()
}

fn jwt(header: Value, claims: Value, sign: impl Fn(&[u8]) -> Option<Vec<u8>>) -> Option<String> {
    let msg = format!("{}.{}", B64URL.encode(header.to_string()), B64URL.encode(claims.to_string()));
    let sig = sign(msg.as_bytes())?;
    Some(format!("{msg}.{}", B64URL.encode(sig)))
}

/// Tokens go into URLs and headers, so only their real alphabets get through.
pub fn valid_token(kind: &str, token: &str) -> bool {
    match kind {
        "apns" | "apns-dev" => (64..=200).contains(&token.len()) && token.bytes().all(|b| b.is_ascii_hexdigit()),
        "fcm" => (20..=4096).contains(&token.len()) && token.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_:.".contains(&b)),
        _ => false,
    }
}

impl Pusher {
    /// APNs: FOG_APNS_KEY (path to the .p8), FOG_APNS_KEY_ID, FOG_APNS_TEAM, FOG_APNS_TOPIC (bundle id).
    /// FCM: FOG_FCM_ACCOUNT (path to the Firebase service account .json). Either may be left unset.
    pub fn from_env() -> Pusher {
        let env = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
        let need = |k: &str| env(k).unwrap_or_else(|| panic!("fog-server: FOG_APNS_KEY is set, so set {k} too"));
        let apns = env("FOG_APNS_KEY").map(|path| {
            let pem = std::fs::read_to_string(&path).expect("FOG_APNS_KEY: can't read the .p8 file");
            let key = pem_der(&pem)
                .and_then(|der| EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &der, &SystemRandom::new()).ok())
                .expect("FOG_APNS_KEY: not an APNs .p8 key");
            Apns { key, key_id: need("FOG_APNS_KEY_ID"), team: need("FOG_APNS_TEAM"), topic: env("FOG_APNS_TOPIC").unwrap_or("org.getfog.app".into()), jwt: Mutex::default() }
        });
        let fcm = env("FOG_FCM_ACCOUNT").map(|path| {
            let text = std::fs::read_to_string(&path).expect("FOG_FCM_ACCOUNT: can't read the service account file");
            let acct: Value = serde_json::from_str(&text).expect("FOG_FCM_ACCOUNT: not JSON");
            let field = |k: &str| acct[k].as_str().unwrap_or_else(|| panic!("FOG_FCM_ACCOUNT: no {k}")).to_owned();
            let key = pem_der(&field("private_key")).and_then(|der| RsaKeyPair::from_pkcs8(&der).ok()).expect("FOG_FCM_ACCOUNT: bad private_key");
            Fcm { key, email: field("client_email"), project: field("project_id"), token: Mutex::default() }
        });
        let http = reqwest::Client::builder().timeout(Duration::from_secs(10)).build().expect("http client");
        Pusher { http, apns, fcm }
    }

    pub fn enabled(&self) -> bool {
        self.apns.is_some() || self.fcm.is_some()
    }

    /// Wake one device. Failures other than a dead token are logged and dropped: the message is
    /// still queued, so the phone gets it the next time Fog opens.
    pub async fn wake(&self, kind: &str, token: &str, call: bool) -> Result<(), Gone> {
        let sent = match kind {
            "apns" | "apns-dev" => self.apns(kind == "apns-dev", token, call).await,
            "fcm" => self.fcm(token, call).await,
            _ => return Err(Gone),
        };
        match sent {
            Some((status, _)) if status < 300 => Ok(()),
            // APNs: 410 unregistered, 400 BadDeviceToken / DeviceTokenNotForTopic. FCM: 404 UNREGISTERED,
            // 400 INVALID_ARGUMENT. The payload is fixed, so a 400 is about the token.
            Some((400 | 404 | 410, _)) => Err(Gone),
            Some((status, body)) => {
                eprintln!("push ({kind}): {status} {}", body.chars().take(200).collect::<String>());
                Ok(())
            }
            None => Ok(()),
        }
    }

    async fn apns(&self, sandbox: bool, token: &str, call: bool) -> Option<(u16, String)> {
        let Some(a) = &self.apns else { return None };
        let bearer = {
            let mut cached = a.jwt.lock().unwrap();
            if cached.0.is_empty() || now() - cached.1 > 45 * 60 {
                let iat = now();
                let rng = SystemRandom::new();
                let t = jwt(json!({"alg": "ES256", "kid": a.key_id}), json!({"iss": a.team, "iat": iat}), |m| a.key.sign(&rng, m).ok().map(|s| s.as_ref().to_vec()))?;
                *cached = (t, iat);
            }
            cached.0.clone()
        };
        let host = if sandbox { "api.sandbox.push.apple.com" } else { "api.push.apple.com" };
        let r = self
            .http
            .post(format!("https://{host}/3/device/{token}"))
            .bearer_auth(bearer)
            .header("apns-topic", &a.topic)
            .header("apns-push-type", "alert")
            .header("apns-priority", "10")
            // Later pushes replace the earlier one instead of stacking up.
            .header("apns-collapse-id", if call { "fog-call" } else { "fog" })
            .header("content-type", "application/json")
            .body(
                if call {
                    json!({"aps": {"alert": {"title": "Fog", "body": CALL_TEXT}, "sound": "fog-ring.wav", "interruption-level": "time-sensitive"}})
                } else {
                    json!({"aps": {"alert": {"body": TEXT}, "sound": "default"}})
                }
                .to_string(),
            )
            .send()
            .await
            .inspect_err(|e| eprintln!("push (apns): {e}"))
            .ok()?;
        Some((r.status().as_u16(), r.text().await.unwrap_or_default()))
    }

    async fn fcm(&self, token: &str, call: bool) -> Option<(u16, String)> {
        let Some(f) = &self.fcm else { return None };
        let access = self.fcm_access(f).await?;
        // A call is a data-only push: the app shows its own full-screen ringing screen. A message
        // is a notification Android shows by itself.
        let msg = if call {
            json!({"message": {"token": token, "data": {"type": "call"}, "android": {"priority": "high", "ttl": "45s"}}})
        } else {
            json!({"message": {
                "token": token,
                "notification": {"body": TEXT},
                "android": {"priority": "high", "collapse_key": "fog", "notification": {"tag": "fog"}},
            }})
        };
        let r = self
            .http
            .post(format!("https://fcm.googleapis.com/v1/projects/{}/messages:send", f.project))
            .bearer_auth(access)
            .header("content-type", "application/json")
            .body(msg.to_string())
            .send()
            .await
            .inspect_err(|e| eprintln!("push (fcm): {e}"))
            .ok()?;
        if r.status() == 401 {
            f.token.lock().unwrap().1 = 0;
        }
        Some((r.status().as_u16(), r.text().await.unwrap_or_default()))
    }

    /// Trade a self-signed service-account JWT for an hour-long OAuth token (Google's server-to-server flow).
    async fn fcm_access(&self, f: &Fcm) -> Option<String> {
        {
            let cached = f.token.lock().unwrap();
            if !cached.0.is_empty() && now() < cached.1 {
                return Some(cached.0.clone());
            }
        }
        let iat = now();
        let claims = json!({"iss": f.email, "scope": "https://www.googleapis.com/auth/firebase.messaging",
                            "aud": "https://oauth2.googleapis.com/token", "iat": iat, "exp": iat + 3600});
        let assertion = jwt(json!({"alg": "RS256", "typ": "JWT"}), claims, |m| {
            let mut sig = vec![0; f.key.public().modulus_len()];
            f.key.sign(&RSA_PKCS1_SHA256, &SystemRandom::new(), m, &mut sig).ok().map(|_| sig)
        })?;
        let r = self
            .http
            .post("https://oauth2.googleapis.com/token")
            .header("content-type", "application/x-www-form-urlencoded")
            .body(format!("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion={assertion}"))
            .send()
            .await
            .inspect_err(|e| eprintln!("push (fcm auth): {e}"))
            .ok()?;
        let body: Value = serde_json::from_str(&r.text().await.ok()?).ok()?;
        let Some(token) = body["access_token"].as_str() else {
            eprintln!("push (fcm auth): {body}");
            return None;
        };
        let life = body["expires_in"].as_u64().unwrap_or(3600);
        *f.token.lock().unwrap() = (token.to_owned(), iat + life.saturating_sub(300));
        Some(token.to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens() {
        assert!(valid_token("apns", &"ab12".repeat(16)));
        assert!(!valid_token("apns", &format!("{}/../x", "a".repeat(64))));
        assert!(valid_token("fcm", "dGVzdA:APA91bH-x_y.z0123456789"));
        assert!(!valid_token("fcm", "abc def ghi jkl mno pqr"));
        assert!(!valid_token("webpush", &"a".repeat(64)));
    }

    #[test]
    fn signs_es256_jwts() {
        let rng = SystemRandom::new();
        let pkcs8 = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &rng).unwrap();
        let key = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, pkcs8.as_ref(), &rng).unwrap();
        let t = jwt(json!({"alg": "ES256"}), json!({"iss": "T"}), |m| key.sign(&rng, m).ok().map(|s| s.as_ref().to_vec())).unwrap();
        let parts: Vec<&str> = t.split('.').collect();
        let pk = ring::signature::UnparsedPublicKey::new(&ring::signature::ECDSA_P256_SHA256_FIXED, ring::signature::KeyPair::public_key(&key).as_ref().to_vec());
        assert!(pk.verify(format!("{}.{}", parts[0], parts[1]).as_bytes(), &B64URL.decode(parts[2]).unwrap()).is_ok());
    }
}
