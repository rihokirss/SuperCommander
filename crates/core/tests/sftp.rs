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
    fs::write(&config,format!("Port {port}\nListenAddress 127.0.0.1\nHostKey {}\nPidFile {}/sshd.pid\nAuthorizedKeysFile {}.pub\nStrictModes no\nUsePAM no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPubkeyAuthentication yes\nAllowUsers {username}\nSubsystem sftp internal-sftp\nLogLevel ERROR\n",host.display(),directory.path().display(),key.display())).unwrap();
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
        assert!(descendant.errors.join(" ").contains("into itself"));
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
