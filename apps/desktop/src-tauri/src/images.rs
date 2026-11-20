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
use std::collections::HashMap;
use std::sync::{Condvar, Mutex};
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

const MAX_CHAT_STORAGE_FILES: usize = 512;
const STORAGE_UNAVAILABLE: &str = "Chat attachment storage is unavailable";

struct IssuedAttachment {
    owner: String,
    disk_path: PathBuf,
    bytes: usize,
    deleting: bool,
}

#[derive(Default)]
struct ChatStore {
    dir: Option<tempfile::TempDir>,
    initializing: bool,
    closed: bool,
    pending: usize,
    files: usize,
    bytes: usize,
    issued: HashMap<String, IssuedAttachment>,
}

#[derive(Default)]
pub struct ChatImages {
    store: Mutex<ChatStore>,
    changed: Condvar,
}

impl ChatImages {
    fn root(&self) -> Option<PathBuf> {
        let store = self.store.lock().ok()?;
        Some(store.dir.as_ref()?.path().to_path_buf())
    }

    fn init_root(
        &self,
        create: impl FnOnce() -> std::io::Result<tempfile::TempDir>,
    ) -> Result<PathBuf, String> {
        let mut store = self.store.lock().map_err(|_| STORAGE_UNAVAILABLE)?;
        loop {
            if let Some(dir) = &store.dir {
                return Ok(dir.path().to_path_buf());
            }
            if !store.initializing {
                store.initializing = true;
                break;
            }
            store = self.changed.wait(store).map_err(|_| STORAGE_UNAVAILABLE)?;
        }
        drop(store);

        let created = create();
        let mut store = self.store.lock().map_err(|_| STORAGE_UNAVAILABLE)?;
        store.initializing = false;
        self.changed.notify_all();
        let dir = created.map_err(|e| format!("Could not initialize chat attachments: {e}"))?;
        let path = dir.path().to_path_buf();
        store.dir = Some(dir);
        Ok(path)
    }

    pub fn clear(&self) {
        let Ok(mut store) = self.store.lock() else { return };
        store.closed = true;
        while store.pending != 0 || store.initializing {
            let Ok(next) = self.changed.wait(store) else { return };
            store = next;
        }
        let dir = store.dir.take();
        store.issued.clear();
        store.files = 0;
        store.bytes = 0;
        drop(store);
        // TempDir performs recursive filesystem cleanup on drop.
        drop(dir);
    }

    fn reserve(&self, bytes: usize) -> Result<(), String> {
        let mut store = self.store.lock().map_err(|_| STORAGE_UNAVAILABLE)?;
        if store.closed {
            return Err(STORAGE_UNAVAILABLE.into());
        }
        if store.files >= MAX_CHAT_STORAGE_FILES || bytes > MAX_CHAT_STORAGE_BYTES - store.bytes {
            return Err("Temporary chat attachment storage is full. Discard drafts or restart Keryx.".into());
        }
        store.files += 1;
        store.bytes += bytes;
        store.pending += 1;
        Ok(())
    }

    fn save(&self, owner: &str, mime_type: &str, data: &str) -> Result<String, String> {
        let bytes = decode_attachment(data)?;
        let suffix = match (mime_type, bytes.as_slice()) {
            ("image/png", b) if b.starts_with(b"\x89PNG\r\n\x1a\n") => ".png",
            ("image/jpeg", b) if b.starts_with(b"\xff\xd8\xff") => ".jpg",
            ("image/gif", b) if b.starts_with(b"GIF87a") || b.starts_with(b"GIF89a") => ".gif",
            ("image/webp", b) if b.starts_with(b"RIFF") && b.get(8..12) == Some(b"WEBP") => ".webp",
            _ => return Err("Unsupported or invalid pasted image".into()),
        };
        self.save_bytes(owner, "image-", suffix, &bytes)
    }

    fn save_file(&self, owner: &str, extension: &str, data: &str) -> Result<String, String> {
        if extension.is_empty() || extension.len() > 12 || !extension.bytes().all(|b| b.is_ascii_alphanumeric()) {
            return Err("Invalid attachment extension".into());
        }
        self.save_bytes(owner, "file-", &format!(".{extension}"), &decode_attachment(data)?)
    }

    fn save_bytes(&self, owner: &str, prefix: &str, suffix: &str, bytes: &[u8]) -> Result<String, String> {
        self.reserve(bytes.len())?;
        let result = self
            .init_root(|| tempfile::Builder::new().prefix("keryx-chat-images-").tempdir())
            .map_err(|message| (message, true))
            .and_then(|root| write_attachment(&root, prefix, suffix, bytes));

        let mut store = self.store.lock().map_err(|_| STORAGE_UNAVAILABLE)?;
        store.pending -= 1;
        self.changed.notify_all();
        match result {
            Ok(disk_path) => {
                let path = disk_path.to_string_lossy().into_owned();
                store.issued.insert(path.clone(), IssuedAttachment {
                    owner: owner.to_owned(),
                    disk_path,
                    bytes: bytes.len(),
                    deleting: false,
                });
                Ok(path)
            }
            Err((message, removed)) => {
                // If cleanup failed, the leftover still counts until exit.
                if removed {
                    store.files -= 1;
                    store.bytes -= bytes.len();
                }
                Err(message)
            }
        }
    }

    fn discard(&self, owner: &str, path: &str) -> Result<(), String> {
        let disk_path = {
            let mut store = self.store.lock().map_err(|_| STORAGE_UNAVAILABLE)?;
            if store.closed {
                return Err(STORAGE_UNAVAILABLE.into());
            }
            let entry = store.issued.get_mut(path)
                .filter(|entry| entry.owner == owner && !entry.deleting)
                .ok_or("Chat attachment is not available to this view")?;
            entry.deleting = true;
            let disk_path = entry.disk_path.clone();
            store.pending += 1;
            disk_path
        };

        let removed = match std::fs::remove_file(disk_path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            result => result,
        };

        let mut store = self.store.lock().map_err(|_| STORAGE_UNAVAILABLE)?;
        store.pending -= 1;
        self.changed.notify_all();
        if let Err(e) = removed {
            if let Some(entry) = store.issued.get_mut(path) {
                entry.deleting = false;
            }
            return Err(format!("Could not discard chat attachment: {e}"));
        }
        if let Some(entry) = store.issued.remove(path) {
            store.files -= 1;
            store.bytes -= entry.bytes;
        }
        Ok(())
    }
}

// The error flag says whether it is safe to release the reservation.
fn write_attachment(root: &Path, prefix: &str, suffix: &str, bytes: &[u8]) -> Result<PathBuf, (String, bool)> {
    let cleanup = |file: tempfile::NamedTempFile, error: std::io::Error| {
        (format!("Could not write chat attachment: {error}"), file.close().is_ok())
    };
    let mut file = tempfile::Builder::new().prefix(prefix).suffix(suffix)
        .tempfile_in(root)
        .map_err(|e| (format!("Could not create chat attachment: {e}"), true))?;
    if let Err(e) = file.write_all(bytes) {
        return Err(cleanup(file, e));
    }
    let (file, path) = file.keep().map_err(|e| cleanup(e.file, e.error))?;
    drop(file);
    Ok(path)
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
pub async fn save_chat_file(app: AppHandle, view: Webview, extension: String, data: String) -> Result<String, String> {
    let owner = view.label().to_owned();
    tauri::async_runtime::spawn_blocking(move || app.state::<ChatImages>().save_file(&owner, &extension, &data))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn save_chat_image(app: AppHandle, view: Webview, mime_type: String, data: String) -> Result<String, String> {
    let owner = view.label().to_owned();
    tauri::async_runtime::spawn_blocking(move || app.state::<ChatImages>().save(&owner, &mime_type, &data))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn discard_chat_attachment(app: AppHandle, view: Webview, path: String) -> Result<(), String> {
    let owner = view.label().to_owned();
    tauri::async_runtime::spawn_blocking(move || app.state::<ChatImages>().discard(&owner, &path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn local_image(app: AppHandle, view: Webview, path: String) -> Result<String, String> {
    let owner = view.label().to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        let root = app.state::<PanelRoots>().get(&owner);
        let mut extra_roots = vec![screenshots_dir()];
        extra_roots.extend(app.state::<ChatImages>().root());
        read_image(&path, root.as_deref(), &extra_roots)
    })
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
        assert!(storage.save("view", "image/jpeg", png).is_err());
        assert!(storage.root().is_none());
        let first = storage.save("view", "image/png", png).unwrap();
        let second = storage.save("view", "image/png", png).unwrap();
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
        assert!(storage.save_file("view", "../txt", "aGVsbG8=").is_err());
        let path = PathBuf::from(storage.save_file("view", "txt", "aGVsbG8=").unwrap());
        assert_eq!(path.extension().and_then(|e| e.to_str()), Some("txt"));
        assert_eq!(std::fs::read(&path).unwrap(), b"hello");
        storage.clear();
        assert!(!path.exists());
    }

    #[test]
    fn temporary_root_initialization_can_retry_after_failure() {
        let storage = ChatImages::default();
        assert!(storage.init_root(|| Err(std::io::Error::other("injected failure"))).is_err());
        assert!(storage.root().is_none());
        let path = storage.save_file("view", "txt", "").unwrap();
        assert!(Path::new(&path).is_file());
    }

    #[test]
    fn discard_requires_an_owned_issued_path_and_reclaims_both_budgets() {
        let storage = ChatImages::default();
        {
            let mut store = storage.store.lock().unwrap();
            store.files = MAX_CHAT_STORAGE_FILES - 1;
            store.bytes = MAX_CHAT_STORAGE_BYTES - 5;
        }
        let path = storage.save_file("owner", "txt", "aGVsbG8=").unwrap();
        assert!(storage.save_file("owner", "txt", "").is_err());

        let unissued = storage.root().unwrap().join("unissued.txt");
        std::fs::write(&unissued, b"keep").unwrap();
        assert!(storage.discard("owner", unissued.to_str().unwrap()).is_err());
        assert!(storage.discard("other", &path).is_err());
        assert!(Path::new(&path).is_file());
        assert!(unissued.is_file());

        storage.discard("owner", &path).unwrap();
        assert!(!Path::new(&path).exists());
        assert!(storage.discard("owner", &path).is_err());
        let replacement = storage.save_file("owner", "txt", "aGVsbG8=").unwrap();
        assert!(Path::new(&replacement).is_file());
        assert!(storage.save_file("owner", "txt", "").is_err());
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
