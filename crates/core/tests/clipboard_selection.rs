use commander_core::{
    clipboard::Files,
    engine::Engine,
    filesystem::{FileSystem, LocalFs, Sources},
    Conflict, Entry, JobEvent, JobRequest, Location, Operation,
};
use std::{
    fs,
    io::{Read, Write},
    path::Path,
    sync::{atomic::AtomicBool, mpsc, Arc},
    time::Duration,
};

struct CoarseFs;
impl FileSystem for CoarseFs {
    fn list(&self, p: &str) -> anyhow::Result<Vec<Entry>> {
        LocalFs.list(p)
    }
    fn stat(&self, p: &str) -> anyhow::Result<Entry> {
        LocalFs.stat(p)
    }
    fn reader(&self, p: &str) -> anyhow::Result<Box<dyn Read + Send>> {
        LocalFs.reader(p)
    }
    fn writer(&self, p: &str) -> anyhow::Result<Box<dyn Write + Send>> {
        LocalFs.writer(p)
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
    fn remove(&self, _: &str) -> anyhow::Result<()> {
        anyhow::bail!("No recursive cleanup")
    }
    fn remove_file(&self, p: &str) -> anyhow::Result<()> {
        LocalFs.remove_file(p)
    }
    fn remove_empty_dir(&self, p: &str) -> anyhow::Result<()> {
        LocalFs.remove_empty_dir(p)
    }
    fn join(&self, p: &str, n: &str) -> String {
        LocalFs.join(p, n)
    }
}
fn capture(backend: &dyn FileSystem, source: &str, paths: &[&Path], cut: bool) -> Files {
    let mut value = Files {
        source: source.into(),
        paths: paths.iter().map(|p| p.to_string_lossy().into()).collect(),
        cut,
        revision: 0,
        connection: None,
        bindings: None,
    };
    value
        .capture_selection(backend, &AtomicBool::new(false), &|_| {})
        .unwrap();
    serde_json::from_slice(&serde_json::to_vec(&value).unwrap()).unwrap()
}
fn paste(value: &Files, target: &Path, backend: Option<Arc<dyn FileSystem>>, expected: &str) {
    let sources = Arc::new(Sources::default());
    if let Some(backend) = backend {
        sources.insert(value.source.clone(), backend);
    }
    let (tx, rx) = mpsc::channel();
    let engine = Engine::new(
        sources,
        Arc::new(move |e| {
            let _ = tx.send(e);
        }),
    );
    let result = engine.enqueue(JobRequest {
        id: "paste".into(),
        operation: if value.cut {
            Operation::Move
        } else {
            Operation::Copy
        },
        source: value.source.clone(),
        paths: value.paths.clone(),
        destination: Location {
            source: "local".into(),
            path: target.to_string_lossy().into(),
        },
        conflict: Conflict::Replace,
        source_connection: value.connection.clone(),
        destination_connection: None,
        source_bindings: value.bindings.clone(),
    });
    result.unwrap();
    loop {
        let e: JobEvent = rx.recv_timeout(Duration::from_secs(10)).unwrap();
        if ["completed", "failed", "cancelled"].contains(&e.state.as_str()) {
            assert_eq!(e.state, expected, "{:?}", e.errors);
            if expected == "failed" {
                assert!(
                    e.errors
                        .iter()
                        .any(|error| error.contains("clipboard source")),
                    "{:?}",
                    e.errors
                );
            }
            break;
        }
    }
}
#[test]
fn native_roots_allow_in_place_edits_but_reject_replacement_before_paste_for_copy_and_cut() {
    for cut in [false, true] {
        let root = tempfile::TempDir::new().unwrap();
        let file = root.path().join("selected.txt");
        let target = root.path().join("Target");
        fs::create_dir(&target).unwrap();
        fs::write(&file, "before").unwrap();
        let value = capture(&LocalFs, "local", &[&file], cut);
        let props = LocalFs.properties(file.to_str().unwrap()).unwrap();
        fs::rename(&file, root.path().join("kept.txt")).unwrap();
        fs::write(&file, "edited").unwrap();
        LocalFs
            .transfer_metadata(file.to_str().unwrap(), &props)
            .unwrap();
        paste(&value, &target, None, "failed");
        assert_eq!(fs::read_to_string(&file).unwrap(), "edited");
        assert_eq!(fs::read_dir(&target).unwrap().count(), 0);
        let fresh = capture(&LocalFs, "local", &[&file], cut);
        fs::write(&file, "in-place edit after selection").unwrap();
        paste(&fresh, &target, None, "completed");
        assert_eq!(
            fs::read_to_string(target.join("selected.txt")).unwrap(),
            "in-place edit after selection"
        );
        assert_eq!(file.exists(), !cut);
    }
}
#[test]
fn native_folder_children_stay_live_but_replacing_the_selected_folder_is_rejected() {
    let root = tempfile::TempDir::new().unwrap();
    let folder = root.path().join("Folder");
    fs::create_dir(&folder).unwrap();
    let target = root.path().join("Target");
    fs::create_dir(&target).unwrap();
    let value = capture(&LocalFs, "local", &[&folder], false);
    fs::write(folder.join("added.txt"), "added before paste").unwrap();
    paste(&value, &target, None, "completed");
    assert_eq!(
        fs::read_to_string(target.join("Folder/added.txt")).unwrap(),
        "added before paste"
    );
    fs::rename(&folder, root.path().join("kept")).unwrap();
    fs::create_dir(&folder).unwrap();
    fs::write(folder.join("foreign.txt"), "keep foreign data").unwrap();
    paste(&value, &target, None, "failed");
    assert!(!target.join("Folder/foreign.txt").exists());
    assert_eq!(
        fs::read_to_string(folder.join("foreign.txt")).unwrap(),
        "keep foreign data"
    );
}
#[test]
fn a_source_without_ids_rejects_equal_size_equal_time_changed_contents() {
    let root = tempfile::TempDir::new().unwrap();
    let file = root.path().join("selected.txt");
    fs::write(&file, "before").unwrap();
    let target = root.path().join("Target");
    fs::create_dir(&target).unwrap();
    let value = capture(&CoarseFs, "coarse", &[&file], true);
    let props = LocalFs.properties(file.to_str().unwrap()).unwrap();
    fs::write(&file, "edited").unwrap();
    LocalFs
        .transfer_metadata(file.to_str().unwrap(), &props)
        .unwrap();
    paste(&value, &target, Some(Arc::new(CoarseFs)), "failed");
    assert_eq!(fs::read_to_string(&file).unwrap(), "edited");
    assert_eq!(fs::read_dir(&target).unwrap().count(), 0);
}
#[test]
fn folder_membership_fallback_catches_a_replacement_with_matching_metadata() {
    let root = tempfile::TempDir::new().unwrap();
    let folder = root.path().join("Folder");
    fs::create_dir(&folder).unwrap();
    fs::write(folder.join("old.txt"), "original").unwrap();
    let target = root.path().join("Target");
    fs::create_dir(&target).unwrap();
    let value = capture(&CoarseFs, "coarse", &[&folder], true);
    let props = LocalFs.properties(folder.to_str().unwrap()).unwrap();
    fs::rename(&folder, root.path().join("Kept")).unwrap();
    fs::create_dir(&folder).unwrap();
    fs::write(folder.join("new.txt"), "new data").unwrap();
    LocalFs
        .transfer_metadata(folder.to_str().unwrap(), &props)
        .unwrap();
    paste(&value, &target, Some(Arc::new(CoarseFs)), "failed");
    assert_eq!(
        fs::read_to_string(folder.join("new.txt")).unwrap(),
        "new data"
    );
    assert_eq!(fs::read_dir(&target).unwrap().count(), 0);
}
#[test]
fn cancelling_capture_never_publishes_a_partial_selection() {
    let root = tempfile::TempDir::new().unwrap();
    let file = root.path().join("selected.txt");
    fs::write(&file, "data").unwrap();
    let mut value = Files {
        source: "local".into(),
        paths: vec![file.to_string_lossy().into()],
        cut: false,
        revision: 0,
        connection: None,
        bindings: None,
    };
    assert!(value
        .capture_selection(&LocalFs, &AtomicBool::new(true), &|_| {})
        .unwrap_err()
        .to_string()
        .contains("Cancelled"));
    assert!(value.bindings.is_none());
    assert_eq!(fs::read_to_string(file).unwrap(), "data");
}
#[test]
fn replacing_a_later_clipboard_root_rejects_the_whole_paste_before_output() {
    let root = tempfile::TempDir::new().unwrap();
    let first = root.path().join("first.txt");
    let second = root.path().join("second.txt");
    fs::write(&first, "first original").unwrap();
    fs::write(&second, "second original").unwrap();
    let target = root.path().join("Target");
    fs::create_dir(&target).unwrap();
    let value = capture(&LocalFs, "local", &[&first, &second], true);
    fs::rename(&second, root.path().join("kept.txt")).unwrap();
    fs::write(&second, "replacement").unwrap();
    paste(&value, &target, None, "failed");
    assert_eq!(fs::read_dir(&target).unwrap().count(), 0);
    assert_eq!(fs::read_to_string(first).unwrap(), "first original");
    assert_eq!(fs::read_to_string(second).unwrap(), "replacement");
}
