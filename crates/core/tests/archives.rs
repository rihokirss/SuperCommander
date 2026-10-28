use commander_core::{
    archive,
    engine::Engine,
    filesystem::{FileSystem, LocalFs, Sources},
    Conflict, JobEvent, JobRequest, Location, Operation,
};
use std::{
    fs,
    io::Write,
    path::Path,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc, Arc, Mutex, Weak,
    },
    time::Duration,
};
use tempfile::TempDir;
use zip::{
    write::{FullFileOptions, SimpleFileOptions},
    ZipWriter,
};

fn text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}
fn request(operation: Operation, paths: &[&Path], destination: &Path) -> JobRequest {
    JobRequest {
        id: uuid::Uuid::new_v4().to_string(),
        operation,
        source: "local".into(),
        paths: paths.iter().map(|p| text(p)).collect(),
        destination: Location {
            source: "local".into(),
            path: text(destination),
        },
        conflict: Conflict::Replace,
        source_connection: None,
        destination_connection: None,
        source_bindings: None,
    }
}
fn run(req: JobRequest, hook: impl Fn(&JobEvent) -> bool + Send + Sync + 'static) -> JobEvent {
    run_from(req, Arc::new(Sources::default()), hook)
}
fn run_from(
    req: JobRequest,
    sources: Arc<Sources>,
    hook: impl Fn(&JobEvent) -> bool + Send + Sync + 'static,
) -> JobEvent {
    let (tx, rx) = mpsc::channel();
    let weak = Arc::new(Mutex::new(Weak::<Engine>::new()));
    let owner = weak.clone();
    let engine = Arc::new(Engine::new(
        sources,
        Arc::new(move |event| {
            if hook(&event) {
                if let Some(engine) = owner.lock().unwrap().upgrade() {
                    engine.cancel(&event.id);
                }
            }
            let _ = tx.send(event);
        }),
    ));
    *weak.lock().unwrap() = Arc::downgrade(&engine);
    engine.enqueue(req).unwrap();
    loop {
        let event = rx.recv_timeout(Duration::from_secs(30)).unwrap();
        if ["completed", "failed", "cancelled"].contains(&event.state.as_str()) {
            return event;
        }
    }
}

#[test]
fn a_source_growing_beyond_its_reported_size_is_rejected_during_inspection() {
    struct Growing;
    impl FileSystem for Growing {
        fn list(&self, _: &str) -> anyhow::Result<Vec<commander_core::Entry>> {
            anyhow::bail!("Not a folder")
        }
        fn stat(&self, path: &str) -> anyhow::Result<commander_core::Entry> {
            Ok(commander_core::Entry {
                name: "input".into(),
                path: path.into(),
                is_dir: false,
                is_symlink: false,
                size: 3,
                modified: 1,
                hidden: false,
            })
        }
        fn reader(&self, _: &str) -> anyhow::Result<Box<dyn std::io::Read + Send>> {
            Ok(Box::new(std::io::Cursor::new(
                b"unexpected growth".to_vec(),
            )))
        }
        fn writer(&self, _: &str) -> anyhow::Result<Box<dyn std::io::Write + Send>> {
            anyhow::bail!("Read-only test source")
        }
        fn mkdir(&self, _: &str) -> anyhow::Result<()> {
            anyhow::bail!("Read-only test source")
        }
        fn rename(&self, _: &str, _: &str) -> anyhow::Result<()> {
            anyhow::bail!("Read-only test source")
        }
        fn remove(&self, _: &str) -> anyhow::Result<()> {
            anyhow::bail!("Read-only test source")
        }
        fn join(&self, parent: &str, name: &str) -> String {
            format!("{parent}/{name}")
        }
    }
    let cancel = AtomicBool::new(false);
    let error = commander_core::comparison::hash(&Growing, "/input", &cancel, |_| {}).unwrap_err();
    assert!(error.to_string().contains("size changed"));
    let root = TempDir::new().unwrap();
    let sources = Arc::new(Sources::default());
    sources.insert("growing".into(), Arc::new(Growing));
    let mut req = request(Operation::Copy, &[Path::new("/input")], root.path());
    req.source = "growing".into();
    let event = run_from(req, sources, |_| false);
    assert_eq!(event.state, "failed", "{:?}", event.errors);
    assert!(event.errors.join("\n").contains("Source size changed"));
    assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0);
}
fn zip(path: &Path, entries: &[(&str, &[u8])]) {
    let mut writer = ZipWriter::new(fs::File::create(path).unwrap());
    for (name, bytes) in entries {
        writer
            .start_file(
                *name,
                SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored),
            )
            .unwrap();
        writer.write_all(bytes).unwrap();
    }
    writer.finish().unwrap();
}
fn no_parts(root: &Path) {
    for entry in walkdir::WalkDir::new(root) {
        let entry = entry.unwrap();
        assert!(
            !entry.file_name().to_string_lossy().ends_with(".part"),
            "{}",
            entry.path().display()
        );
    }
}
fn set_time(path: &Path, nanos: u128) {
    let mut properties = LocalFs.properties(&text(path)).unwrap();
    properties.stamp = nanos.to_string();
    LocalFs.transfer_metadata(&text(path), &properties).unwrap();
}

#[test]
fn zip_creation_and_extraction_keep_precise_times_empty_folders_and_permissions() {
    let root = TempDir::new().unwrap();
    let source = root.path().join("source");
    let dest = root.path().join("dest");
    fs::create_dir_all(source.join("empty")).unwrap();
    fs::create_dir(&dest).unwrap();
    fs::write(source.join("file.txt"), "archive payload").unwrap();
    let time = 1_704_164_646_123_456_700u128;
    for path in [&source.join("file.txt"), &source.join("empty"), &source] {
        set_time(path, time);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(source.join("file.txt"), fs::Permissions::from_mode(0o440)).unwrap();
        fs::set_permissions(source.join("empty"), fs::Permissions::from_mode(0o750)).unwrap();
    }
    #[cfg(windows)]
    {
        let mut permissions = fs::metadata(source.join("file.txt")).unwrap().permissions();
        permissions.set_readonly(true);
        fs::set_permissions(source.join("file.txt"), permissions).unwrap();
    }
    let output = root.path().join("created.zip");
    let event = run(request(Operation::Zip, &[&source], &output), |_| false);
    assert_eq!(event.state, "completed", "{:?}", event.errors);
    let view = archive::ZipFs::new(&text(&output)).unwrap();
    assert_eq!(
        view.stat("/source/file.txt").unwrap().modified,
        1_704_164_646
    );
    assert_eq!(
        view.properties("/source/file.txt").unwrap().stamp,
        time.to_string()
    );
    let event = run(request(Operation::Extract, &[&output], &dest), |_| false);
    assert_eq!(event.state, "completed", "{:?}", event.errors);
    assert_eq!(
        fs::read_to_string(dest.join("source/file.txt")).unwrap(),
        "archive payload"
    );
    for path in [
        &dest.join("source/file.txt"),
        &dest.join("source/empty"),
        &dest.join("source"),
    ] {
        assert_eq!(
            LocalFs.properties(&text(path)).unwrap().stamp,
            time.to_string(),
            "{}",
            path.display()
        );
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(dest.join("source/file.txt"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o440
        );
        assert_eq!(
            fs::metadata(dest.join("source/empty"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o750
        );
    }
    #[cfg(windows)]
    {
        assert!(fs::metadata(dest.join("source/file.txt"))
            .unwrap()
            .permissions()
            .readonly());
        for path in [source.join("file.txt"), dest.join("source/file.txt")] {
            let mut p = fs::metadata(&path).unwrap().permissions();
            p.set_readonly(false);
            fs::set_permissions(path, p).unwrap();
        }
    }
    no_parts(root.path());
}

#[test]
fn zip_view_prefers_utc_metadata_and_resolves_dos_local_time_and_implicit_folders() {
    use chrono::{Local, TimeZone};
    let root = TempDir::new().unwrap();
    let path = root.path().join("times.zip");
    let mut writer = ZipWriter::new(fs::File::create(&path).unwrap());
    let dos = zip::DateTime::from_date_and_time(2024, 1, 2, 3, 4, 6).unwrap();
    writer
        .start_file(
            "dos.txt",
            SimpleFileOptions::default().last_modified_time(dos),
        )
        .unwrap();
    writer.write_all(b"dos").unwrap();
    let mut options = FullFileOptions::default().last_modified_time(dos);
    let mut utc = vec![1];
    utc.extend(1_800_000_000u32.to_le_bytes());
    options
        .add_extra_data(0x5455, utc.into_boxed_slice(), false)
        .unwrap();
    writer.start_file("implicit/utc.txt", options).unwrap();
    writer.write_all(b"utc").unwrap();
    writer.finish().unwrap();
    let view = archive::ZipFs::new(&text(&path)).unwrap();
    assert_eq!(
        view.stat("/dos.txt").unwrap().modified,
        Local
            .with_ymd_and_hms(2024, 1, 2, 3, 4, 6)
            .earliest()
            .unwrap()
            .timestamp() as u64
    );
    assert_eq!(
        view.stat("/implicit/utc.txt").unwrap().modified,
        1_800_000_000
    );
    assert_eq!(view.stat("/implicit").unwrap().modified, 1_800_000_000);
    assert!(!view.exists("/missing").unwrap());
    fs::write(path, "corrupted replacement").unwrap();
    assert!(view.exists("/dos.txt").is_err());
}

#[test]
fn replaced_queued_sources_fail_before_archive_or_extraction_output() {
    for operation in [Operation::Zip, Operation::Extract] {
        let root = TempDir::new().unwrap();
        let a = root.path().join("a.zip");
        let b = root.path().join("b.zip");
        zip(&a, &[("a.txt", b"before")]);
        zip(&b, &[("b.txt", b"before")]);
        let destination = root.path().join("output");
        if operation == Operation::Extract {
            fs::create_dir(&destination).unwrap();
        } else {
            fs::write(&destination, "existing destination").unwrap();
        }
        let old_time = fs::metadata(&b).unwrap().modified().unwrap();
        let replace = b.clone();
        let once = AtomicBool::new(false);
        let event = run(
            request(operation.clone(), &[&a, &b], &destination),
            move |event| {
                if event.state == "running" && !once.swap(true, Ordering::Relaxed) {
                    fs::rename(&replace, replace.with_extension("original")).unwrap();
                    zip(&replace, &[("b.txt", b"edited")]);
                    fs::OpenOptions::new()
                        .write(true)
                        .open(&replace)
                        .unwrap()
                        .set_modified(old_time)
                        .unwrap();
                }
                false
            },
        );
        assert_eq!(event.state, "failed", "{:?}", event.errors);
        if operation == Operation::Extract {
            assert_eq!(fs::read_dir(&destination).unwrap().count(), 0);
        } else {
            assert_eq!(
                fs::read_to_string(&destination).unwrap(),
                "existing destination"
            );
        }
        no_parts(root.path());
    }
}

#[test]
fn source_changes_during_compression_do_not_publish_a_mixed_archive() {
    let root = TempDir::new().unwrap();
    let source = root.path().join("large.bin");
    fs::write(&source, vec![b'a'; 1024 * 1024]).unwrap();
    let output = root.path().join("output.zip");
    fs::write(&output, "existing archive").unwrap();
    let replace = source.clone();
    let time = fs::metadata(&source).unwrap().modified().unwrap();
    let once = AtomicBool::new(false);
    let event = run(request(Operation::Zip, &[&source], &output), move |event| {
        if event.state == "running" && event.bytes > 0 && !once.swap(true, Ordering::Relaxed) {
            fs::write(&replace, vec![b'b'; 1024 * 1024]).unwrap();
            fs::OpenOptions::new()
                .write(true)
                .open(&replace)
                .unwrap()
                .set_modified(time)
                .unwrap();
        }
        false
    });
    assert_eq!(event.state, "failed", "{:?}", event.errors);
    assert_eq!(fs::read_to_string(output).unwrap(), "existing archive");
    no_parts(root.path());
}

#[test]
fn growing_sources_stop_at_the_frozen_length_for_zip_copy_and_move() {
    for operation in [Operation::Zip, Operation::Copy, Operation::Move] {
        let root = TempDir::new().unwrap();
        let source = root.path().join("source.bin");
        fs::write(&source, vec![b'a'; 1024 * 1024]).unwrap();
        let destination = root.path().join("output");
        let target = if operation == Operation::Zip {
            destination.clone()
        } else {
            fs::create_dir(&destination).unwrap();
            destination.join("source.bin")
        };
        fs::write(&target, "existing destination").unwrap();
        let change = source.clone();
        let once = AtomicBool::new(false);
        let event = run(request(operation, &[&source], &destination), move |event| {
            if event.state == "running" && event.bytes > 0 && !once.swap(true, Ordering::Relaxed) {
                fs::OpenOptions::new()
                    .append(true)
                    .open(&change)
                    .unwrap()
                    .write_all(&vec![b'b'; 1024 * 1024])
                    .unwrap();
            }
            false
        });
        assert_eq!(event.state, "failed", "{:?}", event.errors);
        assert!(event.bytes <= 1024 * 1024);
        assert_eq!(fs::metadata(source).unwrap().len(), 2 * 1024 * 1024);
        assert_eq!(fs::read_to_string(target).unwrap(), "existing destination");
        no_parts(root.path());
    }
}

#[test]
fn replacing_a_zip_after_freezing_cannot_change_names_or_extracted_contents() {
    let root = TempDir::new().unwrap();
    let source = root.path().join("input.zip");
    zip(
        &source,
        &[
            ("first.txt", b"before first"),
            ("second.txt", b"before second"),
        ],
    );
    let dest = root.path().join("dest");
    fs::create_dir(&dest).unwrap();
    let replace = source.clone();
    let running = AtomicUsize::new(0);
    let event = run(
        request(Operation::Extract, &[&source], &dest),
        move |event| {
            if event.state == "running"
                && event.bytes == 0
                && running.fetch_add(1, Ordering::Relaxed) == 1
            {
                fs::rename(&replace, replace.with_extension("original")).unwrap();
                zip(
                    &replace,
                    &[("renamed.txt", b"edited"), ("../escape.txt", b"escape")],
                );
            }
            false
        },
    );
    assert_eq!(event.state, "completed", "{:?}", event.errors);
    assert_eq!(
        fs::read_to_string(dest.join("first.txt")).unwrap(),
        "before first"
    );
    assert_eq!(
        fs::read_to_string(dest.join("second.txt")).unwrap(),
        "before second"
    );
    assert!(!root.path().join("escape.txt").exists());
    assert!(!dest.join("renamed.txt").exists());
    no_parts(root.path());
}

#[test]
fn malformed_paths_types_and_parent_collisions_are_rejected_before_creating_output() {
    for bad in [
        "../escape.txt",
        "folder/CON.txt",
        "C:/escape",
        "folder\\escape",
    ] {
        let root = TempDir::new().unwrap();
        let source = root.path().join("input.zip");
        zip(&source, &[("good.txt", b"good"), (bad, b"bad")]);
        let dest = root.path().join("dest");
        fs::create_dir(&dest).unwrap();
        assert_eq!(
            run(request(Operation::Extract, &[&source], &dest), |_| false).state,
            "failed"
        );
        assert_eq!(fs::read_dir(dest).unwrap().count(), 0);
    }
    for names in [
        ["parent", "parent/child.txt"],
        ["File.txt", "file.txt"],
        ["Folder/first.txt", "folder/second.txt"],
    ] {
        let root = TempDir::new().unwrap();
        let source = root.path().join("input.zip");
        zip(&source, &[(names[0], b"first"), (names[1], b"second")]);
        let dest = root.path().join("dest");
        fs::create_dir(&dest).unwrap();
        assert_eq!(
            run(request(Operation::Extract, &[&source], &dest), |_| false).state,
            "failed"
        );
        assert_eq!(fs::read_dir(dest).unwrap().count(), 0);
    }
    let root = TempDir::new().unwrap();
    let source = root.path().join("deep.zip");
    let dest = root.path().join("dest");
    fs::create_dir(&dest).unwrap();
    let deep = format!("{}file.txt", "nested/".repeat(257));
    zip(&source, &[("good.txt", b"good"), (&deep, b"too deep")]);
    assert_eq!(
        run(request(Operation::Extract, &[&source], &dest), |_| false).state,
        "failed"
    );
    assert_eq!(fs::read_dir(dest).unwrap().count(), 0);
}

#[test]
fn cancelled_archive_and_extraction_preserve_existing_files_and_clean_temporary_parts() {
    for operation in [Operation::Zip, Operation::Extract] {
        let root = TempDir::new().unwrap();
        let source = root.path().join("input.bin");
        if operation == Operation::Zip {
            fs::write(&source, vec![b'a'; 1024 * 1024]).unwrap();
        } else {
            zip(&source, &[("file.txt", &vec![b'a'; 1024 * 1024])]);
        }
        let destination = root.path().join("output");
        if operation == Operation::Extract {
            fs::create_dir(&destination).unwrap();
            fs::write(destination.join("file.txt"), "old file").unwrap();
        } else {
            fs::write(&destination, "old archive").unwrap();
        }
        let event = run(
            request(operation.clone(), &[&source], &destination),
            |event| event.state == "running" && event.bytes > 0,
        );
        assert_eq!(event.state, "cancelled", "{:?}", event.errors);
        let target = if operation == Operation::Zip {
            destination
        } else {
            destination.join("file.txt")
        };
        assert_eq!(
            fs::read_to_string(target).unwrap(),
            if operation == Operation::Zip {
                "old archive"
            } else {
                "old file"
            }
        );
        no_parts(root.path());
    }
}

#[test]
fn corrupt_payloads_never_replace_an_existing_destination() {
    let root = TempDir::new().unwrap();
    let source = root.path().join("input.zip");
    zip(&source, &[("file.txt", b"unique CRC payload")]);
    let mut bytes = fs::read(&source).unwrap();
    let offset = bytes
        .windows(18)
        .position(|b| b == b"unique CRC payload")
        .unwrap();
    bytes[offset] ^= 1;
    fs::write(&source, bytes).unwrap();
    let dest = root.path().join("dest");
    fs::create_dir(&dest).unwrap();
    fs::write(dest.join("file.txt"), "old contents").unwrap();
    let event = run(request(Operation::Extract, &[&source], &dest), |_| false);
    assert_eq!(event.state, "failed", "{:?}", event.errors);
    assert_eq!(
        fs::read_to_string(dest.join("file.txt")).unwrap(),
        "old contents"
    );
    no_parts(root.path());
}

#[test]
fn selected_sources_and_physical_aliases_are_never_replaced_by_archive_output() {
    let root = TempDir::new().unwrap();
    let source = root.path().join("source.txt");
    fs::write(&source, "original").unwrap();
    assert_eq!(
        run(request(Operation::Zip, &[&source], &source), |_| false).state,
        "failed"
    );
    assert_eq!(fs::read_to_string(&source).unwrap(), "original");
    let alias = root.path().join("alias.zip");
    fs::hard_link(&source, &alias).unwrap();
    assert_eq!(
        run(request(Operation::Zip, &[&source], &alias), |_| false).state,
        "failed"
    );
    assert_eq!(fs::read_to_string(&source).unwrap(), "original");
    let input = root.path().join("input.zip");
    zip(&input, &[("alias-input.zip", b"must not replace input")]);
    let original = fs::read(&input).unwrap();
    fs::hard_link(&input, root.path().join("alias-input.zip")).unwrap();
    let event = run(request(Operation::Extract, &[&input], root.path()), |_| {
        false
    });
    assert_eq!(event.state, "failed", "{:?}", event.errors);
    assert_eq!(fs::read(input).unwrap(), original);
    no_parts(root.path());
}

#[test]
fn many_small_files_do_not_flood_the_ui_with_per_file_hash_and_copy_events() {
    let root = TempDir::new().unwrap();
    let source = root.path().join("source");
    fs::create_dir(&source).unwrap();
    for index in 0..1000 {
        fs::write(source.join(format!("{index:04}.txt")), b"x").unwrap();
    }
    let count = Arc::new(AtomicUsize::new(0));
    let received = count.clone();
    let started = std::time::Instant::now();
    let event = run(
        request(Operation::Zip, &[&source], &root.path().join("output.zip")),
        move |_| {
            received.fetch_add(1, Ordering::Relaxed);
            false
        },
    );
    assert_eq!(event.state, "completed", "{:?}", event.errors);
    let allowance = started.elapsed().as_millis() as usize / 100 + 20;
    assert!(
        count.load(Ordering::Relaxed) <= allowance,
        "{} events in {:?}; expected throttled progress",
        count.load(Ordering::Relaxed),
        started.elapsed()
    );
}

#[test]
fn whole_folders_can_be_copied_from_a_readonly_zip_with_their_metadata() {
    let root = TempDir::new().unwrap();
    let source = root.path().join("input.zip");
    let destination = root.path().join("dest");
    fs::create_dir(&destination).unwrap();
    let mut writer = ZipWriter::new(fs::File::create(&source).unwrap());
    let time = zip::DateTime::from_date_and_time(2024, 1, 2, 3, 4, 6).unwrap();
    let options = SimpleFileOptions::default().last_modified_time(time);
    writer.add_directory("folder/", options).unwrap();
    writer.add_directory("folder/empty/", options).unwrap();
    writer.start_file("folder/file.txt", options).unwrap();
    writer.write_all(b"ZIP folder contents").unwrap();
    writer.finish().unwrap();
    let view = archive::ZipFs::new(&text(&source)).unwrap();
    let modified = view.stat("/folder/file.txt").unwrap().modified;
    let mut req = request(Operation::Copy, &[], &destination);
    req.source = format!("zip:{}", source.display());
    req.paths = vec!["/folder".into()];
    let event = run(req, |_| false);
    assert_eq!(event.state, "completed", "{:?}", event.errors);
    assert_eq!(
        fs::read_to_string(destination.join("folder/file.txt")).unwrap(),
        "ZIP folder contents"
    );
    assert!(destination.join("folder/empty").is_dir());
    assert_eq!(
        LocalFs
            .stat(&text(&destination.join("folder/file.txt")))
            .unwrap()
            .modified,
        modified
    );
    no_parts(root.path());
}

#[test]
fn changed_destination_and_late_source_children_do_not_publish_an_archive() {
    for late_child in [false, true] {
        let root = TempDir::new().unwrap();
        let source = root.path().join("source");
        fs::create_dir(&source).unwrap();
        fs::write(source.join("file.bin"), vec![b'a'; 1024 * 1024]).unwrap();
        let target = root.path().join("output.zip");
        fs::write(&target, "old archive").unwrap();
        let change = if late_child {
            source.join("late.txt")
        } else {
            target.clone()
        };
        let once = AtomicBool::new(false);
        let event = run(request(Operation::Zip, &[&source], &target), move |event| {
            if event.state == "running" && event.bytes > 0 && !once.swap(true, Ordering::Relaxed) {
                fs::write(&change, "new data").unwrap();
            }
            false
        });
        assert_eq!(event.state, "failed", "{:?}", event.errors);
        assert_eq!(
            fs::read_to_string(target).unwrap(),
            if late_child {
                "old archive"
            } else {
                "new data"
            }
        );
        no_parts(root.path());
    }
}

#[test]
fn archive_replacements_retain_previous_versions_and_recovery_records() {
    for operation in [Operation::Zip, Operation::Extract] {
        let root = TempDir::new().unwrap();
        let source = root.path().join("source");
        let destination = root.path().join("output");
        let target = if operation == Operation::Zip {
            fs::write(&source, "new data").unwrap();
            destination.clone()
        } else {
            zip(&source, &[("file.txt", b"new data")]);
            fs::create_dir(&destination).unwrap();
            destination.join("file.txt")
        };
        fs::write(&target, "previous contents").unwrap();
        let event = run(request(operation, &[&source], &destination), |_| false);
        assert_eq!(event.state, "completed", "{:?}", event.errors);
        assert_eq!(event.preserved_count, 1);
        assert_eq!(
            fs::read_to_string(&event.preserved[0].path).unwrap(),
            "previous contents"
        );
        let saved =
            commander_core::recovery::inspect(&LocalFs, &event.preserved[0].record).unwrap();
        assert_eq!(saved.kind, "backup");
        assert!(!saved.active);
        no_parts(root.path());
    }
}

#[test]
fn extraction_does_not_apply_archive_permissions_to_preexisting_directories() {
    let root = TempDir::new().unwrap();
    let source = root.path().join("input.zip");
    let dest = root.path().join("dest");
    fs::create_dir_all(dest.join("existing")).unwrap();
    let mut writer = ZipWriter::new(fs::File::create(&source).unwrap());
    writer
        .add_directory(
            "existing/",
            SimpleFileOptions::default().unix_permissions(0o500),
        )
        .unwrap();
    writer
        .start_file("existing/file.txt", SimpleFileOptions::default())
        .unwrap();
    writer.write_all(b"new data").unwrap();
    writer.finish().unwrap();
    let before = fs::metadata(dest.join("existing")).unwrap().permissions();
    let event = run(request(Operation::Extract, &[&source], &dest), |_| false);
    assert_eq!(event.state, "completed", "{:?}", event.errors);
    assert_eq!(
        fs::metadata(dest.join("existing")).unwrap().permissions(),
        before
    );
}

#[test]
fn archive_symlinks_are_rejected_before_any_destination_is_created() {
    let root = TempDir::new().unwrap();
    let source = root.path().join("input.zip");
    let dest = root.path().join("dest");
    fs::create_dir(&dest).unwrap();
    let mut writer = ZipWriter::new(fs::File::create(&source).unwrap());
    writer
        .start_file("good.txt", SimpleFileOptions::default())
        .unwrap();
    writer.write_all(b"good").unwrap();
    writer
        .add_symlink("folder/link", "../outside", SimpleFileOptions::default())
        .unwrap();
    writer.finish().unwrap();
    let view = archive::ZipFs::new(&text(&source)).unwrap();
    assert!(!view.stat("/folder").unwrap().is_symlink);
    assert!(view.stat("/folder/link").unwrap().is_symlink);
    let event = run(request(Operation::Extract, &[&source], &dest), |_| false);
    assert_eq!(event.state, "failed", "{:?}", event.errors);
    assert_eq!(fs::read_dir(dest).unwrap().count(), 0);
}

#[cfg(unix)]
#[test]
fn temporary_archive_output_is_private_before_publication() {
    use std::os::unix::fs::PermissionsExt;
    for operation in [Operation::Zip, Operation::Extract] {
        let root = TempDir::new().unwrap();
        let source = root.path().join("source");
        let destination = root.path().join("output");
        if operation == Operation::Zip {
            fs::write(&source, vec![b'a'; 1024 * 1024]).unwrap();
        } else {
            zip(&source, &[("file.txt", &vec![b'a'; 1024 * 1024])]);
            fs::create_dir(&destination).unwrap();
        }
        let folder = if operation == Operation::Zip {
            root.path().to_path_buf()
        } else {
            destination.clone()
        };
        let observed = Arc::new(AtomicBool::new(false));
        let check = observed.clone();
        let event = run(request(operation, &[&source], &destination), move |event| {
            if event.state == "running" && event.bytes > 0 {
                for entry in fs::read_dir(&folder).unwrap() {
                    let entry = entry.unwrap();
                    if entry.file_name().to_string_lossy().ends_with(".part") {
                        assert_eq!(
                            entry.metadata().unwrap().permissions().mode() & 0o777,
                            0o600
                        );
                        check.store(true, Ordering::Relaxed);
                    }
                }
            }
            false
        });
        assert_eq!(event.state, "completed", "{:?}", event.errors);
        assert!(observed.load(Ordering::Relaxed));
    }
}

#[test]
#[ignore = "Explicit ZIP64 acceptance: creates a sparse 4 GiB input and extracts 4 GiB of output"]
fn zip64_round_trip_extracts_an_entry_larger_than_four_gibibytes() {
    let root = TempDir::new().unwrap();
    let source = root.path().join("large.bin");
    let archive_path = root.path().join("large.zip");
    let destination = root.path().join("dest");
    fs::File::create(&source)
        .unwrap()
        .set_len(u32::MAX as u64 + 4096)
        .unwrap();
    fs::create_dir(&destination).unwrap();
    eprintln!("ZIP64: creating archive from sparse 4 GiB source");
    let created = run(request(Operation::Zip, &[&source], &archive_path), |_| {
        false
    });
    assert_eq!(created.state, "completed", "{:?}", created.errors);
    let view = archive::ZipFs::new(&text(&archive_path)).unwrap();
    assert_eq!(
        view.stat("/large.bin").unwrap().size,
        u32::MAX as u64 + 4096
    );
    assert!(view.reader("/large.bin").is_err());
    eprintln!("ZIP64: extracting through the bounded streaming reader");
    let extracted = run(
        request(Operation::Extract, &[&archive_path], &destination),
        |_| false,
    );
    assert_eq!(extracted.state, "completed", "{:?}", extracted.errors);
    assert_eq!(
        fs::metadata(destination.join("large.bin")).unwrap().len(),
        u32::MAX as u64 + 4096
    );
    no_parts(root.path());
    eprintln!("ZIP64: round trip complete; temporary files removed on test exit");
}

#[cfg(unix)]
#[test]
fn replacing_an_extraction_parent_during_writing_cannot_publish_through_its_symlink() {
    let root = TempDir::new().unwrap();
    let source = root.path().join("input.zip");
    let dest = root.path().join("dest");
    let outside = root.path().join("outside");
    fs::create_dir_all(dest.join("nested")).unwrap();
    fs::create_dir(&outside).unwrap();
    zip(&source, &[("nested/file.bin", &vec![b'a'; 1024 * 1024])]);
    let change = dest.join("nested");
    let moved = dest.join("moved");
    let target = outside.clone();
    let once = AtomicBool::new(false);
    let event = run(
        request(Operation::Extract, &[&source], &dest),
        move |event| {
            if event.state == "running" && event.bytes > 0 && !once.swap(true, Ordering::Relaxed) {
                fs::rename(&change, &moved).unwrap();
                std::os::unix::fs::symlink(&target, &change).unwrap();
            }
            false
        },
    );
    assert_eq!(event.state, "failed", "{:?}", event.errors);
    assert_eq!(fs::read_dir(outside).unwrap().count(), 0);
    assert!(!dest.join("moved/file.bin").exists());
    assert!(event.errors.join("\n").contains("temporary output"));
    let part = fs::read_dir(dest.join("moved"))
        .unwrap()
        .map(|e| e.unwrap().path())
        .find(|p| p.to_string_lossy().ends_with(".part"))
        .unwrap();
    let saved = commander_core::recovery::inspect(&LocalFs, &text(&part)).unwrap();
    assert_eq!(saved.kind, "part");
}
