use anyhow::{Context, Result};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::{
    collections::HashMap,
    io::{Read, Write},
    sync::{Arc, Mutex},
};

pub struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}
#[derive(Default)]
pub struct Terminals {
    sessions: Mutex<HashMap<String, Session>>,
}
impl Terminals {
    pub fn open(&self, path: &str, output: Arc<dyn Fn(Vec<u8>) + Send + Sync>) -> Result<String> {
        self.open_with_marker(path, output, None)
    }

    pub fn open_with_marker(
        &self,
        path: &str,
        output: Arc<dyn Fn(Vec<u8>) + Send + Sync>,
        marker: Option<&str>,
    ) -> Result<String> {
        if marker.is_some_and(|value| {
            value.len() != 32 || !value.bytes().all(|byte| byte.is_ascii_hexdigit())
        }) {
            anyhow::bail!("Invalid terminal integration marker");
        }
        if !std::path::Path::new(path).is_dir() {
            anyhow::bail!("Terminal needs a local directory");
        }
        let pair = native_pty_system().openpty(PtySize {
            rows: 24,
            cols: 100,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        #[cfg(windows)]
        let shell = if std::process::Command::new("pwsh.exe")
            .args(["-NoProfile", "-Command", "exit 0"])
            .output()
            .is_ok()
        {
            "pwsh.exe".to_string()
        } else {
            "powershell.exe".to_string()
        };
        #[cfg(not(windows))]
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into());
        let mut command = CommandBuilder::new(shell);
        #[cfg(windows)]
        if let Some(marker) = marker {
            // Install the hook in this shell only, after the user's profile has
            // loaded. Preserve the existing prompt rather than replacing it.
            let script = crate::shell_integration::powershell(marker);
            command.args(["-NoExit", "-Command", &script]);
        }
        #[cfg(not(windows))]
        let _ = marker;
        command.cwd(path);
        command.env("TERM", "xterm-256color");
        let child = pair.slave.spawn_command(command)?;
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader()?;
        let writer = pair.master.take_writer()?;
        let id = uuid::Uuid::new_v4().to_string();
        self.sessions.lock().unwrap().insert(
            id.clone(),
            Session {
                master: pair.master,
                writer,
                child,
            },
        );
        std::thread::spawn(move || {
            let mut buffer = [0; 8192];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => output(buffer[..n].to_vec()),
                }
            }
        });
        Ok(id)
    }
    pub fn write(&self, id: &str, data: &[u8]) -> Result<()> {
        let mut sessions = self.sessions.lock().unwrap();
        let s = sessions.get_mut(id).context("Terminal closed")?;
        s.writer.write_all(data)?;
        s.writer.flush()?;
        Ok(())
    }
    pub fn resize(&self, id: &str, rows: u16, cols: u16) -> Result<()> {
        let sessions = self.sessions.lock().unwrap();
        let s = sessions.get(id).context("Terminal closed")?;
        s.master.resize(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })?;
        Ok(())
    }
    pub fn close(&self, id: &str) -> Result<()> {
        if let Some(mut s) = self.sessions.lock().unwrap().remove(id) {
            s.child.kill()?;
            let _ = s.child.wait();
        }
        Ok(())
    }
    pub fn close_all(&self) {
        let ids: Vec<_> = self.sessions.lock().unwrap().keys().cloned().collect();
        for id in ids {
            let _ = self.close(&id);
        }
    }
}
impl Drop for Terminals {
    fn drop(&mut self) {
        self.close_all();
    }
}
