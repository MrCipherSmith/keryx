//! The few WKWebView calls Tauri does not expose, for the browser panel (D-13):
//! JavaScript with a result in a chosen content world, a snapshot as PNG, and
//! back/forward. Each runs on the main thread through `Webview::with_webview`
//! and hands its result back over a channel; callers must not be on the main
//! thread.

use std::sync::mpsc;
use std::time::Duration;
use tauri::Webview;

pub const JS_TIMEOUT: Duration = Duration::from_secs(15);

/// Where page JavaScript runs: `Page` sees the page's own globals (the console
/// shim lives there); `Client` shares the DOM but not the page's globals, so a
/// page cannot tamper with the agent's helpers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum World {
    Page,
    Client,
}

/// The major macOS version (14 for Sonoma), 0 when unknown.
#[cfg(target_os = "macos")]
pub fn macos_major() -> isize {
    objc2_foundation::NSProcessInfo::processInfo().operatingSystemVersion().majorVersion
}

#[cfg(not(target_os = "macos"))]
pub fn macos_major() -> isize {
    0
}

#[cfg(target_os = "macos")]
mod imp {
    use super::*;
    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage};
    use objc2_foundation::{NSDictionary, NSError, NSString};
    use objc2_web_kit::{WKContentWorld, WKWebView};
    use std::sync::Mutex;

    fn on_webview<T: Send + 'static>(
        webview: &Webview,
        f: impl FnOnce(&WKWebView, MainThreadMarker, mpsc::Sender<Result<T, String>>) + Send + 'static,
    ) -> Result<T, String> {
        let (tx, rx) = mpsc::channel();
        let err_tx = tx.clone();
        webview
            .with_webview(move |pw| {
                // SAFETY: `with_webview` runs this on the main thread.
                let mtm = unsafe { MainThreadMarker::new_unchecked() };
                // SAFETY: on macOS `inner()` is the WKWebView, alive for this call.
                let wk = unsafe { &*(pw.inner() as *const WKWebView) };
                f(wk, mtm, tx);
            })
            .map_err(|e| {
                let _ = err_tx.send(Err(e.to_string()));
                e.to_string()
            })?;
        rx.recv_timeout(JS_TIMEOUT).unwrap_or_else(|_| Err("The page did not answer in time".into()))
    }

    fn error_text(error: *mut NSError) -> String {
        // SAFETY: WebKit passes a valid NSError or null.
        match unsafe { error.as_ref() } {
            Some(e) => e.localizedDescription().to_string(),
            None => "unknown error".into(),
        }
    }

    /// Run `body` as the body of an async function; it must `return` a string
    /// (JSON for structured results).
    pub fn call_js(webview: &Webview, body: String, world: World) -> Result<String, String> {
        on_webview(webview, move |wk, mtm, tx| {
            let tx = Mutex::new(Some(tx));
            let block = RcBlock::new(move |result: *mut AnyObject, error: *mut NSError| {
                let Some(tx) = tx.lock().unwrap().take() else { return };
                if !error.is_null() {
                    let _ = tx.send(Err(error_text(error)));
                    return;
                }
                // SAFETY: a non-null result is a valid object for the block's duration.
                let text = unsafe { result.as_ref() }
                    .and_then(|o| o.downcast_ref::<NSString>())
                    .map(|s| s.to_string())
                    .unwrap_or_default();
                let _ = tx.send(Ok(text));
            });
            let body = NSString::from_str(&body);
            let args: Retained<NSDictionary<NSString, AnyObject>> = NSDictionary::new();
            // SAFETY: plain WebKit calls on the main thread with valid arguments.
            unsafe {
                let world = match world {
                    World::Page => WKContentWorld::pageWorld(mtm),
                    World::Client => WKContentWorld::defaultClientWorld(mtm),
                };
                wk.callAsyncJavaScript_arguments_inFrame_inContentWorld_completionHandler(
                    &body,
                    Some(&args),
                    None,
                    &world,
                    Some(&block),
                );
            }
        })
    }

    /// The visible part of the page as PNG bytes.
    pub fn snapshot_png(webview: &Webview) -> Result<Vec<u8>, String> {
        on_webview(webview, move |wk, _mtm, tx| {
            let tx = Mutex::new(Some(tx));
            let block = RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
                let Some(tx) = tx.lock().unwrap().take() else { return };
                // SAFETY: a non-null image is valid for the block's duration.
                let Some(image) = (unsafe { image.as_ref() }) else {
                    let _ = tx.send(Err(error_text(error)));
                    return;
                };
                let png = image.TIFFRepresentation().and_then(|tiff| {
                    let rep = NSBitmapImageRep::imageRepWithData(&tiff)?;
                    // SAFETY: an empty properties dictionary is valid.
                    unsafe { rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new()) }
                });
                let _ = tx.send(png.map(|d| d.to_vec()).ok_or_else(|| "Could not encode the snapshot".to_string()));
            });
            // SAFETY: nil configuration snapshots the visible bounds.
            unsafe { wk.takeSnapshotWithConfiguration_completionHandler(None, &block) };
        })
    }

    pub fn go(webview: &Webview, forward: bool) -> Result<(), String> {
        on_webview(webview, move |wk, _mtm, tx| {
            // SAFETY: plain WebKit calls on the main thread.
            unsafe {
                if forward {
                    wk.goForward();
                } else {
                    wk.goBack();
                }
            }
            let _ = tx.send(Ok(()));
        })
    }
}

#[cfg(target_os = "macos")]
pub use imp::{call_js, go, snapshot_png};

/// Height of the window's title bar in points. Child web views are placed in
/// the window frame, while the app's page starts below the title bar.
#[cfg(target_os = "macos")]
pub fn title_bar_height(window: &tauri::Window) -> f64 {
    let (tx, rx) = mpsc::channel();
    let Ok(ptr) = window.ns_window() else { return 0.0 };
    let ptr = ptr as usize;
    if window
        .run_on_main_thread(move || {
            // SAFETY: on the main thread; the pointer is the live NSWindow of this Tauri window.
            let ns = unsafe { &*(ptr as *const objc2_app_kit::NSWindow) };
            let h = ns.frame().size.height - ns.contentLayoutRect().size.height;
            let _ = tx.send(h.max(0.0));
        })
        .is_err()
    {
        return 0.0;
    }
    rx.recv_timeout(Duration::from_secs(1)).unwrap_or(0.0)
}

#[cfg(not(target_os = "macos"))]
pub fn title_bar_height(_: &tauri::Window) -> f64 {
    0.0
}

#[cfg(not(target_os = "macos"))]
pub fn call_js(_: &Webview, _: String, _: World) -> Result<String, String> {
    Err("The browser panel's agent tools need macOS".into())
}

#[cfg(not(target_os = "macos"))]
pub fn snapshot_png(_: &Webview) -> Result<Vec<u8>, String> {
    Err("Screenshots need macOS".into())
}

#[cfg(not(target_os = "macos"))]
pub fn go(webview: &Webview, forward: bool) -> Result<(), String> {
    webview.eval(if forward { "history.forward()" } else { "history.back()" }).map_err(|e| e.to_string())
}
