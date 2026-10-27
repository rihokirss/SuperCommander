use commander_core::settings;
use std::{fs, process::Command};
use tempfile::TempDir;

#[test]
fn isolated_settings_and_backup_never_use_the_default_profile() {
    // Environment variables are process-global; exercise overrides in a child.
    if let Some(mode) = std::env::var_os("SC_SETTINGS_CHILD") {
        if mode == "relative" {
            assert!(settings::directory().is_err());
            return;
        }
        let directory = settings::directory().unwrap();
        assert!(!directory.join("settings.json").exists());
        assert!(settings::load().unwrap().is_none());
        let original = serde_json::json!({"bookmarks":[{"name":"My folder","path":"C:\\Files"}]});
        settings::save(&original).unwrap();
        assert_eq!(settings::load().unwrap(), Some(original.clone()));
        let changed = serde_json::json!({"bookmarks":[],"language":"et"});
        settings::save(&changed).unwrap();
        assert_eq!(settings::load().unwrap(), Some(changed));
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(
                &fs::read(directory.join("settings.backup.json")).unwrap()
            )
            .unwrap(),
            original
        );
        return;
    }
    let root = TempDir::new().unwrap();
    for (mode, directory) in [
        ("absolute", root.path().to_path_buf()),
        ("relative", "relative".into()),
    ] {
        let output = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "isolated_settings_and_backup_never_use_the_default_profile",
                "--nocapture",
            ])
            .env("SC_SETTINGS_CHILD", mode)
            .env("SUPERCOMMANDER_DATA_DIR", directory)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stdout)
        );
    }
}
