use commander_core::{
    filesystem::{FileSystem, LocalFs},
    properties::Properties,
    rename, Entry, RenameRules,
};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};
use tempfile::TempDir;

fn text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}
fn rules() -> RenameRules {
    RenameRules {
        find: String::new(),
        replace: String::new(),
        regex: false,
        case_mode: "keep".into(),
        numbering: false,
        start: 1,
        prefix: "new-".into(),
    }
}
fn prepare(fs: &dyn FileSystem, paths: &[&Path]) -> rename::Prepared {
    rename::prepare(
        fs,
        &paths.iter().map(|p| text(p)).collect::<Vec<_>>(),
        &rules(),
        &AtomicBool::new(false),
    )
    .unwrap()
}
fn apply(fs: &dyn FileSystem, plan: &rename::Prepared) -> anyhow::Result<()> {
    rename::apply_prepared(fs, plan, &AtomicBool::new(false))
}

struct TestFs {
    root: PathBuf,
    mode: &'static str,
    coarse: bool,
    connection: &'static str,
    triggered: AtomicBool,
    cancel: AtomicBool,
}
impl TestFs {
    fn new(root: &Path, mode: &'static str) -> Self {
        Self {
            root: root.into(),
            mode,
            coarse: false,
            connection: "first-session",
            triggered: AtomicBool::new(false),
            cancel: AtomicBool::new(false),
        }
    }
}
impl FileSystem for TestFs {
    fn list(&self, p: &str) -> anyhow::Result<Vec<Entry>> {
        LocalFs.list(p)
    }
    fn stat(&self, p: &str) -> anyhow::Result<Entry> {
        LocalFs.stat(p)
    }
    fn properties(&self, p: &str) -> anyhow::Result<Properties> {
        let mut properties = LocalFs.properties(p)?;
        if self.coarse {
            properties.created = None;
            properties.stamp.clear();
        }
        Ok(properties)
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
    fn connection_id(&self) -> Option<&str> {
        Some(self.connection)
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
    fn rename(&self, _: &str, _: &str) -> anyhow::Result<()> {
        anyhow::bail!("Overwriting rename must never be used")
    }
    fn rename_new(&self, from: &str, to: &str) -> anyhow::Result<()> {
        let first = self.root.join("a.txt");
        let second = self.root.join("b.txt");
        let publishing = Path::new(to) == self.root.join("new-a.txt");
        let second_claim = Path::new(from) == second;
        if self.mode == "replace-before-claim"
            && Path::new(from) == first
            && !self.triggered.swap(true, Ordering::Relaxed)
        {
            let time = fs::metadata(&first)?.modified()?;
            fs::rename(&first, self.root.join("kept-original.txt"))?;
            fs::write(&first, "edited")?;
            fs::OpenOptions::new()
                .write(true)
                .open(&first)?
                .set_modified(time)?;
        }
        if self.mode == "late-target" && publishing && !self.triggered.swap(true, Ordering::Relaxed)
        {
            fs::write(to, "racing destination")?;
        }
        if self.mode.starts_with("fail-second")
            && second_claim
            && !self.triggered.swap(true, Ordering::Relaxed)
        {
            if self.mode == "fail-second-new-original" {
                fs::write(&first, "new file at old name")?;
            }
            if self.mode == "fail-second-new-target" {
                fs::rename(
                    self.root.join("new-a.txt"),
                    self.root.join("kept-original.txt"),
                )?;
                fs::write(self.root.join("new-a.txt"), "new file at target name")?;
            }
            anyhow::bail!("Simulated second rename failure");
        }
        LocalFs.rename_new(from, to)?;
        if self.mode == "exit-after-claim" && Path::new(from) == first {
            std::process::exit(73);
        }
        if self.mode == "cancel-after-claim" && Path::new(from) == first {
            self.cancel.store(true, Ordering::Relaxed);
        }
        Ok(())
    }
    fn remove(&self, _: &str) -> anyhow::Result<()> {
        anyhow::bail!("No recursive deletion")
    }
    fn remove_file(&self, p: &str) -> anyhow::Result<()> {
        LocalFs.remove_file(p)
    }
    fn join(&self, p: &str, n: &str) -> String {
        LocalFs.join(p, n)
    }
}
fn setup() -> (TempDir, PathBuf, PathBuf) {
    let root = TempDir::new().unwrap();
    let a = root.path().join("a.txt");
    let b = root.path().join("b.txt");
    fs::write(&a, "before").unwrap();
    fs::write(&b, "second").unwrap();
    (root, a, b)
}
fn no_private_files(root: &Path) {
    assert!(fs::read_dir(root).unwrap().all(|entry| !entry
        .unwrap()
        .file_name()
        .to_string_lossy()
        .starts_with(".supercommander-")));
}

#[test]
fn native_rename_keeps_in_place_edits_and_live_folder_children() {
    let (root, a, _) = setup();
    let dir = root.path().join("folder");
    fs::create_dir(&dir).unwrap();
    let plan = prepare(&LocalFs, &[&a, &dir]);
    fs::write(&a, "changed in the same object").unwrap();
    fs::write(dir.join("late.txt"), "live child").unwrap();
    apply(&LocalFs, &plan).unwrap();
    assert_eq!(
        fs::read_to_string(root.path().join("new-a.txt")).unwrap(),
        "changed in the same object"
    );
    assert_eq!(
        fs::read_to_string(root.path().join("new-folder/late.txt")).unwrap(),
        "live child"
    );
    no_private_files(root.path());
}
#[test]
fn replacement_of_a_later_reviewed_file_prevents_all_renames() {
    let (root, a, b) = setup();
    let plan = prepare(&LocalFs, &[&a, &b]);
    let time = fs::metadata(&b).unwrap().modified().unwrap();
    fs::rename(&b, root.path().join("kept-original.txt")).unwrap();
    fs::write(&b, "edited").unwrap();
    fs::OpenOptions::new()
        .write(true)
        .open(&b)
        .unwrap()
        .set_modified(time)
        .unwrap();
    assert!(apply(&LocalFs, &plan).is_err());
    assert_eq!(fs::read_to_string(a).unwrap(), "before");
    assert_eq!(fs::read_to_string(b).unwrap(), "edited");
    assert!(!root.path().join("new-a.txt").exists());
    no_private_files(root.path());
}
#[test]
fn no_id_backend_detects_equal_size_and_time_edits() {
    let (root, a, _) = setup();
    let mut backend = TestFs::new(root.path(), "ordinary");
    backend.coarse = true;
    let plan = prepare(&backend, &[&a]);
    let time = fs::metadata(&a).unwrap().modified().unwrap();
    fs::write(&a, "edited").unwrap();
    fs::OpenOptions::new()
        .write(true)
        .open(&a)
        .unwrap()
        .set_modified(time)
        .unwrap();
    assert!(apply(&backend, &plan).is_err());
    assert_eq!(fs::read_to_string(a).unwrap(), "edited");
    no_private_files(root.path());
}
#[test]
fn replacement_between_validation_and_claim_is_restored_without_renaming_it() {
    for coarse in [false, true] {
        let (root, a, _) = setup();
        let mut backend = TestFs::new(root.path(), "replace-before-claim");
        backend.coarse = coarse;
        let plan = prepare(&backend, &[&a]);
        assert!(apply(&backend, &plan).is_err());
        assert_eq!(fs::read_to_string(a).unwrap(), "edited");
        assert_eq!(
            fs::read_to_string(root.path().join("kept-original.txt")).unwrap(),
            "before"
        );
        assert!(!root.path().join("new-a.txt").exists());
        no_private_files(root.path());
    }
}
#[test]
fn a_target_created_at_publication_is_never_replaced() {
    let (root, a, _) = setup();
    let backend = TestFs::new(root.path(), "late-target");
    assert!(apply(&backend, &prepare(&backend, &[&a])).is_err());
    assert_eq!(fs::read_to_string(a).unwrap(), "before");
    assert_eq!(
        fs::read_to_string(root.path().join("new-a.txt")).unwrap(),
        "racing destination"
    );
    no_private_files(root.path());
}
#[test]
fn failed_batch_rolls_back_without_overwriting_or_moving_replacement_files() {
    for mode in [
        "fail-second",
        "fail-second-new-original",
        "fail-second-new-target",
    ] {
        let (root, a, b) = setup();
        let backend = TestFs::new(root.path(), mode);
        assert!(apply(&backend, &prepare(&backend, &[&a, &b])).is_err());
        assert_eq!(fs::read_to_string(b).unwrap(), "second");
        match mode {
            "fail-second" => {
                assert_eq!(fs::read_to_string(a).unwrap(), "before");
                assert!(!root.path().join("new-a.txt").exists());
            }
            "fail-second-new-original" => {
                assert_eq!(fs::read_to_string(a).unwrap(), "new file at old name");
                assert_eq!(
                    fs::read_to_string(root.path().join("new-a.txt")).unwrap(),
                    "before"
                );
            }
            _ => {
                assert!(!a.exists());
                assert_eq!(
                    fs::read_to_string(root.path().join("new-a.txt")).unwrap(),
                    "new file at target name"
                );
                assert_eq!(
                    fs::read_to_string(root.path().join("kept-original.txt")).unwrap(),
                    "before"
                );
            }
        }
        no_private_files(root.path());
    }
}
#[test]
fn replaced_parent_and_reconnected_session_invalidate_review() {
    let (root, a, _) = setup();
    let mut backend = TestFs::new(root.path(), "ordinary");
    let plan = prepare(&backend, &[&a]);
    backend.connection = "second-session";
    assert!(apply(&backend, &plan).is_err());
    assert!(a.exists());
    let folder = root.path().join("parent");
    fs::create_dir(&folder).unwrap();
    let file = folder.join("file.txt");
    fs::write(&file, "original").unwrap();
    let plan = prepare(&LocalFs, &[&file]);
    fs::rename(&folder, root.path().join("old-parent")).unwrap();
    fs::create_dir(&folder).unwrap();
    fs::rename(root.path().join("old-parent/file.txt"), &file).unwrap();
    assert!(apply(&LocalFs, &plan).is_err());
    assert_eq!(fs::read_to_string(file).unwrap(), "original");
}
#[test]
fn cancellation_after_claim_restores_original_and_overlapping_roots_are_rejected() {
    let (root, a, _) = setup();
    let backend = TestFs::new(root.path(), "cancel-after-claim");
    let plan = prepare(&backend, &[&a]);
    assert!(rename::apply_prepared(&backend, &plan, &backend.cancel).is_err());
    assert_eq!(fs::read_to_string(a).unwrap(), "before");
    no_private_files(root.path());
    let folder = root.path().join("folder");
    fs::create_dir(&folder).unwrap();
    let child = folder.join("child.txt");
    fs::write(&child, "child").unwrap();
    assert!(rename::prepare(
        &LocalFs,
        &[text(&folder), text(&child)],
        &rules(),
        &AtomicBool::new(false)
    )
    .is_err());
    assert!(rename::prepare(
        &LocalFs,
        &[text(&folder), text(&folder)],
        &rules(),
        &AtomicBool::new(false)
    )
    .is_err());
}
#[test]
fn case_only_rename_changes_spelling_without_replacing_a_distinct_name() {
    let (root, a, _) = setup();
    let rules = RenameRules {
        prefix: String::new(),
        case_mode: "upper".into(),
        ..rules()
    };
    rename::apply(&LocalFs, &[text(&a)], &rules).unwrap();
    let names: Vec<_> = fs::read_dir(root.path())
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    assert!(names.iter().any(|n| n == "A.TXT"));
    assert!(!names.iter().any(|n| n == "a.txt"));
    assert_eq!(
        fs::read_to_string(root.path().join("A.TXT")).unwrap(),
        "before"
    );
    no_private_files(root.path());
}

#[test]
fn interrupted_rename_child() {
    let Ok(root) = std::env::var("SUPERCOMMANDER_RENAME_TEST_ROOT") else {
        return;
    };
    let root = PathBuf::from(root);
    let backend = TestFs::new(&root, "exit-after-claim");
    let _ = apply(&backend, &prepare(&backend, &[&root.join("a.txt")]));
    panic!("Expected process exit during the private rename claim");
}

#[test]
fn process_interruption_leaves_discoverable_payload_and_original_name() {
    let (root, a, _) = setup();
    let result = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "interrupted_rename_child", "--nocapture"])
        .env("SUPERCOMMANDER_RENAME_TEST_ROOT", root.path())
        .output()
        .unwrap();
    assert_eq!(
        result.status.code(),
        Some(73),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(!a.exists());
    assert!(!root.path().join("new-a.txt").exists());
    let journal = fs::read_dir(root.path())
        .unwrap()
        .map(|e| e.unwrap().path())
        .find(|p| p.to_string_lossy().ends_with(".recovery.json"))
        .unwrap();
    let saved = commander_core::recovery::inspect(&LocalFs, &text(&journal)).unwrap();
    assert_eq!(saved.kind, "rename-source");
    assert_eq!(saved.original.as_deref(), Some(text(&a).as_str()));
    assert!(!saved.active);
    assert_eq!(fs::read_to_string(saved.payload).unwrap(), "before");
}
