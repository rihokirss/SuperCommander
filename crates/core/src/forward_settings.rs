//! Port forwards belong to this app, rather than the shared OpenSSH catalog.
use crate::{settings, ssh_config::LocalForward, SftpProfile};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fs, io::Write, path::PathBuf};

static SAVE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[derive(Default, Deserialize, Serialize)]
struct Saved {
    connections: BTreeMap<String, Vec<Connection>>,
}
#[derive(Deserialize, Serialize)]
struct Connection {
    host: String,
    port: u16,
    username: String,
    forwards: Vec<LocalForward>,
}
impl Connection {
    fn matches(&self, profile: &SftpProfile) -> bool {
        self.host == profile.host && self.port == profile.port && self.username == profile.username
    }
}
pub struct Store(PathBuf);
impl Store {
    pub fn application() -> Result<Self> {
        Ok(Self::new(settings::directory()?))
    }
    pub fn new(directory: PathBuf) -> Self {
        Self(directory.join("forwards.json"))
    }
    fn read(&self) -> Result<Saved> {
        match fs::read(&self.0) {
            Ok(bytes) => serde_json::from_slice(&bytes).context("Cannot read saved port forwards"),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Saved::default()),
            Err(e) => Err(e.into()),
        }
    }
    pub fn list(&self, profile: &SftpProfile) -> Result<Vec<LocalForward>> {
        let _guard = SAVE_LOCK.lock().unwrap();
        Ok(self
            .read()?
            .connections
            .remove(&profile.id)
            .and_then(|connections| connections.into_iter().find(|c| c.matches(profile)))
            .map(|c| c.forwards)
            .unwrap_or_default())
    }
    pub fn set(
        &self,
        profile: &SftpProfile,
        forward: &LocalForward,
        enabled: bool,
    ) -> Result<Vec<LocalForward>> {
        forward.validate()?;
        let _guard = SAVE_LOCK.lock().unwrap();
        let mut saved = self.read()?;
        let connections = saved.connections.entry(profile.id.clone()).or_default();
        let index = connections
            .iter()
            .position(|c| c.matches(profile))
            .unwrap_or_else(|| {
                connections.push(Connection {
                    host: profile.host.clone(),
                    port: profile.port,
                    username: profile.username.clone(),
                    forwards: vec![],
                });
                connections.len() - 1
            });
        let connection = &mut connections[index];
        if enabled && !connection.forwards.contains(forward) {
            connection.forwards.push(forward.clone());
        } else if !enabled {
            connection.forwards.retain(|f| f != forward);
        }
        let forwards = connection.forwards.clone();
        let parent = self.0.parent().context("Missing settings directory")?;
        fs::create_dir_all(parent)?;
        let mut temp = tempfile::NamedTempFile::new_in(parent)?;
        temp.write_all(&serde_json::to_vec_pretty(&saved)?)?;
        temp.as_file().sync_all()?;
        if self.0.exists() {
            fs::copy(&self.0, parent.join("forwards.backup.json"))?;
        }
        temp.persist(&self.0).map_err(|e| e.error)?;
        Ok(forwards)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn profile(id: &str, host: &str) -> SftpProfile {
        SftpProfile {
            id: id.into(),
            name: id.into(),
            host: host.into(),
            port: 22,
            username: "alice".into(),
            key_path: String::new(),
            save_secret: false,
        }
    }
    #[test]
    fn remembers_same_ports_for_separate_servers_without_touching_ssh_config() {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().join("config");
        let text = "Host first\r\n HostName first.test\r\n# preserved\r\n";
        fs::write(&config, text).unwrap();
        let store = Store::new(dir.path().into());
        let first = profile("first", "first.test");
        let second = profile("second", "second.test");
        let forward = LocalForward {
            local_port: 5173,
            remote_host: "localhost".into(),
            remote_port: 5173,
        };
        store.set(&first, &forward, true).unwrap();
        store.set(&second, &forward, true).unwrap();
        store.set(&first, &forward, true).unwrap();
        let reopened = Store::new(dir.path().into());
        assert_eq!(reopened.list(&first).unwrap(), vec![forward.clone()]);
        assert_eq!(reopened.list(&second).unwrap(), vec![forward.clone()]);
        assert!(reopened
            .list(&profile("first", "different.test"))
            .unwrap()
            .is_empty());
        reopened
            .set(&profile("first", "different.test"), &forward, true)
            .unwrap();
        assert_eq!(reopened.list(&first).unwrap(), vec![forward.clone()]);
        reopened.set(&first, &forward, false).unwrap();
        assert!(store.list(&first).unwrap().is_empty());
        assert_eq!(store.list(&second).unwrap(), vec![forward]);
        assert_eq!(fs::read_to_string(config).unwrap(), text);
        assert!(dir.path().join("forwards.backup.json").exists());
    }
    #[test]
    fn malformed_saved_ports_are_not_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("forwards.json");
        fs::write(&path, "broken").unwrap();
        let store = Store::new(dir.path().into());
        let forward = LocalForward {
            local_port: 5173,
            remote_host: "localhost".into(),
            remote_port: 5173,
        };
        assert!(store
            .set(&profile("first", "first.test"), &forward, true)
            .is_err());
        assert_eq!(fs::read_to_string(path).unwrap(), "broken");
    }
}
