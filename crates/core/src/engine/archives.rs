//! Archive operations consume the queued manifest. Extraction validates a
//! private immutable copy of each ZIP before creating destination entries.
use super::{
    choose_target,
    snapshot::{Node, Snapshot},
    transfer, validate_destination, ContextJob,
};
use crate::{
    archive::{self, ArchiveEntry},
    filesystem::{FileSystem, LocalFs},
    JobRequest,
};
use anyhow::{Context, Result};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs::File,
    io::{BufRead, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};
use zip::{ZipArchive, ZipWriter};

struct Progress(std::time::Instant);
impl Progress {
    fn new() -> Self {
        Self(std::time::Instant::now() - std::time::Duration::from_millis(100))
    }
    fn advance(&mut self, ctx: &mut ContextJob, bytes: u64, path: &str) {
        ctx.event.bytes += bytes;
        ctx.event.current = path.into();
        if self.0.elapsed().as_millis() >= 100 {
            ctx.emit();
            self.0 = std::time::Instant::now();
        }
    }
}

fn next(snapshot: &mut Snapshot) -> Result<Option<Node>> {
    let mut line = String::new();
    anyhow::ensure!(
        snapshot.input.read_line(&mut line)? != 0,
        "Incomplete archive source manifest"
    );
    Ok(serde_json::from_str(&line)?)
}
fn hash(bytes: impl AsRef<[u8]>) -> String {
    bytes.as_ref().iter().map(|b| format!("{b:02x}")).collect()
}
fn key(path: &str) -> String {
    #[cfg(windows)]
    {
        path.to_lowercase()
    }
    #[cfg(not(windows))]
    {
        path.into()
    }
}
struct Inputs(Vec<(String, Option<String>)>);
fn private_file(path: &Path) -> Result<File> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    Ok(options.open(path)?)
}
fn finish_temp(result: Result<()>, owned: bool, path: &Path) -> Result<()> {
    if let Err(error) = result {
        if owned {
            if let Err(cleanup) = LocalFs.discard_temp(&path.to_string_lossy()) {
                return Err(anyhow::anyhow!("{error:#}; temporary output {} could not be removed: {cleanup:#}. If its parent was moved, look for this .part name in that moved folder.", path.display()));
            }
        }
        return Err(error);
    }
    Ok(())
}
impl Inputs {
    fn capture(req: &JobRequest) -> Result<Self> {
        Ok(Self(
            req.paths
                .iter()
                .map(|p| {
                    Ok((
                        key(&LocalFs.canonical_path(p)?),
                        LocalFs.fingerprint(p)?.map(|(id, _)| id),
                    ))
                })
                .collect::<Result<_>>()?,
        ))
    }
    fn protect(&self, target: &str) -> Result<()> {
        let exists = LocalFs.exists(target)?;
        let canonical = if exists {
            LocalFs.canonical_path(target)?
        } else {
            let path = Path::new(target);
            Path::new(&LocalFs.canonical_path(&crate::rename::parent(target))?)
                .join(path.file_name().context("Invalid archive target")?)
                .to_string_lossy()
                .into_owned()
        };
        let identity = if exists {
            LocalFs.fingerprint(target)?.map(|(id, _)| id)
        } else {
            None
        };
        anyhow::ensure!(!self.0.iter().any(|(path, id)| *path == key(&canonical) || id.is_some() && *id == identity),
            "Archive output would replace a selected source file; choose another name or folder: {target}");
        Ok(())
    }
}

pub(super) fn create(
    req: &JobRequest,
    snapshot: &mut Snapshot,
    ctx: &mut ContextJob,
) -> Result<()> {
    anyhow::ensure!(
        req.source == "local" && req.destination.source == "local",
        "ZIP creation currently requires local files"
    );
    let parent = Path::new(&req.destination.path)
        .parent()
        .context("Invalid archive destination")?;
    for path in &req.paths {
        validate_destination(path, &parent.to_string_lossy())?;
    }
    let inputs = Inputs::capture(req)?;
    let Some(target) = choose_target(&LocalFs, &req.destination.path, ctx)? else {
        return Ok(());
    };
    inputs.protect(&target)?;
    let expected = transfer::target_stamp(&LocalFs, &target, ctx)?;
    let temp = parent.join(format!(".supercommander-{}.part", uuid::Uuid::new_v4()));
    ctx.keep_backups = true;
    let mut owned = false;
    let result = (|| -> Result<()> {
        let output = private_file(&temp)?;
        owned = true;
        let mut archive = ZipWriter::new(output);
        let mut names = HashSet::new();
        let mut buffer = vec![0; 256 * 1024];
        let mut progress = Progress::new();
        for index in 0..snapshot.roots.len() {
            snapshot
                .input
                .seek(SeekFrom::Start(snapshot.roots[index]))?;
            let root = next(snapshot)?.context("Missing archive root")?;
            let parent = Path::new(&root.entry.path)
                .parent()
                .context("Cannot archive a root")?
                .to_path_buf();
            let mut depth = 0usize;
            let mut current = Some(root);
            loop {
                ctx.check()?;
                if let Some(node) = current {
                    node.validate(&LocalFs, ctx, false)?;
                    let relative = Path::new(&node.entry.path)
                        .strip_prefix(&parent)?
                        .to_string_lossy()
                        .replace('\\', "/");
                    anyhow::ensure!(
                        archive::safe_zip_path(&relative)?.components().count() <= 256,
                        "Archive directory nesting exceeds 256 levels"
                    );
                    anyhow::ensure!(
                        names.insert(relative.to_lowercase()),
                        "Selected files would create duplicate archive names: {relative}"
                    );
                    anyhow::ensure!(
                        names.len() <= 200_000,
                        "Archive has more than 200,000 entries; create smaller archives separately"
                    );
                    let options =
                        archive::metadata::options(&LocalFs.properties(&node.entry.path)?)?;
                    if node.entry.is_dir {
                        depth += 1;
                        archive.add_directory(format!("{relative}/"), options)?;
                    } else {
                        archive.start_file(&relative, options)?;
                        let mut input = LocalFs
                            .reader(&node.entry.path)?
                            .take(node.entry.size.saturating_add(1));
                        let mut read = 0u64;
                        let mut digest = Sha256::new();
                        loop {
                            ctx.check()?;
                            let n = input.read(&mut buffer)?;
                            if n == 0 {
                                break;
                            }
                            read += n as u64;
                            anyhow::ensure!(
                                read <= node.entry.size,
                                "Source size changed while creating archive: {}",
                                node.entry.path
                            );
                            digest.update(&buffer[..n]);
                            archive.write_all(&buffer[..n])?;
                            progress.advance(ctx, n as u64, &node.entry.path);
                        }
                        anyhow::ensure!(
                            node.digest.as_deref() == Some(hash(digest.finalize()).as_str()),
                            "Source contents changed while creating archive: {}",
                            node.entry.path
                        );
                        node.validate(&LocalFs, ctx, false)?;
                    }
                } else {
                    anyhow::ensure!(depth > 0, "Invalid archive source manifest");
                    depth -= 1;
                }
                if depth == 0 {
                    break;
                }
                current = next(snapshot)?;
            }
        }
        archive.finish()?.sync_all()?;
        snapshot.validate(&LocalFs, ctx)?;
        snapshot.validate_destination(&LocalFs)?;
        inputs.protect(&target)?;
        transfer::commit(
            &LocalFs,
            &temp.to_string_lossy(),
            &target,
            expected.as_ref(),
            ctx,
            || {
                ctx.check()?;
                snapshot.validate_destination(&LocalFs)?;
                inputs.protect(&target)
            },
        )
    })();
    finish_temp(result, owned, &temp)?;
    ctx.event.completed = req.paths.len() as u64;
    Ok(())
}

struct Frozen {
    zip: ZipArchive<File>,
    entries: Vec<ArchiveEntry>,
}
fn freeze(
    snapshot: &mut Snapshot,
    index: usize,
    ctx: &mut ContextJob,
    progress: &mut Progress,
) -> Result<Frozen> {
    snapshot
        .input
        .seek(SeekFrom::Start(snapshot.roots[index]))?;
    let node = next(snapshot)?.context("Missing archive input")?;
    anyhow::ensure!(
        !node.entry.is_dir && !node.entry.is_symlink,
        "Choose regular ZIP files to extract"
    );
    node.validate(&LocalFs, ctx, false)?;
    let mut input = LocalFs
        .reader(&node.entry.path)?
        .take(node.entry.size.saturating_add(1));
    let mut read = 0u64;
    let mut private = tempfile::tempfile()?;
    let mut digest = Sha256::new();
    let mut buffer = vec![0; 256 * 1024];
    loop {
        ctx.check()?;
        let n = input.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        read += n as u64;
        anyhow::ensure!(
            read <= node.entry.size,
            "Archive size changed after queuing: {}",
            node.entry.path
        );
        private.write_all(&buffer[..n])?;
        digest.update(&buffer[..n]);
        progress.advance(ctx, n as u64, &node.entry.path);
    }
    anyhow::ensure!(
        node.digest.as_deref() == Some(hash(digest.finalize()).as_str()),
        "Archive contents changed after queuing: {}",
        node.entry.path
    );
    node.validate(&LocalFs, ctx, false)?;
    private.rewind()?;
    let mut zip = ZipArchive::new(private)?;
    let entries = archive::inspect_entries(&mut zip, &|| ctx.check())?;
    Ok(Frozen { zip, entries })
}

struct Directory {
    canonical: String,
    identity: Option<String>,
}
impl Directory {
    fn capture(path: &Path, root: &Path) -> Result<Self> {
        let path = path.to_string_lossy();
        let entry = LocalFs.stat(&path)?;
        let canonical = LocalFs.canonical_path(&path)?;
        anyhow::ensure!(
            entry.is_dir && !entry.is_symlink && Path::new(&canonical).starts_with(root),
            "Unsafe extraction directory: {path}"
        );
        Ok(Self {
            canonical,
            identity: LocalFs.fingerprint(&path)?.map(|(id, _)| id),
        })
    }
    fn validate(&self, path: &Path, root: &Path) -> Result<()> {
        let current = Self::capture(path, root)?;
        anyhow::ensure!(
            self.canonical == current.canonical && self.identity == current.identity,
            "Extraction directory changed: {}",
            path.display()
        );
        Ok(())
    }
}
struct Directories {
    root: PathBuf,
    pinned: HashMap<PathBuf, Directory>,
    created: HashSet<PathBuf>,
}
impl Directories {
    fn ensure(
        &mut self,
        relative: &Path,
        snapshot: &Snapshot,
        ctx: &ContextJob,
    ) -> Result<PathBuf> {
        snapshot.validate_destination(&LocalFs)?;
        let mut path = self.root.clone();
        self.validate(&path, snapshot)?;
        for component in relative.components() {
            ctx.check()?;
            path.push(component);
            if !self.pinned.contains_key(&path) {
                if !LocalFs.exists(&path.to_string_lossy())? {
                    std::fs::create_dir(&path)?;
                    self.created.insert(path.clone());
                }
                self.pinned
                    .insert(path.clone(), Directory::capture(&path, &self.root)?);
            }
            self.validate(&path, snapshot)?;
        }
        Ok(path)
    }
    fn validate(&self, path: &Path, snapshot: &Snapshot) -> Result<()> {
        snapshot.validate_destination(&LocalFs)?;
        let mut current = Some(path);
        while let Some(path) = current {
            if let Some(pinned) = self.pinned.get(path) {
                pinned.validate(path, &self.root)?;
            }
            if path == self.root {
                break;
            }
            current = path.parent();
        }
        Ok(())
    }
}

pub(super) fn extract(
    req: &JobRequest,
    snapshot: &mut Snapshot,
    ctx: &mut ContextJob,
) -> Result<()> {
    anyhow::ensure!(
        req.source == "local" && req.destination.source == "local",
        "Extract requires local ZIP files"
    );
    let inputs = Inputs::capture(req)?;
    ctx.keep_backups = true;
    ctx.event.state = "preparing".into();
    ctx.event.bytes = 0;
    ctx.event.total = snapshot.total;
    ctx.emit();
    // All selected ZIP containers are frozen and structurally checked before
    // the first destination is created. A later source cannot partially win.
    let mut frozen = Vec::new();
    let mut total = 0u64;
    let mut progress = Progress::new();
    for index in 0..snapshot.roots.len() {
        let archive = freeze(snapshot, index, ctx, &mut progress)?;
        for entry in &archive.entries {
            total = total
                .checked_add(entry.size)
                .context("Archive sizes overflow")?;
        }
        frozen.push(archive);
    }
    snapshot.validate_destination(&LocalFs)?;
    let root = std::fs::canonicalize(&req.destination.path)?;
    let pinned = HashMap::from([(root.clone(), Directory::capture(&root, &root)?)]);
    let mut directories = Directories {
        root,
        pinned,
        created: HashSet::new(),
    };
    let mut directory_metadata = HashMap::new();
    ctx.event.state = "running".into();
    ctx.event.bytes = 0;
    ctx.event.total = total;
    ctx.emit();
    let mut buffer = vec![0; 256 * 1024];
    let mut progress = Progress::new();
    for Frozen { mut zip, entries } in frozen {
        for entry in entries {
            ctx.check()?;
            let parent =
                directories.ensure(entry.path.parent().unwrap_or(Path::new("")), snapshot, ctx)?;
            if entry.directory {
                let path = directories.ensure(&entry.path, snapshot, ctx)?;
                if directories.created.contains(&path) {
                    directory_metadata.insert(path, entry.metadata);
                }
                continue;
            }
            let full = directories.root.join(&entry.path);
            let Some(target) = choose_target(&LocalFs, &full.to_string_lossy(), ctx)? else {
                continue;
            };
            inputs.protect(&target)?;
            directories.validate(&parent, snapshot)?;
            let expected = transfer::target_stamp(&LocalFs, &target, ctx)?;
            let temp = parent.join(format!(".supercommander-{}.part", uuid::Uuid::new_v4()));
            let mut owned = false;
            let result = (|| -> Result<()> {
                let mut input = zip.by_index(entry.index)?;
                let mut output = private_file(&temp)?;
                owned = true;
                let mut bytes = 0u64;
                loop {
                    ctx.check()?;
                    let n = input.read(&mut buffer)?;
                    if n == 0 {
                        break;
                    }
                    bytes += n as u64;
                    anyhow::ensure!(
                        bytes <= entry.size,
                        "Archive entry exceeds its declared size"
                    );
                    output.write_all(&buffer[..n])?;
                    progress.advance(ctx, n as u64, &entry.path.to_string_lossy());
                }
                anyhow::ensure!(
                    bytes == entry.size,
                    "Archive entry is shorter than its declared size"
                );
                output.sync_all()?;
                drop(output);
                LocalFs.transfer_metadata(
                    &temp.to_string_lossy(),
                    &entry
                        .metadata
                        .properties(LocalFs.stat(&temp.to_string_lossy())?),
                )?;
                transfer::commit(
                    &LocalFs,
                    &temp.to_string_lossy(),
                    &target,
                    expected.as_ref(),
                    ctx,
                    || {
                        ctx.check()?;
                        directories.validate(&parent, snapshot)?;
                        inputs.protect(&target)
                    },
                )
            })();
            finish_temp(result, owned, &temp)?;
        }
        ctx.event.completed += 1;
    }
    let mut metadata: Vec<_> = directory_metadata.into_iter().collect();
    metadata.sort_by_key(|(path, _)| std::cmp::Reverse(path.components().count()));
    for (path, metadata) in metadata {
        ctx.check()?;
        directories.validate(&path, snapshot)?;
        LocalFs.transfer_metadata(
            &path.to_string_lossy(),
            &metadata.properties(LocalFs.stat(&path.to_string_lossy())?),
        )?;
    }
    Ok(())
}
