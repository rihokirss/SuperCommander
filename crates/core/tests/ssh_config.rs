use commander_core::ssh_config;
use std::fs;
use tempfile::TempDir;

#[test]
fn resolves_aliases_defaults_quoted_identity_paths_and_includes() {
    let tmp = TempDir::new().unwrap();
    let dir = tmp.path().join(".ssh");
    fs::create_dir(&dir).unwrap();
    fs::write(dir.join("key with spaces"), "test key placeholder").unwrap();
    fs::write(
        dir.join("extra.conf"),
        "Host included\n HostName included.example\n User included-user\n",
    )
    .unwrap();
    let text="# Preserve this comment\nHost build work\n HostName = build.example\n User alice\n Port 2222\n IdentityFile \"~/.ssh/key with spaces\"\nInclude extra.conf\nHost *\n User fallback\n Port 22\n";
    let config = dir.join("config");
    fs::write(&config, text).unwrap();
    let catalog = ssh_config::read(config.to_str()).unwrap();
    assert_eq!(catalog.text, text);
    assert_eq!(catalog.hosts.len(), 3);
    let build = &catalog.hosts[0];
    assert_eq!(build.alias, "build");
    assert_eq!(build.profile.host, "build.example");
    assert_eq!(build.profile.username, "alice");
    assert_eq!(build.profile.port, 2222);
    assert_eq!(
        build.profile.key_path,
        dir.join("key with spaces").to_string_lossy()
    );
    assert_eq!(catalog.hosts[2].profile.username, "included-user");
    assert!(catalog.hosts.iter().all(|h| !h.disabled));
}

#[test]
fn saves_exact_text_and_preserves_an_original_backup() {
    let tmp = TempDir::new().unwrap();
    let config = tmp.path().join("config");
    let original =
        "# original comment\nHost one\n HostName original.example\n UnknownOption untouched\n";
    fs::write(&config, original).unwrap();
    let catalog = ssh_config::read(config.to_str()).unwrap();
    let edited = original.replace("original.example", "new.example");
    let saved = ssh_config::save(
        config.to_str().unwrap(),
        &edited,
        catalog.revision.as_deref(),
    )
    .unwrap();
    assert_eq!(saved.text, edited);
    assert_eq!(saved.hosts[0].profile.host, "new.example");
    let backups: Vec<_> = fs::read_dir(tmp.path())
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().is_some_and(|x| x == "bak"))
        .collect();
    assert_eq!(backups.len(), 1);
    assert_eq!(fs::read_to_string(backups[0].path()).unwrap(), original);
}

#[test]
fn refuses_to_overwrite_external_changes() {
    let tmp = TempDir::new().unwrap();
    let config = tmp.path().join("config");
    fs::write(&config, "Host one\n User alice\n").unwrap();
    let catalog = ssh_config::read(config.to_str()).unwrap();
    fs::write(&config, "# external edit\nHost two\n").unwrap();
    assert!(ssh_config::save(
        config.to_str().unwrap(),
        "Host three\n",
        catalog.revision.as_deref()
    )
    .is_err());
    assert_eq!(
        fs::read_to_string(config).unwrap(),
        "# external edit\nHost two\n"
    );
}

#[test]
fn invalid_configuration_is_still_editable_and_not_saved_over() {
    let tmp = TempDir::new().unwrap();
    let config = tmp.path().join("config");
    fs::write(&config, "Host \"broken\n").unwrap();
    let catalog = ssh_config::read(config.to_str()).unwrap();
    assert!(!catalog.warnings.is_empty());
    assert_eq!(catalog.text, "Host \"broken\n");
    assert!(ssh_config::save(
        config.to_str().unwrap(),
        &catalog.text,
        catalog.revision.as_deref()
    )
    .is_err());
    let saved = ssh_config::save(
        config.to_str().unwrap(),
        "Host repaired\n",
        catalog.revision.as_deref(),
    )
    .unwrap();
    assert_eq!(saved.hosts[0].alias, "repaired");
}

#[test]
fn preserves_unsupported_proxy_options_and_marks_them_explicitly() {
    let tmp = TempDir::new().unwrap();
    let config = tmp.path().join("config");
    let text = "Host private\n HostName private.example\n ProxyJump bastion\n";
    fs::write(&config, text).unwrap();
    let catalog = ssh_config::read(config.to_str()).unwrap();
    assert!(catalog.hosts[0].disabled);
    assert_eq!(catalog.text, text);
    assert!(!catalog.hosts[0].warnings.is_empty());
}

#[test]
fn creates_new_catalogs_only_when_saved() {
    let tmp = TempDir::new().unwrap();
    let config = tmp.path().join("new-dir/config");
    let catalog = ssh_config::read(config.to_str()).unwrap();
    assert!(catalog.revision.is_none());
    assert!(!config.exists());
    let saved = ssh_config::save(
        config.to_str().unwrap(),
        "Host first\n HostName example.com\n",
        None,
    )
    .unwrap();
    assert_eq!(saved.hosts[0].profile.host, "example.com");
}
