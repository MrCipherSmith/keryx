//! Local images the agent links to in its messages (a screenshot it took, an image in the
//! project), read for the chat's thumbnails and preview.
//!
//! The path comes from model output, so only image files are read, only inside the calling
//! project's folder or the browser panel's own screenshot folder, and only up to a size cap.
//! The bytes come back as a `data:` URL for an `<img>`; nothing is opened or run.

use crate::panels::PanelRoots;
use base64::Engine as _;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, Url, Webview};

pub const MAX_BYTES: u64 = 15 << 20;

/// The MIME type of an image file this reads, by extension.
pub fn image_mime(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        "gif" => Some("image/gif"),
        _ => None,
    }
}

/// A link's target as a file path: `file://` URLs and absolute paths are decoded, anything else
/// is relative to `root`.
pub fn link_path(link: &str, root: Option<&Path>) -> Option<PathBuf> {
    let link = link.trim();
    if link.starts_with("file://") {
        return Url::parse(link).ok()?.to_file_path().ok();
    }
    if link.starts_with('/') {
        return Url::parse(&format!("file://{link}")).ok()?.to_file_path().ok();
    }
    if link.contains(':') {
        return None;
    }
    // Decoded as is (no `..` folding): the project-boundary check sees the real target.
    Some(root?.join(percent_decode(link)?))
}

fn percent_decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = s.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// Whether `path` (canonical) lies inside one of `roots` (canonical).
pub fn inside(path: &Path, roots: &[PathBuf]) -> bool {
    roots.iter().any(|r| path.starts_with(r))
}

fn screenshots_dir() -> PathBuf {
    std::env::temp_dir().join("keryx-panel-screenshots")
}

/// Read an allowed local image as a `data:` URL.
pub fn read_image(link: &str, root: Option<&Path>, extra_roots: &[PathBuf]) -> Result<String, String> {
    let path = link_path(link, root).ok_or("Not a local file")?;
    let mime = image_mime(&path).ok_or("Not an image file")?;
    let real = path.canonicalize().map_err(|_| "The image is not there".to_string())?;
    let mut roots: Vec<PathBuf> = extra_roots.iter().filter_map(|r| r.canonicalize().ok()).collect();
    if let Some(r) = root.and_then(|r| r.canonicalize().ok()) {
        roots.push(r);
    }
    if !inside(&real, &roots) {
        return Err("Only images inside the project are shown".into());
    }
    let meta = std::fs::metadata(&real).map_err(|e| e.to_string())?;
    if !meta.is_file() || meta.len() > MAX_BYTES {
        return Err("The image is too large to show".into());
    }
    let bytes = std::fs::read(&real).map_err(|e| e.to_string())?;
    Ok(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

#[tauri::command]
pub async fn local_image(app: AppHandle, view: Webview, path: String) -> Result<String, String> {
    let root = app.state::<PanelRoots>().get(view.label());
    tauri::async_runtime::spawn_blocking(move || read_image(&path, root.as_deref(), &[screenshots_dir()]))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn links_become_paths() {
        let root = Path::new("/p");
        assert_eq!(link_path(".keryx/browser/screenshots/a%20b.png", Some(root)), Some(PathBuf::from("/p/.keryx/browser/screenshots/a b.png")));
        assert_eq!(link_path("/tmp/x.png", Some(root)), Some(PathBuf::from("/tmp/x.png")));
        assert_eq!(link_path("file:///tmp/y%20z.png", None), Some(PathBuf::from("/tmp/y z.png")));
        assert_eq!(link_path("https://e.com/x.png", Some(root)), None);
        assert_eq!(link_path("rel.png", None), None);
    }

    #[test]
    fn only_images_inside_the_project_are_read() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("proj");
        std::fs::create_dir_all(root.join("shots")).unwrap();
        std::fs::write(root.join("shots/a.png"), b"\x89PNG\r\n\x1a\nxx").unwrap();
        std::fs::write(root.join("notes.txt"), b"secret").unwrap();
        std::fs::write(dir.path().join("outside.png"), b"x").unwrap();

        let url = read_image("shots/a.png", Some(&root), &[]).unwrap();
        assert!(url.starts_with("data:image/png;base64,"));
        assert!(read_image("notes.txt", Some(&root), &[]).unwrap_err().contains("Not an image"));
        assert!(read_image("../outside.png", Some(&root), &[]).unwrap_err().contains("inside the project"));
        assert!(read_image(dir.path().join("outside.png").to_str().unwrap(), Some(&root), &[]).unwrap_err().contains("inside the project"));
        assert!(read_image(dir.path().join("outside.png").to_str().unwrap(), Some(&root), &[dir.path().to_path_buf()]).is_ok());
        assert!(read_image("shots/missing.png", Some(&root), &[]).unwrap_err().contains("not there"));
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_out_of_the_project_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("proj");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(dir.path().join("secret.png"), b"x").unwrap();
        std::os::unix::fs::symlink(dir.path().join("secret.png"), root.join("link.png")).unwrap();
        assert!(read_image("link.png", Some(&root), &[]).is_err());
    }
}
