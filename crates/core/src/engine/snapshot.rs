//! Disk-backed source versions captured when a job is accepted, before it waits.
use super::ContextJob;
use crate::{filesystem::FileSystem, properties, Entry};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{BufRead, BufReader, BufWriter, Read, Seek, SeekFrom, Write},
    sync::atomic::AtomicBool,
    time::Instant,
};

#[derive(Serialize, Deserialize)]
pub(super) struct Node {
    pub entry: Entry,
    canonical: Option<String>,
    revision: String,
    fingerprint: Option<(String, String)>,
    pub digest: Option<String>,
    children: Option<String>,
    regular: bool,
}
fn children(entries: &[Entry]) -> String {
    let mut names: Vec<_> = entries
        .iter()
        .map(|e| (&e.name, e.is_dir, e.is_symlink))
        .collect();
    names.sort();
    let mut hash = Sha256::new();
    hash.update(serde_json::to_vec(&names).expect("serializable names"));
    hex(&hash.finalize())
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
fn list(fs: &dyn FileSystem, path: &str, ctx: &ContextJob) -> Result<Vec<Entry>> {
    let stop = AtomicBool::new(false);
    let mut entries = Vec::new();
    let mut failure = None;
    fs.visit_entries(path, &stop, &mut |entry| {
        if let Err(error) = ctx.check().and_then(|_| entry.map(|e| entries.push(e))) {
            failure = Some(error);
            stop.store(true, std::sync::atomic::Ordering::Relaxed);
        }
    })?;
    if let Some(error) = failure {
        return Err(error);
    }
    Ok(entries)
}
impl Node {
    pub fn validate(&self, fs: &dyn FileSystem, ctx: &ContextJob, contents: bool) -> Result<()> {
        ctx.check()?;
        let path = &self.entry.path;
        let fingerprint = fs.fingerprint(path)?;
        let fingerprint_matches = match (&self.fingerprint, &fingerprint) {
            (Some((identity, version)), Some((current, current_version))) => {
                identity == current && (self.entry.is_dir || version == current_version)
            }
            (None, None) => true,
            _ => false,
        };
        if !fingerprint_matches
            || !self.entry.is_dir
                && !self.entry.is_symlink
                && fs.regular_file(path)? != self.regular
            || properties::get(fs, path)?.revision != self.revision
            || self
                .canonical
                .as_ref()
                .is_some_and(|expected| fs.canonical_path(path).ok().as_ref() != Some(expected))
        {
            bail!("Source changed after queuing; start the operation again: {path}");
        }
        if contents {
            if let Some(expected) = &self.digest {
                if &crate::comparison::hash(fs, path, &ctx.control.cancel, |_| {})? != expected {
                    bail!("Source contents changed after queuing: {path}");
                }
            }
            if let Some(expected) = &self.children {
                if &children(&list(fs, path, ctx)?) != expected {
                    bail!("Source folder changed after queuing: {path}");
                }
            }
        }
        Ok(())
    }
    pub fn same_object(&self, fs: &dyn FileSystem, path: &str) -> Result<bool> {
        Ok(match (&self.fingerprint, fs.fingerprint(path)?) {
            (Some((id, _)), Some((current, _))) => id == &current,
            (None, None) => true,
            _ => false,
        })
    }
}
pub(super) type Destination = (String, String, Option<String>);
pub(super) struct Snapshot {
    pub input: BufReader<File>,
    pub roots: Vec<u64>,
    pub total: u64,
    pub destination: Option<Destination>,
}
impl Snapshot {
    pub fn capture(fs: &dyn FileSystem, paths: &[String], ctx: &mut ContextJob) -> Result<Self> {
        let mut output = BufWriter::new(tempfile::tempfile()?);
        let mut roots = Vec::new();
        let mut last = Instant::now();
        for path in paths {
            ctx.check()?;
            roots.push(output.stream_position()?);
            capture(fs, path, &mut output, ctx, &mut last, 0)?;
        }
        output.flush()?;
        let file = output.into_inner()?;
        Ok(Self {
            input: BufReader::new(file),
            roots,
            total: ctx.event.total,
            destination: None,
        })
    }
    pub fn ensure_transferable(&mut self) -> Result<()> {
        self.input.seek(SeekFrom::Start(0))?;
        let mut line = String::new();
        loop {
            line.clear();
            if self.input.read_line(&mut line)? == 0 {
                break;
            }
            if let Some(node) = serde_json::from_str::<Option<Node>>(&line)? {
                if node.entry.is_symlink || !node.entry.is_dir && !node.regular {
                    bail!(
                        "Symbolic links and special files cannot be copied: {}",
                        node.entry.path
                    );
                }
                crate::filesystem::valid_name(&node.entry.name)?;
            }
        }
        Ok(())
    }
    pub fn destination(fs: &dyn FileSystem, path: &str) -> Result<Destination> {
        let canonical = fs.canonical_path(path)?;
        if !fs.stat(&canonical)?.is_dir {
            bail!("Choose a destination directory");
        }
        Ok((
            path.into(),
            canonical.clone(),
            fs.fingerprint(&canonical)?.map(|(id, _)| id),
        ))
    }
    pub fn validate_destination(&self, fs: &dyn FileSystem) -> Result<()> {
        if let Some((path, canonical, id)) = &self.destination {
            if fs.canonical_path(path)? != *canonical
                || fs.fingerprint(canonical)?.map(|(id, _)| id) != *id
            {
                bail!("Destination folder changed after queuing; choose it again: {path}");
            }
        }
        Ok(())
    }
    pub fn validate(&mut self, fs: &dyn FileSystem, ctx: &ContextJob) -> Result<()> {
        self.input.seek(SeekFrom::Start(0))?;
        loop {
            let mut line = String::new();
            if self.input.read_line(&mut line)? == 0 {
                break;
            }
            if let Some(node) = serde_json::from_str::<Option<Node>>(&line)? {
                node.validate(fs, ctx, true)?;
            }
        }
        Ok(())
    }
    pub fn validate_root(
        &mut self,
        fs: &dyn FileSystem,
        index: usize,
        ctx: &ContextJob,
    ) -> Result<()> {
        self.input.seek(SeekFrom::Start(self.roots[index]))?;
        let mut line = String::new();
        self.input.read_line(&mut line)?;
        let root: Node =
            serde_json::from_str::<Option<Node>>(&line)?.context("Missing queued root")?;
        root.validate(fs, ctx, true)?;
        let mut depth = usize::from(root.entry.is_dir && !root.entry.is_symlink);
        while depth > 0 {
            line.clear();
            if self.input.read_line(&mut line)? == 0 {
                bail!("Incomplete queued source snapshot");
            }
            if let Some(node) = serde_json::from_str::<Option<Node>>(&line)? {
                node.validate(fs, ctx, true)?;
                depth += usize::from(node.entry.is_dir && !node.entry.is_symlink);
            } else {
                depth -= 1;
            }
        }
        Ok(())
    }
}
fn capture(
    fs: &dyn FileSystem,
    path: &str,
    output: &mut BufWriter<File>,
    ctx: &mut ContextJob,
    last: &mut Instant,
    depth: usize,
) -> Result<()> {
    ctx.check()?;
    if depth > 256 {
        bail!("Directory nesting exceeds 256 levels");
    }
    let fingerprint = fs.fingerprint(path)?;
    let info = properties::get(fs, path)?;
    let entries = if info.file.is_dir && !info.file.is_symlink {
        Some(list(fs, path, ctx)?)
    } else {
        None
    };
    let mut node = Node {
        regular: !info.file.is_dir && !info.file.is_symlink && fs.regular_file(path)?,
        canonical: if info.file.is_symlink {
            None
        } else {
            Some(fs.canonical_path(path)?)
        },
        revision: info.revision,
        fingerprint,
        children: entries.as_ref().map(|v| children(v)),
        entry: info.file,
        digest: None,
    };
    ctx.event.current = path.into();
    if node.regular {
        ctx.event.total = ctx
            .event
            .total
            .checked_add(node.entry.size)
            .context("Transfer size overflow")?;
        {
            let mut reader = fs.reader(path)?;
            let mut hash = Sha256::new();
            let mut bytes = vec![0; 256 * 1024];
            loop {
                ctx.check()?;
                let n = reader.read(&mut bytes)?;
                if n == 0 {
                    break;
                }
                hash.update(&bytes[..n]);
                ctx.event.bytes += n as u64;
                if last.elapsed().as_millis() >= 100 {
                    ctx.emit();
                    *last = Instant::now();
                }
            }
            node.digest = Some(hex(&hash.finalize()));
        }
    }
    node.validate(fs, ctx, false)?;
    serde_json::to_writer(&mut *output, &Some(&node))?;
    output.write_all(b"\n")?;
    if last.elapsed().as_millis() >= 100 {
        ctx.emit();
        *last = Instant::now();
    }
    if let Some(entries) = entries {
        for entry in entries {
            capture(fs, &entry.path, output, ctx, last, depth + 1)?;
        }
        output.write_all(b"null\n")?;
    }
    Ok(())
}
