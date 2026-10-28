use anyhow::{bail, Result};
use commander_core::{
    filesystem::{FileSystem, LocalFs},
    recovery::{self, RestoreOptions},
    Entry, Location,
};
use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    },
};

struct StreamingTree {
    root: PathBuf,
    nested: bool,
    cancel_at: usize,
    produced: AtomicUsize,
    cancel: Arc<AtomicBool>,
}
impl FileSystem for StreamingTree {
    fn list(&self, _: &str) -> Result<Vec<Entry>> {
        bail!("Bulk directory collection is not supported by this streaming source")
    }
    fn stat(&self, p: &str) -> Result<Entry> {
        LocalFs.stat(p)
    }
    fn reader(&self, p: &str) -> Result<Box<dyn Read + Send>> {
        LocalFs.reader(p)
    }
    fn writer(&self, _: &str) -> Result<Box<dyn Write + Send>> {
        bail!("Planning must not write")
    }
    fn mkdir(&self, _: &str) -> Result<()> {
        bail!("Planning must not create directories")
    }
    fn rename(&self, _: &str, _: &str) -> Result<()> {
        bail!("Planning must not rename")
    }
    fn remove(&self, _: &str) -> Result<()> {
        bail!("Planning must not remove")
    }
    fn join(&self, p: &str, n: &str) -> String {
        LocalFs.join(p, n)
    }
    fn visit_entries(
        &self,
        p: &str,
        stop: &AtomicBool,
        send: &mut dyn FnMut(Result<Entry>),
    ) -> Result<()> {
        let count = if self.nested && Path::new(p) == self.root {
            2
        } else {
            1_000_000
        };
        for i in 0..count {
            if stop.load(Ordering::Relaxed) {
                break;
            }
            let produced = self.produced.fetch_add(1, Ordering::Relaxed) + 1;
            if produced == self.cancel_at {
                self.cancel.store(true, Ordering::Relaxed);
            }
            let name = if self.nested && Path::new(p) == self.root {
                ["nested", "later"][i].to_string()
            } else {
                format!("entry-{i}.txt")
            };
            send(Ok(Entry {
                path: self.join(p, &name),
                name,
                is_dir: self.nested && Path::new(p) == self.root,
                is_symlink: false,
                size: 0,
                modified: 0,
                hidden: false,
            }));
        }
        Ok(())
    }
}
fn check(nested: bool, cancel_at: usize, expected: &str, count: usize) {
    let root = tempfile::TempDir::new().unwrap();
    let payload = root.path().join(format!(
        ".supercommander-{}.delete-directory",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir(&payload).unwrap();
    if nested {
        std::fs::create_dir(payload.join("nested")).unwrap();
        std::fs::create_dir(payload.join("later")).unwrap();
    }
    let cancel = Arc::new(AtomicBool::new(false));
    let backend = StreamingTree {
        root: payload.clone(),
        nested,
        cancel_at,
        produced: AtomicUsize::new(0),
        cancel: cancel.clone(),
    };
    let item = recovery::inspect(&backend, payload.to_str().unwrap()).unwrap();
    let error = recovery::prepare(
        &backend,
        "stream",
        &LocalFs,
        &RestoreOptions {
            key: item.key,
            revision: item.revision,
            connection: None,
            destination: Location {
                source: "local".into(),
                path: root.path().to_string_lossy().into(),
            },
            name: "Must-not-create".into(),
            replace: false,
        },
        &cancel,
        &|_, _| {},
    )
    .err()
    .expect("A limited or cancelled plan cannot become actionable");
    assert!(error.to_string().contains(expected), "{error:#}");
    assert_eq!(backend.produced.load(Ordering::Relaxed), count);
    assert!(!root.path().join("Must-not-create").exists());
}
#[test]
fn a_million_entry_folder_stops_streaming_at_the_global_recovery_limit() {
    check(false, usize::MAX, "supported size", 200_000);
}
#[test]
fn recovery_reserves_budget_for_unvisited_siblings_before_reading_a_nested_folder() {
    check(true, usize::MAX, "supported size", 200_000);
}
#[test]
fn cancelling_during_directory_enumeration_stops_before_collecting_the_rest() {
    check(false, 50, "Cancelled", 50);
}
