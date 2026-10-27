use commander_core::{editor, filesystem::LocalFs};
use std::fs;
use tempfile::TempDir;

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
