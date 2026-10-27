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
