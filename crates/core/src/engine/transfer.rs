use super::{choose_target, ContextJob};
use crate::{filesystem::FileSystem, Entry};
use anyhow::{bail, Context, Result};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{BufRead, BufReader, BufWriter, Read, Seek, SeekFrom, Write},
    sync::atomic::{AtomicBool, Ordering},
};

/// A private, disk-backed preorder manifest. No directory is enumerated after
/// output starts, even when two protocols expose the same underlying tree.
pub(super) struct Plan {
    input: BufReader<File>,
    roots: Vec<u64>,
    cross_source: bool,
}
impl Plan {
    pub fn build(
        fs: &dyn FileSystem,
        paths: &[String],
        ctx: &mut ContextJob,
        cross_source: bool,
    ) -> Result<Self> {
        let mut output = BufWriter::new(tempfile::tempfile()?);
        let mut roots = Vec::new();
        for path in paths {
            roots.push(output.stream_position()?);
            snapshot(fs, path, &mut output, ctx, 0)?;
        }
        output.flush()?;
        let file = output.into_inner()?;
        Ok(Self {
            input: BufReader::new(file),
            roots,
            cross_source,
        })
    }
    pub fn run_root(
        &mut self,
        index: usize,
        src: &dyn FileSystem,
        dst: &dyn FileSystem,
        target: &str,
        moving: bool,
        ctx: &mut ContextJob,
    ) -> Result<bool> {
        self.input.seek(SeekFrom::Start(self.roots[index]))?;
        let entry = next(&mut self.input)?.context("Missing transfer root")?;
        let target = if entry.is_dir && dst.exists(target)? && !dst.stat(target)?.is_dir {
            let Some(chosen) = choose_target(dst, target, ctx)? else {
                return Ok(false);
            };
            if dst.exists(&chosen)? {
                bail!("Cannot replace a file with a directory: {chosen}");
            }
            chosen
        } else {
            target.into()
        };
        if moving && entry.is_dir && self.cross_source {
            validate_move_directory(&mut self.input, src, dst, &entry, &target, ctx)?;
            self.input.seek(SeekFrom::Start(self.roots[index]))?;
            next(&mut self.input)?;
        }
        transfer_tree(&mut self.input, src, dst, entry, &target, moving, ctx)
    }
}
fn snapshot(
    fs: &dyn FileSystem,
    path: &str,
    output: &mut BufWriter<File>,
    ctx: &mut ContextJob,
    depth: usize,
) -> Result<()> {
    ctx.check()?;
    if depth > 256 {
        bail!("Directory nesting exceeds 256 levels; possible filesystem alias cycle");
    }
    let entry = fs.stat(path)?;
    if entry.is_symlink {
        bail!("Symbolic links are not followed: {path}");
    }
    crate::filesystem::valid_name(&entry.name)?;
    serde_json::to_writer(&mut *output, &Some(&entry))?;
    output.write_all(b"\n")?;
    if entry.is_dir {
        let stop = AtomicBool::new(false);
        let mut failure = None;
        fs.visit_entries(path, &stop, &mut |child| {
            if failure.is_some() {
                return;
            }
            if let Err(error) =
                child.and_then(|child| snapshot(fs, &child.path, output, ctx, depth + 1))
            {
                stop.store(true, Ordering::Relaxed);
                failure = Some(error);
            }
        })?;
        if let Some(error) = failure {
            return Err(error);
        }
        output.write_all(b"null\n")?;
    } else {
        ctx.event.total = ctx
            .event
            .total
            .checked_add(entry.size)
            .context("Transfer size overflow")?;
    }
    Ok(())
}
fn next(input: &mut BufReader<File>) -> Result<Option<Entry>> {
    let mut line = String::new();
    if input.read_line(&mut line)? == 0 {
        bail!("Incomplete transfer manifest");
    }
    Ok(serde_json::from_str(&line)?)
}
fn skip(input: &mut BufReader<File>, entry: &Entry, ctx: &ContextJob) -> Result<()> {
    if entry.is_dir {
        while let Some(child) = next(input)? {
            ctx.check()?;
            skip(input, &child, ctx)?;
        }
    }
    Ok(())
}
fn transfer_tree(
    input: &mut BufReader<File>,
    src: &dyn FileSystem,
    dst: &dyn FileSystem,
    entry: Entry,
    target: &str,
    moving: bool,
    ctx: &mut ContextJob,
) -> Result<bool> {
    ctx.check()?;
    if !entry.is_dir {
        return transfer_file(src, dst, &entry, target, moving, ctx);
    }
    let current = src.stat(&entry.path)?;
    if !current.is_dir || current.is_symlink {
        bail!("Source directory changed: {}", entry.path);
    }
    let metadata = src.properties(&entry.path)?;
    let target = if dst.exists(target)? && !dst.stat(target)?.is_dir {
        let Some(target) = choose_target(dst, target, ctx)? else {
            skip(input, &entry, ctx)?;
            return Ok(false);
        };
        // A file cannot be replaced by a directory via an unguarded mkdir.
        if dst.exists(&target)? {
            bail!("Cannot replace a file with a directory: {target}");
        }
        target
    } else {
        target.into()
    };
    let created = !dst.exists(&target)?;
    if created {
        dst.mkdir(&target)?;
    }
    let destination = dst.stat(&target)?;
    if !destination.is_dir || destination.is_symlink {
        bail!("Destination is not a regular directory: {target}");
    }
    let mut all = true;
    while let Some(child) = next(input)? {
        let child_target = dst.join(&target, &child.name);
        all &= transfer_tree(input, src, dst, child, &child_target, moving, ctx)?;
    }
    if moving && all {
        ctx.check()?;
        finish_directory(src, dst, &entry.path, &target)?;
    }
    if created {
        dst.transfer_metadata(&target, &metadata)?;
    }
    Ok(all)
}

/// Compare metadata independent of the private staging name; reads/renames
/// change access times or dot-name visibility without changing the payload.
pub(super) fn stamp(fs: &dyn FileSystem, path: &str) -> Result<String> {
    let mut info = fs.properties(path)?;
    if info.file.is_symlink {
        bail!("Symbolic links cannot be replaced: {path}");
    }
    info.file.path.clear();
    info.file.name.clear();
    info.file.hidden = false;
    info.accessed = None;
    let mut hash = Sha256::new();
    hash.update(serde_json::to_vec(&info)?);
    hash.update(info.stamp.as_bytes());
    Ok(hex(&hash.finalize()))
}
pub(super) struct Revision {
    metadata: String,
    content: String,
}
pub(super) fn target_stamp(
    fs: &dyn FileSystem,
    path: &str,
    ctx: &ContextJob,
) -> Result<Option<Revision>> {
    if !fs.exists(path)? {
        return Ok(None);
    }
    if fs.stat(path)?.is_dir {
        bail!("Cannot replace a directory with a file: {path}");
    }
    if cfg!(windows) && fs.properties(path)?.readonly == Some(true) {
        bail!("Destination is read-only: {path}");
    }
    Ok(Some(Revision {
        metadata: stamp(fs, path)?,
        content: digest(fs, path, ctx)?,
    }))
}
fn private_name(fs: &dyn FileSystem, path: &str, extension: &str) -> String {
    fs.join(
        &crate::rename::parent(path),
        &format!(".supercommander-{}.{extension}", uuid::Uuid::new_v4()),
    )
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
struct Claim<'a> {
    fs: &'a dyn FileSystem,
    original: String,
    preserved: String,
    journal: String,
}
impl<'a> Claim<'a> {
    fn start(fs: &'a dyn FileSystem, path: &str, kind: &str) -> Result<Self> {
        let preserved = private_name(fs, path, kind);
        let journal = format!("{preserved}.recovery.json");
        let mut writer = fs.private_writer(&journal)?;
        let record = serde_json::json!({ "version": 1, "kind": kind, "original": path, "preserved": preserved });
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
        })
    }
    fn restore(&self, error: anyhow::Error) -> anyhow::Error {
        match self.fs.rename_new(&self.preserved, &self.original) {
            Ok(()) => match self.clear() { Ok(()) => error, Err(cleanup) => anyhow::anyhow!("{error:#}; {cleanup:#}") },
            Err(restore) => anyhow::anyhow!("{error:#}; source/original preserved at {}; recovery record {}; restore failed: {restore:#}", self.preserved, self.journal),
        }
    }
    fn clear(&self) -> Result<()> {
        self.fs.remove_file(&self.journal).with_context(|| {
            format!(
                "Operation finalized; unused recovery record remains at {}",
                self.journal
            )
        })
    }
}
fn digest(fs: &dyn FileSystem, path: &str, ctx: &ContextJob) -> Result<String> {
    let mut input = fs.reader(path)?;
    let mut hash = Sha256::new();
    let mut bytes = vec![0; 256 * 1024];
    loop {
        ctx.check()?;
        let n = input.read(&mut bytes)?;
        if n == 0 {
            break;
        }
        hash.update(&bytes[..n]);
    }
    Ok(hex(&hash.finalize()))
}
fn transfer_file(
    src: &dyn FileSystem,
    dst: &dyn FileSystem,
    entry: &Entry,
    target: &str,
    moving: bool,
    ctx: &mut ContextJob,
) -> Result<bool> {
    let Some(target) = choose_target(dst, target, ctx)? else {
        return Ok(false);
    };
    let expected = target_stamp(dst, &target, ctx)?;
    let metadata = src.properties(&entry.path)?;
    if moving && cfg!(windows) && metadata.readonly == Some(true) {
        bail!(
            "Source is read-only; change its attributes before moving: {}",
            entry.path
        );
    }
    let current = src.stat(&entry.path)?;
    if current.is_dir
        || current.is_symlink
        || current.size != entry.size
        || current.modified != entry.modified
    {
        bail!(
            "Source changed since the transfer was planned: {}",
            entry.path
        );
    }
    let original = stamp(src, &entry.path)?;
    let temp = private_name(dst, &target, "part");
    let mut owned_temp = false;
    let result = (|| -> Result<()> {
        let mut reader = src.reader(&entry.path)?;
        let mut writer = dst.private_writer(&temp)?;
        owned_temp = true;
        let mut bytes = vec![0; 256 * 1024];
        let mut hash = Sha256::new();
        let mut written = 0;
        loop {
            ctx.check()?;
            let n = reader.read(&mut bytes)?;
            if n == 0 {
                break;
            }
            writer.write_all(&bytes[..n])?;
            hash.update(&bytes[..n]);
            written += n as u64;
            ctx.progress(n as u64, &entry.path);
        }
        writer.flush()?;
        drop(writer);
        drop(reader);
        dst.transfer_metadata(&temp, &metadata)?;
        if written != entry.size || stamp(src, &entry.path)? != original {
            bail!("Source changed during copy; source preserved");
        }
        ctx.check()?;
        if !moving {
            if digest(src, &entry.path, ctx)? != hex(&hash.finalize()) {
                bail!("Source changed during copy; source preserved");
            }
            return commit(dst, &temp, &target, expected.as_ref(), ctx, || {
                ctx.check()?;
                if stamp(src, &entry.path)? != original {
                    bail!("Source changed or aliases the destination; source preserved");
                }
                Ok(())
            });
        }
        let claim = Claim::start(src, &entry.path, "move-source")?;
        let claimed = &claim.preserved;
        let publish = (|| -> Result<()> {
            if stamp(src, claimed)? != original
                || digest(src, claimed, ctx)? != hex(&hash.finalize())
            {
                bail!("Source changed during move; source preserved");
            }
            commit(dst, &temp, &target, expected.as_ref(), ctx, || {
                ctx.check()?;
                if stamp(src, claimed)? != original {
                    bail!("Source changed during move; source preserved");
                }
                Ok(())
            })
        })();
        if let Err(error) = publish {
            return Err(claim.restore(error));
        }
        // The destination has committed. Finish this leaf even if cancellation
        // arrived now, and NEVER delete the original pathname.
        src.remove_file(claimed).with_context(|| {
            format!(
                "Destination saved; source preserved at {claimed}; recovery record {}",
                claim.journal
            )
        })?;
        claim.clear()?;
        Ok(())
    })();
    if let Err(error) = result {
        if owned_temp {
            match dst.exists(&temp) {
                Ok(true) => {
                    if let Err(cleanup) = dst.discard_temp(&temp) {
                        bail!("{error:#}; incomplete staging file preserved at {temp}; cleanup failed: {cleanup:#}");
                    }
                }
                Ok(false) => {}
                Err(check) => bail!("{error:#}; could not check staging file {temp}: {check:#}"),
            }
        }
        return Err(error);
    }
    Ok(true)
}
fn finish_directory(
    src: &dyn FileSystem,
    dst: &dyn FileSystem,
    path: &str,
    target: &str,
) -> Result<()> {
    if !src.list(path)?.is_empty() {
        bail!("Source directory contains remaining/new files or the destination: {path}");
    }
    let claim = Claim::start(src, path, "move-directory")?;
    let claimed = &claim.preserved;
    let probe = dst.join(
        target,
        &format!(".supercommander-{}.directory-check", uuid::Uuid::new_v4()),
    );
    let mut owned = false;
    let result = (|| -> Result<()> {
        // A real exclusive create is required: a cached stat can report a
        // vanished alias as present. If both paths reach one directory inode,
        // this marker also makes nonrecursive source cleanup fail safely.
        let mut writer = dst.private_writer(&probe)?;
        owned = true;
        writer.flush()?;
        drop(writer);
        src.remove_empty_dir(claimed)
    })();
    let result = if owned {
        match dst.remove_file(&probe) {
            Ok(()) => result,
            Err(error) => Err(anyhow::anyhow!(
                "{}; directory check file preserved at {probe}: {error:#}",
                result
                    .err()
                    .map(|e| format!("{e:#}"))
                    .unwrap_or_else(|| "Source directory cleanup completed".into())
            )),
        }
    } else {
        result
    };
    if let Err(error) = result {
        // If removal succeeded but marker cleanup failed the destination is
        // intact; do not invent a source restoration that no longer exists.
        return if src.exists(claimed).unwrap_or(true) {
            Err(claim.restore(error))
        } else {
            Err(error)
        };
    }
    claim.clear()
}
fn validate_move_directory(
    input: &mut BufReader<File>,
    src: &dyn FileSystem,
    dst: &dyn FileSystem,
    entry: &Entry,
    target: &str,
    ctx: &ContextJob,
) -> Result<()> {
    let path = &entry.path;
    let target_existed = dst.exists(target)?;
    ctx.check()?;
    let claim = Claim::start(src, path, "check-directory")?;
    let claimed = &claim.preserved;
    let name = format!(".supercommander-{}.directory-check", uuid::Uuid::new_v4());
    let probe_parent = if target_existed {
        target.into()
    } else {
        crate::rename::parent(target)
    };
    let probe = dst.join(&probe_parent, &name);
    let mut owned = false;
    let check = (|| -> Result<()> {
        ctx.check()?;
        let mut writer = dst.private_writer(&probe).context(
            "Destination disappeared or cannot be checked while claiming the source directory",
        )?;
        owned = true;
        writer.flush()?;
        drop(writer);
        if find_probe(input, src, claimed, &name, ctx)? {
            bail!(
                "Cannot move a directory onto itself or into its descendant through another source"
            );
        }
        Ok(())
    })();
    let check = if owned {
        match dst.remove_file(&probe) {
            Ok(()) => check,
            Err(error) => Err(anyhow::anyhow!(
                "{}; directory check file preserved at {probe}: {error:#}",
                check
                    .err()
                    .map(|e| format!("{e:#}"))
                    .unwrap_or_else(|| "Directory checked".into())
            )),
        }
    } else {
        check
    };
    if let Err(error) = check {
        return Err(claim.restore(error));
    }
    src.rename_new(claimed, path).with_context(|| {
        format!(
            "Source directory preserved at {claimed}; recovery record {}; could not restore {path}",
            claim.journal
        )
    })?;
    claim.clear()
}
fn find_probe(
    input: &mut BufReader<File>,
    src: &dyn FileSystem,
    directory: &str,
    name: &str,
    ctx: &ContextJob,
) -> Result<bool> {
    ctx.check()?;
    if src.exists(&src.join(directory, name))? {
        return Ok(true);
    }
    while let Some(child) = next(input)? {
        ctx.check()?;
        if child.is_dir && find_probe(input, src, &src.join(directory, &child.name), name, ctx)? {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Publish without clobbering a concurrent writer. Keep the original backup if
/// restoration cannot be completed, and always include its exact recovery path.
pub(super) fn commit(
    fs: &dyn FileSystem,
    temp: &str,
    target: &str,
    expected: Option<&Revision>,
    ctx: &ContextJob,
    validate: impl FnOnce() -> Result<()>,
) -> Result<()> {
    let actual = if fs.exists(target)? {
        Some(stamp(fs, target)?)
    } else {
        None
    };
    if actual.as_deref() != expected.map(|revision| revision.metadata.as_str()) {
        bail!("Destination changed during transfer; source preserved: {target}");
    }
    if expected.is_none() {
        validate()?;
        return fs.rename_new(temp, target);
    }
    let claim = Claim::start(fs, target, "backup")?;
    let backup = &claim.preserved;
    let result = (|| -> Result<()> {
        if stamp(fs, backup)? != expected.unwrap().metadata
            || digest(fs, backup, ctx)? != expected.unwrap().content
        {
            bail!("Destination changed during transfer; original preserved");
        }
        validate()?;
        fs.rename_new(temp, target)
    })();
    if let Err(error) = result {
        return Err(claim.restore(error));
    }
    fs.remove_file(backup).with_context(|| {
        format!(
            "Destination saved; previous file preserved at {backup}; recovery record {}",
            claim.journal
        )
    })?;
    claim.clear()
}
