use crate::{
    filesystem::{valid_name, FileSystem},
    Entry,
};
use anyhow::{bail, Context, Result};
use std::{
    collections::BTreeMap,
    fs::File,
    io::{Cursor, Read, Seek, Write},
    path::Path,
};
use zip::ZipArchive;

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
        let mut entries: BTreeMap<String, (Entry, bool)> = BTreeMap::new();
        for i in 0..archive.len() {
            let f = archive.by_index(i)?;
            if safe_zip_path(f.name()).is_err() {
                continue;
            }
            if let Some(rest) = f.name().strip_prefix(&prefix) {
                let name = rest.split('/').next().unwrap_or("");
                if name.is_empty() {
                    continue;
                }
                let is_dir = rest.contains('/');
                let direct = !rest.trim_end_matches('/').contains('/');
                let modified = metadata::Metadata::from_zip(&f).seconds();
                let (entry, explicit) = entries.entry(name.to_string()).or_insert_with(|| {
                    (
                        Entry {
                            name: name.into(),
                            path: format!("/{prefix}{name}"),
                            is_dir,
                            is_symlink: direct
                                && f.unix_mode().is_some_and(|m| m & 0o170000 == 0o120000),
                            size: if is_dir { 0 } else { f.size() },
                            modified,
                            hidden: name.starts_with('.'),
                        },
                        false,
                    )
                });
                if direct {
                    entry.modified = modified;
                    *explicit = true;
                } else if !*explicit {
                    entry.modified = entry.modified.max(modified);
                }
            }
        }
        Ok(entries.into_values().map(|(entry, _)| entry).collect())
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
        f.by_ref()
            .take(128 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)?;
        anyhow::ensure!(
            bytes.len() <= 128 * 1024 * 1024,
            "Archive entry exceeds the 128 MiB viewing limit; use Extract"
        );
        Ok(Box::new(Cursor::new(bytes)))
    }
    fn properties(&self, path: &str) -> Result<crate::properties::Properties> {
        let entry = self.stat(path)?;
        let mut archive = ZipArchive::new(File::open(&self.path)?)?;
        let name = path.trim_start_matches('/');
        let found = archive
            .index_for_name(name)
            .or_else(|| archive.index_for_name(&format!("{name}/")));
        if let Some(index) = found {
            return Ok(metadata::Metadata::from_zip(&archive.by_index(index)?).properties(entry));
        }
        Ok(crate::properties::Properties::basic(entry))
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
        if path == "/" {
            return Ok(true);
        }
        Ok(self
            .list(&crate::rename::parent(path))?
            .iter()
            .any(|entry| entry.path == path))
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

pub fn extracted_entries(path: &str) -> Result<Vec<(usize, std::path::PathBuf, bool, u64)>> {
    let mut archive = ZipArchive::new(File::open(path)?)?;
    Ok(inspect_entries(&mut archive, &|| Ok(()))?
        .into_iter()
        .map(|entry| (entry.index, entry.path, entry.directory, entry.size))
        .collect())
}

pub(crate) struct ArchiveEntry {
    pub index: usize,
    pub path: std::path::PathBuf,
    pub directory: bool,
    pub size: u64,
    pub metadata: metadata::Metadata,
}
pub(crate) fn inspect_entries<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    check: &dyn Fn() -> Result<()>,
) -> Result<Vec<ArchiveEntry>> {
    anyhow::ensure!(
        archive.len() <= 200_000,
        "Archive has more than 200,000 entries; extract smaller archives separately"
    );
    let mut out = Vec::new();
    let mut names = std::collections::HashMap::new();
    for i in 0..archive.len() {
        check()?;
        let f = archive.by_index(i)?;
        let p = safe_zip_path(f.name())?;
        anyhow::ensure!(
            p.components().count() <= 256,
            "Archive directory nesting exceeds 256 levels"
        );
        if f.unix_mode()
            .is_some_and(|m| ![0, 0o100000, 0o040000].contains(&(m & 0o170000)))
        {
            bail!("Archive contains a symbolic link or special file");
        }
        if names
            .insert(p.to_string_lossy().to_lowercase(), f.is_dir())
            .is_some()
        {
            bail!("Archive contains duplicate target names");
        }
        out.push(ArchiveEntry {
            index: i,
            path: p,
            directory: f.is_dir(),
            size: f.size(),
            metadata: metadata::Metadata::from_zip(&f),
        });
    }
    let mut spellings = std::collections::HashMap::new();
    for entry in &out {
        check()?;
        let mut current = Some(entry.path.as_path());
        while let Some(path) = current.filter(|p| !p.as_os_str().is_empty()) {
            check()?;
            let name = path.to_string_lossy();
            let key = name.to_lowercase();
            if let Some(previous) = spellings.get(&key) {
                anyhow::ensure!(
                    *previous == name,
                    "Archive contains ambiguous folder or file spelling: {name}"
                );
            } else {
                anyhow::ensure!(
                    spellings.len() < 200_000,
                    "Archive has more than 200,000 file and folder paths"
                );
                spellings.insert(key, name.into_owned());
            }
            current = path.parent();
        }
        let mut parent = entry.path.parent();
        while let Some(path) = parent {
            check()?;
            anyhow::ensure!(
                names.get(&path.to_string_lossy().to_lowercase()) != Some(&false),
                "Archive contains a file used as a parent folder"
            );
            parent = path.parent();
        }
    }
    Ok(out)
}
pub(crate) mod metadata;
