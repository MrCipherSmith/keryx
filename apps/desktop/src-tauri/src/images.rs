//! Local images the agent links to in its messages (a screenshot it took, an image in the
//! project), read for the chat's thumbnails and preview.
//!
//! The path comes from model output, so only image files are read, only inside the calling
//! project's folder or the browser panel's own screenshot folder, and only up to a size cap.
//! The bytes come back as a `data:` URL for an `<img>`; nothing is opened or run.

use crate::panels::PanelRoots;
use base64::Engine as _;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
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
    image_mime(&path).ok_or("Not an image file")?;
    let real = path.canonicalize().map_err(|_| "The image is not there".to_string())?;
    // The target decides, not the link's name: a link called x.png may point at any file.
    let mime = image_mime(&real).ok_or("Not an image file")?;
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

const MAX_CHAT_IMAGE_BYTES: usize = 5 << 20;
const MAX_CHAT_STORAGE_BYTES: usize = 256 << 20;

#[derive(Default)]
pub struct ChatImages(Mutex<Option<(tempfile::TempDir, usize)>>);

impl ChatImages {
    fn root(&self) -> Option<PathBuf> {
        let store = self.0.lock().ok()?;
        Some(store.as_ref()?.0.path().to_path_buf())
    }

    pub fn clear(&self) {
        if let Ok(mut store) = self.0.lock() {
            store.take();
        }
    }

    fn save(&self, mime_type: &str, data: &str) -> Result<String, String> {
        let bytes = decode_attachment(data)?;
        let suffix = match (mime_type, bytes.as_slice()) {
            ("image/png", b) if b.starts_with(b"\x89PNG\r\n\x1a\n") => ".png",
            ("image/jpeg", b) if b.starts_with(b"\xff\xd8\xff") => ".jpg",
            ("image/gif", b) if b.starts_with(b"GIF87a") || b.starts_with(b"GIF89a") => ".gif",
            ("image/webp", b) if b.starts_with(b"RIFF") && b.get(8..12) == Some(b"WEBP") => ".webp",
            _ => return Err("Unsupported or invalid pasted image".into()),
        };
        self.save_bytes("image-", suffix, &bytes)
    }

    fn save_file(&self, extension: &str, data: &str) -> Result<String, String> {
        if extension.is_empty() || extension.len() > 12 || !extension.bytes().all(|b| b.is_ascii_alphanumeric()) {
            return Err("Invalid attachment extension".into());
        }
        self.save_bytes("file-", &format!(".{extension}"), &decode_attachment(data)?)
    }

    fn save_bytes(&self, prefix: &str, suffix: &str, bytes: &[u8]) -> Result<String, String> {
        let mut store = self.0.lock().map_err(|_| "Chat attachment storage is unavailable")?;
        if store.is_none() {
            let dir = tempfile::Builder::new().prefix("keryx-chat-images-").tempdir().map_err(|e| e.to_string())?;
            *store = Some((dir, 0));
        }
        let (dir, total) = store.as_mut().ok_or("Chat image storage is unavailable")?;
        if *total + bytes.len() > MAX_CHAT_STORAGE_BYTES {
            return Err("Temporary chat image storage is full. Restart Keryx to clear it.".into());
        }
        let mut file = tempfile::Builder::new().prefix(prefix).suffix(suffix)
            .tempfile_in(dir.path()).map_err(|e| e.to_string())?;
        file.write_all(bytes).map_err(|e| e.to_string())?;
        let (_, path) = file.keep().map_err(|e| e.error.to_string())?;
        *total += bytes.len();
        Ok(path.to_string_lossy().into_owned())
    }
}

fn decode_attachment(data: &str) -> Result<Vec<u8>, String> {
    if data.len() > 4 * MAX_CHAT_IMAGE_BYTES.div_ceil(3) {
        return Err("Attachment exceeds 5 MiB".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data).map_err(|_| "Invalid attachment data")?;
    if bytes.len() > MAX_CHAT_IMAGE_BYTES {
        return Err("Attachment exceeds 5 MiB".into());
    }
    Ok(bytes)
}

#[tauri::command]
pub async fn save_chat_file(app: AppHandle, extension: String, data: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || app.state::<ChatImages>().save_file(&extension, &data))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn save_chat_image(app: AppHandle, mime_type: String, data: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || app.state::<ChatImages>().save(&mime_type, &data))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn local_image(app: AppHandle, view: Webview, path: String) -> Result<String, String> {
    let root = app.state::<PanelRoots>().get(view.label());
    let mut extra_roots = vec![screenshots_dir()];
    extra_roots.extend(app.state::<ChatImages>().root());
    tauri::async_runtime::spawn_blocking(move || read_image(&path, root.as_deref(), &extra_roots))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chat_images_are_validated_and_removed_with_the_store() {
        let storage = ChatImages::default();
        let png = "iVBORw0KGgo=";
        assert!(storage.save("image/jpeg", png).is_err());
        assert!(storage.root().is_none());
        let first = storage.save("image/png", png).unwrap();
        let second = storage.save("image/png", png).unwrap();
        assert_ne!(first, second);
        let root = storage.root().unwrap();
        assert!(Path::new(&first).starts_with(&root));
        assert_eq!(read_image(&first, None, &[root]).unwrap(), format!("data:image/png;base64,{png}"));
        storage.clear();
        assert!(!Path::new(&first).exists());
    }

    #[test]
    fn regular_chat_files_are_private_and_have_safe_extensions() {
        let storage = ChatImages::default();
        assert!(storage.save_file("../txt", "aGVsbG8=").is_err());
        let path = PathBuf::from(storage.save_file("txt", "aGVsbG8=").unwrap());
        assert_eq!(path.extension().and_then(|e| e.to_str()), Some("txt"));
        assert_eq!(std::fs::read(&path).unwrap(), b"hello");
        storage.clear();
        assert!(!path.exists());
    }

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
    fn a_link_named_like_an_image_must_point_at_an_image() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("proj");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("notes.txt"), b"secret").unwrap();
        std::os::unix::fs::symlink(root.join("notes.txt"), root.join("shot.png")).unwrap();
        assert!(read_image("shot.png", Some(&root), &[]).unwrap_err().contains("Not an image"));
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
