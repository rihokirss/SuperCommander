use crate::{
    filesystem::{valid_name, FileSystem},
    Entry,
};
use anyhow::{bail, Context, Result};
use std::{
    collections::BTreeMap,
    fs::File,
    io::{Cursor, Read, Write},
    path::Path,
};
use zip::{write::SimpleFileOptions, ZipArchive, ZipWriter};

pub struct ZipFs {
    path: String,
}
impl ZipFs {
    pub fn new(path: &str) -> Result<Self> {
        ZipArchive::new(File::open(path)?)?;
        Ok(Self { path: path.into() })
    }
}
impl FileSystem for ZipFs {
    fn list(&self, path: &str) -> Result<Vec<Entry>> {
        let prefix = if path.trim_matches('/').is_empty() {
            String::new()
        } else {
            format!("{}/", path.trim_matches('/'))
        };
        let mut archive = ZipArchive::new(File::open(&self.path)?)?;
        let mut entries = BTreeMap::new();
        for i in 0..archive.len() {
            let f = archive.by_index(i)?;
            if f.enclosed_name().is_none() {
                continue;
            }
            if let Some(rest) = f.name().strip_prefix(&prefix) {
                let name = rest.split('/').next().unwrap_or("");
                if name.is_empty() {
                    continue;
                }
                let is_dir = rest.contains('/');
                entries.entry(name.to_string()).or_insert_with(|| Entry {
                    name: name.into(),
                    path: format!("/{prefix}{name}"),
                    is_dir,
                    is_symlink: f.unix_mode().is_some_and(|m| m & 0o170000 == 0o120000),
                    size: if is_dir { 0 } else { f.size() },
                    modified: 0,
                    hidden: name.starts_with('.'),
                });
            }
        }
        Ok(entries.into_values().collect())
    }
    fn stat(&self, path: &str) -> Result<Entry> {
        if path == "/" {
            return Ok(Entry {
                name: "/".into(),
                path: path.into(),
                is_dir: true,
                is_symlink: false,
                size: 0,
                modified: 0,
                hidden: false,
            });
        }
        self.list(&crate::rename::parent(path))?
            .into_iter()
            .find(|e| e.path == path)
            .context("Archive entry not found")
    }
    fn reader(&self, path: &str) -> Result<Box<dyn Read + Send>> {
        let mut archive = ZipArchive::new(File::open(&self.path)?)?;
        let mut f = archive.by_name(path.trim_start_matches('/'))?;
        if f.size() > 128 * 1024 * 1024 {
            bail!("Use Extract for archive entries over 128 MiB");
        }
        let mut bytes = Vec::new();
        f.read_to_end(&mut bytes)?;
        Ok(Box::new(Cursor::new(bytes)))
    }
    fn writer(&self, _: &str) -> Result<Box<dyn Write + Send>> {
        bail!("ZIP view is read-only")
    }
    fn mkdir(&self, _: &str) -> Result<()> {
        bail!("ZIP view is read-only")
    }
    fn rename(&self, _: &str, _: &str) -> Result<()> {
        bail!("ZIP view is read-only")
    }
    fn remove(&self, _: &str) -> Result<()> {
        bail!("ZIP view is read-only")
    }
    fn join(&self, parent: &str, name: &str) -> String {
        format!("{}/{name}", parent.trim_end_matches('/'))
    }
    fn writable(&self) -> bool {
        false
    }
    fn exists(&self, path: &str) -> Result<bool> {
        Ok(self.stat(path).is_ok())
    }
}

pub fn safe_zip_path(name: &str) -> Result<std::path::PathBuf> {
    if name.starts_with(['/', '\\']) || name.contains('\\') {
        bail!("Unsafe archive path: {name}");
    }
    let p = Path::new(name);
    let mut out = std::path::PathBuf::new();
    for part in p.components() {
        match part {
            std::path::Component::Normal(n) => {
                valid_name(&n.to_string_lossy())?;
                out.push(n);
            }
            _ => bail!("Unsafe archive path: {name}"),
        }
    }
    if out.as_os_str().is_empty() {
        bail!("Empty archive path");
    }
    Ok(out)
}

pub fn create_zip(
    paths: &[String],
    target: &Path,
    cancelled: &dyn Fn() -> bool,
    progress: &mut dyn FnMut(u64, &str),
) -> Result<()> {
    let file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(target)?;
    let mut writer = ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    for root in paths {
        let root = Path::new(root);
        let parent = root.parent().context("Cannot archive a root directory")?;
        for entry in walkdir::WalkDir::new(root).follow_links(false) {
            if cancelled() {
                bail!("Cancelled");
            }
            let entry = entry?;
            if entry.file_type().is_symlink() {
                bail!(
                    "Symbolic links are not archived: {}",
                    entry.path().display()
                );
            }
            let relative = entry
                .path()
                .strip_prefix(parent)?
                .to_string_lossy()
                .replace('\\', "/");
            safe_zip_path(&relative)?;
            if entry.file_type().is_dir() {
                writer.add_directory(format!("{relative}/"), options)?;
            } else {
                writer.start_file(&relative, options)?;
                let mut file = File::open(entry.path())?;
                let mut buf = vec![0; 256 * 1024];
                loop {
                    if cancelled() {
                        bail!("Cancelled");
                    }
                    let n = file.read(&mut buf)?;
                    if n == 0 {
                        break;
                    }
                    writer.write_all(&buf[..n])?;
                    progress(n as u64, &relative);
                }
            }
        }
    }
    writer.finish()?.sync_all()?;
    Ok(())
}

pub fn extracted_entries(path: &str) -> Result<Vec<(usize, std::path::PathBuf, bool, u64)>> {
    let mut archive = ZipArchive::new(File::open(path)?)?;
    let mut out = Vec::new();
    let mut names = std::collections::HashSet::new();
    for i in 0..archive.len() {
        let f = archive.by_index(i)?;
        let p = safe_zip_path(f.name())?;
        if f.unix_mode().is_some_and(|m| m & 0o170000 == 0o120000) {
            bail!("Archive contains a symbolic link");
        }
        if !names.insert(p.to_string_lossy().to_lowercase()) {
            bail!("Archive contains duplicate target names");
        }
        out.push((i, p, f.is_dir(), f.size()));
    }
    Ok(out)
}
