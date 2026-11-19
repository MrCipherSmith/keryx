//! Keep every project view on the app's own pages.
//!
//! The web view renders text from the model and from repository files, and
//! links in it are inert in the DOM. The host enforces the same rule: a
//! navigation away from the app origin (for example the WebKit context menu's
//! "Open Link") is refused, and no page may open a new window.

use tauri::webview::{NewWindowResponse, WebviewBuilder};
use tauri::{AppHandle, Runtime, Url};

/// True for the app's own origin and, in a debug build, the Vite dev server
/// origin. The app origin is `tauri://localhost` on macOS and Linux. Only on
/// Windows and Android does Tauri serve it as `http(s)://tauri.localhost`;
/// elsewhere that is an ordinary network name, so it is refused there.
pub fn navigation_allowed(url: &Url, dev_url: Option<&Url>) -> bool {
    let app_origin = match url.scheme() {
        "tauri" => url.host_str() == Some("localhost"),
        #[cfg(any(windows, target_os = "android"))]
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

/// Apply the navigation allowlist and refuse new windows. Every project view
/// (a child web view of a host window, see `projects`) goes through this.
pub fn guard<R: Runtime>(builder: WebviewBuilder<R>, dev_url: Option<Url>) -> WebviewBuilder<R> {
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
    }

    #[cfg(any(windows, target_os = "android"))]
    #[test]
    fn the_http_app_origin_is_allowed_where_tauri_serves_it() {
        assert!(navigation_allowed(&url("http://tauri.localhost/index.html"), None));
        assert!(navigation_allowed(&url("https://tauri.localhost/"), None));
    }

    #[cfg(not(any(windows, target_os = "android")))]
    #[test]
    fn tauri_localhost_over_http_is_a_network_origin_and_refused() {
        assert!(!navigation_allowed(&url("http://tauri.localhost/index.html"), None));
        assert!(!navigation_allowed(&url("https://tauri.localhost/"), None));
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
