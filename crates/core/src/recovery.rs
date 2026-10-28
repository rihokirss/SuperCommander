//! Recovery records retain original names before a file or directory is claimed.
use crate::filesystem::FileSystem;
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    sync::{LazyLock, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

static ACTIVE: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(Mutex::default);
#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        engine::Engine,
        filesystem::{LocalFs, Sources},
        Location,
    };
    use std::sync::{atomic::AtomicBool, Arc};
    #[test]
    fn an_active_claim_cannot_be_restored_or_purged_even_if_the_client_clears_its_flag() {
        let root = tempfile::TempDir::new().unwrap();
        let original = root.path().join("original.txt");
        std::fs::write(&original, "active original").unwrap();
        let claim = Claim::start(&LocalFs, original.to_str().unwrap(), "backup").unwrap();
        let mut item = inspect(&LocalFs, &claim.journal).unwrap();
        assert!(item.active);
        let options = RestoreOptions {
            key: item.key.clone(),
            revision: item.revision.clone(),
            connection: None,
            destination: Location {
                source: "local".into(),
                path: root.path().to_string_lossy().into(),
            },
            name: "recovered.txt".into(),
            replace: false,
        };
        let error = prepare(
            &LocalFs,
            "local",
            &LocalFs,
            &options,
            &AtomicBool::new(false),
            &|_, _| {},
        )
        .err()
        .unwrap();
        assert!(error.to_string().contains("active operation"));
        item.active = false;
        let engine = Engine::new(Arc::new(Sources::default()), Arc::new(|_| {}));
        assert!(engine
            .enqueue_recovery_cleanup(uuid::Uuid::new_v4().to_string(), "local".into(), item)
            .unwrap_err()
            .to_string()
            .contains("active operation"));
        let journal = claim.journal.clone();
        drop(claim);
        assert!(!inspect(&LocalFs, &journal).unwrap().active);
        assert!(prepare(
            &LocalFs,
            "local",
            &LocalFs,
            &options,
            &AtomicBool::new(false),
            &|_, _| {}
        )
        .is_ok());
        assert_eq!(
            std::fs::read_to_string(inspect(&LocalFs, &journal).unwrap().payload).unwrap(),
            "active original"
        );
    }
}
pub(crate) struct Active(String);
impl Active {
    pub fn acquire(path: &str) -> Result<Self> {
        let key = token(path).unwrap_or_else(|| path.into());
        if !ACTIVE.lock().unwrap().insert(key.clone()) {
            bail!("This saved copy is in use by an active operation");
        }
        Ok(Self(key))
    }
    pub fn new(path: &str) -> Self {
        let key = token(path).unwrap_or_else(|| path.into());
        ACTIVE.lock().unwrap().insert(key.clone());
        Self(key)
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub key: String,
    pub folder: String,
    pub payload: String,
    pub record: Option<String>,
    pub original: Option<String>,
    pub kind: String,
    pub entry: Option<crate::Entry>,
    pub created: Option<u64>,
    pub active: bool,
    pub error: Option<String>,
    pub revision: String,
    pub connection: Option<String>,
    #[serde(skip)]
    pub checksum: Option<String>,
}
fn payload_kind(name: &str) -> Option<&str> {
    let id = token(name)?;
    let suffix = name.strip_prefix(&format!(".supercommander-{id}."))?;
    [
        "backup",
        "part",
        "move-source",
        "move-directory",
        "check-directory",
        "delete-source",
        "delete-directory",
    ]
    .contains(&suffix)
    .then_some(suffix)
}
pub fn inspect(fs: &dyn FileSystem, key: &str) -> Result<Item> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let folder = crate::rename::parent(key);
    let name = key
        .rsplit(['/', '\\'])
        .next()
        .context("Invalid recovery path")?;
    let has_record = name.ends_with(".recovery.json");
    let payload_name = name.strip_suffix(".recovery.json").unwrap_or(name);
    let kind = payload_kind(payload_name)
        .context("Choose a SuperCommander recovery record or saved copy")?;
    // Prefer the sibling record even if a caller selected the payload directly.
    // A record appearing during a scan must not turn the same copy into an orphan.
    let sibling = format!("{key}.recovery.json");
    if !has_record && fs.exists(&sibling)? {
        return inspect(fs, &sibling);
    }
    let payload = fs.join(&folder, payload_name);
    let mut error = None;
    let mut original = None;
    let mut checksum = None;
    let mut created = None;
    let mut raw = Vec::new();
    if has_record {
        let read = (|| -> Result<()> {
            let entry = fs.stat(key)?;
            if entry.is_dir || entry.is_symlink || entry.size > 256 * 1024 {
                bail!("Invalid recovery record");
            }
            fs.reader(key)?.take(256 * 1024 + 1).read_to_end(&mut raw)?;
            if raw.len() > 256 * 1024 {
                bail!("Recovery record is too large");
            }
            let record: Record = serde_json::from_slice(&raw)?;
            let basename = |path: &str| path.rsplit(['/', '\\']).next().unwrap_or("").to_string();
            if record.version != 1
                || record.kind != kind
                || basename(&record.preserved) != payload_name
                || crate::rename::parent(&record.original)
                    != crate::rename::parent(&record.preserved)
                || record.original.contains('\0')
                || record.preserved.contains('\0')
            {
                bail!("Recovery record does not match its saved copy");
            }
            crate::filesystem::valid_name(&basename(&record.original))?;
            if record
                .checksum
                .as_ref()
                .is_some_and(|v| v.len() != 64 || !v.bytes().all(|b| b.is_ascii_hexdigit()))
            {
                bail!("Invalid recorded checksum");
            }
            original = Some(record.original);
            checksum = record.checksum.map(|v| v.to_ascii_lowercase());
            created = record.created;
            Ok(())
        })();
        if let Err(e) = read {
            error = Some(format!("{e:#}"));
        }
    }
    let mut hash = Sha256::new();
    hash.update(&raw);
    hash.update(key.as_bytes());
    let entry = if fs.exists(&payload)? {
        let info = crate::properties::get(fs, &payload)?;
        hash.update(info.revision.as_bytes());
        hash.update(serde_json::to_vec(&fs.fingerprint(&payload)?)?);
        if info.file.is_symlink {
            error = Some("Symbolic links cannot be recovered as files".into());
        }
        Some(info.file)
    } else {
        error = Some("The saved copy is missing; only its record remains".into());
        None
    };
    let revision = hash.finalize().iter().map(|b| format!("{b:02x}")).collect();
    Ok(Item {
        key: key.into(),
        folder,
        payload,
        record: has_record.then(|| key.into()),
        original,
        kind: kind.into(),
        entry,
        created,
        active: active(key),
        error,
        revision,
        connection: fs.connection_id().map(str::to_owned),
        checksum,
    })
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Batch {
    pub items: Vec<Item>,
    pub scanned: u64,
    pub done: bool,
    pub cancelled: bool,
    pub limited: bool,
    pub errors: Vec<String>,
}
pub fn scan(
    fs: &dyn FileSystem,
    path: &str,
    recursive: bool,
    cancel: &std::sync::atomic::AtomicBool,
    send: &dyn Fn(Batch),
) -> Result<()> {
    use std::{collections::HashSet, sync::atomic::Ordering, time::Instant};
    struct Walker<'a> {
        fs: &'a dyn FileSystem,
        recursive: bool,
        cancel: &'a std::sync::atomic::AtomicBool,
        send: &'a dyn Fn(Batch),
        batch: Batch,
        last: Instant,
        seen: HashSet<String>,
        found: usize,
    }
    impl Walker<'_> {
        fn flush(&mut self) {
            (self.send)(self.batch.clone());
            self.batch.items.clear();
            self.last = Instant::now();
        }
        fn visit(&mut self, path: &str, depth: usize) -> Result<()> {
            if self.cancel.load(Ordering::Relaxed) || self.batch.limited {
                return Ok(());
            }
            if depth > 256 {
                bail!("Recovery scan nesting exceeds 256 levels");
            }
            if !self.seen.insert(self.fs.canonical_path(path)?) {
                return Ok(());
            }
            let mut entries = Vec::new();
            let stop = std::sync::atomic::AtomicBool::new(false);
            let mut truncated = false;
            self.fs.visit_entries(path, &stop, &mut |entry| {
                if self.cancel.load(Ordering::Relaxed) {
                    stop.store(true, Ordering::Relaxed);
                } else if self.batch.scanned + entries.len() as u64 >= 200_000 {
                    truncated = true;
                    stop.store(true, Ordering::Relaxed);
                } else {
                    entries.push(entry);
                }
            })?;
            let names: HashSet<_> = entries
                .iter()
                .filter_map(|e| e.as_ref().ok().map(|e| e.name.clone()))
                .collect();
            let mut directories = Vec::new();
            for entry in entries {
                if self.cancel.load(Ordering::Relaxed) || self.batch.limited {
                    break;
                }
                self.batch.scanned += 1;
                if self.batch.scanned > 200_000 {
                    self.batch.limited = true;
                    break;
                }
                match entry {
                    Err(e) => {
                        if self.batch.errors.len() < 10 {
                            self.batch.errors.push(format!("{path}: {e:#}"));
                        }
                    }
                    Ok(entry) => {
                        let payload = entry
                            .name
                            .strip_suffix(".recovery.json")
                            .unwrap_or(&entry.name);
                        if payload_kind(payload).is_some() {
                            if entry.name.ends_with(".recovery.json")
                                || !names.contains(&format!("{}.recovery.json", entry.name))
                            {
                                match inspect(self.fs, &entry.path) {
                                    Ok(item) => {
                                        self.batch.items.push(item);
                                        self.found += 1;
                                    }
                                    Err(e) => {
                                        if self.batch.errors.len() < 10 {
                                            self.batch
                                                .errors
                                                .push(format!("{}: {e:#}", entry.path));
                                        }
                                    }
                                }
                                if self.found >= 2000 {
                                    self.batch.limited = true;
                                }
                            }
                        } else if entry.is_dir && !entry.is_symlink && self.recursive {
                            directories.push(entry.path);
                        }
                    }
                }
                if self.last.elapsed().as_millis() >= 100 || self.batch.items.len() >= 128 {
                    self.flush();
                }
            }
            self.batch.limited |= truncated;
            for path in directories {
                if let Err(e) = self.visit(&path, depth + 1) {
                    if self.batch.errors.len() < 10 {
                        self.batch.errors.push(format!("{path}: {e:#}"));
                    }
                }
            }
            Ok(())
        }
    }
    if !fs.stat(&fs.canonical_path(path)?)?.is_dir {
        bail!("Choose a folder to scan for saved copies");
    }
    let mut walker = Walker {
        fs,
        recursive,
        cancel,
        send,
        batch: Batch::default(),
        last: Instant::now(),
        seen: HashSet::new(),
        found: 0,
    };
    let result = walker.visit(path, 0);
    walker.batch.done = true;
    walker.batch.cancelled = cancel.load(Ordering::Relaxed);
    walker.flush();
    result
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreOptions {
    pub key: String,
    pub revision: String,
    pub connection: Option<String>,
    pub destination: crate::Location,
    pub name: String,
    pub replace: bool,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreRow {
    pub path: String,
    pub directory: bool,
    pub replace: bool,
    pub size: u64,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreSummary {
    pub destination: crate::Location,
    pub files: u64,
    pub folders: u64,
    pub bytes: u64,
    pub replace: u64,
    pub rows: Vec<RestoreRow>,
    pub checksum_changed: bool,
}
pub struct Prepared {
    pub summary: RestoreSummary,
    pub copy: crate::comparison::Prepared,
    pub item: Item,
}

pub fn prepare(
    fs: &dyn FileSystem,
    source: &str,
    dst: &dyn FileSystem,
    options: &RestoreOptions,
    cancel: &std::sync::atomic::AtomicBool,
    send: &dyn Fn(u64, u64),
) -> Result<Prepared> {
    use crate::{
        comparison::{self, Action, Node, Plan, Progress, Root},
        properties, Location, Operation,
    };
    use std::{
        collections::BTreeMap,
        sync::{atomic::Ordering, Arc},
    };
    crate::filesystem::valid_name(&options.name)?;
    if fs.connection_id() != options.connection.as_deref() {
        bail!("The recovery source connection changed; scan again");
    }
    let item = inspect(fs, &options.key)?;
    if item.revision != options.revision {
        bail!("The saved copy or record changed; scan again");
    }
    if item.active {
        bail!("This saved copy is still in use by an active operation");
    }
    let entry = item.entry.as_ref().context("The saved copy is missing")?;
    if entry.is_symlink {
        bail!("Symbolic links cannot be recovered as files");
    }
    if !dst.writable() {
        bail!("The recovery destination is read-only");
    }
    let destination = Root {
        location: options.destination.clone(),
        connection: dst.connection_id().map(str::to_owned),
        writable: dst.writable(),
        canonical: dst.canonical_path(&options.destination.path)?,
        identity: dst
            .fingerprint(&dst.canonical_path(&options.destination.path)?)?
            .map(|(id, _)| id),
    };
    if !dst.stat(&destination.canonical)?.is_dir {
        bail!("Choose a destination folder");
    }
    let source_root = Root {
        location: Location {
            source: source.into(),
            path: item.folder.clone(),
        },
        connection: fs.connection_id().map(str::to_owned),
        writable: fs.writable(),
        canonical: fs.canonical_path(&item.folder)?,
        identity: fs
            .fingerprint(&fs.canonical_path(&item.folder)?)?
            .map(|(id, _)| id),
    };
    let payload_canonical = fs.canonical_path(&item.payload)?;
    if source == options.destination.source && entry.is_dir {
        let root = payload_canonical.trim_end_matches(['/', '\\']);
        let target = destination.canonical.trim_end_matches(['/', '\\']);
        if root == target
            || target.starts_with(&format!("{root}/"))
            || target.starts_with(&format!("{root}\\"))
        {
            bail!("Recover into a folder outside the saved copy");
        }
    }
    struct Build<'a> {
        source: &'a str,
        fs: &'a dyn FileSystem,
        dst: &'a dyn FileSystem,
        options: &'a RestoreOptions,
        cancel: &'a std::sync::atomic::AtomicBool,
        send: &'a dyn Fn(u64, u64),
        left: BTreeMap<String, Arc<Node>>,
        right: BTreeMap<String, Arc<Node>>,
        rows: Vec<comparison::Row>,
        actions: Vec<Action>,
        summary: RestoreSummary,
        discovered: usize,
    }
    impl Build<'_> {
        fn visit(&mut self, path: &str, relative: &str, depth: usize) -> Result<()> {
            if self.cancel.load(Ordering::Relaxed) {
                bail!("Cancelled");
            }
            if depth > 256 || self.rows.len() >= 200_000 {
                bail!("Recovery tree exceeds the supported size or depth");
            }
            let info = properties::get(self.fs, path)?;
            if info.file.is_symlink {
                bail!("A symbolic link needs separate handling: {path}");
            }
            let canonical = self.fs.canonical_path(path)?;
            let mut children = Vec::new();
            if info.file.is_dir {
                let stop = std::sync::atomic::AtomicBool::new(false);
                let mut failure = None;
                self.fs.visit_entries(path, &stop, &mut |entry| {
                    if failure.is_some() {
                        return;
                    }
                    if self.cancel.load(Ordering::Relaxed) {
                        failure = Some(anyhow::anyhow!("Cancelled"));
                    } else if self.discovered >= 200_000 {
                        failure = Some(anyhow::anyhow!(
                            "Recovery tree exceeds the supported size or depth"
                        ));
                    } else {
                        match entry {
                            Ok(entry) => {
                                // Reserve space for every discovered entry, including
                                // siblings still waiting in ancestor traversal lists.
                                self.discovered += 1;
                                children.push(entry);
                            }
                            Err(error) => failure = Some(error),
                        }
                    }
                    if failure.is_some() {
                        stop.store(true, Ordering::Relaxed);
                    }
                })?;
                if let Some(error) = failure {
                    return Err(error);
                }
                if self.cancel.load(Ordering::Relaxed) {
                    bail!("Cancelled");
                }
            } else if !self.fs.regular_file(path)? {
                bail!("Special files cannot be recovered by copying: {path}");
            }
            let digest = if info.file.is_dir {
                None
            } else {
                Some(comparison::hash(self.fs, path, self.cancel, |n| {
                    self.summary.bytes += n;
                    (self.send)(self.summary.files, self.summary.bytes);
                })?)
            };
            if properties::get(self.fs, path)?.revision != info.revision {
                bail!("Saved copy changed while preparing recovery: {path}");
            }
            let node = Node {
                relative: relative.into(),
                entry: info.file,
                error: None,
                empty: children.is_empty(),
                revision: info.revision,
                canonical,
                digest,
            };
            let target_path =
                comparison::path_at(self.dst, &self.options.destination.path, relative)?;
            let target = if self.dst.exists(&target_path)? {
                let info = properties::get(self.dst, &target_path)?;
                if info.file.is_symlink || info.file.is_dir != node.entry.is_dir {
                    bail!("A destination type conflict needs a different recovery name: {target_path}");
                }
                if !info.file.is_dir && !self.options.replace {
                    bail!("A destination file already exists. Choose another name or review replacement: {target_path}");
                }
                let digest = if info.file.is_dir {
                    None
                } else {
                    Some(comparison::hash(
                        self.dst,
                        &target_path,
                        self.cancel,
                        |_| {},
                    )?)
                };
                let canonical = self.dst.canonical_path(&target_path)?;
                if self.options.destination.source == self.source && canonical == node.canonical {
                    bail!("Choose a recovery name different from the saved copy");
                }
                if properties::get(self.dst, &target_path)?.revision != info.revision {
                    bail!("Destination changed while preparing recovery: {target_path}");
                }
                Some(Node {
                    relative: relative.into(),
                    entry: info.file,
                    error: None,
                    empty: false,
                    revision: info.revision,
                    canonical,
                    digest,
                })
            } else {
                None
            };
            let directory = node.entry.is_dir;
            if directory {
                self.summary.folders += 1;
            } else {
                self.summary.files += 1;
            }
            let actionable = !directory || target.is_none();
            let replaced = !directory && target.is_some();
            if actionable {
                self.summary.replace += u64::from(replaced);
                self.summary.rows.push(RestoreRow {
                    path: relative.into(),
                    directory,
                    replace: replaced,
                    size: if directory { 0 } else { node.entry.size },
                });
                self.actions.push(Action {
                    relative: relative.into(),
                    side: 0,
                    source: node.clone(),
                    target: target.clone(),
                    target_path,
                    target_relative: relative.into(),
                });
            }
            let left = Arc::new(node);
            let right = target.map(Arc::new);
            self.left.insert(relative.into(), left.clone());
            if let Some(node) = &right {
                self.right.insert(relative.into(), node.clone());
            }
            self.rows.push(comparison::Row {
                id: self.rows.len(),
                path: relative.into(),
                status: if actionable { "different" } else { "folder" }.into(),
                left: Some(left),
                right,
                blocked: None,
                to_left: false,
                to_right: actionable,
            });
            for child in children {
                self.visit(
                    &child.path,
                    &format!("{relative}/{}", child.name),
                    depth + 1,
                )?;
            }
            Ok(())
        }
    }
    let mut build = Build {
        source,
        fs,
        dst,
        options,
        cancel,
        send,
        left: BTreeMap::new(),
        right: BTreeMap::new(),
        rows: Vec::new(),
        actions: Vec::new(),
        discovered: 1,
        summary: RestoreSummary {
            destination: options.destination.clone(),
            files: 0,
            folders: 0,
            bytes: 0,
            replace: 0,
            rows: Vec::new(),
            checksum_changed: false,
        },
    };
    build.visit(&item.payload, &options.name, 0)?;
    if build.actions.is_empty() {
        bail!("The destination already contains this empty folder; choose another recovery name");
    }
    let checksum = build
        .left
        .get(&options.name)
        .and_then(|n| n.digest.as_ref());
    let changed = item
        .checksum
        .as_ref()
        .is_some_and(|expected| checksum != Some(expected));
    if changed
        && (options.replace
            || item
                .original
                .as_ref()
                .is_some_and(|p| p.rsplit(['/', '\\']).next() == Some(options.name.as_str())))
    {
        bail!("The saved copy differs from its recorded checksum. Recover its current contents under a new name without replacement.");
    }
    build.summary.checksum_changed = changed;
    let trees = [build.left, build.right];
    let indexes = std::array::from_fn(|side| {
        trees[side]
            .iter()
            .map(|(p, n)| (p.clone(), vec![n.clone()]))
            .collect()
    });
    let plan = Arc::new(Plan {
        left: source_root,
        right: destination,
        options: comparison::Options::default(),
        rows: build.rows,
        progress: Progress {
            done: true,
            ..Progress::default()
        },
        trees,
        indexes,
    });
    Ok(Prepared {
        summary: build.summary,
        copy: comparison::Prepared {
            plan,
            actions: build.actions,
            operation: Operation::Restore,
        },
        item,
    })
}
impl Drop for Active {
    fn drop(&mut self) {
        ACTIVE.lock().unwrap().remove(&self.0);
    }
}
fn token(path: &str) -> Option<String> {
    let name = path.rsplit(['/', '\\']).next()?;
    let rest = name.strip_prefix(".supercommander-")?;
    let id = rest.get(..36)?;
    uuid::Uuid::parse_str(id).ok()?;
    Some(id.into())
}
pub fn active(path: &str) -> bool {
    token(path).is_some_and(|id| ACTIVE.lock().unwrap().contains(&id))
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub version: u32,
    pub kind: String,
    pub original: String,
    pub preserved: String,
    #[serde(default)]
    pub created: Option<u64>,
    #[serde(default)]
    pub checksum: Option<String>,
}
pub(crate) struct Claim<'a> {
    fs: &'a dyn FileSystem,
    pub original: String,
    pub preserved: String,
    pub journal: String,
    _active: Active,
}
impl<'a> Claim<'a> {
    pub fn start(fs: &'a dyn FileSystem, path: &str, kind: &str) -> Result<Self> {
        Self::checked(fs, path, kind, None)
    }
    pub fn checked(
        fs: &'a dyn FileSystem,
        path: &str,
        kind: &str,
        checksum: Option<&str>,
    ) -> Result<Self> {
        let preserved = fs.join(
            &crate::rename::parent(path),
            &format!(".supercommander-{}.{kind}", uuid::Uuid::new_v4()),
        );
        let journal = format!("{preserved}.recovery.json");
        let active = Active::new(&journal);
        let record = Record {
            version: 1,
            kind: kind.into(),
            original: path.into(),
            preserved: preserved.clone(),
            created: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .ok()
                .map(|t| t.as_secs()),
            checksum: checksum.map(str::to_owned),
        };
        let mut writer = fs.private_writer(&journal)?;
        let written = (|| -> Result<()> {
            serde_json::to_writer_pretty(&mut writer, &record)?;
            writer.write_all(b"\n")?;
            writer.flush()?;
            Ok(())
        })();
        drop(writer);
        if let Err(error) = written {
            let _ = fs.remove_file(&journal);
            return Err(error);
        }
        if let Err(error) = fs.rename_new(path, &preserved) {
            return match fs.remove_file(&journal) {
                Ok(()) => Err(error),
                Err(cleanup) => Err(anyhow::anyhow!(
                    "{error:#}; unused recovery record remains at {journal}: {cleanup:#}"
                )),
            };
        }
        Ok(Self {
            fs,
            original: path.into(),
            preserved,
            journal,
            _active: active,
        })
    }
    pub fn restore(&self, error: anyhow::Error) -> anyhow::Error {
        match self.fs.rename_new(&self.preserved,&self.original) {
            Ok(())=>match self.clear(){Ok(())=>error,Err(cleanup)=>anyhow::anyhow!("{error:#}; {cleanup:#}")},
            Err(restore)=>anyhow::anyhow!("{error:#}; source/original preserved at {}; recovery record {}; restore failed: {restore:#}",self.preserved,self.journal),
        }
    }
    pub fn clear(&self) -> Result<()> {
        self.fs.remove_file(&self.journal).with_context(|| {
            format!(
                "Operation finalized; unused recovery record remains at {}",
                self.journal
            )
        })
    }
}

/// Metadata independent of a private sibling name. Rename changes paths and
/// access/change times, while the payload, attributes and modification time stay.
pub(crate) fn metadata_signature(mut info: crate::properties::Properties) -> Result<String> {
    use sha2::{Digest, Sha256};
    info.file.path.clear();
    info.file.name.clear();
    info.file.hidden = false;
    info.accessed = None;
    info.revision.clear();
    info.connection = None;
    let mut hash = Sha256::new();
    hash.update(serde_json::to_vec(&info)?);
    hash.update(info.stamp.as_bytes());
    Ok(hash.finalize().iter().map(|b| format!("{b:02x}")).collect())
}
