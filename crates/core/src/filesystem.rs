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
    fn visit_entries(
        &self,
        path: &str,
        cancel: &AtomicBool,
        send: &mut dyn FnMut(Result<Entry>),
    ) -> Result<()> {
        for entry in self.list(path)? {
            if cancel.load(Ordering::Relaxed) {
                break;
            }
            send(Ok(entry));
        }
        Ok(())
    }
    fn properties(&self, path: &str) -> Result<crate::properties::Properties> {
        Ok(crate::properties::Properties::basic(self.stat(path)?))
    }
    fn apply_properties(&self, _path: &str, _changes: &crate::properties::Changes) -> Result<()> {
        bail!("Attributes are not supported for this source")
    }
    /// Resolve existing paths before comparing transfer locations. Backends with
    /// aliases or symlinks override this with their filesystem's canonical path.
    fn canonical_path(&self, path: &str) -> Result<String> {
        Ok(self.stat(path)?.path)
    }
    fn connection_id(&self) -> Option<&str> {
        None
    }
    /// Stable object identity and a precise change token, where the filesystem
    /// exposes them. These complement the content checks for queued work.
    fn fingerprint(&self, _path: &str) -> Result<Option<(String, String)>> {
        Ok(None)
    }
    fn regular_file(&self, path: &str) -> Result<bool> {
        let entry = self.stat(path)?;
        Ok(!entry.is_dir && !entry.is_symlink)
    }
    fn reader(&self, path: &str) -> Result<Box<dyn Read + Send>>;
    fn writer(&self, path: &str) -> Result<Box<dyn Write + Send>>;
    fn private_writer(&self, path: &str) -> Result<Box<dyn Write + Send>> {
        self.writer(path)
    }
    fn mkdir(&self, path: &str) -> Result<()>;
    fn private_mkdir(&self, path: &str) -> Result<()> {
        self.mkdir(path)
    }
    fn rename(&self, from: &str, to: &str) -> Result<()>;
    /// Move an entry into a new name without replacing an existing entry.
    fn rename_new(&self, _from: &str, _to: &str) -> Result<()> {
        bail!("This filesystem does not support publishing new files safely")
    }
    fn remove(&self, path: &str) -> Result<()>;
    /// Transfer cleanup must never recursively delete a path that may now
    /// contain the destination or a file created by another process.
    fn remove_file(&self, _path: &str) -> Result<()> {
        bail!("Safe file cleanup is not supported for this source")
    }
    fn remove_empty_dir(&self, _path: &str) -> Result<()> {
        bail!("Safe directory cleanup is not supported for this source")
    }
    fn transfer_metadata(
        &self,
        _path: &str,
        _original: &crate::properties::Properties,
    ) -> Result<()> {
        Ok(())
    }
    fn discard_temp(&self, path: &str) -> Result<()> {
        self.remove_file(path)
    }
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
    fn copy_permissions(&self, _from: &str, _to: &str) -> Result<()> {
        Ok(())
    }
    fn close(&self) -> Result<()> {
        Ok(())
    }
}

pub struct LocalFs;
pub fn same_directory(left: &str, right: &str) -> Result<bool> {
    Ok(same_file::is_same_file(left, right)?)
}
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
    fn regular_file(&self, path: &str) -> Result<bool> {
        Ok(fs::symlink_metadata(path)?.is_file())
    }
    fn fingerprint(&self, path: &str) -> Result<Option<(String, String)>> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let meta = fs::symlink_metadata(path)?;
            let id = format!("{}:{}", meta.dev(), meta.ino());
            let version = format!(
                "{id}:{}:{}:{}:{}:{}",
                meta.ctime(),
                meta.ctime_nsec(),
                meta.mtime(),
                meta.mtime_nsec(),
                meta.len()
            );
            return Ok(Some((id, version)));
        }
        #[cfg(windows)]
        {
            use std::os::windows::{fs::OpenOptionsExt, io::AsRawHandle};
            use windows_sys::Win32::Storage::FileSystem::*;
            let file = fs::OpenOptions::new()
                .read(true)
                .access_mode(0)
                .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
                .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
                .open(path)?;
            let mut id = BY_HANDLE_FILE_INFORMATION::default();
            let mut basic = FILE_BASIC_INFO::default();
            let handle = file.as_raw_handle();
            if unsafe { GetFileInformationByHandle(handle, &mut id) } == 0
                || unsafe {
                    GetFileInformationByHandleEx(
                        handle,
                        FileBasicInfo,
                        (&mut basic as *mut FILE_BASIC_INFO).cast(),
                        std::mem::size_of::<FILE_BASIC_INFO>() as u32,
                    )
                } == 0
            {
                return Ok(None);
            }
            if basic.ChangeTime == 0 || id.nFileIndexHigh == 0 && id.nFileIndexLow == 0 {
                return Ok(None);
            }
            let identity = format!(
                "{}:{}:{}",
                id.dwVolumeSerialNumber, id.nFileIndexHigh, id.nFileIndexLow
            );
            let version = format!(
                "{identity}:{}:{}:{}:{}",
                basic.ChangeTime, basic.LastWriteTime, id.nFileSizeHigh, id.nFileSizeLow
            );
            return Ok(Some((identity, version)));
        }
        #[allow(unreachable_code)]
        Ok(None)
    }
    fn visit_entries(
        &self,
        path: &str,
        cancel: &AtomicBool,
        send: &mut dyn FnMut(Result<Entry>),
    ) -> Result<()> {
        if crate::network::is_server(path) {
            for entry in self.list(path)? {
                if cancel.load(Ordering::Relaxed) {
                    break;
                }
                send(Ok(entry));
            }
            return Ok(());
        }
        for entry in fs::read_dir(path)? {
            if cancel.load(Ordering::Relaxed) {
                break;
            }
            send(
                entry
                    .map_err(anyhow::Error::from)
                    .and_then(|entry| Self::entry(&entry.path())),
            );
        }
        Ok(())
    }
    fn properties(&self, path: &str) -> Result<crate::properties::Properties> {
        if crate::network::is_server(path) {
            return Ok(crate::properties::Properties::basic(self.stat(path)?));
        }
        crate::properties::local(path, self.stat(path)?)
    }
    fn apply_properties(&self, path: &str, changes: &crate::properties::Changes) -> Result<()> {
        crate::properties::apply_local(path, changes)
    }
    fn canonical_path(&self, path: &str) -> Result<String> {
        Ok(fs::canonicalize(path)?.to_string_lossy().into_owned())
    }
    fn copy_permissions(&self, from: &str, to: &str) -> Result<()> {
        let permissions = fs::metadata(from)?.permissions();
        if permissions.readonly() {
            bail!("The file is read-only");
        }
        fs::set_permissions(to, permissions)?;
        Ok(())
    }
    fn list(&self, path: &str) -> Result<Vec<Entry>> {
        if crate::network::is_server(path) {
            return crate::network::shares(path);
        }
        fs::read_dir(path)?
            .map(|e| Self::entry(&e?.path()))
            .collect()
    }
    fn stream(&self, path: &str, send: &dyn Fn(Listing)) -> Result<()> {
        if crate::network::is_server(path) {
            for chunk in crate::network::shares(path)?.chunks(256) {
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
            return Ok(());
        }
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
        if crate::network::is_server(path) {
            return Ok(Entry {
                name: path.trim_matches('\\').into(),
                path: path.into(),
                is_dir: true,
                is_symlink: false,
                size: 0,
                modified: 0,
                hidden: false,
            });
        }
        Self::entry(Path::new(path))
    }
    fn reader(&self, path: &str) -> Result<Box<dyn Read + Send>> {
        if !fs::metadata(path)?.is_file() {
            bail!("Choose a regular file; special files cannot be read as documents");
        }
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
    fn private_mkdir(&self, path: &str) -> Result<()> {
        let builder = fs::DirBuilder::new();
        #[cfg(unix)]
        let builder = {
            use std::os::unix::fs::DirBuilderExt;
            let mut builder = builder;
            builder.mode(0o700);
            builder
        };
        builder.create(path)?;
        Ok(())
    }
    fn private_writer(&self, path: &str) -> Result<Box<dyn Write + Send>> {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        Ok(Box::new(options.open(path)?))
    }
    fn rename(&self, from: &str, to: &str) -> Result<()> {
        fs::rename(from, to)?;
        Ok(())
    }
    fn rename_new(&self, from: &str, to: &str) -> Result<()> {
        #[cfg(windows)]
        {
            let from: Vec<u16> = from.encode_utf16().chain(Some(0)).collect();
            let to: Vec<u16> = to.encode_utf16().chain(Some(0)).collect();
            // No MOVEFILE_REPLACE_EXISTING: this works on NTFS, FAT and network shares.
            if unsafe {
                windows_sys::Win32::Storage::FileSystem::MoveFileExW(from.as_ptr(), to.as_ptr(), 0)
            } == 0
            {
                return Err(std::io::Error::last_os_error().into());
            }
        }
        #[cfg(target_os = "linux")]
        {
            rustix::fs::renameat_with(
                rustix::fs::CWD,
                from,
                rustix::fs::CWD,
                to,
                rustix::fs::RenameFlags::NOREPLACE,
            )?;
        }
        #[cfg(all(not(windows), not(target_os = "linux")))]
        {
            fs::hard_link(from, to)?;
            fs::remove_file(from)?;
        }
        Ok(())
    }
    fn remove_file(&self, path: &str) -> Result<()> {
        guard_destructive(path)?;
        #[cfg(windows)]
        {
            use std::os::windows::fs::FileTypeExt;
            if fs::symlink_metadata(path)?.file_type().is_symlink_dir() {
                fs::remove_dir(path)?;
                return Ok(());
            }
        }
        fs::remove_file(path)?;
        Ok(())
    }
    fn discard_temp(&self, path: &str) -> Result<()> {
        #[cfg(windows)]
        {
            let meta = fs::symlink_metadata(path)?;
            if meta.is_file() && meta.permissions().readonly() {
                let mut permissions = meta.permissions();
                permissions.set_readonly(false);
                fs::set_permissions(path, permissions)?;
            }
        }
        self.remove_file(path)
    }
    fn transfer_metadata(
        &self,
        path: &str,
        original: &crate::properties::Properties,
    ) -> Result<()> {
        if original.file.modified != 0
            || !original.stamp.is_empty()
            || original.mode.is_some()
            || original.accessed.is_some()
        {
            let nanos = original
                .stamp
                .parse::<u128>()
                .ok()
                .unwrap_or(original.file.modified as u128 * 1_000_000_000);
            let time = UNIX_EPOCH
                .checked_add(std::time::Duration::new(
                    (nanos / 1_000_000_000).try_into()?,
                    (nanos % 1_000_000_000) as u32,
                ))
                .context("Unsupported file timestamp")?;
            #[cfg(windows)]
            let file = {
                use std::os::windows::fs::OpenOptionsExt;
                fs::OpenOptions::new()
                    .access_mode(0x100)
                    .custom_flags(0x02000000)
                    .open(path)?
            };
            #[cfg(not(windows))]
            let file = fs::File::open(path)?;
            file.set_modified(time)?;
        }
        #[cfg(unix)]
        if let Some(mode) = original.mode {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(mode & 0o7777))?;
        }
        #[cfg(windows)]
        crate::properties::apply_local(
            path,
            &crate::properties::Changes {
                readonly: (!original.file.is_dir).then_some(original.readonly.unwrap_or(false)),
                hidden: original.hidden,
                ..Default::default()
            },
        )?;
        Ok(())
    }
    fn remove_empty_dir(&self, path: &str) -> Result<()> {
        guard_destructive(path)?;
        fs::remove_dir(path)?;
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
    crate::search::run(fs, path, filter, cancel, &|batch| {
        send(Listing {
            entries: batch.matches.into_iter().map(|hit| hit.entry).collect(),
            done: batch.done,
            error: (batch.done && !batch.errors.is_empty()).then(|| batch.errors.join("\n")),
        });
    })
}

pub fn preview(fs: &dyn FileSystem, path: &str) -> Result<Preview> {
    preview_at(fs, path, 1, &AtomicBool::new(false))
}
pub fn preview_at(
    fs: &dyn FileSystem,
    path: &str,
    line: u64,
    cancel: &AtomicBool,
) -> Result<Preview> {
    let meta = fs.stat(path)?;
    if meta.is_dir {
        bail!("Choose a file to preview");
    }
    let ext = Path::new(path)
        .extension()
        .unwrap_or_default()
        .to_string_lossy()
        .to_lowercase();
    let mut detect_text = false;
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
        _ => {
            detect_text = true;
            ("text", "text/plain", 256 * 1024)
        }
    };
    let mut out = Preview {
        connection: fs.connection_id().map(str::to_owned),
        kind: kind.into(),
        mime: mime.into(),
        data: String::new(),
        truncated: meta.size > limit,
        size: meta.size,
        ..Preview::default()
    };
    if kind == "text" {
        match crate::text::window(fs.reader(path)?, line, cancel) {
            Ok(window) => {
                out.data = window.text;
                out.start_line = window.first_line;
                out.end_line = window.last_line;
                out.has_more = window.more;
                out.encoding = window.encoding;
                out.line_ending = window.line_ending;
                out.truncated = window.more || window.first_line > 1;
            }
            Err(error) if detect_text && error.to_string().contains("not supported") => {
                out.kind = "unsupported".into();
                out.mime = "application/octet-stream".into();
            }
            Err(error) => return Err(error),
        }
    } else {
        if out.truncated {
            bail!("Preview is too large ({} MiB limit)", limit / 1024 / 1024);
        }
        let mut bytes = Vec::new();
        fs.reader(path)?.take(limit + 1).read_to_end(&mut bytes)?;
        if bytes.len() as u64 > limit {
            bail!("The file grew beyond the preview limit");
        }
        out.data = base64::engine::general_purpose::STANDARD.encode(bytes);
    }
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

/// Read Explorer's saved locations; this does not scan the network or contact remote hosts.
pub fn network_places() -> Result<Vec<crate::Place>> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let script = r#"
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
$items=[System.Collections.Generic.List[object]]::new()
$network=New-Object -ComObject WScript.Network
$drives=$network.EnumNetworkDrives()
for($i=0;$i -lt $drives.Count();$i+=2){$letter=[string]$drives.Item($i);$target=[string]$drives.Item($i+1);$items.Add(@{name="$letter $target";path="$letter\";kind='network'})}
$shell=New-Object -ComObject WScript.Shell
$folder=Join-Path $env:APPDATA 'Microsoft\Windows\Network Shortcuts'
if(Test-Path -LiteralPath $folder){
foreach($item in Get-ChildItem -LiteralPath $folder -Force){
$links=if($item.PSIsContainer){@(Get-ChildItem -LiteralPath $item.FullName -Filter '*.lnk' -Force)}elseif($item.Extension -eq '.lnk'){@($item)}else{@()}
foreach($link in $links){$target=$shell.CreateShortcut($link.FullName).TargetPath;if($target.StartsWith('\\')){$items.Add(@{name=$item.BaseName;path=$target;kind='network'})}}
}}
$explorer=New-Object -ComObject Shell.Application
$quick=$explorer.Namespace('shell:::{679f85cb-0220-4080-b29b-5540cc05aab6}')
if($null -ne $quick){foreach($item in $quick.Items()){$target=[string]$item.Path;if($item.IsFolder -and $target.StartsWith('\\')){$items.Add(@{name=[string]$item.Name;path=$target;kind='network'})}}}
ConvertTo-Json -InputObject @($items.ToArray()) -Compress
"#;
        let output = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .creation_flags(0x08000000)
            .output()?;
        if !output.status.success() {
            bail!(
                "Cannot read Windows network locations: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            );
        }
        let values: Vec<serde_json::Value> = serde_json::from_slice(&output.stdout)?;
        let mut seen = std::collections::HashSet::new();
        return Ok(values
            .into_iter()
            .filter_map(|v| {
                let path = v.get("path")?.as_str()?.to_string();
                if !seen.insert(path.to_lowercase()) {
                    return None;
                }
                Some(crate::Place {
                    name: v.get("name")?.as_str()?.into(),
                    path,
                    kind: "network".into(),
                })
            })
            .collect());
    }
    #[cfg(not(windows))]
    Ok(vec![])
}
