use anyhow::{Context, Result};
use serde_json::Value;
use std::{fs, path::PathBuf};
static SETTINGS_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub fn directory() -> Result<PathBuf> {
    Ok(dirs::config_dir()
        .context("No application data directory")?
        .join("SuperCommander"))
}
pub fn load() -> Result<Option<Value>> {
    let _guard = SETTINGS_LOCK.lock().unwrap();
    let path = directory()?.join("settings.json");
    if !path.exists() {
        return Ok(None);
    }
    Ok(Some(serde_json::from_slice(&fs::read(path)?)?))
}
pub fn save(value: &Value) -> Result<()> {
    let _guard = SETTINGS_LOCK.lock().unwrap();
    let dir = directory()?;
    fs::create_dir_all(&dir)?;
    let temp = dir.join("settings.tmp");
    let mut f = fs::File::create(&temp)?;
    use std::io::Write;
    f.write_all(&serde_json::to_vec_pretty(value)?)?;
    f.sync_all()?;
    let final_path = dir.join("settings.json");
    // Backup preserves the old config if replacement fails on Windows.
    let backup = dir.join("settings.backup.json");
    if final_path.exists() {
        fs::copy(&final_path, &backup)?;
        fs::remove_file(&final_path)?;
    }
    if let Err(e) = fs::rename(&temp, &final_path) {
        if backup.exists() {
            let _ = fs::copy(backup, final_path);
        }
        return Err(e.into());
    }
    Ok(())
}

pub fn secret(id: &str) -> Result<Option<String>> {
    let entry = keyring::Entry::new("SuperCommander", id)?;
    match entry.get_password() {
        Ok(p) => Ok(Some(p)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}
pub fn save_secret(id: &str, value: &str) -> Result<()> {
    keyring::Entry::new("SuperCommander", id)?.set_password(value)?;
    Ok(())
}
pub fn delete_secret(id: &str) -> Result<()> {
    match keyring::Entry::new("SuperCommander", id)?.delete_credential() {
        Ok(_) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    }
}
