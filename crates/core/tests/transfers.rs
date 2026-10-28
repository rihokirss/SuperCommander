//! Regression tests exercise real local files through independent source IDs.
//! Real OpenSSH and UNC variants are covered by the integration/native suites.
use commander_core::{
    engine::Engine,
    filesystem::{LocalFs, Sources},
    Conflict, JobEvent, JobRequest, Location, Operation,
};
use commander_core::{filesystem::FileSystem, properties::Properties, Entry};
use std::io::{Read, Write};
use std::{
    fs,
    path::Path,
    sync::{mpsc, Arc, Mutex, Weak},
    time::Duration,
};
use tempfile::TempDir;

type RenameHook = dyn Fn(&str, &str) -> anyhow::Result<()> + Send + Sync;
struct HookFs {
    hook: Box<RenameHook>,
    coarse_times: bool,
}
impl FileSystem for HookFs {
    fn list(&self, p: &str) -> anyhow::Result<Vec<Entry>> {
        LocalFs.list(p)
    }
    fn stat(&self, p: &str) -> anyhow::Result<Entry> {
        LocalFs.stat(p)
    }
    fn properties(&self, p: &str) -> anyhow::Result<Properties> {
        let mut props = LocalFs.properties(p)?;
        if self.coarse_times {
            props.stamp.clear();
            props.created = None;
        }
        Ok(props)
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
        (self.hook)(a, b)?;
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
    fn discard_temp(&self, p: &str) -> anyhow::Result<()> {
        LocalFs.discard_temp(p)
    }
    fn transfer_metadata(&self, p: &str, props: &Properties) -> anyhow::Result<()> {
        LocalFs.transfer_metadata(p, props)
    }
    fn join(&self, a: &str, b: &str) -> String {
        LocalFs.join(a, b)
    }
}

fn request(
    operation: Operation,
    source: &str,
    file: &Path,
    destination: &str,
    folder: &Path,
) -> JobRequest {
    JobRequest {
        id: uuid::Uuid::new_v4().to_string(),
        operation,
        source: source.into(),
        paths: vec![file.to_string_lossy().into()],
        destination: Location {
            source: destination.into(),
            path: folder.to_string_lossy().into(),
        },
        conflict: Conflict::Replace,
        source_connection: None,
        destination_connection: None,
        source_bindings: None,
    }
}
fn sources() -> Arc<Sources> {
    let sources = Arc::new(Sources::default());
    sources.insert("other".into(), Arc::new(LocalFs));
    sources
}
fn run(req: JobRequest) -> JobEvent {
    run_with(req, |_| {})
}
fn run_with(req: JobRequest, on_event: impl Fn(&JobEvent) + Send + Sync + 'static) -> JobEvent {
    run_custom(req, sources(), on_event)
}
fn run_custom(
    req: JobRequest,
    sources: Arc<Sources>,
    on_event: impl Fn(&JobEvent) + Send + Sync + 'static,
) -> JobEvent {
    let (tx, rx) = mpsc::channel();
    let engine = Engine::new(
        sources,
        Arc::new(move |event| {
            on_event(&event);
            let _ = tx.send(event);
        }),
    );
    engine.enqueue(req).unwrap();
    loop {
        let event = rx.recv_timeout(Duration::from_secs(10)).unwrap();
        if ["failed", "completed", "cancelled"].contains(&event.state.as_str()) {
            return event;
        }
    }
}
#[test]
fn a_concurrent_destination_is_not_clobbered_and_original_backup_is_reported() {
    let tmp = TempDir::new().unwrap();
    let source = tmp.path().join("file.txt");
    let dest = tmp.path().join("dest");
    fs::create_dir(&dest).unwrap();
    fs::write(&source, "source payload").unwrap();
    fs::write(dest.join("file.txt"), "original destination").unwrap();
    let sources = sources();
    sources.insert(
        "racing".into(),
        Arc::new(HookFs {
            coarse_times: false,
            hook: Box::new(|a, b| {
                if a.ends_with(".part") {
                    fs::write(b, "created after destination validation")?;
                }
                Ok(())
            }),
        }),
    );
    let event = run_custom(
        request(Operation::Move, "other", &source, "racing", &dest),
        sources,
        |_| {},
    );
    assert_eq!(event.state, "failed");
    assert!(event.errors.join(" ").contains("preserved at"));
    assert_eq!(fs::read_to_string(&source).unwrap(), "source payload");
    assert_eq!(
        fs::read_to_string(dest.join("file.txt")).unwrap(),
        "created after destination validation"
    );
    let backups: Vec<_> = fs::read_dir(&dest)
        .unwrap()
        .map(|p| p.unwrap().path())
        .filter(|p| p.extension().is_some_and(|e| e == "backup"))
        .collect();
    assert_eq!(backups.len(), 1);
    assert!(event
        .errors
        .join(" ")
        .contains(backups[0].file_name().unwrap().to_str().unwrap()));
    assert_eq!(
        fs::read_to_string(&backups[0]).unwrap(),
        "original destination"
    );
    let record: serde_json::Value = serde_json::from_slice(
        &fs::read(format!("{}.recovery.json", backups[0].to_string_lossy())).unwrap(),
    )
    .unwrap();
    assert_eq!(record["original"], dest.join("file.txt").to_str().unwrap());
    assert_eq!(record["preserved"], backups[0].to_str().unwrap());
    assert_eq!(fs::read_dir(&dest).unwrap().count(), 3);
    assert_eq!(fs::read_dir(tmp.path()).unwrap().count(), 2);
}
#[test]
fn same_size_same_timestamp_external_edits_are_detected_by_content() {
    let tmp = TempDir::new().unwrap();
    let source = tmp.path().join("file.txt");
    let dest = tmp.path().join("dest");
    fs::create_dir(&dest).unwrap();
    fs::write(&source, "source").unwrap();
    let target = dest.join("file.txt");
    fs::write(&target, "before").unwrap();
    let original_time = fs::metadata(&target).unwrap().modified().unwrap();
    let sources = sources();
    sources.insert(
        "coarse".into(),
        Arc::new(HookFs {
            coarse_times: true,
            hook: Box::new(|_, _| Ok(())),
        }),
    );
    let change = target.clone();
    let event = run_custom(
        request(Operation::Move, "other", &source, "coarse", &dest),
        sources,
        move |event| {
            if event.bytes > 0 && event.state == "running" {
                fs::write(&change, "edited").unwrap();
                fs::OpenOptions::new()
                    .write(true)
                    .open(&change)
                    .unwrap()
                    .set_modified(original_time)
                    .unwrap();
            }
        },
    );
    assert_eq!(event.state, "failed");
    assert_eq!(fs::read_to_string(&source).unwrap(), "source");
    assert_eq!(fs::read_to_string(&target).unwrap(), "edited");
    assert_eq!(fs::read_dir(&dest).unwrap().count(), 1);
    assert_eq!(fs::read_dir(tmp.path()).unwrap().count(), 2);
}
#[test]
fn same_size_same_timestamp_source_edits_are_preserved_before_publication() {
    for operation in [Operation::Copy, Operation::Move] {
        let tmp = TempDir::new().unwrap();
        let source = tmp.path().join("file.txt");
        let dest = tmp.path().join("dest");
        fs::create_dir(&dest).unwrap();
        fs::write(&source, "before").unwrap();
        fs::write(dest.join("file.txt"), "existing destination").unwrap();
        let original_time = fs::metadata(&source).unwrap().modified().unwrap();
        let sources = sources();
        sources.insert(
            "coarse".into(),
            Arc::new(HookFs {
                coarse_times: true,
                hook: Box::new(|_, _| Ok(())),
            }),
        );
        let change = source.clone();
        let event = run_custom(
            request(operation, "coarse", &source, "local", &dest),
            sources,
            move |event| {
                if event.bytes > 0 && event.state == "running" && change.exists() {
                    fs::write(&change, "edited").unwrap();
                    fs::OpenOptions::new()
                        .write(true)
                        .open(&change)
                        .unwrap()
                        .set_modified(original_time)
                        .unwrap();
                }
            },
        );
        assert_eq!(event.state, "failed");
        assert_eq!(fs::read_to_string(&source).unwrap(), "edited");
        assert_eq!(
            fs::read_to_string(dest.join("file.txt")).unwrap(),
            "existing destination"
        );
        assert_eq!(fs::read_dir(&dest).unwrap().count(), 1);
        assert_eq!(fs::read_dir(tmp.path()).unwrap().count(), 2);
    }
}
#[test]
fn skipping_directory_file_conflicts_preserves_the_source_and_other_roots_still_run() {
    let tmp = TempDir::new().unwrap();
    let folder = tmp.path().join("folder");
    let dest = tmp.path().join("dest");
    fs::create_dir(&folder).unwrap();
    fs::create_dir(&dest).unwrap();
    fs::write(folder.join("file.txt"), "source tree").unwrap();
    fs::write(dest.join("folder"), "existing file").unwrap();
    let mut req = request(Operation::Move, "other", &folder, "local", &dest);
    req.conflict = Conflict::Skip;
    let event = run(req);
    assert_eq!(event.state, "completed", "{:?}", event.errors);
    assert_eq!(
        fs::read_to_string(folder.join("file.txt")).unwrap(),
        "source tree"
    );
    assert_eq!(
        fs::read_to_string(dest.join("folder")).unwrap(),
        "existing file"
    );
    let second = dest.join("independent.txt");
    fs::write(&second, "independent root").unwrap();
    let mut req = request(Operation::Move, "other", &folder, "local", tmp.path());
    req.paths.push(second.to_string_lossy().into());
    let event = run(req);
    assert_eq!(event.state, "failed");
    assert_eq!(event.completed, 1);
    assert_eq!(
        fs::read_to_string(folder.join("file.txt")).unwrap(),
        "source tree"
    );
    assert_eq!(
        fs::read_to_string(tmp.path().join("independent.txt")).unwrap(),
        "independent root"
    );
    assert!(!second.exists());
}

#[test]
#[ignore = "Explicit large transfer manifest acceptance check"]
fn a_large_transfer_uses_the_disk_manifest_without_recursive_output_enumeration() {
    let tmp = TempDir::new().unwrap();
    let source = tmp.path().join("source");
    let dest = tmp.path().join("dest");
    fs::create_dir(&source).unwrap();
    fs::create_dir(&dest).unwrap();
    for index in 0..100_000 {
        fs::File::create(source.join(format!("{index:06}.txt"))).unwrap();
    }
    let (tx, rx) = mpsc::channel();
    let engine = Engine::new(
        sources(),
        Arc::new(move |e| {
            if ["completed", "failed", "cancelled"].contains(&e.state.as_str()) {
                let _ = tx.send(e);
            }
        }),
    );
    engine
        .enqueue(request(Operation::Copy, "other", &source, "local", &dest))
        .unwrap();
    let event = rx.recv_timeout(Duration::from_secs(180)).unwrap();
    assert_eq!(event.state, "completed", "{:?}", event.errors);
    assert_eq!(fs::read_dir(dest.join("source")).unwrap().count(), 100_000);
    assert_eq!(fs::read_dir(&source).unwrap().count(), 100_000);
}
#[test]
fn cancellation_after_source_claim_restores_it_or_reports_the_preserved_copy() {
    for recreate in [false, true] {
        let tmp = TempDir::new().unwrap();
        let source = tmp.path().join("file.txt");
        let dest = tmp.path().join("dest");
        fs::create_dir(&dest).unwrap();
        fs::write(&source, "original source").unwrap();
        fs::write(dest.join("file.txt"), "original destination").unwrap();
        let holder: Arc<Mutex<Option<Weak<Engine>>>> = Arc::default();
        let cancel = holder.clone();
        let original = source.clone();
        let id = uuid::Uuid::new_v4().to_string();
        let cancel_id = id.clone();
        let sources = sources();
        sources.insert(
            "claim".into(),
            Arc::new(HookFs {
                coarse_times: false,
                hook: Box::new(move |from, to| {
                    if to.ends_with(".move-source") {
                        cancel
                            .lock()
                            .unwrap()
                            .as_ref()
                            .and_then(Weak::upgrade)
                            .unwrap()
                            .cancel(&cancel_id);
                    }
                    if recreate && from.ends_with(".move-source") {
                        fs::write(&original, "new concurrent source")?;
                    }
                    Ok(())
                }),
            }),
        );
        let (tx, rx) = mpsc::channel();
        let engine = Arc::new(Engine::new(
            sources,
            Arc::new(move |e| {
                let _ = tx.send(e);
            }),
        ));
        *holder.lock().unwrap() = Some(Arc::downgrade(&engine));
        let mut req = request(Operation::Move, "claim", &source, "local", &dest);
        req.id = id;
        engine.enqueue(req).unwrap();
        let event = loop {
            let event = rx.recv_timeout(Duration::from_secs(10)).unwrap();
            if ["cancelled", "failed", "completed"].contains(&event.state.as_str()) {
                break event;
            }
        };
        assert_eq!(event.state, "cancelled");
        assert_eq!(
            fs::read_to_string(dest.join("file.txt")).unwrap(),
            "original destination"
        );
        assert_eq!(fs::read_dir(&dest).unwrap().count(), 1);
        if recreate {
            assert_eq!(
                fs::read_to_string(&source).unwrap(),
                "new concurrent source"
            );
            let claimed: Vec<_> = fs::read_dir(tmp.path())
                .unwrap()
                .map(|e| e.unwrap().path())
                .filter(|p| p.extension().is_some_and(|e| e == "move-source"))
                .collect();
            assert_eq!(claimed.len(), 1);
            assert_eq!(fs::read_to_string(&claimed[0]).unwrap(), "original source");
            assert!(event
                .errors
                .join(" ")
                .contains(claimed[0].file_name().unwrap().to_str().unwrap()));
        } else {
            assert_eq!(fs::read_to_string(&source).unwrap(), "original source");
            assert_eq!(fs::read_dir(tmp.path()).unwrap().count(), 2);
        }
    }
}
#[test]
fn copies_preserve_file_and_new_directory_timestamps_and_supported_attributes() {
    let tmp = TempDir::new().unwrap();
    let source = tmp.path().join("folder");
    let dest = tmp.path().join("dest");
    fs::create_dir(&source).unwrap();
    fs::create_dir(&dest).unwrap();
    let file = source.join("file.txt");
    fs::write(&file, "payload").unwrap();
    let timestamp = std::time::UNIX_EPOCH + Duration::new(1_700_000_000, 123_456_700);
    fs::OpenOptions::new()
        .write(true)
        .open(&file)
        .unwrap()
        .set_modified(timestamp)
        .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&file, fs::Permissions::from_mode(0o640)).unwrap();
    }
    let before = fs::metadata(&file).unwrap().modified().unwrap();
    let folder_time = fs::metadata(&source).unwrap().modified().unwrap();
    let event = run(request(Operation::Copy, "other", &source, "local", &dest));
    assert_eq!(event.state, "completed", "{:?}", event.errors);
    assert_eq!(
        fs::metadata(dest.join("folder/file.txt"))
            .unwrap()
            .modified()
            .unwrap(),
        before
    );
    assert_eq!(
        fs::metadata(dest.join("folder"))
            .unwrap()
            .modified()
            .unwrap(),
        folder_time
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(dest.join("folder/file.txt"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o640
        );
    }
}
#[test]
fn interrupted_move_child() {
    let Some(root) = std::env::var_os("SC_TRANSFER_CRASH_ROOT") else {
        return;
    };
    let root = std::path::PathBuf::from(root);
    let directory = std::env::var("SC_TRANSFER_CRASH_KIND").unwrap() == "directory";
    let source = root.join(if directory { "folder" } else { "file.txt" });
    let sources = sources();
    sources.insert(
        "crash".into(),
        Arc::new(HookFs {
            coarse_times: false,
            hook: Box::new(move |from, to| {
                if to.ends_with(if directory {
                    ".check-directory"
                } else {
                    ".move-source"
                }) {
                    let record: serde_json::Value =
                        serde_json::from_slice(&fs::read(format!("{to}.recovery.json"))?)?;
                    assert_eq!(record["original"], from);
                    assert_eq!(record["preserved"], to);
                    LocalFs.rename_new(from, to)?;
                    std::process::exit(73);
                }
                Ok(())
            }),
        }),
    );
    run_custom(
        request(
            Operation::Move,
            "crash",
            &source,
            "local",
            &root.join("dest"),
        ),
        sources,
        |_| {},
    );
    panic!("Expected the simulated process interruption");
}
#[test]
fn cancellation_before_enqueue_is_not_lost_and_never_touches_files() {
    let tmp = TempDir::new().unwrap();
    let file = tmp.path().join("file.txt");
    let dest = tmp.path().join("dest");
    fs::create_dir(&dest).unwrap();
    fs::write(&file, "source preserved").unwrap();
    fs::write(dest.join("file.txt"), "destination preserved").unwrap();
    let (tx, rx) = mpsc::channel();
    let engine = Engine::new(
        sources(),
        Arc::new(move |e| {
            let _ = tx.send(e);
        }),
    );
    for operation in [Operation::Copy, Operation::Move, Operation::Delete] {
        let req = request(operation, "other", &file, "local", &dest);
        engine.cancel(&req.id);
        engine.enqueue(req).unwrap();
        loop {
            let event = rx.recv_timeout(Duration::from_secs(10)).unwrap();
            if ["completed", "failed", "cancelled"].contains(&event.state.as_str()) {
                assert_eq!(event.state, "cancelled");
                break;
            }
        }
        assert_eq!(fs::read_to_string(&file).unwrap(), "source preserved");
        assert_eq!(
            fs::read_to_string(dest.join("file.txt")).unwrap(),
            "destination preserved"
        );
    }
}
#[cfg(unix)]
#[test]
fn staging_files_are_private_before_any_payload_is_written() {
    use std::os::unix::fs::PermissionsExt;
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("staging.part");
    let mut writer = LocalFs.private_writer(path.to_str().unwrap()).unwrap();
    assert_eq!(
        fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    writer.write_all(b"private payload").unwrap();
    writer.flush().unwrap();
    assert_eq!(
        fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
}
#[test]
fn interrupted_claims_keep_original_names_and_can_be_recovered_after_process_exit() {
    for kind in ["file", "directory"] {
        let tmp = TempDir::new().unwrap();
        let dest = tmp.path().join("dest");
        fs::create_dir(&dest).unwrap();
        let source = tmp
            .path()
            .join(if kind == "file" { "file.txt" } else { "folder" });
        let payload = if kind == "file" {
            source.clone()
        } else {
            fs::create_dir(&source).unwrap();
            source.join("payload.txt")
        };
        fs::write(&payload, "must survive a process exit").unwrap();
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "interrupted_move_child", "--nocapture"])
            .env("SC_TRANSFER_CRASH_ROOT", tmp.path())
            .env("SC_TRANSFER_CRASH_KIND", kind)
            .output()
            .unwrap();
        assert_eq!(
            output.status.code(),
            Some(73),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(!source.exists());
        let journals: Vec<_> = fs::read_dir(tmp.path())
            .unwrap()
            .map(|e| e.unwrap().path())
            .filter(|p| p.to_string_lossy().ends_with(".recovery.json"))
            .collect();
        assert_eq!(journals.len(), 1);
        let record: serde_json::Value =
            serde_json::from_slice(&fs::read(&journals[0]).unwrap()).unwrap();
        assert_eq!(record["original"], source.to_str().unwrap());
        let preserved = std::path::PathBuf::from(record["preserved"].as_str().unwrap());
        let preserved_payload = if kind == "file" {
            preserved.clone()
        } else {
            preserved.join("payload.txt")
        };
        assert_eq!(
            fs::read_to_string(preserved_payload).unwrap(),
            "must survive a process exit"
        );
        LocalFs
            .rename_new(preserved.to_str().unwrap(), source.to_str().unwrap())
            .unwrap();
        fs::remove_file(&journals[0]).unwrap();
        assert_eq!(
            fs::read_to_string(&payload).unwrap(),
            "must survive a process exit"
        );
    }
}
#[test]
fn copy_and_move_onto_a_physical_alias_preserve_the_original_in_both_directions() {
    let tmp = TempDir::new().unwrap();
    let file = tmp.path().join("Õunad.txt");
    for (source, destination) in [("local", "other"), ("other", "local")] {
        for operation in [Operation::Copy, Operation::Move] {
            fs::write(&file, "must survive").unwrap();
            let event = run(request(operation, source, &file, destination, tmp.path()));
            assert_eq!(event.state, "failed", "{:?}", event.errors);
            assert_eq!(fs::read_to_string(&file).unwrap(), "must survive");
            assert_eq!(
                fs::read_dir(tmp.path()).unwrap().count(),
                1,
                "No abandoned staging files"
            );
        }
    }
}
#[test]
fn moving_populated_or_empty_directory_aliases_or_descendants_fails_before_writing() {
    let tmp = TempDir::new().unwrap();
    let source = tmp.path().join("folder");
    fs::create_dir_all(source.join("child")).unwrap();
    for populated in [false, true] {
        if populated {
            fs::write(source.join("payload.txt"), "preserved").unwrap();
        }
        for destination in [tmp.path(), source.as_path(), source.join("child").as_path()] {
            let event = run(request(
                Operation::Move,
                "other",
                &source,
                "local",
                destination,
            ));
            assert_eq!(event.state, "failed", "{:?}", event.errors);
            assert!(source.join("child").is_dir());
            if populated {
                assert_eq!(
                    fs::read_to_string(source.join("payload.txt")).unwrap(),
                    "preserved"
                );
            }
            assert_eq!(fs::read_dir(tmp.path()).unwrap().count(), 1);
            assert_eq!(fs::read_dir(source.join("child")).unwrap().count(), 0);
        }
    }
}
#[test]
fn regular_cross_source_move_finishes_and_late_source_files_are_never_deleted() {
    let tmp = TempDir::new().unwrap();
    let source = tmp.path().join("folder");
    let dest = tmp.path().join("dest");
    fs::create_dir_all(source.join("nested")).unwrap();
    fs::create_dir(&dest).unwrap();
    fs::write(source.join("nested/file.txt"), "payload").unwrap();
    let event = run(request(Operation::Move, "other", &source, "local", &dest));
    assert_eq!(event.state, "completed", "{:?}", event.errors);
    assert!(!source.exists());
    assert_eq!(
        fs::read_to_string(dest.join("folder/nested/file.txt")).unwrap(),
        "payload"
    );
    fs::create_dir(&source).unwrap();
    fs::write(source.join("old.txt"), "known file").unwrap();
    let late = source.join("late.txt");
    let create = late.clone();
    let event = run_with(
        request(Operation::Move, "other", &source, "local", &dest),
        move |event| {
            if event.bytes > 0 {
                fs::write(&create, "created after the manifest").unwrap();
            }
        },
    );
    assert_eq!(event.state, "failed");
    assert_eq!(
        fs::read_to_string(late).unwrap(),
        "created after the manifest"
    );
    assert_eq!(
        fs::read_to_string(dest.join("folder/old.txt")).unwrap(),
        "known file"
    );
}
#[test]
fn cancellation_preserves_source_and_destination_and_leaves_no_staging_files() {
    let tmp = TempDir::new().unwrap();
    let file = tmp.path().join("large.bin");
    let dest = tmp.path().join("dest");
    fs::create_dir(&dest).unwrap();
    fs::write(&file, vec![42; 2 * 1024 * 1024]).unwrap();
    fs::write(dest.join("large.bin"), "original destination").unwrap();
    let holder: Arc<Mutex<Option<Weak<Engine>>>> = Arc::default();
    let cancel = holder.clone();
    let (tx, rx) = mpsc::channel();
    let engine = Arc::new(Engine::new(
        sources(),
        Arc::new(move |event| {
            if event.bytes > 0 {
                cancel
                    .lock()
                    .unwrap()
                    .as_ref()
                    .and_then(Weak::upgrade)
                    .unwrap()
                    .cancel(&event.id);
            }
            let _ = tx.send(event);
        }),
    ));
    *holder.lock().unwrap() = Some(Arc::downgrade(&engine));
    engine
        .enqueue(request(Operation::Move, "other", &file, "local", &dest))
        .unwrap();
    loop {
        let event = rx.recv_timeout(Duration::from_secs(10)).unwrap();
        if ["cancelled", "failed", "completed"].contains(&event.state.as_str()) {
            assert_eq!(event.state, "cancelled");
            break;
        }
    }
    assert_eq!(fs::metadata(&file).unwrap().len(), 2 * 1024 * 1024);
    assert_eq!(
        fs::read_to_string(dest.join("large.bin")).unwrap(),
        "original destination"
    );
    assert_eq!(fs::read_dir(tmp.path()).unwrap().count(), 2);
    assert_eq!(fs::read_dir(dest).unwrap().count(), 1);
}
