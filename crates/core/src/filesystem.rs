use crate::{Entry, Listing, Preview, SearchFilter};
use anyhow::{bail, Context, Result};
use base64::Engine;
use std::{
    collections::HashMap,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::UNIX_EPOCH,
};

pub trait FileSystem: Send + Sync {
    fn list(&self, path: &str) -> Result<Vec<Entry>>;
    fn stream(&self, path: &str, send: &dyn Fn(Listing)) -> Result<()> {
        for chunk in self.list(path)?.chunks(256) {
            send(Listing {
                entries: chunk.to_vec(),
                done: false,
                error: None,
            });
        }
        send(Listing {
            entries: vec![],
            done: true,
            error: None,
        });
        Ok(())
    }
    fn stat(&self, path: &str) -> Result<Entry>;
    fn reader(&self, path: &str) -> Result<Box<dyn Read + Send>>;
    fn writer(&self, path: &str) -> Result<Box<dyn Write + Send>>;
    fn mkdir(&self, path: &str) -> Result<()>;
    fn rename(&self, from: &str, to: &str) -> Result<()>;
    fn remove(&self, path: &str) -> Result<()>;
    fn join(&self, parent: &str, name: &str) -> String;
    fn exists(&self, path: &str) -> Result<bool> {
        match self.stat(path) {
            Ok(_) => Ok(true),
            Err(e) => {
                if e.downcast_ref::<std::io::Error>()
                    .is_some_and(|e| e.kind() == std::io::ErrorKind::NotFound)
                {
                    Ok(false)
                } else {
                    Err(e)
                }
            }
        }
    }
    fn writable(&self) -> bool {
        true
    }
    fn close(&self) -> Result<()> {
        Ok(())
    }
}

pub struct LocalFs;
impl LocalFs {
    fn entry(path: &Path) -> Result<Entry> {
        let meta = fs::symlink_metadata(path).with_context(|| path.display().to_string())?;
        let name = path
            .file_name()
            .unwrap_or(path.as_os_str())
            .to_string_lossy()
            .into_owned();
        #[cfg(windows)]
        let hidden = {
            use std::os::windows::fs::MetadataExt;
            meta.file_attributes() & 2 != 0 || name.starts_with('.')
        };
        #[cfg(not(windows))]
        let hidden = name.starts_with('.');
        Ok(Entry {
            name,
            path: path.to_string_lossy().into_owned(),
            is_dir: meta.is_dir(),
            is_symlink: meta.file_type().is_symlink(),
            size: meta.len(),
            modified: meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|t| t.as_secs())
                .unwrap_or(0),
            hidden,
        })
    }
}
impl FileSystem for LocalFs {
    fn list(&self, path: &str) -> Result<Vec<Entry>> {
        fs::read_dir(path)?
            .map(|e| Self::entry(&e?.path()))
            .collect()
    }
    fn stream(&self, path: &str, send: &dyn Fn(Listing)) -> Result<()> {
        let mut batch = Vec::new();
        let mut errors = Vec::new();
        for result in fs::read_dir(path)? {
            match result
                .map_err(anyhow::Error::from)
                .and_then(|e| Self::entry(&e.path()))
            {
                Ok(entry) => batch.push(entry),
                Err(e) => errors.push(e.to_string()),
            }
            if batch.len() == 256 {
                send(Listing {
                    entries: std::mem::take(&mut batch),
                    done: false,
                    error: None,
                });
            }
        }
        send(Listing {
            entries: batch,
            done: true,
            error: (!errors.is_empty())
                .then(|| errors.into_iter().take(10).collect::<Vec<_>>().join("\n")),
        });
        Ok(())
    }
    fn stat(&self, path: &str) -> Result<Entry> {
        Self::entry(Path::new(path))
    }
    fn reader(&self, path: &str) -> Result<Box<dyn Read + Send>> {
        Ok(Box::new(fs::File::open(path)?))
    }
    fn writer(&self, path: &str) -> Result<Box<dyn Write + Send>> {
        Ok(Box::new(
            fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(path)?,
        ))
    }
    fn mkdir(&self, path: &str) -> Result<()> {
        fs::create_dir(path)?;
        Ok(())
    }
    fn rename(&self, from: &str, to: &str) -> Result<()> {
        fs::rename(from, to)?;
        Ok(())
    }
    fn remove(&self, path: &str) -> Result<()> {
        guard_destructive(path)?;
        let meta = fs::symlink_metadata(path)?;
        if meta.is_dir() && !meta.file_type().is_symlink() {
            fs::remove_dir_all(path)?;
        } else {
            #[cfg(windows)]
            if meta.file_type().is_symlink() {
                use std::os::windows::fs::FileTypeExt;
                if meta.file_type().is_symlink_dir() {
                    fs::remove_dir(path)?;
                    return Ok(());
                }
            }
            fs::remove_file(path)?;
        }
        Ok(())
    }
    fn join(&self, parent: &str, name: &str) -> String {
        Path::new(parent).join(name).to_string_lossy().into_owned()
    }
}

#[derive(Default)]
pub struct Sources {
    remote: Mutex<HashMap<String, Arc<dyn FileSystem>>>,
}
impl Sources {
    pub fn get(&self, source: &str) -> Result<Arc<dyn FileSystem>> {
        if source == "local" {
            return Ok(Arc::new(LocalFs));
        }
        if let Some(path) = source.strip_prefix("zip:") {
            return Ok(Arc::new(crate::archive::ZipFs::new(path)?));
        }
        self.remote
            .lock()
            .unwrap()
            .get(source)
            .cloned()
            .context("SFTP connection is not active")
    }
    pub fn insert(&self, id: String, fs: Arc<dyn FileSystem>) {
        self.remote.lock().unwrap().insert(id, fs);
    }
    pub fn disconnect(&self, id: &str) -> Result<()> {
        let source = self.remote.lock().unwrap().remove(id);
        if let Some(source) = source {
            source.close()?;
        }
        Ok(())
    }
}

pub fn valid_name(name: &str) -> Result<()> {
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.ends_with([' ', '.'])
        || name.chars().any(|c| c < ' ' || "<>:\"/\\|?*".contains(c))
    {
        bail!("Invalid Windows filename: {name}");
    }
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    if [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
        "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ]
    .contains(&stem.as_str())
    {
        bail!("Reserved Windows filename: {name}");
    }
    Ok(())
}

pub fn guard_destructive(path: &str) -> Result<()> {
    let p = Path::new(path);
    if !p.is_absolute()
        || p.file_name().is_none()
        || p.components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        bail!("Refusing an ambiguous or root path");
    }
    if let Some(home) = dirs::home_dir() {
        if p == home {
            bail!("Refusing to delete the user home folder");
        }
    }
    Ok(())
}

pub fn stream_listing(fs: &dyn FileSystem, path: &str, send: &dyn Fn(Listing)) -> Result<()> {
    if path.contains('\0') {
        bail!("Invalid path");
    }
    fs.stream(path, send)
}

pub fn search(
    fs: &dyn FileSystem,
    path: &str,
    filter: &SearchFilter,
    cancel: &AtomicBool,
    send: &dyn Fn(Listing),
) -> Result<()> {
    let mut stack = vec![path.to_string()];
    let mut batch = Vec::new();
    let mut errors = Vec::new();
    let query = filter.query.to_lowercase();
    while let Some(dir) = stack.pop() {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        match fs.list(&dir) {
            Err(e) => errors.push(format!("{dir}: {e}")),
            Ok(entries) => {
                for e in entries {
                    if cancel.load(Ordering::Relaxed) {
                        break;
                    }
                    if e.hidden && !filter.show_hidden {
                        continue;
                    }
                    if e.is_dir && !e.is_symlink {
                        stack.push(e.path.clone());
                    }
                    if e.name.to_lowercase().contains(&query)
                        && filter.min_size.is_none_or(|n| e.size >= n)
                        && filter.max_size.is_none_or(|n| e.size <= n)
                        && filter.after.is_none_or(|n| e.modified >= n)
                        && filter.before.is_none_or(|n| e.modified <= n)
                    {
                        batch.push(e);
                        if batch.len() >= 128 {
                            send(Listing {
                                entries: std::mem::take(&mut batch),
                                done: false,
                                error: None,
                            });
                        }
                    }
                }
            }
        }
    }
    send(Listing {
        entries: batch,
        done: true,
        error: if errors.is_empty() {
            None
        } else {
            Some(errors.into_iter().take(10).collect::<Vec<_>>().join("\n"))
        },
    });
    Ok(())
}

pub fn preview(fs: &dyn FileSystem, path: &str) -> Result<Preview> {
    let meta = fs.stat(path)?;
    if meta.is_dir {
        bail!("Choose a file to preview");
    }
    let ext = Path::new(path)
        .extension()
        .unwrap_or_default()
        .to_string_lossy()
        .to_lowercase();
    let (kind, mime, limit) = match ext.as_str() {
        "png" => ("image", "image/png", 24 * 1024 * 1024),
        "jpg" | "jpeg" => ("image", "image/jpeg", 24 * 1024 * 1024),
        "gif" => ("image", "image/gif", 24 * 1024 * 1024),
        "webp" => ("image", "image/webp", 24 * 1024 * 1024),
        "bmp" => ("image", "image/bmp", 24 * 1024 * 1024),
        "pdf" => ("pdf", "application/pdf", 48 * 1024 * 1024),
        "txt" | "md" | "rs" | "js" | "ts" | "tsx" | "jsx" | "json" | "toml" | "yaml" | "yml"
        | "xml" | "html" | "css" | "csv" | "log" | "ini" | "cfg" | "sh" | "ps1" | "py" | "c"
        | "h" | "cpp" | "sql" | "gitignore" => ("text", "text/plain", 256 * 1024),
        _ => ("unsupported", "application/octet-stream", 0),
    };
    let mut out = Preview {
        kind: kind.into(),
        mime: mime.into(),
        data: String::new(),
        truncated: meta.size > limit,
        size: meta.size,
    };
    if limit == 0 {
        return Ok(out);
    }
    if kind != "text" && out.truncated {
        bail!("Preview is too large ({} MiB limit)", limit / 1024 / 1024);
    }
    let mut bytes = Vec::new();
    fs.reader(path)?.take(limit).read_to_end(&mut bytes)?;
    out.data = if kind == "text" {
        if bytes.starts_with(&[0xff, 0xfe]) {
            String::from_utf16_lossy(
                &bytes[2..]
                    .as_chunks::<2>()
                    .0
                    .iter()
                    .map(|b| u16::from_le_bytes([b[0], b[1]]))
                    .collect::<Vec<_>>(),
            )
        } else {
            String::from_utf8_lossy(&bytes).into_owned()
        }
    } else {
        base64::engine::general_purpose::STANDARD.encode(bytes)
    };
    Ok(out)
}

pub fn local_places() -> (String, Vec<crate::Place>, Vec<crate::Place>) {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("C:\\"));
    let mut places = vec![crate::Place {
        name: "home".into(),
        path: home.to_string_lossy().into(),
        kind: "home".into(),
    }];
    for (name, path) in [
        ("desktop", dirs::desktop_dir()),
        ("documents", dirs::document_dir()),
        ("downloads", dirs::download_dir()),
        ("pictures", dirs::picture_dir()),
        ("music", dirs::audio_dir()),
        ("videos", dirs::video_dir()),
    ] {
        if let Some(path) = path.filter(|p| p.exists()) {
            places.push(crate::Place {
                name: name.into(),
                path: path.to_string_lossy().into(),
                kind: name.into(),
            });
        }
    }
    #[cfg(windows)]
    let drives = ('A'..='Z')
        .filter_map(|letter| {
            let path = format!("{letter}:\\");
            Path::new(&path).exists().then(|| crate::Place {
                name: format!("{letter}:"),
                path,
                kind: "drive".into(),
            })
        })
        .collect();
    #[cfg(not(windows))]
    let drives = vec![crate::Place {
        name: "Filesystem".into(),
        path: "/".into(),
        kind: "drive".into(),
    }];
    (home.to_string_lossy().into(), places, drives)
}
