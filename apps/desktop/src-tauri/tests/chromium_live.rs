//! Live check of the Chromium engine against the installed Chrome (headless):
//! launch with a throwaway profile, open a local page, read the accessibility
//! snapshot, click and type with real input, take screenshots, read console and
//! network.
//!
//! Ignored by default (needs Chrome). Run with
//!   cargo test --test chromium_live -- --ignored --nocapture
//! or point CHROME_BIN at another Chrome/Chromium binary.

use keryx_desktop_lib::chromium::launch::{find_chrome, Chromium, OWNER_FILE};
use keryx_desktop_lib::chromium::page::{Browser, Shot};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::time::Duration;

const PAGE: &str = r#"<!doctype html><html><head><title>Live test</title>
<style>body{font:16px system-ui;margin:40px;height:2400px}</style></head><body>
<h1>Settings</h1>
<label for="mail">Email</label> <input id="mail">
<label for="pw">Password</label> <input id="pw" type="password">
<button id="save" onclick="console.log('clicked', event.isTrusted, document.getElementById('mail').value); console.log('saved', 42)">Save changes</button>
<script>
  console.warn('booted');
  // A hostile page: its title cannot be read from script, and it opens a dialog on load.
  Object.defineProperty(document, 'title', { get() { throw new Error('no title for you'); }, set() {} });
  alert('hello from the page');
  fetch('/api/missing').catch(() => {});
</script>
</body></html>"#;

/// A one-thread HTTP server: `/` is the page, anything else a 404.
fn serve() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut s) = stream else { continue };
            let mut buf = [0u8; 4096];
            let n = s.read(&mut buf).unwrap_or(0);
            let req = String::from_utf8_lossy(&buf[..n]);
            let path = req.split_whitespace().nth(1).unwrap_or("/");
            let (status, body, ty) = if path == "/" { ("200 OK", PAGE, "text/html") } else { ("404 Not Found", "{\"error\":\"nope\"}", "application/json") };
            let _ = write!(s, "HTTP/1.1 {status}\r\nContent-Type: {ty}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
        }
    });
    port
}

fn chrome() -> PathBuf {
    std::env::var("CHROME_BIN")
        .map(PathBuf::from)
        .ok()
        .or_else(|| find_chrome(std::env::var("HOME").ok().map(PathBuf::from).as_deref(), &[]))
        .expect("no Chrome found; set CHROME_BIN")
}

/// The app was killed and its browser kept running on the project's profile: the next launch takes it
/// over. A browser whose app still runs is left alone.
#[test]
#[ignore]
fn a_browser_left_on_the_profile_is_replaced() {
    let profile = tempfile::tempdir().unwrap();
    let first = Chromium::launch(&chrome(), profile.path(), true, Duration::from_secs(20)).expect("first launch");
    let first_pid = first.0.pid() as i32;
    // Its app (this test) still runs: a second launch must not take it over.
    assert!(Chromium::launch(&chrome(), profile.path(), true, Duration::from_secs(10)).is_err());
    // As if the app died without stopping it.
    std::mem::forget(first);
    std::fs::write(profile.path().join(OWNER_FILE), "999999").unwrap();
    let second = Chromium::launch(&chrome(), profile.path(), true, Duration::from_secs(20)).expect("second launch takes over");
    assert_ne!(second.0.pid() as i32, first_pid);
    // Gone, or a zombie only because this test is its parent and never waits for it (launchd reaps it in the app).
    let out = std::process::Command::new("/bin/ps").args(["-o", "stat=", "-p", &first_pid.to_string()]).output().unwrap();
    let stat = String::from_utf8_lossy(&out.stdout).trim().to_string();
    assert!(stat.is_empty() || stat.starts_with('Z'), "the old browser still runs: {stat}");
    let browser = Browser::new(second.1.clone());
    assert!(browser.open_page().is_ok());
}

#[test]
#[ignore]
fn drive_a_local_page_with_real_input() {
    let profile = tempfile::tempdir().unwrap();
    // Over the debugging pipe: no port is opened.
    let (browser_proc, cdp) = Chromium::launch(&chrome(), profile.path(), true, Duration::from_secs(20)).expect("launch");
    let port = serve();

    let browser = Browser::new(cdp);
    let page = browser.open_page().expect("open page");
    // The page's alert on load is answered, so navigation finishes.
    page.navigate(&format!("http://127.0.0.1:{port}/")).expect("navigate");
    // The address and title come from the browser, not from the page's (throwing) script.
    let (url, title) = page.url_and_title();
    assert_eq!(url, format!("http://127.0.0.1:{port}/"));
    assert_eq!(title, "Live test");

    let snap = page.snapshot().expect("snapshot");
    println!("{}", snap.text);
    assert!(snap.text.contains("heading[1] \"Settings\""), "{}", snap.text);
    let line = |needle: &str| snap.text.lines().find(|l| l.contains(needle)).unwrap_or_else(|| panic!("no {needle} in\n{}", snap.text)).to_string();
    let reference = |l: &str| l.split("[ref=").nth(1).unwrap().split(']').next().unwrap().to_string();
    let mail = reference(&line("textbox \"Email\""));
    let pw = reference(&line("textbox \"Password\""));
    let save = reference(&line("button \"Save changes\""));

    page.type_text(&mail, "me@example.test", false).expect("type");
    assert!(page.type_text(&pw, "secret", false).unwrap_err().contains("password"));
    page.click(&save).expect("click");
    std::thread::sleep(Duration::from_millis(200));
    // A trusted click, and the typed value reached the page.
    // The page's own title setter is a no-op now, so check the click through its console line.

    let png = page.screenshot(&Shot::Viewport, "png").expect("viewport shot");
    assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
    let full = page.screenshot(&Shot::FullPage, "png").expect("full shot");
    assert!(full.len() > png.len() / 2);
    let el = page.screenshot(&Shot::Element(save.clone()), "jpeg").expect("element shot");
    assert_eq!(&el[..2], b"\xff\xd8");

    let console: Vec<String> = page.console(50).iter().map(|e| format!("{}: {}", e.level, e.text)).collect();
    println!("{console:?}");
    assert!(console.iter().any(|l| l == "warn: booted"), "{console:?}");
    assert!(console.iter().any(|l| l == "log: saved 42"), "{console:?}");
    // A trusted click, and the typed value reached the page.
    assert!(console.iter().any(|l| l == "log: clicked true me@example.test"), "{console:?}");
    assert!(console.iter().any(|l| l == "dialog: alert dialog: hello from the page"), "{console:?}");

    let net = page.network(50, Some("/api/"));
    println!("{net:?}");
    let api = net.iter().find(|n| n.url.ends_with("/api/missing")).expect("the fetch was recorded");
    assert_eq!(api.status, Some(404));
    assert_eq!(page.response_body(&api.id, 1000).unwrap(), "{\"error\":\"nope\"}");

    page.press_key("Tab").expect("key");
    assert_eq!(page.evaluate("1 + 2").unwrap(), serde_json::json!(3));
    page.close();
    drop(browser_proc);
}
