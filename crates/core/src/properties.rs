use crate::{filesystem::FileSystem, Entry};
use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::{Instant, SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Editable {
    pub readonly: bool,
    pub hidden: bool,
    pub mode: bool,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Properties {
    pub file: Entry,
    pub created: Option<u64>,
    pub accessed: Option<u64>,
    pub readonly: Option<bool>,
    pub hidden: Option<bool>,
    pub system: Option<bool>,
    pub compressed: Option<bool>,
    pub encrypted: Option<bool>,
    pub mode: Option<u32>,
    pub uid: Option<u32>,
    pub gid: Option<u32>,
    pub link_target: Option<String>,
    pub editable: Editable,
    pub connection: Option<String>,
    pub revision: String,
    #[serde(skip)]
    pub stamp: String,
}
impl Properties {
    pub fn basic(file: Entry) -> Self {
        Self {
            file,
            created: None,
            accessed: None,
            readonly: None,
            hidden: None,
            system: None,
            compressed: None,
            encrypted: None,
            mode: None,
            uid: None,
            gid: None,
            link_target: None,
            editable: Editable::default(),
            connection: None,
            revision: String::new(),
            stamp: String::new(),
        }
    }
}
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Changes {
    pub readonly: Option<bool>,
    pub hidden: Option<bool>,
    pub mode: Option<u32>,
    #[serde(default)]
    pub mode_set: u32,
    #[serde(default)]
    pub mode_clear: u32,
}
static APPLY: Mutex<()> = Mutex::new(());

pub fn get(fs: &dyn FileSystem, path: &str) -> Result<Properties> {
    let mut info = fs.properties(path)?;
    info.connection = fs.connection_id().map(str::to_owned);
    let accessed = info.accessed.take(); // Reading a file must not invalidate its attribute dialog.
    let mut hash = Sha256::new();
    hash.update(serde_json::to_vec(&info)?);
    hash.update(info.stamp.as_bytes());
    info.revision = hash.finalize().iter().map(|b| format!("{b:02x}")).collect();
    info.accessed = accessed;
    Ok(info)
}
pub fn apply(
    fs: &dyn FileSystem,
    path: &str,
    expected: &str,
    changes: &Changes,
) -> Result<Properties> {
    let _lock = APPLY.lock().unwrap();
    let info = get(fs, path)?;
    if info.revision != expected {
        bail!(
            "The file or its connection changed. Refresh the properties before applying changes."
        );
    }
    if !fs.writable() || info.file.is_symlink {
        bail!("Attributes cannot be changed for this item");
    }
    if changes.readonly.is_some() && !info.editable.readonly
        || changes.hidden.is_some() && !info.editable.hidden
        || (changes.mode.is_some() || changes.mode_set != 0 || changes.mode_clear != 0)
            && !info.editable.mode
        || changes.mode.is_some_and(|mode| mode > 0o7777)
        || (changes.mode_set | changes.mode_clear) > 0o7777
        || changes.mode_set & changes.mode_clear != 0
    {
        bail!("These attributes are not supported for this item");
    }
    let mut normalized = changes.clone();
    if changes.mode_set != 0 || changes.mode_clear != 0 {
        normalized.mode = Some(
            (changes.mode.unwrap_or(info.mode.unwrap_or(0)) | changes.mode_set)
                & !changes.mode_clear,
        );
    }
    if normalized.readonly.is_some() || normalized.hidden.is_some() || normalized.mode.is_some() {
        fs.apply_properties(path, &normalized)?;
    }
    get(fs, path)
}
fn seconds(time: std::io::Result<SystemTime>) -> Option<u64> {
    time.ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|v| v.as_secs())
}
pub fn local(path: &str, file: Entry) -> Result<Properties> {
    let meta = std::fs::symlink_metadata(path)?;
    let mut info = Properties::basic(file);
    info.created = seconds(meta.created());
    info.accessed = seconds(meta.accessed());
    info.stamp = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|t| t.as_nanos().to_string())
        .unwrap_or_default();
    info.readonly = Some(meta.permissions().readonly());
    if info.file.is_symlink {
        info.link_target = std::fs::read_link(path)
            .ok()
            .map(|p| p.to_string_lossy().into_owned());
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        let flags = meta.file_attributes();
        info.hidden = Some(flags & 2 != 0);
        info.system = Some(flags & 4 != 0);
        info.compressed = Some(flags & 0x800 != 0);
        info.encrypted = Some(flags & 0x4000 != 0);
        info.editable.readonly = !info.file.is_symlink && !info.file.is_dir;
        info.editable.hidden =
            !info.file.is_symlink && std::path::Path::new(path).parent().is_some();
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        info.mode = Some(meta.mode() & 0o7777);
        info.uid = Some(meta.uid());
        info.gid = Some(meta.gid());
        info.editable.mode = !info.file.is_symlink;
    }
    Ok(info)
}
pub fn apply_local(path: &str, changes: &Changes) -> Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        let mut flags = std::fs::symlink_metadata(path)?.file_attributes();
        if let Some(value) = changes.readonly {
            flags = if value { flags | 1 } else { flags & !1 };
        }
        if let Some(value) = changes.hidden {
            flags = if value { flags | 2 } else { flags & !2 };
        }
        if flags != 0x80 {
            flags &= !0x80;
        }
        if flags == 0 {
            flags = 0x80;
        }
        let path: Vec<u16> = path.encode_utf16().chain(Some(0)).collect();
        if unsafe {
            windows_sys::Win32::Storage::FileSystem::SetFileAttributesW(path.as_ptr(), flags)
        } == 0
        {
            return Err(std::io::Error::last_os_error().into());
        }
    }
    #[cfg(unix)]
    if let Some(mode) = changes.mode {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = std::fs::symlink_metadata(path)?.permissions();
        permissions.set_mode((permissions.mode() & !0o7777) | mode);
        std::fs::set_permissions(path, permissions)?;
    }
    Ok(())
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SizeSummary {
    pub files: u64,
    pub folders: u64,
    pub links: u64,
    pub bytes: u64,
    pub errors: Vec<String>,
    pub error_count: u64,
    pub done: bool,
    pub cancelled: bool,
}
impl SizeSummary {
    fn error(&mut self, path: &str, error: impl std::fmt::Display) {
        self.error_count += 1;
        if self.errors.len() < 10 {
            self.errors.push(format!("{path}: {error}"));
        }
    }
    fn leaf(&mut self, entry: &Entry, seen: &mut std::collections::HashSet<String>) -> Result<()> {
        if !seen.insert(entry.path.clone()) {
            return Ok(());
        }
        if entry.is_symlink {
            self.links += 1;
        } else {
            self.bytes = self
                .bytes
                .checked_add(entry.size)
                .ok_or_else(|| anyhow::anyhow!("Total size exceeds the supported range"))?;
            self.files += 1;
        }
        Ok(())
    }
}
pub fn calculate(
    fs: &dyn FileSystem,
    paths: &[String],
    cancel: &AtomicBool,
    send: &dyn Fn(SizeSummary),
) -> Result<()> {
    let mut summary = SizeSummary::default();
    let mut stack: Vec<_> = paths.iter().map(|path| (path.clone(), None)).collect();
    let mut seen = std::collections::HashSet::new();
    let mut entries_seen = std::collections::HashSet::new();
    let mut last = Instant::now();
    let mut visited = 0_u64;
    while let Some((path, cached)) = stack.pop() {
        if cancel.load(Ordering::Relaxed) {
            summary.cancelled = true;
            break;
        }
        let result = (|| -> Result<()> {
            let entry = match cached {
                Some(entry) => entry,
                None => {
                    let mut entry = fs.stat(&path)?;
                    if !entry.is_symlink {
                        entry.path = fs.canonical_path(&path)?;
                    }
                    entry
                }
            };
            if entry.is_dir && !entry.is_symlink {
                let canonical = fs.canonical_path(&entry.path)?;
                if !seen.insert(canonical.clone()) {
                    return Ok(());
                }
                summary.folders += 1;
                fs.visit_entries(&canonical, cancel, &mut |result| {
                    if cancel.load(Ordering::Relaxed) {
                        return;
                    }
                    visited += 1;
                    match result {
                        Ok(child) if child.is_dir && !child.is_symlink => {
                            stack.push((child.path.clone(), Some(child)))
                        }
                        Ok(child) => {
                            if let Err(error) = summary.leaf(&child, &mut entries_seen) {
                                summary.error(&child.path, error);
                            }
                        }
                        Err(error) => summary.error(&canonical, error),
                    }
                    if last.elapsed().as_millis() >= 100 || visited.is_multiple_of(256) {
                        send(summary.clone());
                        last = Instant::now();
                    }
                })?;
            } else {
                summary.leaf(&entry, &mut entries_seen)?;
            }
            Ok(())
        })();
        if let Err(error) = result {
            summary.error(&path, error);
        }
        if last.elapsed().as_millis() >= 100 {
            send(summary.clone());
            last = Instant::now();
        }
    }
    summary.cancelled |= cancel.load(Ordering::Relaxed);
    summary.done = true;
    send(summary);
    Ok(())
}
