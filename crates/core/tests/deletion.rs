use commander_core::{
    engine::Engine,
    filesystem::{FileSystem, LocalFs, Sources},
    properties::Properties,
    Conflict, Entry, JobEvent, JobRequest, Location, Operation,
};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    },
    time::Duration,
};
use tempfile::TempDir;

struct RaceFs {
    root: PathBuf,
    directory: bool,
    changed: AtomicBool,
    coarse: bool,
    late_unlink: bool,
}
impl RaceFs {
    fn replace(&self, path: &str) -> anyhow::Result<()> {
        if !self.late_unlink
            && Path::new(path) == self.root
            && !self.changed.swap(true, Ordering::Relaxed)
        {
            if self.directory {
                fs::write(self.root.join("late.txt"), "not approved for deletion")?;
            } else {
                let time = fs::metadata(&self.root)?.modified()?;
                fs::rename(&self.root, self.root.with_extension("original"))?;
                fs::write(&self.root, "edited")?;
                fs::OpenOptions::new()
                    .write(true)
                    .open(&self.root)?
                    .set_modified(time)?;
            }
        }
        Ok(())
    }
}
impl FileSystem for RaceFs {
    fn list(&self, p: &str) -> anyhow::Result<Vec<Entry>> {
        LocalFs.list(p)
    }
    fn stat(&self, p: &str) -> anyhow::Result<Entry> {
        LocalFs.stat(p)
    }
    fn properties(&self, p: &str) -> anyhow::Result<Properties> {
        let mut value = LocalFs.properties(p)?;
        if self.coarse {
            value.stamp.clear();
            value.created = None;
        }
        Ok(value)
    }
    fn canonical_path(&self, p: &str) -> anyhow::Result<String> {
        LocalFs.canonical_path(p)
    }
    fn fingerprint(&self, p: &str) -> anyhow::Result<Option<(String, String)>> {
        if self.coarse {
            Ok(None)
        } else {
            LocalFs.fingerprint(p)
        }
    }
    fn regular_file(&self, p: &str) -> anyhow::Result<bool> {
        LocalFs.regular_file(p)
    }
    fn reader(&self, p: &str) -> anyhow::Result<Box<dyn Read + Send>> {
        LocalFs.reader(p)
    }
    fn writer(&self, p: &str) -> anyhow::Result<Box<dyn Write + Send>> {
        LocalFs.writer(p)
    }
    fn private_writer(&self, p: &str) -> anyhow::Result<Box<dyn Write + Send>> {
        LocalFs.private_writer(p)
    }
    fn mkdir(&self, p: &str) -> anyhow::Result<()> {
        LocalFs.mkdir(p)
    }
    fn rename(&self, a: &str, b: &str) -> anyhow::Result<()> {
        LocalFs.rename(a, b)
    }
    fn rename_new(&self, a: &str, b: &str) -> anyhow::Result<()> {
        self.replace(a)?;
        LocalFs.rename_new(a, b)
    }
    fn remove(&self, p: &str) -> anyhow::Result<()> {
        self.replace(p)?;
        LocalFs.remove(p)
    }
    fn remove_file(&self, p: &str) -> anyhow::Result<()> {
        LocalFs.remove_file(p)?;
        if self.late_unlink
            && p.ends_with(".delete-source")
            && !self.changed.swap(true, Ordering::Relaxed)
        {
            fs::write(
                Path::new(p).parent().unwrap().join("late.txt"),
                "created after approved deletion",
            )?;
        }
        Ok(())
    }
    fn remove_empty_dir(&self, p: &str) -> anyhow::Result<()> {
        LocalFs.remove_empty_dir(p)
    }
    fn join(&self, a: &str, b: &str) -> String {
        LocalFs.join(a, b)
    }
}
fn run(sources: Arc<Sources>, source: &str, path: &Path, destination: &str) -> JobEvent {
    let (tx, rx) = mpsc::channel();
    let engine = Engine::new(
        sources,
        Arc::new(move |e| {
            let _ = tx.send(e);
        }),
    );
    engine
        .enqueue(JobRequest {
            id: uuid::Uuid::new_v4().to_string(),
            operation: Operation::Delete,
            source: source.into(),
            paths: vec![path.to_string_lossy().into()],
            destination: Location {
                source: destination.into(),
                path: path.parent().unwrap().to_string_lossy().into(),
            },
            conflict: Conflict::Replace,
            source_connection: None,
            destination_connection: None,
            source_bindings: None,
        })
        .unwrap();
    loop {
        let e = rx.recv_timeout(Duration::from_secs(10)).unwrap();
        if ["completed", "failed", "cancelled"].contains(&e.state.as_str()) {
            return e;
        }
    }
}
#[test]
fn a_late_child_at_the_delete_boundary_is_not_recursively_removed() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().join("folder");
    fs::create_dir(&root).unwrap();
    fs::write(root.join("one.txt"), "approved data").unwrap();
    let source = Arc::new(RaceFs {
        root: root.clone(),
        directory: true,
        changed: AtomicBool::new(false),
        coarse: false,
        late_unlink: false,
    });
    let sources = Arc::new(Sources::default());
    sources.insert("race".into(), source.clone());
    let event = run(sources, "race", &root, "local");
    assert!(source.changed.load(Ordering::Relaxed));
    assert_eq!(event.state, "failed", "{:?}", event.errors);
    assert_eq!(
        fs::read_to_string(root.join("late.txt")).unwrap(),
        "not approved for deletion"
    );
    assert_eq!(
        fs::read_to_string(root.join("one.txt")).unwrap(),
        "approved data"
    );
}
#[test]
fn a_replacement_with_matching_metadata_at_the_delete_boundary_is_restored() {
    let tmp = TempDir::new().unwrap();
    let file = tmp.path().join("file.txt");
    fs::write(&file, "before").unwrap();
    let source = Arc::new(RaceFs {
        root: file.clone(),
        directory: false,
        changed: AtomicBool::new(false),
        coarse: true,
        late_unlink: false,
    });
    let sources = Arc::new(Sources::default());
    sources.insert("race".into(), source.clone());
    let event = run(sources, "race", &file, "local");
    assert!(source.changed.load(Ordering::Relaxed));
    assert_eq!(event.state, "failed", "{:?}", event.errors);
    assert_eq!(fs::read_to_string(file).unwrap(), "edited");
    assert_eq!(
        fs::read_to_string(tmp.path().join("file.original")).unwrap(),
        "before"
    );
}
#[test]
fn deletion_does_not_depend_on_the_other_panes_connection() {
    let tmp = TempDir::new().unwrap();
    let file = tmp.path().join("file.txt");
    fs::write(&file, "delete me").unwrap();
    let event = run(
        Arc::new(Sources::default()),
        "local",
        &file,
        "sftp:disconnected",
    );
    assert_eq!(event.state, "completed", "{:?}", event.errors);
    assert!(!file.exists());
}
#[test]
fn a_new_child_after_a_leaf_is_deleted_stops_directory_cleanup_and_restores_remaining_data() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().join("folder");
    fs::create_dir(&root).unwrap();
    fs::write(root.join("approved.txt"), "approved permanent deletion").unwrap();
    let source = Arc::new(RaceFs {
        root: root.clone(),
        directory: true,
        changed: AtomicBool::new(false),
        coarse: false,
        late_unlink: true,
    });
    let sources = Arc::new(Sources::default());
    sources.insert("late".into(), source.clone());
    let event = run(sources, "late", &root, "sftp:disconnected");
    assert_eq!(event.state, "failed", "{:?}", event.errors);
    assert!(source.changed.load(Ordering::Relaxed));
    assert_eq!(
        fs::read_to_string(root.join("late.txt")).unwrap(),
        "created after approved deletion"
    );
    assert!(!root.join("approved.txt").exists());
    assert_eq!(fs::read_dir(tmp.path()).unwrap().count(), 1);
    assert_eq!(fs::read_dir(root).unwrap().count(), 1);
}
