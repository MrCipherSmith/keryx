//! Keep every window on the app's own pages.
//!
//! The web view renders text from the model and from repository files, and
//! links in it are inert in the DOM. The host enforces the same rule: a
//! navigation away from the app origin (for example the WebKit context menu's
//! "Open Link") is refused, and no page may open a new window.

use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, Runtime, Url, WebviewWindowBuilder};

/// True for the app's own origin (`tauri://localhost`, or
/// `http(s)://tauri.localhost` where the platform serves it that way) and, in a
/// debug build, the Vite dev server origin.
pub fn navigation_allowed(url: &Url, dev_url: Option<&Url>) -> bool {
    let app_origin = match url.scheme() {
        "tauri" => url.host_str() == Some("localhost"),
        "http" | "https" => url.host_str() == Some("tauri.localhost") && url.port().is_none(),
        _ => false,
    };
    app_origin || dev_url.is_some_and(|dev| url.origin() == dev.origin())
}

/// The dev server origin pages may load from: `build.devUrl` in a debug build,
/// nothing in a release build.
pub fn dev_url<R: Runtime>(app: &AppHandle<R>) -> Option<Url> {
    if cfg!(debug_assertions) {
        app.config().build.dev_url.clone()
    } else {
        None
    }
}

/// Apply the navigation allowlist and refuse new windows. Every window builder
/// goes through this.
pub fn guard<'a, R: Runtime, M: Manager<R>>(
    builder: WebviewWindowBuilder<'a, R, M>,
    dev_url: Option<Url>,
) -> WebviewWindowBuilder<'a, R, M> {
    builder
        .on_navigation(move |url| navigation_allowed(url, dev_url.as_ref()))
        .on_new_window(|_, _| NewWindowResponse::Deny)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn the_app_origin_is_allowed() {
        assert!(navigation_allowed(&url("tauri://localhost/index.html"), None));
        assert!(navigation_allowed(&url("tauri://localhost/"), None));
        assert!(navigation_allowed(&url("http://tauri.localhost/index.html"), None));
        assert!(navigation_allowed(&url("https://tauri.localhost/"), None));
    }

    #[test]
    fn links_out_of_the_app_are_refused() {
        for bad in [
            "https://example.com/setup",
            "http://localhost:1420/",
            "tauri://evil/",
            "http://tauri.localhost.example.com/",
            "http://tauri.localhost:8080/",
            "file:///etc/hosts",
            "mailto:a@b.c",
            "data:text/html,hi",
            "javascript:alert(1)",
            "about:blank",
        ] {
            assert!(!navigation_allowed(&url(bad), None), "{bad}");
        }
    }

    #[test]
    fn the_dev_server_origin_is_allowed_only_when_given() {
        let dev = url("http://localhost:1420");
        assert!(navigation_allowed(&url("http://localhost:1420/src/main.tsx"), Some(&dev)));
        assert!(!navigation_allowed(&url("http://localhost:1421/"), Some(&dev)));
        assert!(!navigation_allowed(&url("https://localhost:1420/"), Some(&dev)));
        assert!(!navigation_allowed(&url("https://example.com/"), Some(&dev)));
    }
}
