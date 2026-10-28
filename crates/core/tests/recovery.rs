use commander_core::{
    comparison,
    engine::Engine,
    filesystem::{FileSystem, LocalFs, Sources},
    recovery::{self, Item, RestoreOptions},
    Location,
};
use std::{
    fs,
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    },
    time::Duration,
};
use tempfile::TempDir;
fn location(path: &Path) -> Location {
    Location {
        source: "local".into(),
        path: path.to_string_lossy().into(),
    }
}
fn saved(root: &Path, original: &str, kind: &str, data: &str) -> Item {
    let name = format!(".supercommander-{}.{}", uuid::Uuid::new_v4(), kind);
    let payload = root.join(name);
    fs::write(&payload, data).unwrap();
    let key = format!("{}.recovery.json", payload.display());
    let checksum = comparison::hash(
        &LocalFs,
        payload.to_str().unwrap(),
        &AtomicBool::new(false),
        |_| {},
    )
    .unwrap();
    fs::write(&key,serde_json::to_vec(&serde_json::json!({"version":1,"kind":kind,"original":root.join(original),"preserved":payload,"checksum":checksum})).unwrap()).unwrap();
    recovery::inspect(&LocalFs, &key).unwrap()
}
fn prepare(item: &Item, target: &Path, name: &str, replace: bool) -> recovery::Prepared {
    recovery::prepare(
        &LocalFs,
        "local",
        &LocalFs,
        &RestoreOptions {
            key: item.key.clone(),
            revision: item.revision.clone(),
            connection: None,
            destination: location(target),
            name: name.into(),
            replace,
        },
        &AtomicBool::new(false),
        &|_, _| {},
    )
    .unwrap()
}
fn run(prepared: recovery::Prepared) -> commander_core::JobEvent {
    let (tx, rx) = mpsc::channel();
    let engine = Engine::new(
        Arc::new(Sources::default()),
        Arc::new(move |e| {
            let _ = tx.send(e);
        }),
    );
    engine
        .enqueue_recovery(uuid::Uuid::new_v4().to_string(), prepared)
        .unwrap();
    loop {
        let e = rx.recv_timeout(Duration::from_secs(10)).unwrap();
        if ["completed", "failed", "cancelled"].contains(&e.state.as_str()) {
            return e;
        }
    }
}
#[test]
fn selecting_a_payload_prefers_its_record_and_preserves_the_original_name() {
    let root = TempDir::new().unwrap();
    let item = saved(root.path(), "original.txt", "backup", "saved data");
    let selected = recovery::inspect(&LocalFs, &item.payload).unwrap();
    assert_eq!(selected.key, item.key);
    assert_eq!(selected.original, item.original);
    assert_eq!(selected.revision, item.revision);
}

struct DenyPayloadDelete(AtomicBool);
#[cfg(unix)]
#[test]
fn recovery_checks_aliases_even_when_one_source_cannot_resolve_parent_symlinks() {
    let root = TempDir::new().unwrap();
    let payload = root.path().join(format!(
        ".supercommander-{}.delete-directory",
        uuid::Uuid::new_v4()
    ));
    fs::create_dir(&payload).unwrap();
    fs::create_dir(payload.join("nested")).unwrap();
    fs::write(payload.join("saved.txt"), "saved data").unwrap();
    let alias = root.path().join("alias");
    std::os::unix::fs::symlink(&payload, &alias).unwrap();
    let backend = Arc::new(DenyPayloadDelete(AtomicBool::new(false)));
    let item = recovery::inspect(backend.as_ref(), payload.to_str().unwrap()).unwrap();
    let prepared = recovery::prepare(
        backend.as_ref(),
        "unresolved",
        backend.as_ref(),
        &RestoreOptions {
            key: item.key,
            revision: item.revision,
            connection: None,
            destination: Location {
                source: "unresolved".into(),
                path: alias.join("nested").to_string_lossy().into(),
            },
            name: "Must-not-copy".into(),
            replace: false,
        },
        &AtomicBool::new(false),
        &|_, _| {},
    )
    .unwrap();
    let sources = Arc::new(Sources::default());
    sources.insert("unresolved".into(), backend);
    let (tx, rx) = mpsc::channel();
    let engine = Engine::new(
        sources,
        Arc::new(move |event| {
            let _ = tx.send(event);
        }),
    );
    engine
        .enqueue_recovery(uuid::Uuid::new_v4().to_string(), prepared)
        .unwrap();
    loop {
        let event = rx.recv_timeout(Duration::from_secs(10)).unwrap();
        if ["completed", "failed", "cancelled"].contains(&event.state.as_str()) {
            assert_eq!(event.state, "failed", "{:?}", event.errors);
            assert!(event
                .errors
                .iter()
                .any(|error| error.contains("outside the saved copy")));
            break;
        }
    }
    assert_eq!(
        fs::read_to_string(payload.join("saved.txt")).unwrap(),
        "saved data"
    );
    assert_eq!(fs::read_dir(payload.join("nested")).unwrap().count(), 0);
}
impl FileSystem for DenyPayloadDelete {
    fn list(&self, p: &str) -> anyhow::Result<Vec<commander_core::Entry>> {
        LocalFs.list(p)
    }
    fn stat(&self, p: &str) -> anyhow::Result<commander_core::Entry> {
        LocalFs.stat(p)
    }
    fn reader(&self, p: &str) -> anyhow::Result<Box<dyn std::io::Read + Send>> {
        LocalFs.reader(p)
    }
    fn writer(&self, p: &str) -> anyhow::Result<Box<dyn std::io::Write + Send>> {
        LocalFs.writer(p)
    }
    fn private_writer(&self, p: &str) -> anyhow::Result<Box<dyn std::io::Write + Send>> {
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
    fn remove(&self, _p: &str) -> anyhow::Result<()> {
        anyhow::bail!("Recursive removal is not allowed")
    }
    fn remove_file(&self, p: &str) -> anyhow::Result<()> {
        if self.0.load(Ordering::Relaxed) && p.ends_with(".delete-source") {
            anyhow::bail!("Injected payload deletion failure")
        }
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
fn failed_saved_copy_cleanup_keeps_its_record_and_ignores_client_supplied_payload_paths() {
    let root = TempDir::new().unwrap();
    let original = saved(root.path(), "original.txt", "backup", "saved data");
    let victim = root.path().join("unrelated.txt");
    fs::write(&victim, "unrelated data").unwrap();
    let backend = Arc::new(DenyPayloadDelete(AtomicBool::new(true)));
    let mut item = recovery::inspect(backend.as_ref(), &original.key).unwrap();
    item.payload = victim.to_string_lossy().into();
    item.record = Some(victim.to_string_lossy().into());
    let sources = Arc::new(Sources::default());
    sources.insert("deny".into(), backend.clone());
    let (tx, rx) = mpsc::channel();
    let engine = Engine::new(
        sources,
        Arc::new(move |event| {
            let _ = tx.send(event);
        }),
    );
    for expected in ["failed", "completed"] {
        let current = if expected == "failed" {
            item.clone()
        } else {
            recovery::inspect(backend.as_ref(), &original.key).unwrap()
        };
        engine
            .enqueue_recovery_cleanup(uuid::Uuid::new_v4().to_string(), "deny".into(), current)
            .unwrap();
        loop {
            let event = rx.recv_timeout(Duration::from_secs(10)).unwrap();
            if ["completed", "failed", "cancelled"].contains(&event.state.as_str()) {
                assert_eq!(event.state, expected, "{:?}", event.errors);
                break;
            }
        }
        if expected == "failed" {
            assert_eq!(fs::read_to_string(&original.payload).unwrap(), "saved data");
            assert!(
                Path::new(&original.key).exists(),
                "Failed payload cleanup must retain the recovery record"
            );
            assert!(
                !recovery::inspect(backend.as_ref(), &original.key)
                    .unwrap()
                    .active
            );
            backend.0.store(false, Ordering::Relaxed);
        }
    }
    assert!(!Path::new(&original.payload).exists());
    assert!(!Path::new(&original.key).exists());
    assert_eq!(fs::read_to_string(victim).unwrap(), "unrelated data");
}

#[test]
fn directory_recovery_rejects_a_destination_inside_the_saved_tree_through_another_source() {
    let root = TempDir::new().unwrap();
    let payload = root.path().join(format!(
        ".supercommander-{}.delete-directory",
        uuid::Uuid::new_v4()
    ));
    fs::create_dir(&payload).unwrap();
    fs::create_dir(payload.join("nested")).unwrap();
    fs::write(payload.join("file.txt"), "keep saved data").unwrap();
    let item = recovery::inspect(&LocalFs, payload.to_str().unwrap()).unwrap();
    let prepared = recovery::prepare(
        &LocalFs,
        "alias",
        &LocalFs,
        &RestoreOptions {
            key: item.key.clone(),
            revision: item.revision,
            connection: None,
            destination: location(&payload.join("nested")),
            name: "Must-not-copy".into(),
            replace: false,
        },
        &AtomicBool::new(false),
        &|_, _| {},
    )
    .unwrap();
    let sources = Arc::new(Sources::default());
    sources.insert("alias".into(), Arc::new(LocalFs));
    let (tx, rx) = mpsc::channel();
    let engine = Engine::new(
        sources,
        Arc::new(move |event| {
            let _ = tx.send(event);
        }),
    );
    engine
        .enqueue_recovery(uuid::Uuid::new_v4().to_string(), prepared)
        .unwrap();
    loop {
        let event = rx.recv_timeout(Duration::from_secs(10)).unwrap();
        if ["completed", "failed", "cancelled"].contains(&event.state.as_str()) {
            assert_eq!(event.state, "failed", "{:?}", event.errors);
            assert!(event
                .errors
                .iter()
                .any(|error| error.contains("outside the saved copy")));
            break;
        }
    }
    assert_eq!(
        fs::read_to_string(payload.join("file.txt")).unwrap(),
        "keep saved data"
    );
    assert_eq!(fs::read_dir(payload.join("nested")).unwrap().count(), 0);
}
#[test]
fn previous_versions_restore_with_a_review_and_keep_both_the_saved_and_current_copies() {
    let root = TempDir::new().unwrap();
    let item = saved(root.path(), "document.txt", "backup", "old contents");
    fs::write(root.path().join("document.txt"), "current contents").unwrap();
    let mut items = Vec::new();
    let batch = std::sync::Mutex::new(Vec::new());
    recovery::scan(
        &LocalFs,
        root.path().to_str().unwrap(),
        true,
        &AtomicBool::new(false),
        &|b| batch.lock().unwrap().extend(b.items),
    )
    .unwrap();
    items.extend(batch.into_inner().unwrap());
    assert_eq!(items.len(), 1);
    assert_eq!(
        items[0].original.as_deref(),
        root.path().join("document.txt").to_str()
    );
    let prepared = prepare(&item, root.path(), "document.txt", true);
    assert_eq!(prepared.summary.files, 1);
    assert_eq!(prepared.summary.replace, 1);
    let event = run(prepared);
    assert_eq!(event.state, "completed", "{:?}", event.errors);
    assert_eq!(event.preserved_count, 1);
    assert_eq!(
        fs::read_to_string(root.path().join("document.txt")).unwrap(),
        "old contents"
    );
    assert_eq!(fs::read_to_string(&item.payload).unwrap(), "old contents");
    assert!(Path::new(item.record.as_ref().unwrap()).exists());
    assert_eq!(
        fs::read_to_string(&event.preserved[0].path).unwrap(),
        "current contents"
    );
}
#[test]
fn orphan_temporary_copies_and_records_from_another_path_namespace_can_be_recovered() {
    let root = TempDir::new().unwrap();
    let file = root
        .path()
        .join(format!(".supercommander-{}.part", uuid::Uuid::new_v4()));
    fs::write(&file, "partial text").unwrap();
    let item = recovery::inspect(&LocalFs, file.to_str().unwrap()).unwrap();
    assert!(item.original.is_none());
    let e = run(prepare(&item, root.path(), "Recovered.txt", false));
    assert_eq!(e.state, "completed");
    assert_eq!(
        fs::read_to_string(root.path().join("Recovered.txt")).unwrap(),
        "partial text"
    );
    let legacy = saved(root.path(), "legacy.txt", "backup", "legacy data");
    let record = legacy.record.as_ref().unwrap();
    let payload = Path::new(&legacy.payload)
        .file_name()
        .unwrap()
        .to_str()
        .unwrap();
    fs::write(record,serde_json::to_vec(&serde_json::json!({"version":1,"kind":"backup","original":"C:\\old-machine\\legacy.txt","preserved":format!("C:\\old-machine\\{payload}")})).unwrap()).unwrap();
    let legacy = recovery::inspect(&LocalFs, record).unwrap();
    assert!(legacy.error.is_none());
    let e = run(prepare(&legacy, root.path(), "legacy.txt", false));
    assert_eq!(e.state, "completed", "{:?}", e.errors);
    assert_eq!(
        fs::read_to_string(root.path().join("legacy.txt")).unwrap(),
        "legacy data"
    );
}
#[test]
fn an_untrusted_record_cannot_redirect_reads_or_recovery_outside_its_payload_folder() {
    let root = TempDir::new().unwrap();
    let outside = TempDir::new().unwrap();
    let victim = outside.path().join("victim.txt");
    fs::write(&victim, "outside data").unwrap();
    let item = saved(root.path(), "old.txt", "backup", "real saved copy");
    fs::write(item.record.as_ref().unwrap(),serde_json::to_vec(&serde_json::json!({"version":1,"kind":"backup","original":outside.path().join("other.txt"),"preserved":victim})).unwrap()).unwrap();
    let item = recovery::inspect(&LocalFs, &item.key).unwrap();
    assert!(item.error.is_some());
    assert!(item.original.is_none());
    let event = run(prepare(&item, root.path(), "safe.txt", false));
    assert_eq!(event.state, "completed");
    assert_eq!(
        fs::read_to_string(root.path().join("safe.txt")).unwrap(),
        "real saved copy"
    );
    assert_eq!(fs::read_to_string(victim).unwrap(), "outside data");
}
#[test]
fn recovery_creates_nested_folders_and_never_deletes_a_preserved_directory() {
    let root = TempDir::new().unwrap();
    let payload = root.path().join(format!(
        ".supercommander-{}.move-directory",
        uuid::Uuid::new_v4()
    ));
    fs::create_dir_all(payload.join("nested/empty")).unwrap();
    fs::write(payload.join("nested/file.txt"), "directory data").unwrap();
    let key = format!("{}.recovery.json", payload.display());
    fs::write(&key,serde_json::to_vec(&serde_json::json!({"version":1,"kind":"move-directory","original":root.path().join("Folder"),"preserved":payload})).unwrap()).unwrap();
    let item = recovery::inspect(&LocalFs, &key).unwrap();
    let prepared = prepare(&item, root.path(), "Folder", false);
    assert_eq!(prepared.summary.files, 1);
    assert_eq!(prepared.summary.folders, 3);
    let event = run(prepared);
    assert_eq!(event.state, "completed", "{:?}", event.errors);
    assert_eq!(
        fs::read_to_string(root.path().join("Folder/nested/file.txt")).unwrap(),
        "directory data"
    );
    assert!(root.path().join("Folder/nested/empty").is_dir());
    assert!(payload.join("nested/file.txt").exists());
}
#[test]
fn changed_contents_need_a_new_name_and_late_destinations_never_get_overwritten() {
    let root = TempDir::new().unwrap();
    let item = saved(root.path(), "document.txt", "backup", "before");
    fs::write(&item.payload, "edited").unwrap();
    let item = recovery::inspect(&LocalFs, &item.key).unwrap();
    let options = RestoreOptions {
        key: item.key.clone(),
        revision: item.revision.clone(),
        connection: None,
        destination: location(root.path()),
        name: "document.txt".into(),
        replace: false,
    };
    assert!(recovery::prepare(
        &LocalFs,
        "local",
        &LocalFs,
        &options,
        &AtomicBool::new(false),
        &|_, _| {}
    )
    .is_err());
    let prepared = prepare(&item, root.path(), "Recovered.txt", false);
    assert!(prepared.summary.checksum_changed);
    fs::write(root.path().join("Recovered.txt"), "created after review").unwrap();
    let event = run(prepared);
    assert_eq!(event.state, "failed");
    assert_eq!(
        fs::read_to_string(root.path().join("Recovered.txt")).unwrap(),
        "created after review"
    );
    assert_eq!(fs::read_to_string(&item.payload).unwrap(), "edited");
}
