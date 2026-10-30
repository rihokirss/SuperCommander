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
        fs::canonicalize(&build.profile.key_path).unwrap(),
        fs::canonicalize(dir.join("key with spaces")).unwrap()
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

#[test]
fn connection_form_updates_the_same_stanza_without_losing_other_options() {
    let tmp = TempDir::new().unwrap();
    let config = tmp.path().join("config");
    let original="# catalog comment\nHost work\n HostName old.example\n User old-user\n Port 22 # keep this note\n ServerAliveInterval 15\n\nHost other\n HostName other.example\n";
    fs::write(&config, original).unwrap();
    let before = ssh_config::read(config.to_str()).unwrap();
    let mut profile = before.hosts[0].profile.clone();
    profile.host = "new.example".into();
    profile.port = 2222;
    let after = ssh_config::upsert(
        config.to_str(),
        "work",
        &profile,
        before.revision.as_deref(),
    )
    .unwrap();
    assert_eq!(after.hosts.len(), 2);
    assert_eq!(after.hosts[0].profile.host, "new.example");
    assert_eq!(after.hosts[0].profile.port, 2222);
    assert!(after.text.contains("ServerAliveInterval 15"));
    assert!(after.text.contains("# keep this note"));
    assert!(after.text.contains("Host other\n HostName other.example"));
    let again =
        ssh_config::upsert(config.to_str(), "work", &profile, after.revision.as_deref()).unwrap();
    assert_eq!(again.text.matches("Host work").count(), 1);
}

#[test]
fn new_form_connections_precede_general_defaults_and_check_revisions() {
    let tmp = TempDir::new().unwrap();
    let config = tmp.path().join("config");
    fs::write(&config, "Host *\n User fallback\n Port 22\n").unwrap();
    let before = ssh_config::read(config.to_str()).unwrap();
    let profile = commander_core::SftpProfile {
        id: "form".into(),
        name: "new-host".into(),
        host: "example.com".into(),
        port: 2222,
        username: "alice".into(),
        key_path: String::new(),
        save_secret: false,
    };
    let after = ssh_config::upsert(
        config.to_str(),
        "new-host",
        &profile,
        before.revision.as_deref(),
    )
    .unwrap();
    assert_eq!(after.hosts[0].profile.username, "alice");
    assert_eq!(after.hosts[0].profile.port, 2222);
    assert!(ssh_config::upsert(
        config.to_str(),
        "new-host",
        &profile,
        before.revision.as_deref()
    )
    .is_err());
    assert_eq!(fs::read_to_string(config).unwrap(), after.text);
}

#[test]
fn moving_a_forward_preserves_other_hosts_comments_and_line_endings() {
    let tmp = TempDir::new().unwrap();
    let config = tmp.path().join("config");
    let original = "# keep\r\nHost work\r\n User alice\r\n LocalForward 8080 localhost:80 # web\r\n ServerAliveInterval 15\r\nHost other\r\n LocalForward 9090 localhost:90\r\n";
    fs::write(&config, original).unwrap();
    let before = ssh_config::read(config.to_str()).unwrap();
    let forward = &before.hosts[0].forwards[0];
    let text = ssh_config::forward_removal(
        config.to_str().unwrap(),
        "work",
        forward,
        before.revision.as_deref(),
    )
    .unwrap();
    // Planning the move leaves the shared configuration untouched.
    assert_eq!(fs::read_to_string(&config).unwrap(), original);
    let removed =
        ssh_config::save(config.to_str().unwrap(), &text, before.revision.as_deref()).unwrap();
    assert!(removed.hosts[0].forwards.is_empty());
    assert!(removed.text.contains("    # web\r\n"));
    assert!(removed.text.contains("ServerAliveInterval 15"));
    assert!(removed
        .text
        .contains("Host other\r\n LocalForward 9090 localhost:90"));
    assert!(ssh_config::forward_removal(
        config.to_str().unwrap(),
        "work",
        forward,
        before.revision.as_deref(),
    )
    .is_err());
}

#[test]
fn inherited_shared_and_unsupported_forward_options_are_not_silently_changed() {
    let tmp = TempDir::new().unwrap();
    let config = tmp.path().join("config");
    let text = "Host work\nHost shared alias\nHost *\n LocalForward 8080 localhost:80\n LocalForward 0.0.0.0:9090 localhost:90\n LocalForward /tmp/socket /tmp/remote\n";
    fs::write(&config, text).unwrap();
    let catalog = ssh_config::read(config.to_str()).unwrap();
    assert_eq!(catalog.hosts[0].forwards.len(), 1);
    assert_eq!(catalog.hosts[0].warnings.len(), 2);
    assert!(!catalog.hosts[0].disabled);
    let forward = &catalog.hosts[0].forwards[0];
    assert!(ssh_config::forward_removal(
        config.to_str().unwrap(),
        "work",
        forward,
        catalog.revision.as_deref()
    )
    .is_err());
    assert!(ssh_config::forward_removal(
        config.to_str().unwrap(),
        "shared",
        forward,
        catalog.revision.as_deref()
    )
    .is_err());
    assert_eq!(fs::read_to_string(config).unwrap(), text);
}
