#![cfg(unix)]
use commander_core::{filesystem::FileSystem, remote, SftpProfile};
use std::{
    fs,
    io::{Read, Write},
    net::TcpListener,
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};
use tempfile::TempDir;

struct Server {
    child: Child,
    _directory: TempDir,
    profile: SftpProfile,
}
impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
fn start() -> Server {
    let directory = TempDir::new().unwrap();
    let host = directory.path().join("host");
    let key = directory.path().join("client");
    for path in [&host, &key] {
        assert!(Command::new("ssh-keygen")
            .args(["-q", "-t", "ed25519", "-N", "", "-f"])
            .arg(path)
            .status()
            .unwrap()
            .success());
    }
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let username = std::env::var("USER").unwrap();
    let config = directory.path().join("sshd_config");
    fs::write(&config,format!("Port {port}\nListenAddress 127.0.0.1\nHostKey {}\nPidFile {}/sshd.pid\nAuthorizedKeysFile {}.pub\nStrictModes no\nUsePAM no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPubkeyAuthentication yes\nAllowUsers {username}\nSubsystem sftp internal-sftp\nLogLevel ERROR\nSetEnv HISTFILE={}/shell-history\n",host.display(),directory.path().display(),key.display(),directory.path().display())).unwrap();
    let child = Command::new("/usr/sbin/sshd")
        .arg("-D")
        .arg("-e")
        .arg("-f")
        .arg(config)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("Install openssh-server to run this integration test");
    let end = Instant::now() + Duration::from_secs(5);
    while std::net::TcpStream::connect(("127.0.0.1", port)).is_err() {
        assert!(Instant::now() < end, "sshd did not start");
        std::thread::sleep(Duration::from_millis(30));
    }
    Server {
        child,
        _directory: directory,
        profile: SftpProfile {
            id: "test".into(),
            name: "Test".into(),
            host: "127.0.0.1".into(),
            port,
            username,
            key_path: key.to_string_lossy().into_owned(),
            save_secret: false,
        },
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "Requires local OpenSSH server and ssh-keygen"]
async fn reviewed_remote_rename_checks_contents_and_connection_before_claiming() {
    use commander_core::{rename, RenameRules};
    use std::sync::atomic::AtomicBool;
    let server = start();
    let (probe, _) = remote::connect(&server.profile, "", None).await.unwrap();
    let (_, first) = remote::connect(&server.profile, "", Some(probe.fingerprint.clone()))
        .await
        .unwrap();
    let (_, second) = remote::connect(&server.profile, "", Some(probe.fingerprint))
        .await
        .unwrap();
    let (first, second) = (first.unwrap(), second.unwrap());
    let folder = server._directory.path().join("rename");
    fs::create_dir(&folder).unwrap();
    tokio::task::spawn_blocking(move || {
        let file = folder.join("source.txt");
        fs::write(&file, "before").unwrap();
        let paths = vec![file.to_string_lossy().into_owned()];
        let rules = RenameRules {
            find: String::new(),
            replace: String::new(),
            regex: false,
            case_mode: "keep".into(),
            numbering: false,
            start: 1,
            prefix: "new-".into(),
        };
        let cancel = AtomicBool::new(false);
        let plan = rename::prepare(first.as_ref(), &paths, &rules, &cancel).unwrap();
        let modified = fs::metadata(&file).unwrap().modified().unwrap();
        fs::write(&file, "edited").unwrap();
        fs::OpenOptions::new()
            .write(true)
            .open(&file)
            .unwrap()
            .set_modified(modified)
            .unwrap();
        assert!(rename::apply_prepared(first.as_ref(), &plan, &cancel).is_err());
        assert!(!folder.join("new-source.txt").exists());
        let plan = rename::prepare(first.as_ref(), &paths, &rules, &cancel).unwrap();
        assert!(rename::apply_prepared(second.as_ref(), &plan, &cancel).is_err());
        rename::apply_prepared(first.as_ref(), &plan, &cancel).unwrap();
        assert_eq!(
            fs::read_to_string(folder.join("new-source.txt")).unwrap(),
            "edited"
        );
        let dir = folder.join("directory");
        fs::create_dir(&dir).unwrap();
        fs::write(dir.join("child.txt"), "child").unwrap();
        let plan = rename::prepare(
            first.as_ref(),
            &[dir.to_string_lossy().into_owned()],
            &rules,
            &cancel,
        )
        .unwrap();
        rename::apply_prepared(first.as_ref(), &plan, &cancel).unwrap();
        assert_eq!(
            fs::read_to_string(folder.join("new-directory/child.txt")).unwrap(),
            "child"
        );
        assert!(fs::read_dir(folder).unwrap().all(|e| !e
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".supercommander-")));
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "Requires local OpenSSH server and ssh-keygen"]
async fn directory_comparison_synchronizes_reviewed_local_and_ssh_snapshots() {
    use commander_core::{
        comparison::{self, Choice, Direction, Options},
        engine::Engine,
        filesystem::{LocalFs, Sources},
        Location,
    };
    use std::sync::{atomic::AtomicBool, mpsc, Arc};
    let server = start();
    let (probe, _) = remote::connect(&server.profile, "", None).await.unwrap();
    let (_, first) = remote::connect(&server.profile, "", Some(probe.fingerprint.clone()))
        .await
        .unwrap();
    let (_, second) = remote::connect(&server.profile, "", Some(probe.fingerprint))
        .await
        .unwrap();
    let (first, second) = (first.unwrap(), second.unwrap());
    let left = server._directory.path().join("local");
    let right = server._directory.path().join("remote");
    fs::create_dir(&left).unwrap();
    fs::create_dir(&right).unwrap();
    fs::create_dir_all(left.join("new/empty")).unwrap();
    fs::write(left.join("new/file.txt"), "new contents").unwrap();
    fs::write(left.join("replace.bin"), b"\0before\xff").unwrap();
    fs::write(right.join("replace.bin"), b"\0edited\xff").unwrap();
    fs::write(right.join("remote.txt"), "remote payload").unwrap();
    let time = std::time::UNIX_EPOCH + Duration::from_secs(1_700_000_000);
    for root in [&left, &right] {
        fs::OpenOptions::new()
            .write(true)
            .open(root.join("replace.bin"))
            .unwrap()
            .set_modified(time)
            .unwrap();
    }
    tokio::task::spawn_blocking(move || {
        let cancel = AtomicBool::new(false);
        let plan = Arc::new(
            comparison::scan(
                &LocalFs,
                first.as_ref(),
                Location {
                    source: "local".into(),
                    path: left.to_string_lossy().into(),
                },
                Location {
                    source: "sftp:reviewed".into(),
                    path: right.to_string_lossy().into(),
                },
                Options::default(),
                &cancel,
                &|_| {},
            )
            .unwrap(),
        );
        assert_eq!(
            plan.rows
                .iter()
                .find(|r| r.path == "replace.bin")
                .unwrap()
                .status,
            "different"
        );
        let choices: Vec<_> = [
            ("new", Direction::LeftToRight),
            ("new/empty", Direction::LeftToRight),
            ("new/file.txt", Direction::LeftToRight),
            ("replace.bin", Direction::LeftToRight),
            ("remote.txt", Direction::RightToLeft),
        ]
        .into_iter()
        .map(|(name, direction)| Choice {
            id: plan.rows.iter().find(|r| r.path == name).unwrap().id,
            direction,
        })
        .collect();
        assert!(
            comparison::prepare(plan.clone(), &choices, &LocalFs, second.as_ref(), &cancel)
                .is_err()
        );
        let prepared =
            comparison::prepare(plan, &choices, &LocalFs, first.as_ref(), &cancel).unwrap();
        let sources = Arc::new(Sources::default());
        sources.insert("sftp:reviewed".into(), first);
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
        let event = loop {
            let event = rx.recv_timeout(Duration::from_secs(30)).unwrap();
            if ["completed", "failed", "cancelled"].contains(&event.state.as_str()) {
                break event;
            }
        };
        assert_eq!(event.state, "completed", "{:?}", event.errors);
        assert_eq!(
            fs::read(right.join("replace.bin")).unwrap(),
            b"\0before\xff"
        );
        assert_eq!(fs::read(&event.preserved[0].path).unwrap(), b"\0edited\xff");
        assert!(right.join("new/empty").is_dir());
        assert_eq!(
            fs::read_to_string(right.join("new/file.txt")).unwrap(),
            "new contents"
        );
        assert_eq!(
            fs::read_to_string(left.join("remote.txt")).unwrap(),
            "remote payload"
        );
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "Requires local OpenSSH server and ssh-keygen"]
async fn cross_protocol_moves_and_copies_preserve_aliases_and_transfer_metadata() {
    use commander_core::{
        engine::Engine, filesystem::Sources, Conflict, JobRequest, Location, Operation,
    };
    use std::{
        os::unix::fs::{symlink, PermissionsExt},
        sync::{mpsc, Arc},
    };
    let server = start();
    let (probe, _) = remote::connect(&server.profile, "", None).await.unwrap();
    let (_, first) = remote::connect(&server.profile, "", Some(probe.fingerprint.clone()))
        .await
        .unwrap();
    let (_, second) = remote::connect(&server.profile, "", Some(probe.fingerprint))
        .await
        .unwrap();
    let (first, second) = (first.unwrap(), second.unwrap());
    let directory = server._directory.path().join("alias-transfer");
    fs::create_dir(&directory).unwrap();
    let alias = directory.with_file_name("another-path");
    symlink(&directory, &alias).unwrap();
    let sources = Arc::new(Sources::default());
    sources.insert("sftp:first".into(), first.clone());
    sources.insert("sftp:second".into(), second.clone());
    tokio::task::spawn_blocking(move || {
        let (tx, rx) = mpsc::channel();
        let engine = Engine::new(
            sources,
            Arc::new(move |e| {
                let _ = tx.send(e);
            }),
        );
        let run = |operation,
                   source: &str,
                   path: &std::path::Path,
                   destination: &str,
                   target: &std::path::Path| {
            engine
                .enqueue(JobRequest {
                    id: uuid::Uuid::new_v4().to_string(),
                    operation,
                    source: source.into(),
                    paths: vec![path.to_string_lossy().into()],
                    destination: Location {
                        source: destination.into(),
                        path: target.to_string_lossy().into(),
                    },
                    conflict: Conflict::Replace,
                    source_connection: None,
                    destination_connection: None,
                    source_bindings: None,
                })
                .unwrap();
            loop {
                let e = rx.recv_timeout(Duration::from_secs(20)).unwrap();
                if ["completed", "failed", "cancelled"].contains(&e.state.as_str()) {
                    break e;
                }
            }
        };
        let file = directory.join("Õunad.txt");
        fs::write(&file, "must survive through both aliases").unwrap();
        for (source, destination) in [
            ("sftp:first", "local"),
            ("local", "sftp:first"),
            ("sftp:first", "sftp:second"),
        ] {
            for operation in [Operation::Copy, Operation::Move] {
                let event = run(operation, source, &file, destination, &alias);
                assert_eq!(event.state, "failed", "{:?}", event.errors);
                assert_eq!(
                    fs::read_to_string(&file).unwrap(),
                    "must survive through both aliases"
                );
                assert_eq!(fs::read_dir(&directory).unwrap().count(), 1);
            }
        }
        let folder = directory.join("folder");
        fs::create_dir_all(folder.join("child")).unwrap();
        fs::write(folder.join("original.txt"), "unchanged source tree").unwrap();
        for target in [&alias, &alias.join("folder/child")] {
            let event = run(Operation::Move, "sftp:first", &folder, "local", target);
            assert_eq!(event.state, "failed", "{:?}", event.errors);
            assert_eq!(
                fs::read_to_string(folder.join("original.txt")).unwrap(),
                "unchanged source tree"
            );
            assert_eq!(fs::read_dir(folder.join("child")).unwrap().count(), 0);
        }
        let dest = directory.join("destination");
        fs::create_dir(&dest).unwrap();
        let private = dest.join("private.part");
        let mut private_writer = second.private_writer(private.to_str().unwrap()).unwrap();
        assert_eq!(
            fs::metadata(&private).unwrap().permissions().mode() & 0o777,
            0o600
        );
        private_writer
            .write_all(b"private staging payload")
            .unwrap();
        private_writer.flush().unwrap();
        drop(private_writer);
        second.remove_file(private.to_str().unwrap()).unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o640)).unwrap();
        let modified = std::time::UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        fs::OpenOptions::new()
            .write(true)
            .open(&file)
            .unwrap()
            .set_modified(modified)
            .unwrap();
        let event = run(Operation::Move, "sftp:first", &file, "sftp:second", &dest);
        assert_eq!(event.state, "completed", "{:?}", event.errors);
        assert!(!file.exists());
        let saved = dest.join("Õunad.txt");
        assert_eq!(
            fs::read_to_string(&saved).unwrap(),
            "must survive through both aliases"
        );
        assert_eq!(fs::metadata(&saved).unwrap().modified().unwrap(), modified);
        assert_eq!(
            fs::metadata(&saved).unwrap().permissions().mode() & 0o777,
            0o640
        );
        let event = run(Operation::Move, "sftp:first", &folder, "local", &dest);
        assert_eq!(event.state, "completed", "{:?}", event.errors);
        assert!(!folder.exists());
        assert_eq!(
            fs::read_to_string(dest.join("folder/original.txt")).unwrap(),
            "unchanged source tree"
        );
        FileSystem::close(first.as_ref()).unwrap();
        FileSystem::close(second.as_ref()).unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "Requires local OpenSSH server and ssh-keygen"]
async fn remote_properties_preserve_permissions_and_reject_replaced_connections() {
    use commander_core::properties::{self, Changes, SizeSummary};
    use std::{
        os::unix::fs::{symlink, PermissionsExt},
        sync::{atomic::AtomicBool, Mutex},
    };
    let server = start();
    let (probe, _) = remote::connect(&server.profile, "", None).await.unwrap();
    let (_, first) = remote::connect(&server.profile, "", Some(probe.fingerprint.clone()))
        .await
        .unwrap();
    let (_, second) = remote::connect(&server.profile, "", Some(probe.fingerprint))
        .await
        .unwrap();
    let (first, second) = (first.unwrap(), second.unwrap());
    let directory = server._directory.path().join("attributes");
    fs::create_dir(&directory).unwrap();
    let file = directory.join("file.txt");
    fs::write(&file, "preserved").unwrap();
    fs::set_permissions(&file, fs::Permissions::from_mode(0o640)).unwrap();
    symlink(&file, directory.join("link")).unwrap();
    tokio::task::spawn_blocking(move || {
        let path = file.to_str().unwrap();
        let info = properties::get(first.as_ref(), path).unwrap();
        assert_eq!(info.mode, Some(0o640));
        assert!(info.uid.is_some() && info.gid.is_some() && info.editable.mode);
        let changes = Changes {
            mode_set: 0o004,
            mode_clear: 0o020,
            ..Changes::default()
        };
        assert!(properties::apply(second.as_ref(), path, &info.revision, &changes).is_err());
        let changed = properties::apply(first.as_ref(), path, &info.revision, &changes).unwrap();
        assert_eq!(changed.mode, Some(0o644));
        assert!(properties::apply(first.as_ref(), path, &info.revision, &changes).is_err());
        let link = directory.join("link");
        let link = link.to_str().unwrap();
        let info = properties::get(first.as_ref(), link).unwrap();
        assert!(info.file.is_symlink && !info.editable.mode);
        assert_eq!(info.link_target.as_deref(), Some(path));
        assert!(properties::apply(first.as_ref(), link, &info.revision, &changes).is_err());
        assert_eq!(fs::read_to_string(&file).unwrap(), "preserved");
        let search_result = Mutex::new(commander_core::search::Batch::default());
        commander_core::search::run(
            first.as_ref(),
            directory.to_str().unwrap(),
            &commander_core::SearchFilter {
                content: "preserved".into(),
                ..Default::default()
            },
            &AtomicBool::new(false),
            &|batch| *search_result.lock().unwrap() = batch,
        )
        .unwrap();
        let search_result = search_result.into_inner().unwrap();
        assert_eq!(search_result.found, 1);
        assert_eq!(search_result.error_count, 0);
        assert_eq!(search_result.connection.as_deref(), first.connection_id());
        let fifo = directory.join("pipe");
        assert!(Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .unwrap()
            .success());
        assert!(first.reader(fifo.to_str().unwrap()).is_err());
        fs::remove_file(fifo).unwrap();
        let result = Mutex::new(SizeSummary::default());
        properties::calculate(
            first.as_ref(),
            &[directory.to_str().unwrap().into()],
            &AtomicBool::new(false),
            &|summary| *result.lock().unwrap() = summary,
        )
        .unwrap();
        let result = result.into_inner().unwrap();
        assert_eq!(
            (
                result.files,
                result.folders,
                result.links,
                result.bytes,
                result.error_count
            ),
            (1, 1, 1, 9, 0)
        );
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "Requires local OpenSSH server and ssh-keygen"]
async fn queued_ssh_jobs_and_clipboards_do_not_rebind_to_replacement_connections() {
    use commander_core::{
        clipboard::Files, engine::Engine, filesystem::Sources, Conflict, JobRequest, Location,
        Operation,
    };
    use std::sync::{mpsc, Arc};
    let server = start();
    let (probe, _) = remote::connect(&server.profile, "", None).await.unwrap();
    let (_, first) = remote::connect(&server.profile, "", Some(probe.fingerprint.clone()))
        .await
        .unwrap();
    let (_, second) = remote::connect(&server.profile, "", Some(probe.fingerprint))
        .await
        .unwrap();
    let first = first.unwrap();
    let second = second.unwrap();
    assert_ne!(first.connection_id(), second.connection_id());
    let root = server._directory.path().to_path_buf();
    tokio::task::spawn_blocking(move || {
        let path = |p: &std::path::Path| p.to_string_lossy().into_owned();
        let source = root.join("remote.txt");
        fs::write(&source, "must remain on the original server").unwrap();
        let clipboard = Files {
            source: "sftp:test".into(),
            paths: vec![path(&source)],
            cut: true,
            revision: 0,
            connection: first.connection_id().map(str::to_owned),
            bindings: None,
        };
        assert!(clipboard.validate_source(first.as_ref()).is_ok());
        assert!(clipboard.validate_source(second.as_ref()).is_err());
        assert!(Files {
            connection: None,
            ..clipboard
        }
        .validate_source(first.as_ref())
        .is_err());

        let destination = root.join("destination");
        fs::create_dir(&destination).unwrap();
        let hold = root.join("hold.txt");
        fs::write(&hold, "new").unwrap();
        fs::write(destination.join("hold.txt"), "existing").unwrap();
        let sources = Arc::new(Sources::default());
        sources.insert("sftp:test".into(), first.clone());
        let (tx, rx) = mpsc::channel();
        let engine = Engine::new(
            sources.clone(),
            Arc::new(move |event| {
                let _ = tx.send(event);
            }),
        );
        let blocking = JobRequest {
            id: "hold".into(),
            operation: Operation::Copy,
            source: "local".into(),
            paths: vec![path(&hold)],
            destination: Location {
                source: "local".into(),
                path: path(&destination),
            },
            conflict: Conflict::Ask,
            source_connection: None,
            destination_connection: None,
            source_bindings: None,
        };
        engine.enqueue(blocking.clone()).unwrap();
        loop {
            let event = rx.recv_timeout(Duration::from_secs(15)).unwrap();
            if event.state == "conflict" {
                break;
            }
            assert_ne!(event.state, "failed");
        }
        let queued = JobRequest {
            id: "old-session".into(),
            source: "sftp:test".into(),
            paths: vec![path(&source)],
            source_connection: first.connection_id().map(str::to_owned),
            ..blocking
        };
        engine.enqueue(queued.clone()).unwrap();
        sources.insert("sftp:test".into(), second.clone());
        // A clipboard plan created before reconnecting must also be rejected at enqueue.
        assert!(engine
            .enqueue(JobRequest {
                id: "stale-plan".into(),
                ..queued
            })
            .is_err());
        FileSystem::close(first.as_ref()).unwrap();
        engine.cancel("hold");
        loop {
            let event = rx.recv_timeout(Duration::from_secs(15)).unwrap();
            if event.id == "old-session"
                && ["completed", "failed", "cancelled"].contains(&event.state.as_str())
            {
                assert_eq!(
                    event.state, "failed",
                    "an old job used the replacement SSH connection"
                );
                break;
            }
        }
        assert!(!destination.join("remote.txt").exists());
        assert_eq!(
            fs::read_to_string(source).unwrap(),
            "must remain on the original server"
        );
        assert!(
            !second.list("/").unwrap().is_empty(),
            "replacement connection remains usable"
        );
        FileSystem::close(second.as_ref()).unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "Requires local OpenSSH server and ssh-keygen"]
async fn clipboard_selection_checks_remote_contents_before_paste_and_can_be_cancelled() {
    use commander_core::{
        clipboard::Files,
        engine::Engine,
        filesystem::{LocalFs, Sources},
        Conflict, JobRequest, Location, Operation,
    };
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    };
    let server = start();
    let (probe, _) = remote::connect(&server.profile, "", None).await.unwrap();
    let (_, connection) = remote::connect(&server.profile, "", Some(probe.fingerprint))
        .await
        .unwrap();
    let connection = connection.unwrap();
    let root = server._directory.path().to_path_buf();
    tokio::task::spawn_blocking(move || {
        let source = root.join("selected.txt");
        let target = root.join("Target");
        fs::create_dir(&target).unwrap();
        fs::write(&source, "before").unwrap();
        let mut value = Files {
            source: "sftp:clipboard".into(),
            paths: vec![source.to_string_lossy().into()],
            cut: true,
            revision: 0,
            connection: None,
            bindings: None,
        };
        value
            .capture_selection(connection.as_ref(), &AtomicBool::new(false), &|_| {})
            .unwrap();
        let props = LocalFs.properties(source.to_str().unwrap()).unwrap();
        fs::rename(&source, root.join("Kept.txt")).unwrap();
        fs::write(&source, "edited").unwrap();
        LocalFs
            .transfer_metadata(source.to_str().unwrap(), &props)
            .unwrap();
        let sources = Arc::new(Sources::default());
        sources.insert(value.source.clone(), connection.clone());
        let (tx, rx) = mpsc::channel();
        let engine = Engine::new(
            sources,
            Arc::new(move |event| {
                let _ = tx.send(event);
            }),
        );
        for (id, operation, expected) in [
            ("stale", Operation::Move, "failed"),
            ("fresh", Operation::Copy, "completed"),
        ] {
            if id == "fresh" {
                value
                    .capture_selection(connection.as_ref(), &AtomicBool::new(false), &|_| {})
                    .unwrap();
            }
            engine
                .enqueue(JobRequest {
                    id: id.into(),
                    operation,
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
                })
                .unwrap();
            loop {
                let event = rx.recv_timeout(Duration::from_secs(15)).unwrap();
                if event.id == id
                    && ["completed", "failed", "cancelled"].contains(&event.state.as_str())
                {
                    assert_eq!(event.state, expected, "{:?}", event.errors);
                    if id == "stale" {
                        assert!(event
                            .errors
                            .iter()
                            .any(|error| error.contains("clipboard source")));
                        assert_eq!(fs::read_dir(&target).unwrap().count(), 0);
                    }
                    break;
                }
            }
        }
        assert_eq!(fs::read_to_string(&source).unwrap(), "edited");
        assert_eq!(
            fs::read_to_string(target.join("selected.txt")).unwrap(),
            "edited"
        );
        let cancel = AtomicBool::new(false);
        let error = value
            .capture_selection(connection.as_ref(), &cancel, &|progress| {
                if progress.bytes > 0 {
                    cancel.store(true, Ordering::Relaxed);
                }
            })
            .unwrap_err();
        assert!(error.to_string().contains("Cancelled"));
        assert!(value.bindings.is_none());
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "Requires local OpenSSH server and ssh-keygen"]
async fn remote_terminal_prompt_markers_follow_the_real_shell() {
    let server = start();
    let (probe, _) = remote::connect(&server.profile, "", None).await.unwrap();
    let (_, fs) = remote::connect(&server.profile, "", Some(probe.fingerprint))
        .await
        .unwrap();
    let fs = fs.unwrap();
    let output = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let received = output.clone();
    let marker = "1234567890abcdef1234567890abcdef";
    let shell = fs
        .open_terminal_with_marker(
            std::sync::Arc::new(move |data| received.lock().unwrap().extend(data)),
            Some(marker),
        )
        .await
        .unwrap();
    let prefix = format!("\x1b]633;SC:{marker}:");
    let count = || {
        String::from_utf8_lossy(&output.lock().unwrap())
            .matches(&prefix)
            .count()
    };
    tokio::time::timeout(Duration::from_secs(15), async {
        while count() == 0 {
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
    })
    .await
    .expect("interactive shell did not emit its prompt marker");
    let initial = count();
    fs.write_terminal(
        &shell,
        b"printf 'SC_BUSY_BEGIN\\n'; sleep 2; printf 'SC_BUSY_END\\n'\r".to_vec(),
    )
    .await
    .unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if String::from_utf8_lossy(&output.lock().unwrap()).contains("SC_BUSY_BEGIN\r\n") {
                break;
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        count(),
        initial,
        "running command must not be mistaken for a prompt"
    );
    tokio::time::timeout(Duration::from_secs(8), async {
        while count() == initial {
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
    })
    .await
    .expect("shell did not report its next prompt");
    use base64::Engine as _;
    let folder = server._directory.path().join("O'Brien õ folder");
    std::fs::create_dir(&folder).unwrap();
    let target = folder.to_string_lossy();
    fs.write_terminal(
        &shell,
        b"printf 'SC_%s\\n' USER_HISTORY_SENTINEL\r".to_vec(),
    )
    .await
    .unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    let encoded = base64::engine::general_purpose::STANDARD.encode(target.as_bytes());
    fs.write_terminal(
        &shell,
        format!("SC{marker}:{encoded}\x1b[633;{marker}~").into_bytes(),
    )
    .await
    .unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while !String::from_utf8_lossy(&output.lock().unwrap())
            .contains(&format!("{prefix}{encoded}\x07"))
        {
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
    })
    .await
    .expect("widget did not change directories");
    fs.write_terminal(&shell, b"\x1b[A\r".to_vec())
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while String::from_utf8_lossy(&output.lock().unwrap())
            .matches("SC_USER_HISTORY_SENTINEL\r\n")
            .count()
            < 2
        {
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
    })
    .await
    .expect("Up recalled an automatic command instead of the user command");
    fs.close_terminal(&shell).await.unwrap();
    fs.close().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "Requires local OpenSSH server and ssh-keygen"]
async fn verifies_host_authenticates_and_transfers_over_real_sftp() {
    let server = start();
    let (probe, fs) = remote::connect(&server.profile, "", None).await.unwrap();
    assert!(probe.needs_trust);
    assert!(fs.is_none());
    assert!(probe.fingerprint.starts_with("SHA256:"));
    let (mismatch, fs) = remote::connect(&server.profile, "", Some("SHA256:wrong".into()))
        .await
        .unwrap();
    assert!(mismatch.needs_trust);
    assert!(fs.is_none());
    let (result, fs) = remote::connect(&server.profile, "", Some(probe.fingerprint.clone()))
        .await
        .unwrap();
    assert!(!result.needs_trust);
    let fs = fs.unwrap();
    let dir = server
        ._directory
        .path()
        .join("transfer")
        .to_string_lossy()
        .into_owned();
    let remote = fs.clone();
    tokio::task::spawn_blocking(move || {
        remote.mkdir(&dir).unwrap();
        let file = remote.join(&dir, "Õunad.txt");
        let mut writer = remote.writer(&file).unwrap();
        writer.write_all(b"SFTP round trip").unwrap();
        writer.flush().unwrap();
        drop(writer);
        let mut text = String::new();
        remote
            .reader(&file)
            .unwrap()
            .read_to_string(&mut text)
            .unwrap();
        assert_eq!(text, "SFTP round trip");
        assert_eq!(remote.list(&dir).unwrap().len(), 1);
        let renamed = remote.join(&dir, "renamed.txt");
        remote.rename(&file, &renamed).unwrap();
        assert!(!remote.exists(&file).unwrap());
        // REALPATH must protect transfers even when the destination is reached
        // through an alias, or contains a parent-directory segment.
        let root = std::path::Path::new(&dir);
        let inner = root.join("inner");
        fs::create_dir(&inner).unwrap();
        let alias = root.with_file_name("transfer-alias");
        let descendant_alias = root.with_file_name("descendant-alias");
        std::os::unix::fs::symlink(root, &alias).unwrap();
        std::os::unix::fs::symlink(&inner, &descendant_alias).unwrap();
        let sources = std::sync::Arc::new(commander_core::filesystem::Sources::default());
        sources.insert("sftp:test".into(), remote.clone());
        let (tx, rx) = std::sync::mpsc::channel();
        let engine = commander_core::engine::Engine::new(
            sources,
            std::sync::Arc::new(move |event| {
                let _ = tx.send(event);
            }),
        );
        let run = |operation, source: &str, destination: &str, conflict| {
            engine
                .enqueue(commander_core::JobRequest {
                    id: uuid::Uuid::new_v4().to_string(),
                    operation,
                    source: "sftp:test".into(),
                    paths: vec![source.into()],
                    destination: commander_core::Location {
                        source: "sftp:test".into(),
                        path: destination.into(),
                    },
                    conflict,
                    source_connection: None,
                    destination_connection: None,
                    source_bindings: None,
                })
                .unwrap();
            loop {
                let event = rx.recv_timeout(Duration::from_secs(15)).unwrap();
                if ["failed", "completed", "cancelled"].contains(&event.state.as_str()) {
                    return event;
                }
            }
        };
        use commander_core::{Conflict, Operation};
        let descendant = run(
            Operation::Copy,
            &dir,
            &descendant_alias.to_string_lossy(),
            Conflict::Replace,
        );
        assert_eq!(descendant.state, "failed");
        assert!(
            descendant.errors.join(" ").contains("into itself"),
            "{:?}",
            descendant.errors
        );
        let parent_segment = run(
            Operation::Copy,
            &dir,
            &format!("{dir}/inner/.."),
            Conflict::Replace,
        );
        assert_eq!(parent_segment.state, "failed");
        assert!(parent_segment.errors.join(" ").contains("into itself"));
        let same = run(
            Operation::Move,
            &renamed,
            &alias.to_string_lossy(),
            Conflict::Replace,
        );
        assert_eq!(same.state, "failed");
        assert_eq!(fs::read_to_string(&renamed).unwrap(), "SFTP round trip");
        let duplicate = run(
            Operation::Copy,
            &renamed,
            &alias.to_string_lossy(),
            Conflict::KeepBoth,
        );
        assert_eq!(duplicate.state, "completed", "{:?}", duplicate.errors);
        assert_eq!(
            fs::read_to_string(root.join("renamed (1).txt")).unwrap(),
            "SFTP round trip"
        );
        assert!(fs::read_dir(&inner).unwrap().next().is_none());
        fs::remove_file(alias).unwrap();
        fs::remove_file(descendant_alias).unwrap();
        let new_file = remote.join(&dir, "new-editor.txt");
        let blank = commander_core::editor::prepare(remote.as_ref(), &new_file).unwrap();
        assert!(blank.revision.is_empty());
        assert_eq!(blank.connection.as_deref(), remote.connection_id());
        assert!(!remote.exists(&new_file).unwrap());
        let format = commander_core::editor::Format {
            encoding: "UTF-8 BOM".into(),
            line_ending: "CRLF".into(),
        };
        let saved =
            commander_core::editor::write(remote.as_ref(), &new_file, "Õunad\n", None, &format)
                .unwrap();
        assert_eq!(saved.text, "Õunad\n");
        assert!(remote.rename_new(&new_file, &renamed).is_err());
        let updated = commander_core::editor::write(
            remote.as_ref(),
            &new_file,
            "Changed\n",
            Some(&saved.revision),
            &format,
        )
        .unwrap();
        assert_eq!(updated.text, "Changed\n");
        assert_eq!(fs::read_to_string(&renamed).unwrap(), "SFTP round trip");
        remote.remove(&dir).unwrap();
    })
    .await
    .unwrap();
    let mut bad_profile = server.profile.clone();
    bad_profile.key_path.clear();
    assert!(
        remote::connect(&bad_profile, "wrong-password", Some(probe.fingerprint))
            .await
            .is_err()
    );
    let echo = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let echo_port = echo.local_addr().unwrap().port();
    let echo_task = tokio::spawn(async move {
        loop {
            let (mut socket, _) = echo.accept().await.unwrap();
            tokio::spawn(async move {
                let (mut read, mut write) = socket.split();
                let _ = tokio::io::copy(&mut read, &mut write).await;
            });
        }
    });
    let tunnel = fs
        .start_forward(0, "127.0.0.1".into(), echo_port)
        .await
        .unwrap();
    assert_eq!(fs.forwards().len(), 1);
    let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", tunnel.local_port))
        .await
        .unwrap();
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    stream
        .write_all(b"through the existing SSH session")
        .await
        .unwrap();
    let mut answer = [0; 32];
    tokio::time::timeout(Duration::from_secs(5), stream.read_exact(&mut answer))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(&answer, b"through the existing SSH session");
    drop(stream);
    fs.stop_forward(&tunnel.id).await.unwrap();
    assert!(
        tokio::net::TcpStream::connect(("127.0.0.1", tunnel.local_port))
            .await
            .is_err()
    );
    assert!(fs.forwards().is_empty());
    let second = fs
        .start_forward(0, "127.0.0.1".into(), echo_port)
        .await
        .unwrap();
    // A PTY shell shares the authenticated SSH connection with SFTP and both tunnels.
    let output = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let received = output.clone();
    let shell = fs
        .open_terminal(std::sync::Arc::new(move |data| {
            received.lock().unwrap().extend(data)
        }))
        .await
        .unwrap();
    fs.resize_terminal(&shell, 30, 120).await.unwrap();
    fs.write_terminal(
        &shell,
        b"printf 'SC_SHELL_%s\\n' \"$(uname -s)\"\r".to_vec(),
    )
    .await
    .unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if String::from_utf8_lossy(&output.lock().unwrap()).contains("SC_SHELL_Linux") {
                break;
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
    })
    .await
    .unwrap();
    fs.close_terminal(&shell).await.unwrap();
    let sftp = fs.clone();
    assert!(!tokio::task::spawn_blocking(move || sftp.list("/"))
        .await
        .unwrap()
        .unwrap()
        .is_empty());
    assert_eq!(fs.forwards().len(), 1);
    fs.close().await.unwrap();
    assert!(
        tokio::net::TcpStream::connect(("127.0.0.1", second.local_port))
            .await
            .is_err()
    );
    echo_task.abort();
    let remote = fs.clone();
    assert!(tokio::task::spawn_blocking(move || remote.list("/"))
        .await
        .unwrap()
        .is_err());
}
