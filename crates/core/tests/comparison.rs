use commander_core::{
    comparison::{self, Choice, Direction, Options, Plan},
    engine::Engine,
    filesystem::{FileSystem, LocalFs, Sources},
    Location,
};
use std::{
    fs,
    path::Path,
    sync::{atomic::AtomicBool, mpsc, Arc},
    time::Duration,
};
use tempfile::TempDir;
fn location(path: &Path) -> Location {
    Location {
        source: "local".into(),
        path: path.to_string_lossy().into(),
    }
}
fn compare(left: &Path, right: &Path, options: Options) -> Arc<Plan> {
    Arc::new(
        comparison::scan(
            &LocalFs,
            &LocalFs,
            location(left),
            location(right),
            options,
            &AtomicBool::new(false),
            &|_| {},
        )
        .unwrap(),
    )
}
fn fixture() -> (TempDir, std::path::PathBuf, std::path::PathBuf) {
    let tmp = TempDir::new().unwrap();
    let left = tmp.path().join("Left");
    let right = tmp.path().join("Right");
    fs::create_dir(&left).unwrap();
    fs::create_dir(&right).unwrap();
    (tmp, left, right)
}
fn choose(plan: &Plan, path: &str, direction: Direction) -> Choice {
    Choice {
        id: plan.rows.iter().find(|r| r.path == path).unwrap().id,
        direction,
    }
}
fn run(prepared: comparison::Prepared, sources: Arc<Sources>) -> commander_core::JobEvent {
    let (tx, rx) = mpsc::channel();
    let engine = Engine::new(
        sources,
        Arc::new(move |event| {
            let _ = tx.send(event);
        }),
    );
    engine
        .enqueue_synchronization(uuid::Uuid::new_v4().to_string(), prepared)
        .unwrap();
    loop {
        let e = rx.recv_timeout(Duration::from_secs(10)).unwrap();
        if ["completed", "failed", "cancelled"].contains(&e.state.as_str()) {
            return e;
        }
    }
}
#[test]
fn content_comparison_finds_same_size_same_time_changes_and_filters_recursively() {
    let (_tmp, left, right) = fixture();
    for root in [&left, &right] {
        fs::create_dir_all(root.join("nested")).unwrap();
        fs::write(root.join("same.bin"), b"\0same\xff").unwrap();
    }
    fs::write(left.join("different.txt"), "before").unwrap();
    fs::write(right.join("different.txt"), "edited").unwrap();
    let time = std::time::UNIX_EPOCH + Duration::from_secs(1_700_000_000);
    for root in [&left, &right] {
        fs::OpenOptions::new()
            .write(true)
            .open(root.join("different.txt"))
            .unwrap()
            .set_modified(time)
            .unwrap();
    }
    fs::write(left.join("nested/only-left.txt"), "left").unwrap();
    fs::write(right.join("only-right.txt"), "right").unwrap();
    fs::write(left.join(".hidden"), "hidden").unwrap();
    fs::write(left.join(".supercommander-test.backup"), "old").unwrap();
    let plan = compare(&left, &right, Options::default());
    assert_eq!(
        plan.rows
            .iter()
            .find(|r| r.path == "different.txt")
            .unwrap()
            .status,
        "different"
    );
    assert_eq!(
        plan.rows
            .iter()
            .find(|r| r.path == "same.bin")
            .unwrap()
            .status,
        "same"
    );
    assert_eq!(
        plan.rows
            .iter()
            .find(|r| r.path == "nested/only-left.txt")
            .unwrap()
            .status,
        "left_only"
    );
    assert_eq!(plan.rows.len(), 5);
    let quick = compare(
        &left,
        &right,
        Options {
            content: false,
            ..Options::default()
        },
    );
    assert_eq!(
        quick
            .rows
            .iter()
            .find(|r| r.path == "different.txt")
            .unwrap()
            .status,
        "same_metadata"
    );
    let excluded = compare(
        &left,
        &right,
        Options {
            show_hidden: true,
            exclude: "nested;only-right.txt".into(),
            ..Options::default()
        },
    );
    assert!(excluded.rows.iter().any(|r| r.path == ".hidden"));
    assert!(!excluded
        .rows
        .iter()
        .any(|r| r.path.contains("only-") || r.path.starts_with(".supercommander")));
}
#[test]
fn reviewed_two_way_copies_create_empty_folders_and_keep_replaced_versions() {
    let (_tmp, left, right) = fixture();
    fs::create_dir_all(left.join("new/empty")).unwrap();
    fs::write(left.join("new/one.txt"), "left data").unwrap();
    fs::write(right.join("right.txt"), "right data").unwrap();
    fs::write(left.join("replace.txt"), "new content").unwrap();
    fs::write(right.join("replace.txt"), "old content").unwrap();
    let plan = compare(&left, &right, Options::default());
    let choices = vec![
        choose(&plan, "new/one.txt", Direction::LeftToRight),
        choose(&plan, "new/empty", Direction::LeftToRight),
        choose(&plan, "right.txt", Direction::RightToLeft),
        choose(&plan, "replace.txt", Direction::LeftToRight),
    ];
    let prepared =
        comparison::prepare(plan, &choices, &LocalFs, &LocalFs, &AtomicBool::new(false)).unwrap();
    let event = run(prepared, Arc::new(Sources::default()));
    assert_eq!(event.state, "completed", "{:?}", event.errors);
    assert_eq!(event.completed, 4);
    assert_eq!(event.preserved_count, 1);
    assert_eq!(
        fs::read_to_string(right.join("new/one.txt")).unwrap(),
        "left data"
    );
    assert!(right.join("new/empty").is_dir());
    assert_eq!(
        fs::read_to_string(left.join("right.txt")).unwrap(),
        "right data"
    );
    assert_eq!(
        fs::read_to_string(right.join("replace.txt")).unwrap(),
        "new content"
    );
    assert_eq!(
        fs::read_to_string(&event.preserved[0].path).unwrap(),
        "old content"
    );
    let record: serde_json::Value =
        serde_json::from_slice(&fs::read(&event.preserved[0].record).unwrap()).unwrap();
    assert_eq!(
        record["original"],
        right.join("replace.txt").to_str().unwrap()
    );
    assert!(fs::read_dir(right.join("new")).unwrap().all(|e| !e
        .unwrap()
        .file_name()
        .to_string_lossy()
        .starts_with(".supercommander")));
}
#[test]
fn stale_comparison_and_queued_changes_are_rejected_before_any_writes() {
    let (_tmp, left, right) = fixture();
    fs::write(left.join("one.txt"), "one").unwrap();
    fs::write(left.join("two.txt"), "two").unwrap();
    let plan = compare(&left, &right, Options::default());
    let choices = vec![
        choose(&plan, "one.txt", Direction::LeftToRight),
        choose(&plan, "two.txt", Direction::LeftToRight),
    ];
    let prepared = comparison::prepare(
        plan.clone(),
        &choices,
        &LocalFs,
        &LocalFs,
        &AtomicBool::new(false),
    )
    .unwrap();
    fs::write(left.join("two.txt"), "changed").unwrap();
    assert!(
        comparison::prepare(plan, &choices, &LocalFs, &LocalFs, &AtomicBool::new(false)).is_err()
    );
    let event = run(prepared, Arc::new(Sources::default()));
    assert_eq!(event.state, "failed");
    assert_eq!(fs::read_dir(&right).unwrap().count(), 0);
}
#[test]
fn parent_type_conflicts_and_case_ambiguity_never_become_copy_actions() {
    let (_tmp, left, right) = fixture();
    fs::create_dir(left.join("parent")).unwrap();
    fs::write(left.join("parent/file.txt"), "payload").unwrap();
    fs::write(right.join("parent"), "blocking file").unwrap();
    let plan = compare(&left, &right, Options::default());
    for row in &plan.rows {
        assert!(row.blocked.is_some());
        assert!(!row.to_left && !row.to_right);
    }
    assert!(comparison::prepare(
        plan.clone(),
        &[choose(&plan, "parent/file.txt", Direction::LeftToRight)],
        &LocalFs,
        &LocalFs,
        &AtomicBool::new(false)
    )
    .is_err());
    #[cfg(unix)]
    {
        fs::write(left.join("Case.txt"), "upper").unwrap();
        fs::write(left.join("case.txt"), "lower").unwrap();
        let plan = compare(
            &left,
            &right,
            Options {
                case_sensitive: false,
                ..Options::default()
            },
        );
        assert!(plan.rows.iter().any(|r| r.status == "ambiguous"));
    }
}
#[test]
fn limits_and_cancellation_keep_comparison_unactionable() {
    let (_tmp, left, right) = fixture();
    fs::write(left.join("one.txt"), "one").unwrap();
    fs::write(left.join("two.txt"), "two").unwrap();
    let plan = compare(
        &left,
        &right,
        Options {
            max_entries: 1,
            ..Options::default()
        },
    );
    assert!(plan.progress.limited);
    let choice = Choice {
        id: 0,
        direction: Direction::LeftToRight,
    };
    assert!(
        comparison::prepare(plan, &[choice], &LocalFs, &LocalFs, &AtomicBool::new(false)).is_err()
    );
    assert!(comparison::scan(
        &LocalFs,
        &LocalFs,
        location(&left),
        location(&right),
        Options::default(),
        &AtomicBool::new(true),
        &|_| {}
    )
    .is_err());
}
#[test]
fn unresolved_cross_namespace_overlap_preserves_overwritten_source_versions() {
    let (_tmp, left, _right) = fixture();
    let right = left.join("sub");
    fs::create_dir_all(right.join("sub")).unwrap();
    fs::write(left.join("alpha.txt"), "AAAA").unwrap();
    fs::write(right.join("alpha.txt"), "BBBB").unwrap();
    fs::write(right.join("sub/alpha.txt"), "CCCC").unwrap();
    let mut remote = location(&right);
    remote.source = "alias".into();
    let plan = Arc::new(
        comparison::scan(
            &LocalFs,
            &LocalFs,
            location(&left),
            remote,
            Options::default(),
            &AtomicBool::new(false),
            &|_| {},
        )
        .unwrap(),
    );
    let choices = vec![
        choose(&plan, "alpha.txt", Direction::LeftToRight),
        choose(&plan, "sub/alpha.txt", Direction::LeftToRight),
    ];
    let prepared =
        comparison::prepare(plan, &choices, &LocalFs, &LocalFs, &AtomicBool::new(false)).unwrap();
    let sources = Arc::new(Sources::default());
    sources.insert("alias".into(), Arc::new(LocalFs));
    let event = run(prepared, sources);
    assert_eq!(event.state, "failed");
    assert_eq!(event.completed, 1);
    assert_eq!(event.preserved_count, 1);
    assert_eq!(
        fs::read_to_string(&event.preserved[0].path).unwrap(),
        "BBBB"
    );
    assert_eq!(
        fs::read_to_string(right.join("sub/alpha.txt")).unwrap(),
        "CCCC"
    );
}

#[test]
fn selecting_children_before_their_parent_does_not_invalidate_the_review() {
    let (_tmp, left, right) = fixture();
    fs::create_dir_all(left.join("new/empty")).unwrap();
    fs::write(left.join("new/file.txt"), "reviewed payload").unwrap();
    let plan = compare(&left, &right, Options::default());
    let choices = vec![
        choose(&plan, "new/file.txt", Direction::LeftToRight),
        choose(&plan, "new/empty", Direction::LeftToRight),
        choose(&plan, "new", Direction::LeftToRight),
    ];
    let prepared =
        comparison::prepare(plan, &choices, &LocalFs, &LocalFs, &AtomicBool::new(false)).unwrap();
    let event = run(prepared, Arc::new(Sources::default()));
    assert_eq!(event.state, "completed", "{:?}", event.errors);
    assert_eq!(event.completed, 3);
    assert_eq!(
        fs::read_to_string(right.join("new/file.txt")).unwrap(),
        "reviewed payload"
    );
    assert!(right.join("new/empty").is_dir());
}

#[test]
fn archive_comparison_only_allows_copying_out_of_the_read_only_source() {
    use std::io::Write;
    let (tmp, _left, right) = fixture();
    let archive_path = tmp.path().join("files.zip");
    let mut writer = zip::ZipWriter::new(fs::File::create(&archive_path).unwrap());
    writer
        .start_file(
            "nested/from-zip.txt",
            zip::write::SimpleFileOptions::default(),
        )
        .unwrap();
    writer.write_all(b"archived contents").unwrap();
    writer.finish().unwrap();
    let archive =
        Arc::new(commander_core::archive::ZipFs::new(archive_path.to_str().unwrap()).unwrap());
    fs::write(right.join("local-only.txt"), "stay local").unwrap();
    let from = Location {
        source: format!("zip:{}", archive_path.display()),
        path: "/".into(),
    };
    let plan = Arc::new(
        comparison::scan(
            archive.as_ref(),
            &LocalFs,
            from,
            location(&right),
            Options::default(),
            &AtomicBool::new(false),
            &|_| {},
        )
        .unwrap(),
    );
    assert!(!plan.left.writable);
    assert!(plan.rows.iter().all(|r| !r.to_left));
    let choices = [choose(&plan, "nested/from-zip.txt", Direction::LeftToRight)];
    let prepared = comparison::prepare(
        plan,
        &choices,
        archive.as_ref(),
        &LocalFs,
        &AtomicBool::new(false),
    )
    .unwrap();
    let sources = Arc::new(Sources::default());
    let event = run(prepared, sources);
    assert_eq!(event.state, "completed", "{:?}", event.errors);
    assert_eq!(
        fs::read_to_string(right.join("nested/from-zip.txt")).unwrap(),
        "archived contents"
    );
    assert_eq!(
        fs::read_to_string(right.join("local-only.txt")).unwrap(),
        "stay local"
    );
}

#[test]
fn case_insensitive_matching_keeps_existing_destination_parent_spelling() {
    let (_tmp, left, right) = fixture();
    fs::create_dir(left.join("Photos")).unwrap();
    fs::create_dir(right.join("photos")).unwrap();
    fs::write(left.join("Photos/new.txt"), "picture notes").unwrap();
    fs::write(right.join("photos/keep.txt"), "keep").unwrap();
    let plan = compare(
        &left,
        &right,
        Options {
            case_sensitive: false,
            ..Options::default()
        },
    );
    let folder = plan.rows.iter().find(|row| row.path == "Photos").unwrap();
    assert_eq!(folder.status, "folder_different");
    let choices = [choose(&plan, "Photos/new.txt", Direction::LeftToRight)];
    let prepared =
        comparison::prepare(plan, &choices, &LocalFs, &LocalFs, &AtomicBool::new(false)).unwrap();
    let event = run(prepared, Arc::new(Sources::default()));
    assert_eq!(event.state, "completed", "{:?}", event.errors);
    assert_eq!(
        fs::read_to_string(right.join("photos/new.txt")).unwrap(),
        "picture notes"
    );
    assert_eq!(fs::read_dir(&right).unwrap().count(), 1);
}

// A destination can observe an external edit after all preflight checks and
// before the first read. Coarse timestamps model an SFTP server's precision.
type WriteHook = dyn Fn(&str) -> anyhow::Result<()> + Send + Sync;
struct StagingFs {
    on_write: Box<WriteHook>,
}
impl commander_core::filesystem::FileSystem for StagingFs {
    fn list(&self, p: &str) -> anyhow::Result<Vec<commander_core::Entry>> {
        LocalFs.list(p)
    }
    fn stat(&self, p: &str) -> anyhow::Result<commander_core::Entry> {
        LocalFs.stat(p)
    }
    fn canonical_path(&self, p: &str) -> anyhow::Result<String> {
        LocalFs.canonical_path(p)
    }
    fn properties(&self, p: &str) -> anyhow::Result<commander_core::properties::Properties> {
        let mut props = LocalFs.properties(p)?;
        props.stamp.clear();
        props.created = None;
        Ok(props)
    }
    fn reader(&self, p: &str) -> anyhow::Result<Box<dyn std::io::Read + Send>> {
        LocalFs.reader(p)
    }
    fn writer(&self, p: &str) -> anyhow::Result<Box<dyn std::io::Write + Send>> {
        LocalFs.writer(p)
    }
    fn private_writer(&self, p: &str) -> anyhow::Result<Box<dyn std::io::Write + Send>> {
        (self.on_write)(p)?;
        LocalFs.private_writer(p)
    }
    fn mkdir(&self, p: &str) -> anyhow::Result<()> {
        LocalFs.mkdir(p)
    }
    fn private_mkdir(&self, p: &str) -> anyhow::Result<()> {
        LocalFs.private_mkdir(p)
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
    fn transfer_metadata(
        &self,
        p: &str,
        props: &commander_core::properties::Properties,
    ) -> anyhow::Result<()> {
        LocalFs.transfer_metadata(p, props)
    }
    fn join(&self, a: &str, b: &str) -> String {
        LocalFs.join(a, b)
    }
}

#[test]
fn synchronization_never_publishes_a_different_snapshot_after_review() {
    let (_tmp, left, right) = fixture();
    let file = left.join("file.txt");
    fs::write(&file, "before").unwrap();
    fs::write(right.join("file.txt"), "target").unwrap();
    let time = fs::metadata(&file).unwrap().modified().unwrap();
    let changed = file.clone();
    let source = Arc::new(StagingFs {
        on_write: Box::new(|_| Ok(())),
    });
    let destination = Arc::new(StagingFs {
        on_write: Box::new(move |path| {
            if path.ends_with(".part") {
                fs::write(&changed, "edited")?;
                fs::OpenOptions::new()
                    .write(true)
                    .open(&changed)?
                    .set_modified(time)?;
            }
            Ok(())
        }),
    });
    let mut from = location(&left);
    from.source = "coarse".into();
    let mut to = location(&right);
    to.source = "staging".into();
    let plan = Arc::new(
        comparison::scan(
            source.as_ref(),
            destination.as_ref(),
            from,
            to,
            Options::default(),
            &AtomicBool::new(false),
            &|_| {},
        )
        .unwrap(),
    );
    let choices = [choose(&plan, "file.txt", Direction::LeftToRight)];
    let prepared = comparison::prepare(
        plan,
        &choices,
        source.as_ref(),
        destination.as_ref(),
        &AtomicBool::new(false),
    )
    .unwrap();
    let sources = Arc::new(Sources::default());
    sources.insert("coarse".into(), source);
    sources.insert("staging".into(), destination);
    let event = run(prepared, sources);
    assert_eq!(event.state, "failed");
    assert!(
        event
            .errors
            .join(" ")
            .contains("Source contents changed since comparison"),
        "{:?}",
        event.errors
    );
    assert_eq!(fs::read_to_string(file).unwrap(), "edited");
    assert_eq!(
        fs::read_to_string(right.join("file.txt")).unwrap(),
        "target"
    );
    assert_eq!(LocalFs.list(right.to_str().unwrap()).unwrap().len(), 1);
}

#[cfg(unix)]
#[test]
fn new_directories_are_private_until_their_reviewed_contents_are_published() {
    use std::os::unix::fs::PermissionsExt;
    let (_tmp, left, right) = fixture();
    fs::create_dir(left.join("new")).unwrap();
    fs::set_permissions(left.join("new"), fs::Permissions::from_mode(0o755)).unwrap();
    fs::write(left.join("new/file.txt"), "payload").unwrap();
    let directory = right.join("new");
    let destination = Arc::new(StagingFs {
        on_write: Box::new(move |path| {
            if path.ends_with(".part") {
                assert_eq!(
                    fs::metadata(&directory)?.permissions().mode() & 0o777,
                    0o700
                );
            }
            Ok(())
        }),
    });
    let mut to = location(&right);
    to.source = "staging".into();
    let plan = Arc::new(
        comparison::scan(
            &LocalFs,
            destination.as_ref(),
            location(&left),
            to,
            Options::default(),
            &AtomicBool::new(false),
            &|_| {},
        )
        .unwrap(),
    );
    let choices = [choose(&plan, "new/file.txt", Direction::LeftToRight)];
    let prepared = comparison::prepare(
        plan,
        &choices,
        &LocalFs,
        destination.as_ref(),
        &AtomicBool::new(false),
    )
    .unwrap();
    let sources = Arc::new(Sources::default());
    sources.insert("staging".into(), destination);
    let event = run(prepared, sources);
    assert_eq!(event.state, "completed", "{:?}", event.errors);
    assert_eq!(
        fs::metadata(right.join("new"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o755
    );
    assert_eq!(
        fs::read_to_string(right.join("new/file.txt")).unwrap(),
        "payload"
    );
}
