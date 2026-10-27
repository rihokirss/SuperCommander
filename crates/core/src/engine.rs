use crate::{
    filesystem::{guard_destructive, FileSystem, LocalFs, Sources},
    Conflict, JobEvent, JobRequest, Operation,
};
use anyhow::{bail, Context, Result};
use std::{
    collections::HashMap,
    io::{Read, Write},
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Condvar, Mutex,
    },
    time::Duration,
};

pub type Sink = Arc<dyn Fn(JobEvent) + Send + Sync>;
struct Control {
    cancel: AtomicBool,
    answer: Mutex<Option<(Conflict, bool)>>,
    ready: Condvar,
}
impl Default for Control {
    fn default() -> Self {
        Self {
            cancel: AtomicBool::new(false),
            answer: Mutex::new(None),
            ready: Condvar::new(),
        }
    }
}
pub struct Engine {
    queue: mpsc::Sender<(JobRequest, Arc<Control>)>,
    controls: Arc<Mutex<HashMap<String, Arc<Control>>>>,
}

impl Engine {
    pub fn new(sources: Arc<Sources>, sink: Sink) -> Self {
        let (tx, rx) = mpsc::channel::<(JobRequest, Arc<Control>)>();
        let controls: Arc<Mutex<HashMap<String, Arc<Control>>>> = Arc::default();
        let registry = controls.clone();
        std::thread::spawn(move || {
            for (req, control) in rx {
                let mut context = ContextJob {
                    event: JobEvent {
                        id: req.id.clone(),
                        state: "running".into(),
                        current: String::new(),
                        bytes: 0,
                        total: 0,
                        completed: 0,
                        errors: vec![],
                        conflict_path: None,
                    },
                    control,
                    sink: sink.clone(),
                    policy: req.conflict.clone(),
                };
                context.emit();
                let result = run(&sources, &req, &mut context);
                context.event.conflict_path = None;
                context.event.state = if context.control.cancel.load(Ordering::Relaxed) {
                    "cancelled".into()
                } else if let Err(e) = result {
                    context.event.errors.push(format!("{e:#}"));
                    "failed".into()
                } else if !context.event.errors.is_empty() {
                    "failed".into()
                } else {
                    "completed".into()
                };
                context.emit();
                registry.lock().unwrap().remove(&req.id);
            }
        });
        Self {
            queue: tx,
            controls,
        }
    }
    pub fn enqueue(&self, request: JobRequest) -> Result<()> {
        if request.paths.is_empty() {
            bail!("Select at least one file");
        }
        let mut controls = self.controls.lock().unwrap();
        if controls.contains_key(&request.id) {
            bail!("Duplicate job ID");
        }
        let control = Arc::new(Control::default());
        controls.insert(request.id.clone(), control.clone());
        self.queue.send((request, control))?;
        Ok(())
    }
    pub fn cancel(&self, id: &str) {
        if let Some(c) = self.controls.lock().unwrap().get(id) {
            c.cancel.store(true, Ordering::Relaxed);
            c.ready.notify_all();
        }
    }
    pub fn resolve(&self, id: &str, policy: Conflict, all: bool) -> Result<()> {
        if policy == Conflict::Ask {
            bail!("Choose a conflict action");
        }
        let map = self.controls.lock().unwrap();
        let c = map.get(id).context("Job no longer exists")?;
        *c.answer.lock().unwrap() = Some((policy, all));
        c.ready.notify_all();
        Ok(())
    }
}

struct ContextJob {
    event: JobEvent,
    control: Arc<Control>,
    sink: Sink,
    policy: Conflict,
}
impl ContextJob {
    fn emit(&self) {
        (self.sink)(self.event.clone());
    }
    fn check(&self) -> Result<()> {
        if self.control.cancel.load(Ordering::Relaxed) {
            bail!("Cancelled");
        }
        Ok(())
    }
    fn progress(&mut self, n: u64, path: &str) {
        self.event.bytes += n;
        self.event.current = path.into();
        self.emit();
    }
    fn conflict(&mut self, path: &str) -> Result<Conflict> {
        if self.policy != Conflict::Ask {
            return Ok(self.policy.clone());
        }
        self.event.state = "conflict".into();
        self.event.conflict_path = Some(path.into());
        self.emit();
        let mut answer = self.control.answer.lock().unwrap();
        loop {
            self.check()?;
            if let Some((policy, all)) = answer.take() {
                if all {
                    self.policy = policy.clone();
                }
                drop(answer);
                self.event.state = "running".into();
                self.event.conflict_path = None;
                self.emit();
                return Ok(policy);
            }
            answer = self
                .control
                .ready
                .wait_timeout(answer, Duration::from_millis(200))
                .unwrap()
                .0;
        }
    }
}

fn validate_destination(source: &str, destination: &str) -> Result<()> {
    let src = std::fs::canonicalize(source)?;
    let dst = std::fs::canonicalize(destination)?;
    if dst == src || dst.starts_with(&src) {
        bail!("Cannot copy or move a directory into itself");
    }
    Ok(())
}

fn run(sources: &Sources, req: &JobRequest, ctx: &mut ContextJob) -> Result<()> {
    ctx.check()?;
    let source = sources.get(&req.source)?;
    if req.operation == Operation::Zip {
        return zip_job(req, ctx);
    }
    if req.operation == Operation::Extract {
        return extract_job(req, ctx);
    }
    let dest = sources.get(&req.destination.source)?;
    if matches!(req.operation, Operation::Copy | Operation::Move) && !dest.writable() {
        bail!("Destination is read-only");
    }
    if matches!(
        req.operation,
        Operation::Delete | Operation::Trash | Operation::Move
    ) && !source.writable()
    {
        bail!("Source is read-only");
    }
    if req.operation == Operation::Trash && req.source != "local" {
        bail!("Remote files do not have a recycle bin");
    }
    for path in &req.paths {
        if req.source == "local" {
            guard_destructive(path)?;
        }
        if path == "/" || path.trim_matches('/').is_empty() {
            bail!("Cannot operate on a filesystem root");
        }
        if matches!(req.operation, Operation::Copy | Operation::Move)
            && req.source == "local"
            && req.destination.source == "local"
        {
            validate_destination(path, &req.destination.path)?;
        }
        if matches!(req.operation, Operation::Copy | Operation::Move)
            && req.source == req.destination.source
            && req.source != "local"
        {
            let canonical_source = source.canonical_path(path)?;
            let canonical_destination = dest.canonical_path(&req.destination.path)?;
            let root = canonical_source.trim_end_matches('/');
            let target = canonical_destination.trim_end_matches('/');
            if target == root || target.starts_with(&format!("{root}/")) {
                bail!("Cannot copy or move a directory into itself");
            }
        }
    }
    if matches!(req.operation, Operation::Copy | Operation::Move) {
        for path in &req.paths {
            ctx.event.total += measure(source.as_ref(), path, ctx)?;
        }
    }
    for path in &req.paths {
        ctx.check()?;
        ctx.event.current = path.clone();
        ctx.emit();
        let result = match req.operation {
            Operation::Trash => trash::delete(path).map_err(anyhow::Error::from),
            Operation::Delete => source.remove(path),
            Operation::Copy | Operation::Move => {
                let entry = source.stat(path)?;
                crate::filesystem::valid_name(&entry.name)?;
                let mut target = dest.join(&req.destination.path, &entry.name);
                let same = req.source == req.destination.source
                    && (path == &target
                        || dest.exists(&target)?
                            && if req.source == "local" {
                                same_file::is_same_file(path, &target)?
                            } else {
                                source.canonical_path(path)? == dest.canonical_path(&target)?
                            });
                if same && !(req.operation == Operation::Copy && req.conflict == Conflict::KeepBoth)
                {
                    bail!("Source and destination are the same");
                }
                if same
                    || entry.is_dir && req.conflict == Conflict::KeepBoth && dest.exists(&target)?
                {
                    target = choose_target(dest.as_ref(), &target, ctx)?
                        .context("No available copy destination")?;
                }
                match copy_tree(source.as_ref(), dest.as_ref(), path, &target, ctx) {
                    Ok(true) if req.operation == Operation::Move => {
                        ctx.check()?;
                        source.remove(path)
                    }
                    Ok(_) => Ok(()),
                    Err(e) => Err(e),
                }
            }
            _ => unreachable!(),
        };
        match result {
            Ok(()) => ctx.event.completed += 1,
            Err(e) => {
                ctx.check()?;
                ctx.event.errors.push(format!("{path}: {e:#}"));
            }
        }
        ctx.emit();
    }
    Ok(())
}

fn measure(fs: &dyn FileSystem, path: &str, ctx: &ContextJob) -> Result<u64> {
    ctx.check()?;
    let entry = fs.stat(path)?;
    if entry.is_symlink {
        bail!("Symbolic links are not followed: {path}");
    }
    if !entry.is_dir {
        return Ok(entry.size);
    }
    let mut total = 0;
    for e in fs.list(path)? {
        total += measure(fs, &e.path, ctx)?;
    }
    Ok(total)
}

fn choose_target(fs: &dyn FileSystem, path: &str, ctx: &mut ContextJob) -> Result<Option<String>> {
    if !fs.exists(path)? {
        return Ok(Some(path.into()));
    }
    match ctx.conflict(path)? {
        Conflict::Skip => Ok(None),
        Conflict::Replace => Ok(Some(path.into())),
        Conflict::KeepBoth => {
            let parent = crate::rename::parent(path);
            let name = fs.stat(path)?.name;
            let (stem, ext) = if fs.stat(path)?.is_dir {
                (name.as_str(), String::new())
            } else {
                name.rsplit_once('.')
                    .map(|(s, e)| (s, format!(".{e}")))
                    .unwrap_or((&name, String::new()))
            };
            for n in 1..100_000 {
                let p = fs.join(&parent, &format!("{stem} ({n}){ext}"));
                if !fs.exists(&p)? {
                    return Ok(Some(p));
                }
            }
            bail!("Unable to find an available filename")
        }
        Conflict::Ask => unreachable!(),
    }
}

fn copy_tree(
    src: &dyn FileSystem,
    dst: &dyn FileSystem,
    path: &str,
    target: &str,
    ctx: &mut ContextJob,
) -> Result<bool> {
    ctx.check()?;
    let entry = src.stat(path)?;
    if entry.is_symlink {
        bail!("Symbolic links are not followed");
    }
    if entry.is_dir {
        let target = if dst.exists(target)? {
            if dst.stat(target)?.is_dir {
                target.into()
            } else {
                choose_target(dst, target, ctx)?
                    .context("Cannot merge a folder into a skipped file")?
            }
        } else {
            target.into()
        };
        if !dst.exists(&target)? {
            dst.mkdir(&target)?;
        }
        if !dst.stat(&target)?.is_dir || dst.stat(&target)?.is_symlink {
            bail!("Destination is not a regular directory");
        }
        let mut all = true;
        for child in src.list(path)? {
            crate::filesystem::valid_name(&child.name)?;
            all &= copy_tree(src, dst, &child.path, &dst.join(&target, &child.name), ctx)?;
        }
        return Ok(all);
    }
    let Some(target) = choose_target(dst, target, ctx)? else {
        return Ok(false);
    };
    let temp = dst.join(
        &crate::rename::parent(&target),
        &format!(".supercommander-{}.part", uuid::Uuid::new_v4()),
    );
    let result = (|| -> Result<()> {
        let mut reader = src.reader(path)?;
        let mut writer = dst.writer(&temp)?;
        let mut bytes = vec![0; 256 * 1024];
        let mut written = 0;
        loop {
            ctx.check()?;
            let n = reader.read(&mut bytes)?;
            if n == 0 {
                break;
            }
            writer.write_all(&bytes[..n])?;
            written += n as u64;
            ctx.progress(n as u64, path);
        }
        writer.flush()?;
        drop(writer);
        let after = src.stat(path)?;
        if written != entry.size || after.size != entry.size || after.modified != entry.modified {
            bail!("Source changed during copy; source preserved");
        }
        ctx.check()?;
        commit(dst, &temp, &target)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = dst.remove(&temp);
    }
    result?;
    Ok(true)
}

fn commit(fs: &dyn FileSystem, temp: &str, target: &str) -> Result<()> {
    if !fs.exists(target)? {
        return fs.rename(temp, target);
    }
    if fs.stat(target)?.is_dir {
        bail!("Cannot replace a directory with a file");
    }
    let backup = fs.join(
        &crate::rename::parent(target),
        &format!(".supercommander-{}.backup", uuid::Uuid::new_v4()),
    );
    fs.rename(target, &backup)?;
    if let Err(e) = fs.rename(temp, target) {
        if let Err(restore) = fs.rename(&backup, target) {
            bail!("{e}; original is preserved at {backup}; restore failed: {restore}");
        }
        return Err(e);
    }
    fs.remove(&backup)?;
    Ok(())
}

fn zip_job(req: &JobRequest, ctx: &mut ContextJob) -> Result<()> {
    if req.source != "local" || req.destination.source != "local" {
        bail!("ZIP creation currently requires local files");
    }
    let parent = Path::new(&req.destination.path)
        .parent()
        .context("Invalid archive destination")?;
    for path in &req.paths {
        guard_destructive(path)?;
        validate_destination(path, &parent.to_string_lossy())?;
        ctx.event.total += measure(&LocalFs, path, ctx)?;
    }
    let Some(target) = choose_target(&LocalFs, &req.destination.path, ctx)? else {
        return Ok(());
    };
    let temp = parent.join(format!(".supercommander-{}.part", uuid::Uuid::new_v4()));
    let control = ctx.control.clone();
    let result = crate::archive::create_zip(
        &req.paths,
        &temp,
        &|| control.cancel.load(Ordering::Relaxed),
        &mut |n, p| ctx.progress(n, p),
    );
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result?;
    if let Err(e) = ctx.check() {
        let _ = std::fs::remove_file(&temp);
        return Err(e);
    }
    commit(&LocalFs, &temp.to_string_lossy(), &target)?;
    ctx.event.completed = req.paths.len() as u64;
    Ok(())
}

fn extract_job(req: &JobRequest, ctx: &mut ContextJob) -> Result<()> {
    if req.source != "local" || req.destination.source != "local" {
        bail!("Extract requires local ZIP files");
    }
    let root = std::fs::canonicalize(&req.destination.path)?;
    for path in &req.paths {
        let entries = crate::archive::extracted_entries(path)?;
        ctx.event.total += entries.iter().map(|e| e.3).sum::<u64>();
        let mut archive = zip::ZipArchive::new(std::fs::File::open(path)?)?;
        for (index, relative, is_dir, _) in entries {
            ctx.check()?;
            let full = root.join(&relative);
            let mut current = root.clone();
            for component in relative.parent().unwrap_or(Path::new("")).components() {
                current.push(component);
                if current.exists() {
                    if std::fs::symlink_metadata(&current)?
                        .file_type()
                        .is_symlink()
                        || !std::fs::canonicalize(&current)?.starts_with(&root)
                    {
                        bail!("Unsafe extraction path: {}", current.display());
                    }
                } else {
                    std::fs::create_dir(&current)?;
                }
            }
            if is_dir {
                if !full.exists() {
                    std::fs::create_dir(&full)?;
                } else if !full.is_dir()
                    || std::fs::symlink_metadata(&full)?.file_type().is_symlink()
                {
                    bail!("Invalid destination directory");
                }
                continue;
            }
            let Some(target) = choose_target(&LocalFs, &full.to_string_lossy(), ctx)? else {
                continue;
            };
            let temp = full
                .parent()
                .unwrap()
                .join(format!(".supercommander-{}.part", uuid::Uuid::new_v4()));
            let result = (|| -> Result<()> {
                let mut input = archive.by_index(index)?;
                let mut out = std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&temp)?;
                let mut buffer = vec![0; 256 * 1024];
                loop {
                    ctx.check()?;
                    let n = input.read(&mut buffer)?;
                    if n == 0 {
                        break;
                    }
                    out.write_all(&buffer[..n])?;
                    ctx.progress(n as u64, &relative.to_string_lossy());
                }
                out.sync_all()?;
                drop(out);
                ctx.check()?;
                commit(&LocalFs, &temp.to_string_lossy(), &target)
            })();
            if result.is_err() {
                let _ = std::fs::remove_file(&temp);
            }
            result?;
        }
        ctx.event.completed += 1;
    }
    Ok(())
}
