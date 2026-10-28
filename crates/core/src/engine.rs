mod transfer;

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
    cancel: Arc<AtomicBool>,
    _task: Option<crate::tasks::Task>,
    answer: Mutex<Option<(Conflict, bool)>>,
    ready: Condvar,
}
impl Default for Control {
    fn default() -> Self {
        Self {
            cancel: Arc::new(AtomicBool::new(false)),
            _task: None,
            answer: Mutex::new(None),
            ready: Condvar::new(),
        }
    }
}
pub struct Engine {
    queue: mpsc::Sender<QueuedJob>,
    controls: Arc<Mutex<HashMap<String, Arc<Control>>>>,
    sources: Arc<Sources>,
    tasks: crate::tasks::Tasks,
}
struct QueuedJob {
    request: JobRequest,
    control: Arc<Control>,
    sources: Sources,
}

impl Engine {
    pub fn new(sources: Arc<Sources>, sink: Sink) -> Self {
        let (tx, rx) = mpsc::channel::<QueuedJob>();
        let controls: Arc<Mutex<HashMap<String, Arc<Control>>>> = Arc::default();
        let registry = controls.clone();
        std::thread::spawn(move || {
            for QueuedJob {
                request: req,
                control,
                sources,
            } in rx
            {
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
                if let Err(error) = &result {
                    if error.to_string() != "Cancelled" {
                        context.event.errors.push(format!("{error:#}"));
                    }
                }
                context.event.state = if context.control.cancel.load(Ordering::Relaxed) {
                    "cancelled".into()
                } else if result.is_err() || !context.event.errors.is_empty() {
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
            sources,
            tasks: crate::tasks::Tasks::default(),
        }
    }
    pub fn enqueue(&self, request: JobRequest) -> Result<()> {
        if request.paths.is_empty() {
            bail!("Select at least one file");
        }
        let task = self.tasks.start(request.id.clone())?;
        // Bind a queued job to these connections. Resolving profile IDs only when
        // it starts could redirect an old job to a newly connected server.
        let source = self.sources.get(&request.source)?;
        let destination = if request.source == request.destination.source {
            source.clone()
        } else {
            self.sources.get(&request.destination.source)?
        };
        if request
            .source_connection
            .as_deref()
            .is_some_and(|id| Some(id) != source.connection_id())
            || request
                .destination_connection
                .as_deref()
                .is_some_and(|id| Some(id) != destination.connection_id())
        {
            bail!("An SSH connection changed. Start the operation again.");
        }
        let sources = Sources::default();
        sources.insert(request.source.clone(), source);
        sources.insert(request.destination.source.clone(), destination);
        let mut controls = self.controls.lock().unwrap();
        if controls.contains_key(&request.id) {
            bail!("Duplicate job ID");
        }
        let control = Arc::new(Control {
            cancel: task.cancel.clone(),
            _task: Some(task),
            ..Default::default()
        });
        controls.insert(request.id.clone(), control.clone());
        let id = request.id.clone();
        if self
            .queue
            .send(QueuedJob {
                request,
                control,
                sources,
            })
            .is_err()
        {
            controls.remove(&id);
            bail!("The file operation queue has stopped");
        }
        Ok(())
    }
    pub fn cancel(&self, id: &str) {
        self.tasks.cancel(id.into());
        if let Some(c) = self.controls.lock().unwrap().get(id) {
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
    let mut plan = if matches!(req.operation, Operation::Copy | Operation::Move) {
        Some(transfer::Plan::build(
            source.as_ref(),
            &req.paths,
            ctx,
            req.source != req.destination.source,
        )?)
    } else {
        None
    };
    for (index, path) in req.paths.iter().enumerate() {
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
                plan.as_mut()
                    .unwrap()
                    .run_root(
                        index,
                        source.as_ref(),
                        dest.as_ref(),
                        &target,
                        req.operation == Operation::Move,
                        ctx,
                    )
                    .map(|_| ())
            }
            _ => unreachable!(),
        };
        match result {
            Ok(()) => ctx.event.completed += 1,
            Err(e) => {
                if e.to_string() != "Cancelled" {
                    ctx.event.errors.push(format!("{path}: {e:#}"));
                }
                ctx.check()?;
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
    let expected = transfer::target_stamp(&LocalFs, &target, ctx)?;
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
    if let Err(error) = transfer::commit(
        &LocalFs,
        &temp.to_string_lossy(),
        &target,
        expected.as_ref(),
        ctx,
        || ctx.check(),
    ) {
        let _ = std::fs::remove_file(&temp);
        return Err(error);
    }
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
            let expected = transfer::target_stamp(&LocalFs, &target, ctx)?;
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
                transfer::commit(
                    &LocalFs,
                    &temp.to_string_lossy(),
                    &target,
                    expected.as_ref(),
                    ctx,
                    || ctx.check(),
                )
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
