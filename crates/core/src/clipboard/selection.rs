//! Bind clipboard roots to selected filesystem objects before paste. Native IDs
//! permit in-place edits; sources without IDs use conservative version checks.
use super::{Files, MAX_BYTES, MAX_PATHS};
use crate::{filesystem::FileSystem, properties};
use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Binding {
    canonical: Option<String>,
    identity: Option<String>,
    revision: String,
    digest: Option<String>,
    directory: bool,
    link: bool,
}
impl Binding {
    pub(crate) fn check_metadata(
        &self,
        entry: &crate::Entry,
        canonical: Option<&str>,
        identity: Option<&str>,
        revision: &str,
    ) -> Result<()> {
        if self.canonical.as_deref() != canonical
            || self.directory != entry.is_dir
            || self.link != entry.is_symlink
            || self.identity.as_deref() != identity
            || self.identity.is_none() && self.revision != revision
        {
            bail!(
                "A clipboard source was replaced or changed. Copy the files again: {}",
                entry.path
            );
        }
        Ok(())
    }
    pub(crate) fn check_digest(&self, digest: Option<&str>, path: &str) -> Result<()> {
        if self.identity.is_none() && self.digest.as_deref() != digest {
            bail!("A clipboard source was replaced or changed. Copy the files again: {path}");
        }
        Ok(())
    }
}
#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub files: u64,
    pub bytes: u64,
    pub current: String,
}
fn check(cancel: &AtomicBool) -> Result<()> {
    if cancel.load(Ordering::Relaxed) {
        bail!("Cancelled");
    }
    Ok(())
}
fn directory_digest(fs: &dyn FileSystem, path: &str, cancel: &AtomicBool) -> Result<String> {
    let mut names = Vec::new();
    let mut bytes = 0;
    let mut failure = None;
    let stop = AtomicBool::new(false);
    fs.visit_entries(path, &stop, &mut |entry| {
        if failure.is_some() { return; }
        let result = check(cancel).and(entry).and_then(|entry| {
            bytes += entry.name.len();
            if names.len() >= MAX_PATHS || bytes > MAX_BYTES / 4 {
                bail!("Folder is too large for clipboard selection checking. Use F5 or F6 for this operation.");
            }
            names.push((entry.name, entry.is_dir, entry.is_symlink));
            Ok(())
        });
        if let Err(error) = result { failure = Some(error); stop.store(true, Ordering::Relaxed); }
    })?;
    if let Some(error) = failure {
        return Err(error);
    }
    names.sort();
    Ok(Sha256::digest(serde_json::to_vec(&names)?)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}
fn capture(
    fs: &dyn FileSystem,
    path: &str,
    cancel: &AtomicBool,
    progress: &mut Progress,
    send: &dyn Fn(Progress),
) -> Result<Binding> {
    check(cancel)?;
    progress.current = path.into();
    send(progress.clone());
    let info = properties::get(fs, path)?;
    let identity = fs.fingerprint(path)?.map(|(id, _)| id);
    let canonical = if info.file.is_symlink {
        None
    } else {
        Some(fs.canonical_path(path)?)
    };
    let digest = if identity.is_some() || info.file.is_symlink {
        None
    } else if info.file.is_dir {
        Some(directory_digest(fs, path, cancel)?)
    } else if fs.regular_file(path)? {
        Some(crate::comparison::hash(fs, path, cancel, |n| {
            progress.bytes += n;
            send(progress.clone());
        })?)
    } else {
        None
    };
    check(cancel)?;
    if fs.fingerprint(path)?.map(|(id, _)| id) != identity
        || identity.is_none() && properties::get(fs, path)?.revision != info.revision
    {
        bail!("Selection changed while checking it. Copy the files again: {path}");
    }
    progress.files += 1;
    send(progress.clone());
    Ok(Binding {
        canonical,
        identity,
        revision: info.revision,
        digest,
        directory: info.file.is_dir,
        link: info.file.is_symlink,
    })
}
impl Files {
    pub fn capture_selection(
        &mut self,
        fs: &dyn FileSystem,
        cancel: &AtomicBool,
        send: &dyn Fn(Progress),
    ) -> Result<()> {
        self.bindings = None;
        self.validate()?;
        self.connection = fs.connection_id().map(str::to_owned);
        let mut progress = Progress::default();
        let mut bindings = Vec::with_capacity(self.paths.len());
        let last = std::cell::Cell::new(std::time::Instant::now());
        let report = |progress: Progress| {
            if last.get().elapsed().as_millis() >= 100
                || progress.files as usize == self.paths.len()
            {
                last.set(std::time::Instant::now());
                send(progress);
            }
        };
        for path in &self.paths {
            bindings.push(capture(fs, path, cancel, &mut progress, &report)?);
        }
        check(cancel)?;
        self.bindings = Some(bindings);
        Ok(())
    }
    pub fn validate_selection(
        &self,
        fs: &dyn FileSystem,
        cancel: &AtomicBool,
        send: &dyn Fn(Progress),
    ) -> Result<()> {
        self.validate()?;
        self.validate_source(fs)?;
        let Some(bindings) = &self.bindings else {
            return Ok(());
        }; // CF_HDROP carries paths only.
        let mut progress = Progress::default();
        for (path, expected) in self.paths.iter().zip(bindings) {
            let current = capture(fs, path, cancel, &mut progress, send)?;
            if expected.canonical != current.canonical
                || expected.directory != current.directory
                || expected.link != current.link
                || expected.identity != current.identity
                || expected.identity.is_none()
                    && (expected.revision != current.revision || expected.digest != current.digest)
            {
                bail!("A clipboard source was replaced or changed. Copy the files again: {path}");
            }
        }
        Ok(())
    }
}
