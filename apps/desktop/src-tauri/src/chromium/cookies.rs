//! Import cookies from the installed Google Chrome into the current project's
//! Chromium profile (browser panel, Chromium engine only).
//!
//! - It is a one-time copy of the domains the user picks, not a sync: later
//!   changes in Chrome stay there until the next import.
//! - Listing a profile's domains reads only host names and counts; nothing is
//!   decrypted and the Keychain is not touched.
//! - Importing reads the chosen domains' cookies from a private temporary copy
//!   of Chrome's `Cookies` database (with the system `sqlite3`), decrypts their
//!   values with the "Chrome Safe Storage" key from the macOS Keychain (macOS
//!   asks the user to allow that; no password is asked for or handled here),
//!   and sets them in the project's browser over CDP (`Storage.setCookies`).
//! - Decrypted values exist only in memory on their way to the browser: never in
//!   logs, errors, the agent, ACP or any file but the Chromium profile.

use super::engine;
use aes::cipher::{block_padding::Pkcs7, BlockDecryptMut, KeyIvInit};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{AppHandle, Manager, Webview};
use zeroize::Zeroizing;

type Aes128CbcDec = cbc::Decryptor<aes::Aes128>;

/// Seconds between 1601-01-01 (Chrome's epoch) and 1970-01-01.
const WINDOWS_TO_UNIX: f64 = 11_644_473_600.0;
/// Chrome databases from this version on prefix each decrypted value with SHA-256(host_key).
const HASH_PREFIX_VERSION: i64 = 24;
const SQLITE: &str = "/usr/bin/sqlite3";

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChromeProfile {
    /// The profile's folder name (`Default`, `Profile 1`).
    pub dir: String,
    /// What Chrome calls it.
    pub name: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct DomainCount {
    pub domain: String,
    pub count: u64,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub imported: u64,
    /// Expired, partitioned or undecryptable cookies left out.
    pub skipped: u64,
    pub domains: Vec<String>,
}

/// One row of Chrome's `cookies` table (the value still encrypted).
#[derive(Clone, PartialEq)]
pub struct Row {
    pub host_key: String,
    pub name: String,
    pub path: String,
    pub value: String,
    pub encrypted: Vec<u8>,
    pub expires_utc: i64,
    pub secure: bool,
    pub http_only: bool,
    pub same_site: i64,
    pub partitioned: bool,
}

pub fn chrome_root() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Application Support/Google/Chrome"))
}

/// Chrome's profiles from its `Local State`, or the folders that hold a `Cookies` file.
pub fn profiles(root: &Path) -> Vec<ChromeProfile> {
    let mut out: Vec<ChromeProfile> = std::fs::read_to_string(root.join("Local State"))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v.pointer("/profile/info_cache").and_then(|c| c.as_object()).cloned())
        .map(|cache| {
            cache
                .iter()
                .map(|(dir, info)| ChromeProfile { dir: dir.clone(), name: info.get("name").and_then(|n| n.as_str()).unwrap_or(dir).to_string() })
                .collect()
        })
        .unwrap_or_default();
    if out.is_empty() {
        if let Ok(entries) = std::fs::read_dir(root) {
            for e in entries.flatten() {
                let dir = e.file_name().to_string_lossy().to_string();
                if e.path().join("Cookies").is_file() {
                    out.push(ChromeProfile { name: dir.clone(), dir });
                }
            }
        }
    }
    out.retain(|p| root.join(&p.dir).join("Cookies").is_file());
    out.sort_by(|a, b| (a.dir != "Default").cmp(&(b.dir != "Default")).then(a.name.cmp(&b.name)));
    out
}

/// The `Cookies` file of profile `dir` (a plain folder name, nothing that leaves `root`).
pub fn cookies_file(root: &Path, dir: &str) -> Result<PathBuf, String> {
    if dir.is_empty() || dir.contains('/') || dir.contains('\\') || dir == "." || dir == ".." {
        return Err("Unknown Chrome profile".into());
    }
    let f = root.join(dir).join("Cookies");
    if f.is_file() {
        Ok(f)
    } else {
        Err(format!("Chrome profile {dir} has no cookies"))
    }
}

/// A private copy of a `Cookies` database (Chrome keeps the original open), removed on drop.
pub struct TempCopy {
    dir: PathBuf,
    pub db: PathBuf,
}

impl TempCopy {
    pub fn of(db: &Path) -> Result<TempCopy, String> {
        let mut rnd = [0u8; 8];
        if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
            use std::io::Read;
            let _ = f.read_exact(&mut rnd);
        }
        let name: String = rnd.iter().map(|b| format!("{b:02x}")).collect();
        let dir = std::env::temp_dir().join(format!("keryx-cookies-{name}"));
        std::fs::create_dir(&dir).map_err(|e| format!("Could not prepare the import: {e}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
        }
        let copy = TempCopy { db: dir.join("Cookies"), dir };
        std::fs::copy(db, &copy.db).map_err(|e| format!("Could not read Chrome's cookies: {e}"))?;
        // Recent changes may still sit in the write-ahead log.
        for ext in ["-wal", "-journal"] {
            let side = PathBuf::from(format!("{}{ext}", db.display()));
            if side.is_file() {
                let _ = std::fs::copy(&side, PathBuf::from(format!("{}{ext}", copy.db.display())));
            }
        }
        Ok(copy)
    }
}

impl Drop for TempCopy {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// Run a read-only query with the system `sqlite3` and return its rows as JSON objects.
pub fn query(db: &Path, sql: &str) -> Result<Vec<Value>, String> {
    let out = Command::new(SQLITE)
        // No ~/.sqliterc or other start-up file is read.
        .args(["-init", "/dev/null", "-readonly", "-json"])
        .arg(db)
        .arg(sql)
        .output()
        .map_err(|e| format!("Could not run sqlite3: {e}"))?;
    if !out.status.success() {
        return Err("Could not read Chrome's cookie database".into());
    }
    let text = String::from_utf8_lossy(&out.stdout);
    if text.trim().is_empty() {
        return Ok(Vec::new());
    }
    serde_json::from_str::<Vec<Value>>(&text).map_err(|_| "Could not read Chrome's cookie database".to_string())
}

/// A host as the picker shows it: no leading dot, lower case, no port.
pub fn normalize_host(h: &str) -> String {
    let h = h.trim().trim_start_matches('.').to_ascii_lowercase();
    match h.rsplit_once(':') {
        Some((host, port)) if !host.is_empty() && port.chars().all(|c| c.is_ascii_digit()) => host.to_string(),
        _ => h,
    }
}

/// Group `(host_key, count)` pairs by shown host, most cookies first.
pub fn group_domains(rows: impl IntoIterator<Item = (String, u64)>) -> Vec<DomainCount> {
    let mut by: BTreeMap<String, u64> = BTreeMap::new();
    for (host, n) in rows {
        let d = normalize_host(&host);
        if !d.is_empty() {
            *by.entry(d).or_default() += n;
        }
    }
    let mut out: Vec<DomainCount> = by.into_iter().map(|(domain, count)| DomainCount { domain, count }).collect();
    out.sort_by(|a, b| b.count.cmp(&a.count).then(a.domain.cmp(&b.domain)));
    out
}

/// Whether a cookie's host is one of the picked domains (exact, as the picker lists them).
pub fn selected(host_key: &str, picked: &[String]) -> bool {
    let h = normalize_host(host_key);
    picked.iter().any(|p| normalize_host(p) == h)
}

fn hex_decode(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        return None;
    }
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok()).collect()
}

fn row_of(v: &Value) -> Option<Row> {
    let s = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
    let i = |k: &str| v.get(k).and_then(|x| x.as_i64()).unwrap_or(0);
    Some(Row {
        host_key: s("host_key"),
        name: s("name"),
        path: s("path"),
        value: s("value"),
        encrypted: hex_decode(v.get("enc").and_then(|x| x.as_str()).unwrap_or(""))?,
        expires_utc: i("expires_utc"),
        secure: i("is_secure") != 0,
        http_only: i("is_httponly") != 0,
        same_site: v.get("samesite").and_then(|x| x.as_i64()).unwrap_or(-1),
        partitioned: !s("top_frame_site_key").is_empty(),
    })
}

/// The database's meta version and the rows of the picked domains.
pub fn read_rows(db: &Path, picked: &[String]) -> Result<(i64, Vec<Row>), String> {
    let version = query(db, "SELECT value FROM meta WHERE key = 'version'")?
        .first()
        .and_then(|r| r.get("value"))
        .and_then(|v| v.as_str().and_then(|s| s.parse().ok()).or_else(|| v.as_i64()))
        .unwrap_or(0);
    let columns: Vec<String> = query(db, "PRAGMA table_info(cookies)")?.iter().filter_map(|c| c.get("name").and_then(|n| n.as_str()).map(String::from)).collect();
    let partition = if columns.iter().any(|c| c == "top_frame_site_key") { "top_frame_site_key" } else { "'' AS top_frame_site_key" };
    let sql = format!(
        "SELECT host_key, name, path, value, hex(encrypted_value) AS enc, expires_utc, is_secure, is_httponly, samesite, {partition} FROM cookies"
    );
    // Picked domains are matched here, not put into SQL.
    let rows = query(db, &sql)?.iter().filter_map(row_of).filter(|r| selected(&r.host_key, picked)).collect();
    Ok((version, rows))
}

/// Chrome's cookie key from the Keychain password: PBKDF2-HMAC-SHA1, salt "saltysalt", 1003 rounds.
pub fn derive_key(password: &[u8]) -> [u8; 16] {
    let mut key = [0u8; 16];
    pbkdf2::pbkdf2_hmac::<sha1::Sha1>(password, b"saltysalt", 1003, &mut key);
    key
}

/// Decrypt one `v10` value (AES-128-CBC, IV of 16 spaces); `strip_hash` drops the 32-byte host hash.
pub fn decrypt(encrypted: &[u8], key: &[u8; 16], strip_hash: bool) -> Option<String> {
    let body = encrypted.strip_prefix(b"v10")?;
    let mut buf = body.to_vec();
    let plain = Aes128CbcDec::new(key.into(), &[b' '; 16].into()).decrypt_padded_mut::<Pkcs7>(&mut buf).ok()?;
    let plain = if strip_hash {
        plain.get(32..)?
    } else {
        plain
    };
    String::from_utf8(plain.to_vec()).ok()
}

/// A cookie as `Storage.setCookies` takes it, or `None` when it is left out.
pub fn to_cdp(row: &Row, value: String, now_unix: f64) -> Option<Value> {
    if row.partitioned || row.name.is_empty() {
        return None;
    }
    let path = if row.path.is_empty() { "/" } else { row.path.as_str() };
    let mut c = json!({
        "name": row.name,
        "value": value,
        "path": path,
        "secure": row.secure,
        "httpOnly": row.http_only,
    });
    if row.host_key.starts_with('.') {
        // A domain cookie: it applies to the domain and its subdomains.
        c["domain"] = json!(row.host_key);
    } else {
        // A host-only cookie (and every `__Host-` one): set by URL, with no domain, or the browser
        // widens it to the whole domain or refuses it.
        let scheme = if row.secure { "https" } else { "http" };
        c["url"] = json!(format!("{scheme}://{}{path}", row.host_key));
    }
    if row.expires_utc > 0 {
        let expires = row.expires_utc as f64 / 1_000_000.0 - WINDOWS_TO_UNIX;
        if expires <= now_unix {
            return None;
        }
        c["expires"] = json!(expires);
    }
    match row.same_site {
        // SameSite=None needs Secure.
        0 if row.secure => c["sameSite"] = json!("None"),
        1 => c["sameSite"] = json!("Lax"),
        2 => c["sameSite"] = json!("Strict"),
        _ => {}
    }
    Some(c)
}

impl std::fmt::Debug for Row {
    /// Values never reach a log: only where the cookie belongs and how long its value is.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Row")
            .field("host_key", &self.host_key)
            .field("name", &self.name)
            .field("path", &self.path)
            .field("value", &"<redacted>")
            .field("encrypted_len", &self.encrypted.len())
            .finish()
    }
}

/// Turn rows into CDP cookies with `key`; returns (cookies, skipped).
pub fn prepare(rows: &[Row], version: i64, key: &[u8; 16], now_unix: f64) -> (Vec<Value>, u64) {
    let strip = version >= HASH_PREFIX_VERSION;
    let mut out = Vec::new();
    let mut skipped = 0;
    for r in rows {
        let value = if r.encrypted.is_empty() { Some(r.value.clone()) } else { decrypt(&r.encrypted, key, strip) };
        // The plain value is wiped once copied into the browser call.
        let value = value.map(Zeroizing::new);
        match value.and_then(|v| to_cdp(r, v.to_string(), now_unix)) {
            Some(c) => out.push(c),
            None => skipped += 1,
        }
    }
    (out, skipped)
}

/// The "Chrome Safe Storage" password, read in this process with Security.framework: macOS asks the
/// user to let Keryx (not a helper tool) read it, and an "Always Allow" there grants Keryx alone.
#[cfg(target_os = "macos")]
fn keychain_password() -> Result<Zeroizing<Vec<u8>>, String> {
    security_framework::passwords::get_generic_password("Chrome Safe Storage", "Chrome")
        .map(Zeroizing::new)
        .map_err(|_| "Keychain access to Chrome's key was not allowed (or Chrome has no key yet)".into())
}

#[cfg(not(target_os = "macos"))]
fn keychain_password() -> Result<Zeroizing<Vec<u8>>, String> {
    Err("Importing cookies from Chrome needs macOS".into())
}

/// Copies an earlier run left behind (it crashed mid-import): removed when the app starts.
pub fn remove_stale_copies() {
    let Ok(entries) = std::fs::read_dir(std::env::temp_dir()) else { return };
    for e in entries.flatten() {
        if e.file_name().to_string_lossy().starts_with("keryx-cookies-") {
            let _ = std::fs::remove_dir_all(e.path());
        }
    }
}

/// Whether the caller is a project view (the cookie commands serve the browser panel only).
fn is_project_view(app: &AppHandle, view: &Webview) -> Result<(), String> {
    app.state::<crate::panels::PanelRoots>().get(view.label()).map(|_| ()).ok_or_else(|| "Open a project first".to_string())
}

fn now_unix() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0)
}

fn chrome_root_or_err() -> Result<PathBuf, String> {
    chrome_root().filter(|r| r.is_dir()).ok_or_else(|| "Google Chrome has no profile on this Mac".into())
}

#[tauri::command]
pub async fn cookie_profiles(app: AppHandle, view: Webview) -> Result<Vec<ChromeProfile>, String> {
    is_project_view(&app, &view)?;
    let root = chrome_root_or_err()?;
    Ok(profiles(&root))
}

/// The domains in a Chrome profile, with cookie counts (nothing is decrypted).
#[tauri::command]
pub async fn cookie_scan(app: AppHandle, view: Webview, profile: String) -> Result<Vec<DomainCount>, String> {
    is_project_view(&app, &view)?;
    tauri::async_runtime::spawn_blocking(move || {
        let root = chrome_root_or_err()?;
        let copy = TempCopy::of(&cookies_file(&root, &profile)?)?;
        let rows = query(&copy.db, "SELECT host_key, COUNT(*) AS n FROM cookies GROUP BY host_key")?;
        Ok(group_domains(rows.iter().map(|r| {
            (r.get("host_key").and_then(|h| h.as_str()).unwrap_or("").to_string(), r.get("n").and_then(|n| n.as_u64()).unwrap_or(0))
        })))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Copy the picked domains' cookies from Chrome profile `profile` into this project's browser.
#[tauri::command]
pub async fn cookie_import(app: AppHandle, view: Webview, profile: String, domains: Vec<String>) -> Result<ImportResult, String> {
    is_project_view(&app, &view)?;
    let label = view.label().to_string();
    if !engine::is_chromium(&app, &label) {
        return Err("Importing cookies needs the Chromium browser engine (Settings → Browser panel)".into());
    }
    if domains.is_empty() {
        return Err("Pick at least one domain".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let root = chrome_root_or_err()?;
        let (version, rows) = {
            let copy = TempCopy::of(&cookies_file(&root, &profile)?)?;
            read_rows(&copy.db, &domains)?
        };
        let mut result = ImportResult { domains: domains.clone(), ..Default::default() };
        if rows.is_empty() {
            return Ok(result);
        }
        let key = Zeroizing::new(if rows.iter().any(|r| !r.encrypted.is_empty()) { derive_key(&keychain_password()?) } else { [0u8; 16] });
        let (cookies, skipped) = prepare(&rows, version, &key, now_unix());
        result.skipped = skipped;
        let cdp = engine::browser_cdp(&app, &label)?;
        for chunk in cookies.chunks(200) {
            if cdp.call(None, "Storage.setCookies", json!({ "cookies": chunk })).is_ok() {
                result.imported += chunk.len() as u64;
                continue;
            }
            // One bad cookie fails the whole call: set them one by one and count the refused ones.
            for c in chunk {
                match cdp.call(None, "Storage.setCookies", json!({ "cookies": [c] })) {
                    Ok(_) => result.imported += 1,
                    Err(_) => result.skipped += 1,
                }
            }
        }
        Ok(result)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use aes::cipher::BlockEncryptMut;

    type Aes128CbcEnc = cbc::Encryptor<aes::Aes128>;

    fn encrypt(plain: &[u8], key: &[u8; 16]) -> Vec<u8> {
        let ct = Aes128CbcEnc::new(key.into(), &[b' '; 16].into()).encrypt_padded_vec_mut::<Pkcs7>(plain);
        [b"v10".as_slice(), &ct].concat()
    }

    fn row(host: &str, name: &str, enc: Vec<u8>) -> Row {
        Row {
            host_key: host.into(),
            name: name.into(),
            path: "/".into(),
            value: String::new(),
            encrypted: enc,
            expires_utc: 0,
            secure: true,
            http_only: true,
            same_site: 1,
            partitioned: false,
        }
    }

    #[test]
    fn the_key_is_pbkdf2_sha1_of_the_keychain_password() {
        // Fixture password; the derived key must be stable and 16 bytes.
        let k = derive_key(b"fixture-safe-storage-password");
        assert_eq!(k, derive_key(b"fixture-safe-storage-password"));
        assert_ne!(k, derive_key(b"other"));
    }

    #[test]
    fn pbkdf2_sha1_matches_the_rfc_6070_vector() {
        // RFC 6070: P="password", S="salt", c=2, dkLen=20 → ea6c014dc72d6f8ccd1ed92ace1d41f0d8de8957.
        let mut out = [0u8; 20];
        pbkdf2::pbkdf2_hmac::<sha1::Sha1>(b"password", b"salt", 2, &mut out);
        let hex: String = out.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(hex, "ea6c014dc72d6f8ccd1ed92ace1d41f0d8de8957");
    }

    #[test]
    fn values_decrypt_with_and_without_the_host_hash() {
        let key = derive_key(b"fixture-safe-storage-password");
        assert_eq!(decrypt(&encrypt(b"session-abc", &key), &key, false).as_deref(), Some("session-abc"));
        let hashed = [[7u8; 32].as_slice(), b"token-123"].concat();
        assert_eq!(decrypt(&encrypt(&hashed, &key), &key, true).as_deref(), Some("token-123"));
        // A wrong key, no prefix, or garbage give nothing.
        assert_eq!(decrypt(&encrypt(b"x", &key), &derive_key(b"wrong"), false), None);
        assert_eq!(decrypt(b"plain", &key, false), None);
        assert_eq!(decrypt(b"v10\x01\x02", &key, false), None);
    }

    #[test]
    fn domains_group_without_dots_ports_or_case() {
        let g = group_domains(vec![
            (".github.com".to_string(), 3),
            ("github.com".to_string(), 2),
            ("api.github.com".to_string(), 1),
            ("localhost".to_string(), 4),
            ("LOCALHOST:3000".to_string(), 1),
        ]);
        assert_eq!(
            g,
            vec![
                DomainCount { domain: "github.com".into(), count: 5 },
                DomainCount { domain: "localhost".into(), count: 5 },
                DomainCount { domain: "api.github.com".into(), count: 1 },
            ]
        );
        assert!(selected(".github.com", &["github.com".into()]));
        assert!(selected("localhost", &["localhost:3000".into()]));
        assert!(!selected("api.github.com", &["github.com".into()]));
        assert!(!selected("evilgithub.com", &["github.com".into()]));
    }

    #[test]
    fn cookies_become_cdp_cookies_and_dead_ones_are_skipped() {
        let key = derive_key(b"fixture-safe-storage-password");
        let mut live = row(".github.com", "user_session", encrypt(&[[0u8; 32].as_slice(), b"s3cr3t"].concat(), &key));
        live.expires_utc = ((2_000_000_000.0 + WINDOWS_TO_UNIX) * 1_000_000.0) as i64;
        let mut expired = row("github.com", "old", encrypt(&[[0u8; 32].as_slice(), b"x"].concat(), &key));
        expired.expires_utc = ((1_000.0 + WINDOWS_TO_UNIX) * 1_000_000.0) as i64;
        let mut part = row("github.com", "chips", encrypt(&[[0u8; 32].as_slice(), b"y"].concat(), &key));
        part.partitioned = true;
        let mut plain = row("localhost", "dev", Vec::new());
        plain.value = "1".into();
        plain.secure = false;
        plain.same_site = 0;
        let broken = row("github.com", "bad", b"v10garbage".to_vec());

        let (cookies, skipped) = prepare(&[live, expired, part, plain, broken], 24, &key, 1_800_000_000.0);
        assert_eq!(skipped, 3);
        assert_eq!(cookies.len(), 2);
        assert_eq!(cookies[0]["value"], "s3cr3t");
        assert_eq!(cookies[0]["domain"], ".github.com");
        assert!(cookies[0].get("url").is_none());
        assert_eq!(cookies[0]["sameSite"], "Lax");
        assert!((cookies[0]["expires"].as_f64().unwrap() - 2_000_000_000.0).abs() < 1.0);
        assert_eq!(cookies[1]["value"], "1");
        // A host-only cookie goes by URL, without a domain.
        assert_eq!(cookies[1]["url"], "http://localhost/");
        assert!(cookies[1].get("domain").is_none());
        // SameSite=None without Secure is left unset rather than refused by the browser.
        assert!(cookies[1].get("sameSite").is_none());
        assert!(cookies[1].get("expires").is_none());
    }

    #[test]
    fn host_prefixed_session_cookies_keep_their_host() {
        let mut r = row("github.com", "__Host-user_session_same_site", Vec::new());
        r.value = "v".into();
        let c = to_cdp(&r, "v".into(), 0.0).unwrap();
        assert_eq!(c["url"], "https://github.com/");
        assert!(c.get("domain").is_none());
        assert_eq!(c["secure"], true);
        assert_eq!(c["path"], "/");
    }

    #[test]
    fn rows_never_print_their_values() {
        let mut r = row("github.com", "user_session", b"v10secret-bytes".to_vec());
        r.value = "plain-secret".into();
        let shown = format!("{r:?}");
        assert!(shown.contains("user_session") && shown.contains("<redacted>"));
        assert!(!shown.contains("plain-secret") && !shown.contains("secret-bytes"));
    }

    #[test]
    fn profile_folders_cannot_leave_chromes_folder() {
        let dir = tempfile::tempdir().unwrap();
        for bad in ["", "..", "../x", "a/b"] {
            assert!(cookies_file(dir.path(), bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn profiles_come_from_local_state() {
        let dir = tempfile::tempdir().unwrap();
        for d in ["Default", "Profile 1", "Profile 2"] {
            std::fs::create_dir_all(dir.path().join(d)).unwrap();
        }
        std::fs::write(dir.path().join("Default/Cookies"), b"").unwrap();
        std::fs::write(dir.path().join("Profile 1/Cookies"), b"").unwrap();
        std::fs::write(
            dir.path().join("Local State"),
            r#"{"profile":{"info_cache":{"Profile 1":{"name":"Work"},"Default":{"name":"Personal"},"Profile 2":{"name":"Empty"}}}}"#,
        )
        .unwrap();
        assert_eq!(
            profiles(dir.path()),
            vec![ChromeProfile { dir: "Default".into(), name: "Personal".into() }, ChromeProfile { dir: "Profile 1".into(), name: "Work".into() }]
        );
    }

    /// A small Chrome-shaped database built with the system sqlite3, read back through the same path.
    #[test]
    fn rows_are_read_and_filtered_from_a_cookie_database() {
        if !Path::new(SQLITE).exists() {
            return;
        }
        let key = derive_key(b"fixture-safe-storage-password");
        let enc = |v: &str| encrypt(&[[0u8; 32].as_slice(), v.as_bytes()].concat(), &key).iter().map(|b| format!("{b:02X}")).collect::<String>();
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("Cookies");
        let sql = format!(
            "CREATE TABLE meta(key TEXT, value TEXT);
             INSERT INTO meta VALUES('version','24');
             CREATE TABLE cookies(host_key TEXT, name TEXT, value TEXT, path TEXT, encrypted_value BLOB, expires_utc INTEGER,
               is_secure INTEGER, is_httponly INTEGER, samesite INTEGER, top_frame_site_key TEXT);
             INSERT INTO cookies VALUES('.github.com','user_session','','/',X'{}',0,1,1,1,'');
             INSERT INTO cookies VALUES('example.org','other','','/',X'{}',0,1,0,-1,'');
             INSERT INTO cookies VALUES('localhost','dev','1','/',X'',0,0,0,-1,'');",
            enc("s3cr3t"),
            enc("nope")
        );
        let ok = Command::new(SQLITE).arg(&db).arg(sql).status().unwrap();
        assert!(ok.success());

        let copy = TempCopy::of(&db).unwrap();
        let copied_dir = copy.db.parent().unwrap().to_path_buf();
        let (version, rows) = read_rows(&copy.db, &["github.com".into(), "localhost:3000".into()]).unwrap();
        assert_eq!(version, 24);
        assert_eq!(rows.iter().map(|r| r.host_key.as_str()).collect::<Vec<_>>(), vec![".github.com", "localhost"]);
        let (cookies, skipped) = prepare(&rows, version, &key, 1_800_000_000.0);
        assert_eq!(skipped, 0);
        assert_eq!(cookies[0]["value"], "s3cr3t");
        assert_eq!(cookies[1]["value"], "1");
        drop(copy);
        assert!(!copied_dir.exists(), "the temporary copy is removed");

        let scan = query(&db, "SELECT host_key, COUNT(*) AS n FROM cookies GROUP BY host_key").unwrap();
        let grouped = group_domains(scan.iter().map(|r| (r["host_key"].as_str().unwrap().to_string(), r["n"].as_u64().unwrap())));
        assert_eq!(grouped.len(), 3);
    }
}
