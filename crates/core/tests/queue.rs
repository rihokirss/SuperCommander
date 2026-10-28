use commander_core::{
    engine::Engine, filesystem::Sources, Conflict, JobEvent, JobRequest, Location, Operation,
};
use std::{
    fs,
    path::Path,
    sync::{mpsc, Arc},
    time::Duration,
};
use tempfile::TempDir;

fn request(id: &str, operation: Operation, path: &Path, dest: &Path) -> JobRequest {
    JobRequest {
        id: id.into(),
        operation,
        source: "local".into(),
        paths: vec![path.to_string_lossy().into()],
        destination: Location {
            source: "local".into(),
            path: dest.to_string_lossy().into(),
        },
        conflict: Conflict::Replace,
        source_connection: None,
        destination_connection: None,
    }
}
fn wait(rx: &mpsc::Receiver<JobEvent>, id: &str, states: &[&str]) -> JobEvent {
    loop {
        let event = rx.recv_timeout(Duration::from_secs(15)).unwrap();
        if event.id == id && states.contains(&event.state.as_str()) {
            return event;
        }
    }
}
fn blocked(root: &Path) -> (Engine, mpsc::Receiver<JobEvent>, std::path::PathBuf) {
    let dest = root.join("destination");
    fs::create_dir(&dest).unwrap();
    let hold = root.join("hold.txt");
    fs::write(&hold, "new hold data").unwrap();
    fs::write(dest.join("hold.txt"), "old hold data").unwrap();
    let (tx, rx) = mpsc::channel();
    let engine = Engine::new(
        Arc::new(Sources::default()),
        Arc::new(move |e| {
            let _ = tx.send(e);
        }),
    );
    let mut hold = request("hold", Operation::Copy, &hold, &dest);
    hold.conflict = Conflict::Ask;
    engine.enqueue(hold).unwrap();
    wait(&rx, "hold", &["conflict"]);
    (engine, rx, dest)
}
#[test]
fn queued_operations_reject_replaced_source_files_before_touching_them() {
    for operation in [Operation::Move, Operation::Delete, Operation::Copy] {
        let root = TempDir::new().unwrap();
        let (engine, rx, dest) = blocked(root.path());
        let file = root.path().join("selected.txt");
        fs::write(&file, "chosen").unwrap();
        let time = fs::metadata(&file).unwrap().modified().unwrap();
        engine
            .enqueue(request("queued", operation.clone(), &file, &dest))
            .unwrap();
        fs::rename(&file, root.path().join("original.txt")).unwrap();
        fs::write(&file, "edited").unwrap();
        fs::OpenOptions::new()
            .write(true)
            .open(&file)
            .unwrap()
            .set_modified(time)
            .unwrap();
        engine.cancel("hold");
        let event = wait(&rx, "queued", &["completed", "failed", "cancelled"]);
        assert_eq!(event.state, "failed", "{operation:?}: {:?}", event.errors);
        assert_eq!(fs::read_to_string(file).unwrap(), "edited");
        assert_eq!(
            fs::read_to_string(root.path().join("original.txt")).unwrap(),
            "chosen"
        );
        assert!(!dest.join("selected.txt").exists());
    }
}
#[test]
fn queued_directory_deletion_does_not_remove_late_children() {
    let root = TempDir::new().unwrap();
    let (engine, rx, dest) = blocked(root.path());
    let folder = root.path().join("selected");
    fs::create_dir(&folder).unwrap();
    fs::write(folder.join("one.txt"), "original").unwrap();
    engine
        .enqueue(request("queued", Operation::Delete, &folder, &dest))
        .unwrap();
    fs::write(folder.join("late.txt"), "created after confirmation").unwrap();
    engine.cancel("hold");
    let event = wait(&rx, "queued", &["completed", "failed", "cancelled"]);
    assert_eq!(event.state, "failed", "{:?}", event.errors);
    assert_eq!(
        fs::read_to_string(folder.join("late.txt")).unwrap(),
        "created after confirmation"
    );
    assert_eq!(
        fs::read_to_string(folder.join("one.txt")).unwrap(),
        "original"
    );
}

#[cfg(unix)]
#[test]
fn deleting_a_socket_inspects_its_identity_without_trying_to_read_it() {
    let root = TempDir::new().unwrap();
    let file = root.path().join("socket");
    let _socket = std::os::unix::net::UnixListener::bind(&file).unwrap();
    let (tx, rx) = mpsc::channel();
    let engine = Engine::new(
        Arc::new(Sources::default()),
        Arc::new(move |e| {
            let _ = tx.send(e);
        }),
    );
    engine
        .enqueue(request("socket", Operation::Delete, &file, root.path()))
        .unwrap();
    let event = wait(&rx, "socket", &["completed", "failed", "cancelled"]);
    assert_eq!(event.state, "completed", "{:?}", event.errors);
    assert!(!file.exists());
}

#[test]
fn queued_in_place_edits_with_restored_timestamps_are_detected() {
    let root = TempDir::new().unwrap();
    let (engine, rx, dest) = blocked(root.path());
    let file = root.path().join("selected.txt");
    fs::write(&file, "before").unwrap();
    let time = fs::metadata(&file).unwrap().modified().unwrap();
    engine
        .enqueue(request("queued", Operation::Move, &file, &dest))
        .unwrap();
    fs::write(&file, "edited").unwrap();
    fs::OpenOptions::new()
        .write(true)
        .open(&file)
        .unwrap()
        .set_modified(time)
        .unwrap();
    engine.cancel("hold");
    let event = wait(&rx, "queued", &["completed", "failed", "cancelled"]);
    assert_eq!(event.state, "failed", "{:?}", event.errors);
    assert_eq!(fs::read_to_string(file).unwrap(), "edited");
    assert!(!dest.join("selected.txt").exists());
}

#[test]
fn a_replaced_destination_directory_does_not_redirect_a_queued_move() {
    let root = TempDir::new().unwrap();
    let (engine, rx, dest) = blocked(root.path());
    let file = root.path().join("selected.txt");
    fs::write(&file, "payload").unwrap();
    engine
        .enqueue(request("queued", Operation::Move, &file, &dest))
        .unwrap();
    fs::rename(&dest, root.path().join("original-destination")).unwrap();
    fs::create_dir(&dest).unwrap();
    engine.cancel("hold");
    let event = wait(&rx, "queued", &["completed", "failed", "cancelled"]);
    assert_eq!(event.state, "failed", "{:?}", event.errors);
    assert_eq!(fs::read_to_string(file).unwrap(), "payload");
    assert_eq!(fs::read_dir(&dest).unwrap().count(), 0);
}

#[test]
fn a_changed_later_root_rejects_the_whole_selection_before_any_writes() {
    let root = TempDir::new().unwrap();
    let (engine, rx, dest) = blocked(root.path());
    let first = root.path().join("one.txt");
    let second = root.path().join("two.txt");
    fs::write(&first, "first").unwrap();
    fs::write(&second, "second").unwrap();
    let mut req = request("queued", Operation::Move, &first, &dest);
    req.paths.push(second.to_string_lossy().into());
    engine.enqueue(req).unwrap();
    fs::write(&second, "changed second").unwrap();
    engine.cancel("hold");
    let event = wait(&rx, "queued", &["completed", "failed", "cancelled"]);
    assert_eq!(event.state, "failed");
    assert_eq!(fs::read_to_string(first).unwrap(), "first");
    assert!(!dest.join("one.txt").exists());
}

use commander_core::{
    filesystem::{FileSystem, LocalFs},
    properties::Properties,
    Entry,
};
use std::{
    io::{Read, Write},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};
struct Gate {
    entered: mpsc::SyncSender<()>,
    release: Mutex<mpsc::Receiver<()>>,
    used: AtomicBool,
}
struct CoarseFs {
    gate: Option<Gate>,
}
impl FileSystem for CoarseFs {
    fn list(&self, p: &str) -> anyhow::Result<Vec<Entry>> {
        LocalFs.list(p)
    }
    fn stat(&self, p: &str) -> anyhow::Result<Entry> {
        LocalFs.stat(p)
    }
    fn canonical_path(&self, p: &str) -> anyhow::Result<String> {
        LocalFs.canonical_path(p)
    }
    fn properties(&self, p: &str) -> anyhow::Result<Properties> {
        let mut props = LocalFs.properties(p)?;
        props.stamp.clear();
        props.created = None;
        Ok(props)
    }
    fn reader(&self, p: &str) -> anyhow::Result<Box<dyn Read + Send>> {
        if let Some(gate) = &self.gate {
            if !gate.used.swap(true, Ordering::Relaxed) {
                gate.entered.send(())?;
                gate.release.lock().unwrap().recv()?;
            }
        }
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
        LocalFs.rename_new(a, b)
    }
    fn remove(&self, p: &str) -> anyhow::Result<()> {
        LocalFs.remove(p)
    }
    fn remove_file(&self, p: &str) -> anyhow::Result<()> {
        LocalFs.remove_file(p)
    }
    fn remove_empty_dir(&self, p: &str) -> anyhow::Result<()> {
        LocalFs.remove_empty_dir(p)
    }
    fn join(&self, a: &str, b: &str) -> String {
        LocalFs.join(a, b)
    }
}
#[test]
fn coarse_metadata_backends_use_content_to_reject_equal_size_equal_time_edits() {
    let root = TempDir::new().unwrap();
    let dest = root.path().join("dest");
    fs::create_dir(&dest).unwrap();
    let sources = Arc::new(Sources::default());
    sources.insert("coarse".into(), Arc::new(CoarseFs { gate: None }));
    let (tx, rx) = mpsc::channel();
    let engine = Engine::new(
        sources,
        Arc::new(move |e| {
            let _ = tx.send(e);
        }),
    );
    let hold = root.path().join("hold.txt");
    fs::write(&hold, "hold").unwrap();
    fs::write(dest.join("hold.txt"), "old").unwrap();
    let mut req = request("hold", Operation::Copy, &hold, &dest);
    req.conflict = Conflict::Ask;
    engine.enqueue(req).unwrap();
    wait(&rx, "hold", &["conflict"]);
    let file = root.path().join("selected.txt");
    fs::write(&file, "before").unwrap();
    let time = fs::metadata(&file).unwrap().modified().unwrap();
    let mut req = request("queued", Operation::Move, &file, &dest);
    req.source = "coarse".into();
    engine.enqueue(req).unwrap();
    fs::write(&file, "edited").unwrap();
    fs::OpenOptions::new()
        .write(true)
        .open(&file)
        .unwrap()
        .set_modified(time)
        .unwrap();
    engine.cancel("hold");
    let event = wait(&rx, "queued", &["completed", "failed", "cancelled"]);
    assert_eq!(event.state, "failed");
    assert!(event
        .errors
        .join(" ")
        .contains("contents changed after queuing"));
    assert_eq!(fs::read_to_string(file).unwrap(), "edited");
}
#[test]
fn inspection_can_be_cancelled_without_reordering_later_queued_jobs() {
    for (cancel, replaced) in [(false, false), (true, false), (false, true)] {
        let root = TempDir::new().unwrap();
        let dest = root.path().join("dest");
        fs::create_dir(&dest).unwrap();
        let slow = root.path().join("slow.txt");
        let fast = root.path().join("fast.txt");
        fs::write(&slow, "slow data").unwrap();
        fs::write(&fast, "fast data").unwrap();
        let (entered, waiting) = mpsc::sync_channel(1);
        let (release, released) = mpsc::channel();
        let sources = Arc::new(Sources::default());
        sources.insert(
            "slow".into(),
            Arc::new(CoarseFs {
                gate: Some(Gate {
                    entered,
                    release: Mutex::new(released),
                    used: AtomicBool::new(false),
                }),
            }),
        );
        let (tx, rx) = mpsc::channel();
        let engine = Engine::new(
            sources,
            Arc::new(move |e| {
                let _ = tx.send(e);
            }),
        );
        let first = engine.clone();
        let mut req = request("slow", Operation::Copy, &slow, &dest);
        req.source = "slow".into();
        let preparing = std::thread::spawn(move || first.enqueue(req));
        waiting.recv_timeout(Duration::from_secs(5)).unwrap();
        if replaced {
            fs::rename(&dest, root.path().join("original-destination")).unwrap();
            fs::create_dir(&dest).unwrap();
        }
        engine
            .enqueue(request("fast", Operation::Copy, &fast, &dest))
            .unwrap();
        assert!(!dest.join("fast.txt").exists());
        if cancel {
            engine.cancel("slow");
        }
        release.send(()).unwrap();
        preparing.join().unwrap().unwrap();
        let mut states = std::collections::HashMap::new();
        while states.len() < 2 {
            let e = rx.recv_timeout(Duration::from_secs(15)).unwrap();
            if ["completed", "failed", "cancelled"].contains(&e.state.as_str()) {
                states.insert(e.id, e.state);
            }
        }
        assert_eq!(states["fast"], "completed");
        assert_eq!(
            states["slow"],
            if cancel {
                "cancelled"
            } else if replaced {
                "failed"
            } else {
                "completed"
            }
        );
        assert_eq!(dest.join("slow.txt").exists(), !cancel && !replaced);
        assert_eq!(fs::read_to_string(slow).unwrap(), "slow data");
    }
}
