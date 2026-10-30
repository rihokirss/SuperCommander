use crate::{filesystem::FileSystem, Entry, SftpProfile};
use anyhow::{bail, Context, Result};
use russh::{
    client,
    keys::{HashAlg, PrivateKeyWithHashAlg, PublicKeyOrCertificate},
};
use russh_sftp::{
    client::{fs::File, SftpSession},
    protocol::OpenFlags,
};
use serde::Serialize;
use std::{
    collections::HashMap,
    io::{Read, Write},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    runtime::Handle,
};

struct Verify {
    expected: Option<String>,
    observed: Arc<Mutex<Option<String>>>,
}
impl client::Handler for Verify {
    type Error = anyhow::Error;
    async fn check_server_key(&mut self, key: &PublicKeyOrCertificate) -> Result<bool> {
        let fingerprint = key.public_key().fingerprint(HashAlg::Sha256).to_string();
        *self.observed.lock().unwrap() = Some(fingerprint.clone());
        Ok(self.expected.as_deref() == Some(&fingerprint))
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionResult {
    pub fingerprint: String,
    pub needs_trust: bool,
    pub path: String,
    pub forward_errors: Vec<String>,
}

pub async fn connect(
    profile: &SftpProfile,
    secret: &str,
    expected: Option<String>,
) -> Result<(ConnectionResult, Option<Arc<RemoteFs>>)> {
    if profile.host.trim().is_empty() || profile.username.trim().is_empty() || profile.port == 0 {
        bail!("Host, username and a valid port are required");
    }
    let observed = Arc::new(Mutex::new(None));
    let handler = Verify {
        expected: expected.clone(),
        observed: observed.clone(),
    };
    let config = client::Config {
        inactivity_timeout: Some(Duration::from_secs(90)),
        keepalive_interval: Some(Duration::from_secs(15)),
        keepalive_max: 3,
        ..Default::default()
    };
    let connection = tokio::time::timeout(
        Duration::from_secs(20),
        client::connect(
            Arc::new(config),
            (profile.host.as_str(), profile.port),
            handler,
        ),
    )
    .await
    .context("SSH connection timed out")?;
    let fingerprint = observed.lock().unwrap().clone();
    if let Some(fingerprint) = &fingerprint {
        if expected.as_deref() != Some(fingerprint) {
            return Ok((
                ConnectionResult {
                    fingerprint: fingerprint.clone(),
                    needs_trust: true,
                    path: String::new(),
                    forward_errors: vec![],
                },
                None,
            ));
        }
    }
    let mut ssh = connection?;
    let authenticated = if profile.key_path.is_empty() {
        let mut authenticated = false;
        if secret.is_empty() {
            #[cfg(unix)]
            let agent = russh::keys::agent::client::AgentClient::connect_env().await;
            #[cfg(windows)]
            let agent = russh::keys::agent::client::AgentClient::connect_named_pipe(
                r"\\.\pipe\openssh-ssh-agent",
            )
            .await;
            if let Ok(mut agent) = agent {
                if let Ok(identities) = agent.request_identities().await {
                    let hash = ssh.best_supported_rsa_hash().await?.flatten();
                    for identity in identities.into_iter().take(3) {
                        if ssh
                            .authenticate_publickey_with(
                                &profile.username,
                                identity.public_key().into_owned(),
                                hash,
                                &mut agent,
                            )
                            .await
                            .is_ok_and(|r| r.success())
                        {
                            authenticated = true;
                            break;
                        }
                    }
                }
            }
            if !authenticated {
                if let Some(home) = dirs::home_dir() {
                    for name in ["id_ed25519", "id_rsa"] {
                        let path = home.join(".ssh").join(name);
                        if let Ok(key) = russh::keys::load_secret_key(path, None) {
                            let hash = ssh.best_supported_rsa_hash().await?.flatten();
                            if ssh
                                .authenticate_publickey(
                                    &profile.username,
                                    PrivateKeyWithHashAlg::new(Arc::new(key), hash),
                                )
                                .await?
                                .success()
                            {
                                authenticated = true;
                                break;
                            }
                        }
                    }
                }
            }
        }
        authenticated
            || ssh
                .authenticate_password(&profile.username, secret)
                .await?
                .success()
    } else {
        let key = russh::keys::load_secret_key(
            &profile.key_path,
            (!secret.is_empty()).then_some(secret),
        )?;
        let hash = ssh.best_supported_rsa_hash().await?.flatten();
        ssh.authenticate_publickey(
            &profile.username,
            PrivateKeyWithHashAlg::new(Arc::new(key), hash),
        )
        .await?
        .success()
    };
    if !authenticated {
        bail!("SSH authentication failed");
    }
    let channel = ssh.channel_open_session().await?;
    channel.request_subsystem(true, "sftp").await?;
    let sftp = SftpSession::new(channel.into_stream()).await?;
    let path = sftp.canonicalize(".").await?;
    let result = ConnectionResult {
        fingerprint: fingerprint.context("Server did not provide a key")?,
        needs_trust: false,
        path,
        forward_errors: vec![],
    };
    let fs = RemoteFs {
        connection_id: uuid::Uuid::new_v4().to_string(),
        sftp: Arc::new(sftp),
        runtime: Handle::current(),
        _ssh: ssh,
        forwards: Mutex::new(HashMap::new()),
        terminals: Mutex::new(HashMap::new()),
    };
    Ok((result, Some(Arc::new(fs))))
}

pub struct RemoteFs {
    connection_id: String,
    sftp: Arc<SftpSession>,
    runtime: Handle,
    _ssh: client::Handle<Verify>,
    forwards: Mutex<HashMap<String, Forward>>,
    terminals: Mutex<HashMap<String, RemoteTerminal>>,
}
struct RemoteTerminal {
    writer: Arc<russh::ChannelWriteHalf<client::Msg>>,
    task: tokio::task::JoinHandle<()>,
    startup: Arc<Mutex<Option<ShellStartup>>>,
}
struct ShellStartup {
    directory: String,
    files: Vec<String>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardInfo {
    pub id: String,
    pub local_port: u16,
    pub remote_host: String,
    pub remote_port: u16,
    pub error: Option<String>,
}
struct Forward {
    info: ForwardInfo,
    task: tokio::task::JoinHandle<()>,
    error: Arc<Mutex<Option<String>>>,
}
impl RemoteFs {
    pub async fn open_terminal(
        &self,
        output: Arc<dyn Fn(Vec<u8>) + Send + Sync>,
    ) -> Result<String> {
        self.open_terminal_with_marker(output, None).await
    }

    pub async fn open_terminal_with_marker(
        &self,
        output: Arc<dyn Fn(Vec<u8>) + Send + Sync>,
        marker: Option<&str>,
    ) -> Result<String> {
        let integration = match marker {
            Some(marker) if marker.len() == 32 && marker.bytes().all(|b| b.is_ascii_hexdigit()) => {
                let shell = self.login_shell().await;
                if let Some(shell) = shell {
                    match self.prepare_shell(&shell, marker).await {
                        Ok(plan) => plan,
                        Err(error) => {
                            output(
                                format!("[Shell integration unavailable: {error}]\r\n")
                                    .into_bytes(),
                            );
                            None
                        }
                    }
                } else {
                    None
                }
            }
            Some(_) => bail!("Invalid terminal integration marker"),
            None => None,
        };
        let startup = Arc::new(Mutex::new(integration.as_ref().map(|(_, files)| {
            ShellStartup {
                directory: files.directory.clone(),
                files: files.files.clone(),
            }
        })));
        let opened = async {
            let mut channel = self._ssh.channel_open_session().await?;
            channel
                .request_pty(true, "xterm-256color", 100, 24, 0, 0, &[])
                .await?;
            async fn accepted(channel: &mut russh::Channel<client::Msg>) -> Result<()> {
                tokio::time::timeout(Duration::from_secs(15), async {
                    loop {
                        match channel.wait().await {
                            Some(russh::ChannelMsg::Success) => return Ok(()),
                            Some(russh::ChannelMsg::Failure) | None => {
                                bail!("The SSH server denied an interactive shell or PTY")
                            }
                            _ => {}
                        }
                    }
                })
                .await
                .context("SSH shell request timed out")?
            }
            accepted(&mut channel).await?;
            if let Some((command, _)) = &integration {
                channel.exec(true, command.as_str()).await?;
            } else {
                channel.request_shell(true).await?;
            }
            accepted(&mut channel).await?;
            Ok::<_, anyhow::Error>(channel)
        }
        .await;
        let channel = match opened {
            Ok(channel) => channel,
            Err(error) => {
                let files = { startup.lock().unwrap().take() };
                if let Some(files) = files {
                    Self::cleanup_shell(&self.sftp, files).await;
                }
                return Err(error);
            }
        };
        let (mut reader, writer) = channel.split();
        let writer = Arc::new(writer);
        let cleanup = startup.clone();
        let sftp = self.sftp.clone();
        let prompt = marker.map(|value| format!("\x1b]633;SC:{value}:").into_bytes());
        let close_writer = writer.clone();
        let task = tokio::spawn(async move {
            let mut tail = Vec::new();
            while let Some(message) = reader.wait().await {
                match message {
                    russh::ChannelMsg::Data { data }
                    | russh::ChannelMsg::ExtendedData { data, .. } => {
                        output(data.to_vec());
                        if let Some(prefix) = &prompt {
                            tail.extend_from_slice(&data);
                            if tail.windows(prefix.len()).any(|window| window == prefix) {
                                let files = { cleanup.lock().unwrap().take() };
                                if let Some(files) = files {
                                    Self::cleanup_shell(&sftp, files).await;
                                }
                            }
                            if tail.len() > prefix.len() {
                                tail.drain(..tail.len() - prefix.len());
                            }
                        }
                    }
                    russh::ChannelMsg::ExitStatus { exit_status } => {
                        output(format!("\r\n[SSH shell exited: {exit_status}]\r\n").into_bytes());
                    }
                    russh::ChannelMsg::Close => break,
                    _ => {}
                }
            }
            let _ = close_writer.close().await;
            let files = { cleanup.lock().unwrap().take() };
            if let Some(files) = files {
                Self::cleanup_shell(&sftp, files).await;
            }
        });
        let id = uuid::Uuid::new_v4().to_string();
        self.terminals.lock().unwrap().insert(
            id.clone(),
            RemoteTerminal {
                writer,
                task,
                startup,
            },
        );
        Ok(id)
    }

    async fn prepare_shell(
        &self,
        shell: &str,
        marker: &str,
    ) -> Result<Option<(String, ShellStartup)>> {
        let home = self.sftp.canonicalize(".").await?;
        let directory = format!(
            "{}/.supercommander-shell-{}",
            home.trim_end_matches('/'),
            uuid::Uuid::new_v4()
        );
        let Some(plan) = crate::shell_integration::remote(shell, marker, &directory) else {
            return Ok(None);
        };
        self.sftp.create_dir(&directory).await?;
        let files = ShellStartup {
            directory: directory.clone(),
            files: plan.files.iter().map(|(name, _)| name.clone()).collect(),
        };
        let result = async {
            self.sftp
                .set_metadata(
                    &directory,
                    russh_sftp::client::fs::Metadata {
                        permissions: Some(0o700),
                        ..Default::default()
                    },
                )
                .await?;
            for (name, contents) in plan.files {
                let mut file = self
                    .sftp
                    .open_with_flags_and_attributes(
                        format!("{directory}/{name}"),
                        OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE,
                        russh_sftp::protocol::FileAttributes {
                            permissions: Some(0o600),
                            ..Default::default()
                        },
                    )
                    .await?;
                file.write_all(contents.as_bytes()).await?;
                file.shutdown().await?;
            }
            Ok::<_, anyhow::Error>(())
        }
        .await;
        if let Err(error) = result {
            Self::cleanup_shell(&self.sftp, files).await;
            return Err(error);
        }
        Ok(Some((plan.command, files)))
    }

    async fn cleanup_shell(sftp: &SftpSession, files: ShellStartup) {
        for name in files.files {
            let _ = sftp
                .remove_file(format!("{}/{name}", files.directory))
                .await;
        }
        let _ = sftp.remove_dir(files.directory).await;
    }

    async fn login_shell(&self) -> Option<String> {
        let mut channel = self._ssh.channel_open_session().await.ok()?;
        channel.exec(true, "printf '%s' \"$SHELL\"").await.ok()?;
        let bytes = tokio::time::timeout(Duration::from_secs(5), async {
            let mut output = Vec::new();
            while let Some(message) = channel.wait().await {
                match message {
                    russh::ChannelMsg::Data { data } => {
                        output.extend_from_slice(&data);
                        if output.len() > 4096 {
                            return None;
                        }
                    }
                    russh::ChannelMsg::ExitStatus { exit_status } if exit_status != 0 => {
                        return None
                    }
                    russh::ChannelMsg::Close => break,
                    _ => {}
                }
            }
            Some(output)
        })
        .await
        .ok()??;
        let shell = std::str::from_utf8(&bytes).ok()?.trim();
        if shell.is_empty() || shell.chars().any(char::is_control) {
            return None;
        }
        Some(shell.to_string())
    }
    fn terminal_writer(&self, id: &str) -> Result<Arc<russh::ChannelWriteHalf<client::Msg>>> {
        self.terminals
            .lock()
            .unwrap()
            .get(id)
            .map(|s| s.writer.clone())
            .context("SSH terminal closed")
    }
    pub async fn write_terminal(&self, id: &str, data: Vec<u8>) -> Result<()> {
        self.terminal_writer(id)?.data_bytes(data).await?;
        Ok(())
    }
    pub async fn resize_terminal(&self, id: &str, rows: u16, cols: u16) -> Result<()> {
        self.terminal_writer(id)?
            .window_change(cols.max(1) as u32, rows.max(1) as u32, 0, 0)
            .await?;
        Ok(())
    }
    pub async fn close_terminal(&self, id: &str) -> Result<()> {
        let session = self.terminals.lock().unwrap().remove(id);
        if let Some(session) = session {
            session.task.abort();
            let _ = session.writer.close().await;
            let files = { session.startup.lock().unwrap().take() };
            if let Some(files) = files {
                Self::cleanup_shell(&self.sftp, files).await;
            }
        }
        Ok(())
    }
    pub async fn start_forward(
        self: &Arc<Self>,
        local_port: u16,
        remote_host: String,
        remote_port: u16,
    ) -> Result<ForwardInfo> {
        if remote_host.trim().is_empty()
            || remote_host.contains(['\0', '\n', '\r'])
            || remote_port == 0
        {
            bail!("A target host and valid target port are required");
        }
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", local_port))
            .await
            .context("Cannot bind local port")?;
        let local_port = listener.local_addr()?.port();
        let id = uuid::Uuid::new_v4().to_string();
        let info = ForwardInfo {
            id: id.clone(),
            local_port,
            remote_host: remote_host.clone(),
            remote_port,
            error: None,
        };
        let errors = Arc::new(Mutex::new(None));
        let task_errors = errors.clone();
        let session = self.clone();
        let task = tokio::spawn(async move {
            let mut connections = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    accepted=listener.accept()=> {
                        let (mut local,origin)=match accepted { Ok(v)=>v,Err(e)=>{ *task_errors.lock().unwrap()=Some(e.to_string()); break; } };
                        let session=session.clone(); let host=remote_host.clone(); let errors=task_errors.clone();
                        connections.spawn(async move {
                            let result=async {
                                let channel=session._ssh.channel_open_direct_tcpip(host,remote_port as u32,origin.ip().to_string(),origin.port() as u32).await?;
                                let mut stream=channel.into_stream();
                                tokio::io::copy_bidirectional(&mut local,&mut stream).await?;
                                Ok::<(),anyhow::Error>(())
                            }.await;
                            if let Err(e)=result { *errors.lock().unwrap()=Some(e.to_string()); }
                        });
                    }
                    _=connections.join_next(), if !connections.is_empty()=>{}
                }
            }
        });
        self.forwards.lock().unwrap().insert(
            id,
            Forward {
                info: info.clone(),
                task,
                error: errors,
            },
        );
        Ok(info)
    }
    pub fn forwards(&self) -> Vec<ForwardInfo> {
        self.forwards
            .lock()
            .unwrap()
            .values()
            .map(|f| {
                let mut info = f.info.clone();
                info.error = f.error.lock().unwrap().clone();
                info
            })
            .collect()
    }
    pub async fn stop_forward(&self, id: &str) -> Result<()> {
        let forward = self.forwards.lock().unwrap().remove(id);
        if let Some(forward) = forward {
            forward.task.abort();
            let _ = forward.task.await;
        }
        Ok(())
    }
    pub async fn close(&self) -> Result<()> {
        let terminals: Vec<_> = self.terminals.lock().unwrap().keys().cloned().collect();
        for id in terminals {
            self.close_terminal(&id).await?;
        }
        let ids: Vec<_> = self.forwards.lock().unwrap().keys().cloned().collect();
        for id in ids {
            self.stop_forward(&id).await?;
        }
        let _ = self.sftp.close().await;
        let _ = self
            ._ssh
            .disconnect(russh::Disconnect::ByApplication, "Connection closed", "en")
            .await;
        Ok(())
    }
    fn entry(&self, path: String, name: String, meta: russh_sftp::client::fs::Metadata) -> Entry {
        Entry {
            hidden: name.starts_with('.'),
            name,
            path,
            is_dir: meta.is_dir(),
            is_symlink: meta.is_symlink(),
            size: meta.size.unwrap_or(0),
            modified: meta.mtime.unwrap_or(0) as u64,
        }
    }
}
struct RemoteFile {
    file: File,
    runtime: Handle,
}
impl Read for RemoteFile {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        self.runtime.block_on(self.file.read(buffer))
    }
}
impl Write for RemoteFile {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        self.runtime.block_on(self.file.write(buffer))
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.runtime.block_on(self.file.flush())
    }
}
impl FileSystem for RemoteFs {
    fn regular_file(&self, path: &str) -> Result<bool> {
        let meta = self.runtime.block_on(self.sftp.symlink_metadata(path))?;
        Ok(meta
            .permissions
            .is_none_or(|mode| mode & 0o170000 == 0 || mode & 0o170000 == 0o100000))
    }
    fn properties(&self, path: &str) -> Result<crate::properties::Properties> {
        let meta = self.runtime.block_on(self.sftp.symlink_metadata(path))?;
        let mut info = crate::properties::Properties::basic(
            self.entry(
                path.into(),
                path.trim_end_matches('/')
                    .rsplit('/')
                    .next()
                    .unwrap_or("/")
                    .into(),
                meta.clone(),
            ),
        );
        info.accessed = meta.atime.map(u64::from);
        info.mode = meta.permissions.map(|mode| mode & 0o7777);
        info.uid = meta.uid;
        info.gid = meta.gid;
        if info.file.is_symlink {
            info.link_target = self.runtime.block_on(self.sftp.read_link(path)).ok();
        }
        info.editable.mode = !info.file.is_symlink && info.mode.is_some();
        Ok(info)
    }
    fn apply_properties(&self, path: &str, changes: &crate::properties::Changes) -> Result<()> {
        if let Some(mode) = changes.mode {
            let original = self.runtime.block_on(self.sftp.symlink_metadata(path))?;
            let metadata = russh_sftp::client::fs::Metadata {
                permissions: Some((original.permissions.unwrap_or(0) & !0o7777) | mode),
                ..Default::default()
            };
            self.runtime
                .block_on(self.sftp.set_metadata(path, metadata))?;
        }
        Ok(())
    }
    fn connection_id(&self) -> Option<&str> {
        Some(&self.connection_id)
    }
    fn canonical_path(&self, path: &str) -> Result<String> {
        Ok(self.runtime.block_on(self.sftp.canonicalize(path))?)
    }
    fn copy_permissions(&self, from: &str, to: &str) -> Result<()> {
        let original = self.runtime.block_on(self.sftp.metadata(from))?;
        let meta = russh_sftp::client::fs::Metadata {
            permissions: original.permissions,
            ..Default::default()
        };
        self.runtime.block_on(self.sftp.set_metadata(to, meta))?;
        Ok(())
    }
    fn close(&self) -> Result<()> {
        self.runtime.block_on(RemoteFs::close(self))
    }
    fn list(&self, path: &str) -> Result<Vec<Entry>> {
        Ok(self
            .runtime
            .block_on(self.sftp.read_dir(path))?
            .map(|e| self.entry(e.path(), e.file_name(), e.metadata()))
            .collect())
    }
    fn stat(&self, path: &str) -> Result<Entry> {
        let meta = self.runtime.block_on(self.sftp.symlink_metadata(path))?;
        Ok(self.entry(
            path.into(),
            path.trim_end_matches('/')
                .rsplit('/')
                .next()
                .unwrap_or("/")
                .into(),
            meta,
        ))
    }
    fn exists(&self, path: &str) -> Result<bool> {
        Ok(self.runtime.block_on(self.sftp.try_exists(path))?)
    }
    fn reader(&self, path: &str) -> Result<Box<dyn Read + Send>> {
        let metadata = self.runtime.block_on(self.sftp.metadata(path))?;
        if metadata
            .permissions
            .is_some_and(|mode| mode & 0o170000 != 0 && mode & 0o170000 != 0o100000)
        {
            bail!("Choose a regular file; special files cannot be read as documents");
        }
        Ok(Box::new(RemoteFile {
            file: self.runtime.block_on(self.sftp.open(path))?,
            runtime: self.runtime.clone(),
        }))
    }
    fn writer(&self, path: &str) -> Result<Box<dyn Write + Send>> {
        Ok(Box::new(RemoteFile {
            file: self.runtime.block_on(self.sftp.open_with_flags(
                path,
                OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE,
            ))?,
            runtime: self.runtime.clone(),
        }))
    }
    fn mkdir(&self, path: &str) -> Result<()> {
        self.runtime.block_on(self.sftp.create_dir(path))?;
        Ok(())
    }
    fn private_mkdir(&self, path: &str) -> Result<()> {
        self.mkdir(path)?;
        self.runtime.block_on(self.sftp.set_metadata(
            path,
            russh_sftp::client::fs::Metadata {
                permissions: Some(0o700),
                ..Default::default()
            },
        ))?;
        Ok(())
    }
    fn private_writer(&self, path: &str) -> Result<Box<dyn Write + Send>> {
        Ok(Box::new(RemoteFile {
            file: self
                .runtime
                .block_on(self.sftp.open_with_flags_and_attributes(
                    path,
                    OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE,
                    russh_sftp::protocol::FileAttributes {
                        permissions: Some(0o600),
                        ..Default::default()
                    },
                ))?,
            runtime: self.runtime.clone(),
        }))
    }
    fn rename(&self, from: &str, to: &str) -> Result<()> {
        self.runtime.block_on(self.sftp.rename(from, to))?;
        Ok(())
    }
    fn rename_new(&self, from: &str, to: &str) -> Result<()> {
        // SSH_FXP_RENAME v3 fails if newpath exists; do not use posix-rename.
        self.rename(from, to)
    }
    fn remove(&self, path: &str) -> Result<()> {
        if path.trim_matches('/').is_empty()
            || !path.starts_with('/')
            || path.split('/').any(|p| p == "..")
        {
            bail!("Refusing an ambiguous or root path");
        }
        let entry = self.stat(path)?;
        if entry.is_dir && !entry.is_symlink {
            for child in self.list(path)? {
                self.remove(&child.path)?;
            }
            self.runtime.block_on(self.sftp.remove_dir(path))?;
        } else {
            self.runtime.block_on(self.sftp.remove_file(path))?;
        }
        Ok(())
    }
    fn remove_file(&self, path: &str) -> Result<()> {
        self.runtime.block_on(self.sftp.remove_file(path))?;
        Ok(())
    }
    fn remove_empty_dir(&self, path: &str) -> Result<()> {
        self.runtime.block_on(self.sftp.remove_dir(path))?;
        Ok(())
    }
    fn transfer_metadata(
        &self,
        path: &str,
        original: &crate::properties::Properties,
    ) -> Result<()> {
        let time = (original.file.modified != 0
            || !original.stamp.is_empty()
            || original.mode.is_some()
            || original.accessed.is_some())
        .then(|| original.file.modified.try_into())
        .transpose()?;
        self.runtime.block_on(self.sftp.set_metadata(
            path,
            russh_sftp::client::fs::Metadata {
                permissions: original.mode,
                atime: time,
                mtime: time,
                ..Default::default()
            },
        ))?;
        Ok(())
    }
    fn join(&self, parent: &str, name: &str) -> String {
        format!("{}/{name}", parent.trim_end_matches('/'))
    }
}
