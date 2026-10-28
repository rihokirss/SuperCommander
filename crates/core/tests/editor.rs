use commander_core::{editor, filesystem::LocalFs};
use std::fs;
use tempfile::TempDir;

#[test]
fn creates_only_on_save_preserves_format_and_refuses_unconfirmed_replacement() {
    let tmp = TempDir::new().unwrap();
    let file = tmp.path().join("Õunad.txt");
    let path = file.to_str().unwrap();
    let blank = editor::prepare(&LocalFs, path).unwrap();
    assert!(blank.revision.is_empty());
    assert!(!file.exists());
    let format = editor::Format {
        encoding: "UTF-16 BE".into(),
        line_ending: "CRLF".into(),
    };
    let created = editor::write(&LocalFs, path, "Õunad\n🚀\n", None, &format).unwrap();
    assert_eq!(created.encoding, "UTF-16 BE");
    assert_eq!(created.line_ending, "CRLF");
    let mut expected = vec![0xfe, 0xff];
    expected.extend("Õunad\r\n🚀\r\n".encode_utf16().flat_map(u16::to_be_bytes));
    assert_eq!(fs::read(&file).unwrap(), expected);
    assert!(editor::write(&LocalFs, path, "must not overwrite", None, &format).is_err());
    let revision = editor::target(&LocalFs, path).unwrap().revision.unwrap();
    fs::write(&file, "changed while confirmation was open").unwrap();
    assert!(editor::write(&LocalFs, path, "my changes", Some(&revision), &format).is_err());
    assert_eq!(
        fs::read_to_string(&file).unwrap(),
        "changed while confirmation was open"
    );
    assert_eq!(fs::read_dir(tmp.path()).unwrap().count(), 1);
}

#[test]
fn save_as_keeps_original_and_normalizes_parent_aliases_without_leaving_parts() {
    let tmp = TempDir::new().unwrap();
    let original = tmp.path().join("original.txt");
    fs::write(&original, "original").unwrap();
    let nested = tmp.path().join("nested");
    fs::create_dir(&nested).unwrap();
    let path = nested.join("..").join("copy.txt");
    let format = editor::Format {
        encoding: "UTF-8 BOM".into(),
        line_ending: "CRLF".into(),
    };
    let saved = editor::write(&LocalFs, path.to_str().unwrap(), "changed", None, &format).unwrap();
    assert_eq!(saved.line_ending, "CRLF");
    assert_eq!(fs::read_to_string(&original).unwrap(), "original");
    assert_eq!(
        fs::read(tmp.path().join("copy.txt")).unwrap(),
        b"\xef\xbb\xbfchanged"
    );
    assert_eq!(fs::read_dir(tmp.path()).unwrap().count(), 3);
    assert!(fs::read_dir(nested).unwrap().next().is_none());
}

#[test]
fn publishing_a_new_name_never_overwrites_a_file_created_during_save() {
    use commander_core::filesystem::FileSystem;
    let tmp = TempDir::new().unwrap();
    let source = tmp.path().join("staged.txt");
    let destination = tmp.path().join("existing.txt");
    fs::write(&source, "my new content").unwrap();
    fs::write(&destination, "another application's content").unwrap();
    assert!(LocalFs
        .rename_new(source.to_str().unwrap(), destination.to_str().unwrap())
        .is_err());
    assert_eq!(fs::read_to_string(source).unwrap(), "my new content");
    assert_eq!(
        fs::read_to_string(destination).unwrap(),
        "another application's content"
    );
}

#[test]
fn failed_replacement_preserves_both_external_file_and_original_backup() {
    use commander_core::filesystem::FileSystem;
    use std::{
        io::{Read, Write},
        sync::atomic::{AtomicBool, Ordering},
    };
    struct RaceFs(AtomicBool);
    impl FileSystem for RaceFs {
        fn list(&self, p: &str) -> anyhow::Result<Vec<commander_core::Entry>> {
            LocalFs.list(p)
        }
        fn stat(&self, p: &str) -> anyhow::Result<commander_core::Entry> {
            LocalFs.stat(p)
        }
        fn canonical_path(&self, p: &str) -> anyhow::Result<String> {
            LocalFs.canonical_path(p)
        }
        fn reader(&self, p: &str) -> anyhow::Result<Box<dyn Read + Send>> {
            LocalFs.reader(p)
        }
        fn writer(&self, p: &str) -> anyhow::Result<Box<dyn Write + Send>> {
            LocalFs.writer(p)
        }
        fn private_writer(&self, p: &str) -> anyhow::Result<Box<dyn Write + Send>> {
            LocalFs.private_writer(p)
        }
        fn remove_file(&self, p: &str) -> anyhow::Result<()> {
            LocalFs.remove_file(p)
        }
        fn mkdir(&self, p: &str) -> anyhow::Result<()> {
            LocalFs.mkdir(p)
        }
        fn remove(&self, p: &str) -> anyhow::Result<()> {
            LocalFs.remove(p)
        }
        fn rename(&self, a: &str, b: &str) -> anyhow::Result<()> {
            LocalFs.rename(a, b)
        }
        fn join(&self, a: &str, b: &str) -> String {
            LocalFs.join(a, b)
        }
        fn rename_new(&self, from: &str, to: &str) -> anyhow::Result<()> {
            if from.ends_with(".part") && !self.0.swap(true, Ordering::SeqCst) {
                fs::write(to, "created by another process after final validation")?;
            }
            LocalFs.rename_new(from, to)
        }
    }
    let tmp = TempDir::new().unwrap();
    let file = tmp.path().join("target.txt");
    fs::write(&file, "original").unwrap();
    let document = editor::read(&LocalFs, file.to_str().unwrap()).unwrap();
    let error = editor::save(
        &RaceFs(AtomicBool::new(false)),
        file.to_str().unwrap(),
        "edited",
        &document.revision,
    )
    .unwrap_err();
    assert!(error.to_string().contains("original preserved at"));
    assert_eq!(
        fs::read_to_string(file).unwrap(),
        "created by another process after final validation"
    );
    let backups: Vec<_> = fs::read_dir(tmp.path())
        .unwrap()
        .map(|p| p.unwrap().path())
        .filter(|p| p.extension().is_some_and(|ext| ext == "backup"))
        .collect();
    assert_eq!(backups.len(), 1);
    assert_eq!(fs::read_to_string(&backups[0]).unwrap(), "original");
    let record: serde_json::Value = serde_json::from_slice(
        &fs::read(format!("{}.recovery.json", backups[0].display())).unwrap(),
    )
    .unwrap();
    assert_eq!(
        fs::canonicalize(record["original"].as_str().unwrap()).unwrap(),
        fs::canonicalize(tmp.path().join("target.txt")).unwrap()
    );
    assert_eq!(fs::read_dir(tmp.path()).unwrap().count(), 3);
}

#[test]
fn preserves_unicode_bom_and_windows_line_endings() {
    let tmp = TempDir::new().unwrap();
    let file = tmp.path().join("text.txt");
    fs::write(&file, b"\xef\xbb\xbfTere\r\nmaailm\r\n").unwrap();
    let doc = editor::read(&LocalFs, file.to_str().unwrap()).unwrap();
    assert_eq!(doc.text, "Tere\nmaailm\n");
    assert_eq!(doc.encoding, "UTF-8 BOM");
    let saved = editor::save(
        &LocalFs,
        file.to_str().unwrap(),
        "Õunad\nuus\n",
        &doc.revision,
    )
    .unwrap();
    assert_eq!(saved.text, "Õunad\nuus\n");
    assert_eq!(
        fs::read(&file).unwrap(),
        [b"\xef\xbb\xbf".as_slice(), "Õunad\r\nuus\r\n".as_bytes()].concat()
    );
    assert_eq!(fs::read_dir(tmp.path()).unwrap().count(), 1);
}
#[test]
fn rejects_conflicting_external_edits_binary_data_and_mixed_endings() {
    let tmp = TempDir::new().unwrap();
    let file = tmp.path().join("text.txt");
    fs::write(&file, "original").unwrap();
    let doc = editor::read(&LocalFs, file.to_str().unwrap()).unwrap();
    fs::write(&file, "external").unwrap();
    assert!(editor::save(&LocalFs, file.to_str().unwrap(), "edited", &doc.revision).is_err());
    assert_eq!(fs::read_to_string(&file).unwrap(), "external");
    for contents in [b"a\0b".as_slice(), b"a\r\nb\nc", b"\xff\x99"] {
        fs::write(&file, contents).unwrap();
        assert!(editor::read(&LocalFs, file.to_str().unwrap()).is_err());
    }
}
#[test]
fn utf16_round_trip_keeps_encoding_and_file_mode() {
    let tmp = TempDir::new().unwrap();
    let file = tmp.path().join("text.txt");
    fs::write(
        &file,
        [
            vec![0xff, 0xfe],
            "Õunad\n"
                .encode_utf16()
                .flat_map(u16::to_le_bytes)
                .collect(),
        ]
        .concat(),
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&file, fs::Permissions::from_mode(0o640)).unwrap();
    }
    let doc = editor::read(&LocalFs, file.to_str().unwrap()).unwrap();
    let saved = editor::save(
        &LocalFs,
        file.to_str().unwrap(),
        "Üks\nkaks\n",
        &doc.revision,
    )
    .unwrap();
    assert_eq!(saved.encoding, "UTF-16 LE");
    assert_eq!(saved.text, "Üks\nkaks\n");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o640
        );
    }
}
