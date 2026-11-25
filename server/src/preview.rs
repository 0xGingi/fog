//! Link previews, fetched by the server on the sender's behalf (the browser can't fetch arbitrary
//! sites). The sender embeds the result in the encrypted message, so recipients never contact the
//! site or us. This is a server-side fetch of user-supplied URLs, so it is locked down against SSRF:
//! public addresses only, resolved once and pinned (no DNS rebinding), redirects re-checked,
//! small size and time limits.

use std::net::{IpAddr, SocketAddr};
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use serde_json::{Value, json};

static PERMITS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(8);

pub fn is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, c, _] = v4.octets();
            !(v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_broadcast()
                || v4.is_documentation()
                || v4.is_unspecified()
                || v4.is_multicast()
                || a == 0
                || (a == 100 && (64..128).contains(&b)) // CGNAT
                || (a == 192 && b == 0 && c == 0)
                || (a == 198 && (18..20).contains(&b))
                || a >= 240)
        }
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_public(IpAddr::V4(v4));
            }
            let [s0, s1, ..] = v6.segments();
            !(v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || (s0 & 0xfe00) == 0xfc00 // unique local
                || (s0 & 0xffc0) == 0xfe80 // link local
                || (s0 == 0x64 && s1 == 0xff9b) // NAT64: embeds an IPv4 address we can't vet
                || s0 == 0x2002 // 6to4: same
                || (s0 == 0x2001 && (s1 == 0 || s1 == 0xdb8))) // Teredo, documentation
        }
    }
}

/// GET with SSRF protection and a byte cap. Returns (final url, content type, body).
async fn safe_get(start: &str, max: usize, accept: &str) -> Result<(reqwest::Url, String, Vec<u8>), String> {
    let mut url = reqwest::Url::parse(start).map_err(|_| "bad url")?;
    for _ in 0..4 {
        if !matches!(url.scheme(), "http" | "https") {
            return Err("unsupported scheme".into());
        }
        let host = url.host_str().ok_or("no host")?.to_owned();
        // Web ports only: an open port on some host (the server's own included) is no business of ours.
        let port = url.port_or_known_default().filter(|p| matches!(p, 80 | 443)).ok_or("port not allowed")?;
        let addr: SocketAddr = tokio::net::lookup_host((host.as_str(), port))
            .await
            .map_err(|_| "dns failed")?
            .find(|a| is_public(a.ip()))
            .ok_or("not a public address")?;
        // Pin the vetted address so a second DNS answer can't point us inside the network.
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy() // an env proxy would resolve the host itself and skip our pinning
            .timeout(Duration::from_secs(6))
            .resolve(&host, addr)
            .user_agent("Mozilla/5.0 (compatible; FogLinkPreview/1.0; +https://getfog.org)")
            .build()
            .map_err(|e| e.to_string())?;
        let resp = client.get(url.clone()).header("accept", accept).send().await.map_err(|_| "fetch failed")?;
        if resp.status().is_redirection() {
            let loc = resp.headers().get("location").and_then(|l| l.to_str().ok()).ok_or("bad redirect")?;
            url = url.join(loc).map_err(|_| "bad redirect")?;
            continue;
        }
        if !resp.status().is_success() {
            return Err(format!("status {}", resp.status()));
        }
        let ctype = resp.headers().get("content-type").and_then(|c| c.to_str().ok()).unwrap_or("").to_lowercase();
        let mut body = Vec::new();
        let mut resp = resp;
        while let Some(chunk) = resp.chunk().await.map_err(|_| "read failed")? {
            body.extend_from_slice(&chunk[..chunk.len().min(max - body.len())]);
            if body.len() >= max {
                break;
            }
        }
        return Ok((url, ctype, body));
    }
    Err("too many redirects".into())
}

fn decode(s: &str) -> String {
    s.replace("&amp;", "&").replace("&quot;", "\"").replace("&#39;", "'").replace("&#x27;", "'").replace("&lt;", "<").replace("&gt;", ">").replace("&nbsp;", " ")
}

fn attr(tag: &str, name: &str) -> Option<String> {
    let lower = tag.to_lowercase();
    let mut from = 0;
    while let Some(i) = lower[from..].find(name) {
        let at = from + i;
        let rest = tag[at + name.len()..].trim_start();
        let before_ok = at == 0 || lower.as_bytes()[at - 1].is_ascii_whitespace();
        if before_ok && rest.starts_with('=') {
            let v = rest[1..].trim_start();
            let (q, v) = match v.chars().next() {
                Some(q @ ('"' | '\'')) => (q, &v[1..]),
                _ => (' ', v),
            };
            let end = v.find(|c: char| c == q || (q == ' ' && (c == '>' || c.is_whitespace()))).unwrap_or(v.len());
            return Some(decode(&v[..end]));
        }
        from = at + name.len();
    }
    None
}

/// Pull title/description/image/site name from OpenGraph tags, falling back to <title>.
pub fn parse(html: &str) -> (Option<String>, Option<String>, Option<String>, Option<String>) {
    let (mut title, mut desc, mut image, mut site) = (None, None, None, None);
    for tag in html.split('<').filter(|t| t.len() > 4 && t[..4].eq_ignore_ascii_case("meta")) {
        let tag = tag.split('>').next().unwrap_or("");
        let key = attr(tag, "property").or_else(|| attr(tag, "name")).unwrap_or_default().to_lowercase();
        let Some(content) = attr(tag, "content") else { continue };
        match key.as_str() {
            "og:title" | "twitter:title" if title.is_none() => title = Some(content),
            "og:description" | "description" | "twitter:description" if desc.is_none() => desc = Some(content),
            "og:image" | "og:image:url" | "twitter:image" if image.is_none() => image = Some(content),
            "og:site_name" if site.is_none() => site = Some(content),
            _ => {}
        }
    }
    if title.is_none() {
        let lower = html.to_lowercase();
        if let (Some(a), Some(b)) = (lower.find("<title"), lower.find("</title>")) {
            if let Some(gt) = html[a..b].find('>') {
                title = Some(decode(html[a + gt + 1..b].trim()));
            }
        }
    }
    let clip = |s: Option<String>, n: usize| s.map(|s| s.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(n).collect::<String>()).filter(|s| !s.is_empty());
    (clip(title, 200), clip(desc, 300), image, clip(site, 80))
}

pub async fn fetch(url: &str) -> Result<Value, String> {
    let _permit = PERMITS.acquire().await.map_err(|_| "busy")?;
    let (final_url, ctype, body) = safe_get(url, 512 * 1024, "text/html,application/xhtml+xml").await?;
    if !ctype.contains("html") {
        return Err("not a web page".into());
    }
    let html = String::from_utf8_lossy(&body);
    let (title, desc, image, site) = parse(&html);
    if title.is_none() && desc.is_none() {
        return Err("nothing to preview".into());
    }
    let mut image_data = None;
    if let Some(src) = image.and_then(|i| final_url.join(&i).ok()) {
        if let Ok((_, it, bytes)) = safe_get(src.as_str(), 1_500_000, "image/*").await {
            if it.starts_with("image/") && !it.contains("svg") {
                image_data = Some(format!("data:{};base64,{}", it.split(';').next().unwrap_or("image/jpeg"), B64.encode(bytes)));
            }
        }
    }
    Ok(json!({
        "url": final_url.as_str(),
        "title": title,
        "desc": desc,
        "site": site.or_else(|| final_url.host_str().map(|h| h.trim_start_matches("www.").to_owned())),
        "image": image_data,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_internal_addresses() {
        for ip in ["127.0.0.1", "10.1.2.3", "192.168.1.1", "172.16.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "64:ff9b::a00:1", "2002:a00:1::1", "2001::1"] {
            assert!(!is_public(ip.parse().unwrap()), "{ip} should be blocked");
        }
        for ip in ["93.184.216.34", "1.1.1.1", "2606:4700:4700::1111"] {
            assert!(is_public(ip.parse().unwrap()), "{ip} should be allowed");
        }
    }

    #[test]
    fn parses_open_graph() {
        let html = r#"<html><head><title>Fallback</title>
            <meta property="og:title" content="Fog &amp; friends">
            <meta content='A private messenger' name="description">
            <meta property=og:image content="/cover.png"></head></html>"#;
        let (t, d, i, s) = parse(html);
        assert_eq!(t.as_deref(), Some("Fog & friends"));
        assert_eq!(d.as_deref(), Some("A private messenger"));
        assert_eq!(i.as_deref(), Some("/cover.png"));
        assert_eq!(s, None);
        assert_eq!(parse("<title> Just a title </title>").0.as_deref(), Some("Just a title"));
    }

    #[tokio::test]
    async fn refuses_to_fetch_localhost() {
        assert!(fetch("http://127.0.0.1:8787/").await.is_err());
        assert!(fetch("http://localhost/").await.is_err());
        assert!(fetch("file:///etc/passwd").await.is_err());
    }
}
