use commander_core::{
    archive,
    engine::Engine,
    filesystem::{self, FileSystem, LocalFs, Sources},
    rename, Conflict, JobEvent, JobRequest, Location, Operation, RenameRules, SearchFilter,
};
use std::{
    fs,
    io::Write,
    sync::{atomic::AtomicBool, mpsc, Arc, Mutex, Weak},
    time::Duration,
};
use tempfile::TempDir;

fn path(p: impl AsRef<std::path::Path>) -> String {
    p.as_ref().to_string_lossy().into_owned()
}
fn request(operation: Operation, source: &std::path::Path, dest: &std::path::Path) -> JobRequest {
    JobRequest {
        id: uuid::Uuid::new_v4().to_string(),
        operation,
        source: "local".into(),
        paths: vec![path(source)],
        destination: Location {
            source: "local".into(),
            path: path(dest),
        },
        conflict: Conflict::Replace,
        source_connection: None,
        destination_connection: None,
    }
}
fn run(req: JobRequest) -> JobEvent {
    let (tx, rx) = mpsc::channel();
    let engine = Engine::new(
        Arc::new(Sources::default()),
        Arc::new(move |e| {
            let _ = tx.send(e);
        }),
    );
    engine.enqueue(req).unwrap();
    loop {
        let e = rx
            .recv_timeout(Duration::from_secs(15))
            .expect("Job timed out");
        if ["completed", "failed", "cancelled"].contains(&e.state.as_str()) {
            return e;
        }
    }
}
#[test]
fn copies_tree_and_unicode_without_removing_source() {
    let tmp = TempDir::new().unwrap();
    let source = tmp.path().join("Õunad");
    let dest = tmp.path().join("destination");
    fs::create_dir_all(source.join("nested")).unwrap();
    fs::create_dir(&dest).unwrap();
    fs::write(source.join("nested/tere.txt"), "Tere, maailm!").unwrap();
    let event = run(request(Operation::Copy, &source, &dest));
    assert_eq!(event.state, "completed", "{:?}", event.errors);
    assert_eq!(
        fs::read_to_string(dest.join("Õunad/nested/tere.txt")).unwrap(),
        "Tere, maailm!"
    );
    assert!(source.exists());
}
#[test]
fn move_removes_source_after_completed_transfer() {
    let tmp = TempDir::new().unwrap();
    let source = tmp.path().join("source.txt");
    let dest = tmp.path().join("dest");
    fs::create_dir(&dest).unwrap();
    fs::write(&source, "payload").unwrap();
    assert_eq!(
        run(request(Operation::Move, &source, &dest)).state,
        "completed"
    );
    assert!(!source.exists());
    assert_eq!(
        fs::read_to_string(dest.join("source.txt")).unwrap(),
        "payload"
    );
}
#[test]
fn copying_into_the_same_folder_with_keep_both_duplicates_files_and_trees() {
    let tmp = TempDir::new().unwrap();
    let file = tmp.path().join("Õun.txt");
    fs::write(&file, "original").unwrap();
    let mut req = request(Operation::Copy, &file, tmp.path());
    req.conflict = Conflict::KeepBoth;
    assert_eq!(run(req).state, "completed");
    assert_eq!(
        fs::read_to_string(tmp.path().join("Õun (1).txt")).unwrap(),
        "original"
    );
    assert_eq!(fs::read_to_string(&file).unwrap(), "original");
    let folder = tmp.path().join("folder");
    fs::create_dir(&folder).unwrap();
    fs::write(folder.join("nested.txt"), "tree").unwrap();
    let mut req = request(Operation::Copy, &folder, tmp.path());
    req.conflict = Conflict::KeepBoth;
    assert_eq!(run(req).state, "completed");
    assert_eq!(
        fs::read_to_string(tmp.path().join("folder (1)/nested.txt")).unwrap(),
        "tree"
    );
    assert!(folder.join("nested.txt").exists());
}
#[test]
fn moving_onto_an_alias_of_the_same_file_preserves_both_names_and_content() {
    let tmp = TempDir::new().unwrap();
    let file = tmp.path().join("payload.txt");
    let dest = tmp.path().join("dest");
    fs::create_dir(&dest).unwrap();
    fs::write(&file, "must survive").unwrap();
    fs::hard_link(&file, dest.join("payload.txt")).unwrap();
    assert_eq!(run(request(Operation::Move, &file, &dest)).state, "failed");
    assert_eq!(fs::read_to_string(&file).unwrap(), "must survive");
    assert_eq!(
        fs::read_to_string(dest.join("payload.txt")).unwrap(),
        "must survive"
    );
    #[cfg(windows)]
    {
        let parent = std::path::PathBuf::from(tmp.path().to_string_lossy().to_uppercase());
        assert_eq!(
            run(request(Operation::Move, &file, &parent)).state,
            "failed"
        );
        assert_eq!(fs::read_to_string(&file).unwrap(), "must survive");
    }
}
#[test]
fn skipped_move_preserves_source_and_existing_target() {
    let tmp = TempDir::new().unwrap();
    let source = tmp.path().join("file.txt");
    let dest = tmp.path().join("dest");
    fs::create_dir(&dest).unwrap();
    fs::write(&source, "new").unwrap();
    fs::write(dest.join("file.txt"), "old").unwrap();
    let mut req = request(Operation::Move, &source, &dest);
    req.conflict = Conflict::Skip;
    assert_eq!(run(req).state, "completed");
    assert!(source.exists());
    assert_eq!(fs::read_to_string(dest.join("file.txt")).unwrap(), "old");
}
#[test]
fn conflict_keep_both_preserves_extension() {
    let tmp = TempDir::new().unwrap();
    let source = tmp.path().join("file.txt");
    let dest = tmp.path().join("dest");
    fs::create_dir(&dest).unwrap();
    fs::write(&source, "new").unwrap();
    fs::write(dest.join("file.txt"), "old").unwrap();
    let mut req = request(Operation::Copy, &source, &dest);
    req.conflict = Conflict::KeepBoth;
    assert_eq!(run(req).state, "completed");
    assert_eq!(
        fs::read_to_string(dest.join("file (1).txt")).unwrap(),
        "new"
    );
    assert_eq!(fs::read_to_string(dest.join("file.txt")).unwrap(), "old");
}
#[test]
fn asks_for_conflict_and_applies_answer() {
    let tmp = TempDir::new().unwrap();
    let source = tmp.path().join("file.txt");
    let dest = tmp.path().join("dest");
    fs::create_dir(&dest).unwrap();
    fs::write(&source, "new").unwrap();
    fs::write(dest.join("file.txt"), "old").unwrap();
    let (tx, rx) = mpsc::channel();
    let engine = Engine::new(
        Arc::new(Sources::default()),
        Arc::new(move |e| {
            tx.send(e).unwrap();
        }),
    );
    let mut req = request(Operation::Copy, &source, &dest);
    req.conflict = Conflict::Ask;
    let id = req.id.clone();
    engine.enqueue(req).unwrap();
    loop {
        let e = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        if e.state == "conflict" {
            engine.resolve(&id, Conflict::KeepBoth, true).unwrap();
        }
        if e.state == "completed" {
            break;
        }
        assert_ne!(e.state, "failed");
    }
    assert!(dest.join("file (1).txt").exists());
}
#[test]
fn cancelled_copy_does_not_replace_existing_file_or_leave_partial() {
    let tmp = TempDir::new().unwrap();
    let source = tmp.path().join("large.bin");
    let dest = tmp.path().join("dest");
    fs::create_dir(&dest).unwrap();
    fs::write(&source, vec![42; 4 * 1024 * 1024]).unwrap();
    fs::write(dest.join("large.bin"), "original").unwrap();
    let holder: Arc<Mutex<Option<Weak<Engine>>>> = Arc::default();
    let cancel = holder.clone();
    let (tx, rx) = mpsc::channel();
    let engine = Arc::new(Engine::new(
        Arc::new(Sources::default()),
        Arc::new(move |e| {
            if e.bytes > 0 && e.state == "running" {
                if let Some(engine) = cancel.lock().unwrap().as_ref().and_then(Weak::upgrade) {
                    engine.cancel(&e.id);
                }
            }
            tx.send(e).unwrap();
        }),
    ));
    *holder.lock().unwrap() = Some(Arc::downgrade(&engine));
    engine
        .enqueue(request(Operation::Move, &source, &dest))
        .unwrap();
    loop {
        let e = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        if e.state == "cancelled" {
            break;
        }
        assert_ne!(e.state, "completed");
    }
    assert!(source.exists());
    assert_eq!(
        fs::read_to_string(dest.join("large.bin")).unwrap(),
        "original"
    );
    assert_eq!(fs::read_dir(dest).unwrap().count(), 1);
}
#[test]
fn rejects_copy_into_self_or_descendant() {
    let tmp = TempDir::new().unwrap();
    let src = tmp.path().join("source");
    fs::create_dir_all(src.join("child")).unwrap();
    assert_eq!(
        run(request(Operation::Copy, &src, &src.join("child"))).state,
        "failed"
    );
}
#[test]
fn rejects_windows_reserved_and_ambiguous_names() {
    for name in [
        "", ".", "..", "CON", "nul.txt", "a/b", "a\\b", "name.", "name ", "a:b", "LPT1.log", "a\0b",
    ] {
        assert!(filesystem::valid_name(name).is_err(), "{name}");
    }
    for name in ["Õunad.txt", "COM10", "file.tar.gz", ".gitignore"] {
        assert!(filesystem::valid_name(name).is_ok(), "{name}");
    }
    assert!(filesystem::guard_destructive("/").is_err());
    assert!(filesystem::guard_destructive("relative").is_err());
}
#[test]
fn rename_preview_detects_duplicates_before_applying() {
    let tmp = TempDir::new().unwrap();
    fs::write(tmp.path().join("one.txt"), "one").unwrap();
    fs::write(tmp.path().join("two.txt"), "two").unwrap();
    let paths = vec![
        path(tmp.path().join("one.txt")),
        path(tmp.path().join("two.txt")),
    ];
    let rules = RenameRules {
        find: ".*".into(),
        replace: "same.txt".into(),
        regex: true,
        case_mode: "keep".into(),
        numbering: false,
        start: 1,
        prefix: String::new(),
    };
    let items = rename::plan(&LocalFs, &paths, &rules).unwrap();
    assert!(items.iter().any(|i| i.error.is_some()));
    assert!(rename::apply(&LocalFs, &paths, &rules).is_err());
    assert!(tmp.path().join("one.txt").exists());
}
#[test]
fn bulk_rename_preserves_extensions_and_numbers_in_order() {
    let tmp = TempDir::new().unwrap();
    fs::write(tmp.path().join("photo.jpg"), "image").unwrap();
    let paths = vec![path(tmp.path().join("photo.jpg"))];
    let rules = RenameRules {
        find: "photo".into(),
        replace: "image".into(),
        regex: false,
        case_mode: "keep".into(),
        numbering: true,
        start: 7,
        prefix: "trip-".into(),
    };
    rename::apply(&LocalFs, &paths, &rules).unwrap();
    assert!(tmp.path().join("trip-image_007.jpg").exists());
}
#[test]
fn zip_round_trip_and_read_only_listing() {
    let tmp = TempDir::new().unwrap();
    let src = tmp.path().join("source");
    let dst = tmp.path().join("dest");
    fs::create_dir(&src).unwrap();
    fs::create_dir(&dst).unwrap();
    fs::write(src.join("tere.txt"), "content").unwrap();
    let zip = tmp.path().join("archive.zip");
    assert_eq!(run(request(Operation::Zip, &src, &zip)).state, "completed");
    let view = archive::ZipFs::new(&path(&zip)).unwrap();
    assert_eq!(view.list("/").unwrap()[0].name, "source");
    assert!(!view.writable());
    assert!(view.mkdir("/new").is_err());
    let done = run(request(Operation::Extract, &zip, &dst));
    assert_eq!(done.state, "completed", "{:?}", done.errors);
    assert_eq!(
        fs::read_to_string(dst.join("source/tere.txt")).unwrap(),
        "content"
    );
}
#[test]
fn rejects_zip_slip_and_windows_device_paths() {
    for name in [
        "../outside",
        "/absolute",
        "C:/outside",
        "folder/../../out",
        "a\\..\\out",
        "folder/CON",
        "//server/share",
    ] {
        assert!(archive::safe_zip_path(name).is_err(), "{name}");
    }
    let tmp = TempDir::new().unwrap();
    let zip = tmp.path().join("bad.zip");
    let dest = tmp.path().join("dest");
    fs::create_dir(&dest).unwrap();
    let mut writer = zip::ZipWriter::new(fs::File::create(&zip).unwrap());
    writer
        .start_file("../outside", zip::write::SimpleFileOptions::default())
        .unwrap();
    writer.write_all(b"bad").unwrap();
    writer.finish().unwrap();
    assert_eq!(
        run(request(Operation::Extract, &zip, &dest)).state,
        "failed"
    );
    assert!(!tmp.path().join("outside").exists());
}
#[cfg(unix)]
#[test]
fn extraction_does_not_follow_existing_symlink() {
    let tmp = TempDir::new().unwrap();
    let zip = tmp.path().join("test.zip");
    let dest = tmp.path().join("dest");
    let outside = tmp.path().join("outside");
    fs::create_dir(&dest).unwrap();
    fs::create_dir(&outside).unwrap();
    std::os::unix::fs::symlink(&outside, dest.join("link")).unwrap();
    let mut writer = zip::ZipWriter::new(fs::File::create(&zip).unwrap());
    writer
        .start_file("link/stolen.txt", zip::write::SimpleFileOptions::default())
        .unwrap();
    writer.write_all(b"bad").unwrap();
    writer.finish().unwrap();
    assert_eq!(
        run(request(Operation::Extract, &zip, &dest)).state,
        "failed"
    );
    assert!(!outside.join("stolen.txt").exists());
}
#[test]
fn search_streams_results_and_respects_hidden_and_size_filters() {
    let tmp = TempDir::new().unwrap();
    fs::create_dir(tmp.path().join("nested")).unwrap();
    fs::write(tmp.path().join("nested/Hello.txt"), "123456").unwrap();
    fs::write(tmp.path().join(".hello"), "123456").unwrap();
    fs::write(tmp.path().join("hello-small"), "1").unwrap();
    let results = Mutex::new(vec![]);
    filesystem::search(
        &LocalFs,
        &path(tmp.path()),
        &SearchFilter {
            query: "hello".into(),
            min_size: Some(5),
            ..Default::default()
        },
        &AtomicBool::new(false),
        &|b| results.lock().unwrap().extend(b.entries),
    )
    .unwrap();
    let results = results.lock().unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].name, "Hello.txt");
}
#[test]
fn preview_limits_text_and_does_not_execute_html() {
    let tmp = TempDir::new().unwrap();
    let p = tmp.path().join("large.html");
    fs::write(&p, vec![b'x'; 400_000]).unwrap();
    let preview = filesystem::preview(&LocalFs, &path(&p)).unwrap();
    assert_eq!(preview.kind, "text");
    assert!(preview.truncated);
    assert_eq!(preview.data.len(), 256 * 1024);
    let no_extension = tmp.path().join("config");
    fs::write(&no_extension, "Host example\n User alice\n").unwrap();
    assert_eq!(
        filesystem::preview(&LocalFs, &path(&no_extension))
            .unwrap()
            .kind,
        "text"
    );
    fs::write(&no_extension, b"binary\0payload").unwrap();
    assert_eq!(
        filesystem::preview(&LocalFs, &path(&no_extension))
            .unwrap()
            .kind,
        "unsupported"
    );
}
#[test]
#[ignore = "Explicit large-directory acceptance check"]
fn streams_one_hundred_thousand_entries_in_bounded_batches() {
    let tmp = TempDir::new().unwrap();
    for i in 0..100_000 {
        fs::File::create(tmp.path().join(format!("file-{i:06}.txt"))).unwrap();
    }
    let count = Mutex::new(0);
    let batches = Mutex::new(0);
    LocalFs
        .stream(&path(tmp.path()), &|batch| {
            assert!(batch.entries.len() <= 256);
            *count.lock().unwrap() += batch.entries.len();
            *batches.lock().unwrap() += 1;
        })
        .unwrap();
    assert_eq!(*count.lock().unwrap(), 100_000);
    assert!(*batches.lock().unwrap() > 390);
}
