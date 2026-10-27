use commander_core::{
    filesystem::{FileSystem, LocalFs},
    search::{self, Batch, Hit},
    text, SearchFilter,
};
use std::{
    fs,
    io::{Cursor, Read},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};
use tempfile::TempDir;

fn scan(root: &std::path::Path, filter: SearchFilter) -> (Vec<Hit>, Batch) {
    let hits = Mutex::new(Vec::new());
    let result = Mutex::new(Batch::default());
    search::run(
        &LocalFs,
        root.to_str().unwrap(),
        &filter,
        &AtomicBool::new(false),
        &|batch| {
            hits.lock().unwrap().extend(batch.matches.clone());
            *result.lock().unwrap() = batch;
        },
    )
    .unwrap();
    (hits.into_inner().unwrap(), result.into_inner().unwrap())
}

#[test]
fn filename_masks_exclusions_recursion_case_and_ranges_are_applied_together() {
    let tmp = TempDir::new().unwrap();
    for folder in ["nested", "ignored"] {
        fs::create_dir(tmp.path().join(folder)).unwrap();
    }
    for file in [
        "one.rs",
        "two.toml",
        "UPPER.RS",
        ".hidden.rs",
        "nested/child.rs",
        "ignored/excluded.rs",
    ] {
        fs::write(tmp.path().join(file), "123456").unwrap();
    }
    let mut filter = SearchFilter {
        query: "*.rs;*.toml".into(),
        name_mode: "glob".into(),
        exclude: "ignored".into(),
        min_size: Some(5),
        kind: "files".into(),
        ..Default::default()
    };
    assert_eq!(scan(tmp.path(), filter.clone()).0.len(), 4);
    filter.recursive = false;
    assert_eq!(scan(tmp.path(), filter.clone()).0.len(), 3);
    filter.case_sensitive = true;
    assert_eq!(scan(tmp.path(), filter.clone()).0.len(), 2);
    filter.show_hidden = true;
    assert_eq!(scan(tmp.path(), filter.clone()).0.len(), 3);
    filter.min_size = Some(7);
    filter.kind = "all".into();
    filter.query = "*".into();
    assert!(scan(tmp.path(), filter).0.is_empty());
}

#[test]
fn contents_decode_utf8_and_utf16_and_return_unicode_safe_line_snippets() {
    let tmp = TempDir::new().unwrap();
    let text = "First line\r\nÕunad 🚀 NEEDLE on teine\r\n";
    fs::write(tmp.path().join("utf8.txt"), text).unwrap();
    fs::write(tmp.path().join("bom.txt"), format!("\u{feff}{text}")).unwrap();
    for le in [true, false] {
        let mut bytes = if le {
            vec![0xff, 0xfe]
        } else {
            vec![0xfe, 0xff]
        };
        bytes.extend(text.encode_utf16().flat_map(|word| {
            if le {
                word.to_le_bytes()
            } else {
                word.to_be_bytes()
            }
        }));
        fs::write(
            tmp.path().join(if le { "little.txt" } else { "big.txt" }),
            bytes,
        )
        .unwrap();
    }
    fs::write(tmp.path().join("binary.txt"), b"\0NEEDLE").unwrap();
    fs::write(tmp.path().join("unsupported.txt"), [0xff, 0, 0x80]).unwrap();
    let (hits, summary) = scan(
        tmp.path(),
        SearchFilter {
            content: "needle".into(),
            whole_word: true,
            ..Default::default()
        },
    );
    assert_eq!(hits.len(), 4);
    assert_eq!(summary.skipped_binary, 2);
    for hit in hits {
        assert_eq!((hit.line, hit.column), (Some(2), Some(9)));
        let preview: Vec<u16> = hit.preview.unwrap().encode_utf16().collect();
        assert_eq!(
            String::from_utf16(&preview[hit.start..hit.end]).unwrap(),
            "NEEDLE"
        );
    }
    let (hits, _) = scan(
        tmp.path(),
        SearchFilter {
            query: "^utf8\\.txt$".into(),
            name_mode: "regex".into(),
            content: "N.E+DL[AE]".into(),
            content_regex: true,
            case_sensitive: true,
            ..Default::default()
        },
    );
    assert_eq!(hits.len(), 1);
}

#[test]
fn large_files_are_streamed_and_the_matching_window_can_be_viewed() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("large.log");
    let mut data = format!("{}\n", "x".repeat(64)).repeat(90_000);
    data.push_str("last line contains TARGET 🚀");
    fs::write(&path, data).unwrap();
    let (hits, summary) = scan(
        tmp.path(),
        SearchFilter {
            content: "TARGET".into(),
            ..Default::default()
        },
    );
    assert_eq!(summary.found, 1);
    assert_eq!(hits[0].line, Some(90_001));
    assert_eq!(hits[0].entry.path, path.to_str().unwrap());
    let window = text::window(
        LocalFs.reader(path.to_str().unwrap()).unwrap(),
        90_001,
        &AtomicBool::new(false),
    )
    .unwrap();
    assert!(window.first_line > 1 && window.first_line <= 90_001);
    assert_eq!(window.last_line, 90_001);
    assert!(window.text.ends_with("TARGET 🚀") && !window.more);
    assert!(window.text.len() < 256 * 1024);
    let eof = text::window(
        LocalFs.reader(path.to_str().unwrap()).unwrap(),
        1_000_000,
        &AtomicBool::new(false),
    )
    .unwrap();
    assert_eq!(eof.last_line, 90_001);
    assert!(eof.text.ends_with("TARGET 🚀"));
}

#[test]
fn streaming_cancellation_and_result_limits_preserve_partial_results() {
    let tmp = TempDir::new().unwrap();
    for index in 0..300 {
        fs::write(tmp.path().join(format!("{index}.txt")), "hit").unwrap();
    }
    let cancel = AtomicBool::new(false);
    let last = Mutex::new(Batch::default());
    search::run(
        &LocalFs,
        tmp.path().to_str().unwrap(),
        &SearchFilter::default(),
        &cancel,
        &|batch| {
            if !batch.done {
                cancel.store(true, Ordering::Relaxed);
            }
            *last.lock().unwrap() = batch;
        },
    )
    .unwrap();
    let summary = last.into_inner().unwrap();
    assert!(summary.done && summary.cancelled && summary.found >= 128 && summary.found < 300);
    let (hits, summary) = scan(
        tmp.path(),
        SearchFilter {
            max_results: 3,
            ..Default::default()
        },
    );
    assert_eq!(hits.len(), 3);
    assert!(summary.limited && summary.done && !summary.cancelled);
    assert_eq!(
        summary.scanned, 3,
        "Stop directory enumeration at the limit"
    );
}

#[test]
fn long_lines_and_invalid_patterns_are_explicit_and_not_silent_nonmatches() {
    let tmp = TempDir::new().unwrap();
    fs::write(tmp.path().join("long.txt"), vec![b'a'; text::MAX_LINE + 1]).unwrap();
    let (hits, summary) = scan(
        tmp.path(),
        SearchFilter {
            content: "needle".into(),
            ..Default::default()
        },
    );
    assert!(hits.is_empty());
    assert_eq!(summary.skipped_long_lines, 1);
    for filter in [
        SearchFilter {
            name_mode: "regex".into(),
            query: "[".into(),
            ..Default::default()
        },
        SearchFilter {
            content_regex: true,
            content: "(".into(),
            ..Default::default()
        },
        SearchFilter {
            min_size: Some(9),
            max_size: Some(1),
            ..Default::default()
        },
        SearchFilter {
            max_results: 0,
            ..Default::default()
        },
    ] {
        assert!(search::run(
            &LocalFs,
            tmp.path().to_str().unwrap(),
            &filter,
            &AtomicBool::new(false),
            &|_| {}
        )
        .is_err());
    }
}

#[cfg(unix)]
#[test]
fn denied_folders_report_partial_errors_and_child_links_are_not_followed() {
    use std::os::unix::fs::{symlink, MetadataExt, PermissionsExt};
    let tmp = TempDir::new().unwrap();
    if fs::metadata(tmp.path()).unwrap().uid() == 0 {
        return;
    }
    let denied = tmp.path().join("denied");
    fs::create_dir(&denied).unwrap();
    fs::write(denied.join("private.txt"), "needle").unwrap();
    fs::write(tmp.path().join("public.txt"), "needle").unwrap();
    let blocked = tmp.path().join("blocked.txt");
    fs::write(&blocked, "needle").unwrap();
    fs::set_permissions(&blocked, fs::Permissions::from_mode(0o000)).unwrap();
    symlink(tmp.path(), tmp.path().join("cycle")).unwrap();
    fs::set_permissions(&denied, fs::Permissions::from_mode(0o000)).unwrap();
    let (hits, summary) = scan(
        tmp.path(),
        SearchFilter {
            content: "needle".into(),
            ..Default::default()
        },
    );
    fs::set_permissions(&denied, fs::Permissions::from_mode(0o700)).unwrap();
    fs::set_permissions(&blocked, fs::Permissions::from_mode(0o600)).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(summary.error_count, 2);
    assert!(summary
        .errors
        .iter()
        .any(|error| error.contains("blocked.txt") && error.contains("Permission denied")));
}

#[test]
fn text_reader_handles_split_boms_surrogates_empty_files_and_cancellation() {
    struct Chunks {
        bytes: Cursor<Vec<u8>>,
        size: usize,
    }
    impl Read for Chunks {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            let limit = buffer.len().min(self.size);
            self.bytes.read(&mut buffer[..limit])
        }
    }
    let mut data = vec![0xff, 0xfe];
    data.extend("Õunad 🚀\r\nend".encode_utf16().flat_map(u16::to_le_bytes));
    let window = text::window(
        Box::new(Chunks {
            bytes: Cursor::new(data),
            size: 1,
        }),
        1,
        &AtomicBool::new(false),
    )
    .unwrap();
    assert_eq!(window.encoding, "UTF-16 LE");
    assert_eq!(window.text, "Õunad 🚀\nend");
    let empty = text::window(
        Box::new(Cursor::new(Vec::new())),
        1,
        &AtomicBool::new(false),
    )
    .unwrap();
    assert_eq!(empty.text, "");
    assert!(text::window(
        Box::new(Cursor::new(b"text".to_vec())),
        1,
        &AtomicBool::new(true)
    )
    .is_err());
}

#[cfg(unix)]
#[test]
fn content_search_refuses_named_pipes_without_blocking() {
    let tmp = TempDir::new().unwrap();
    let fifo = tmp.path().join("pipe");
    assert!(std::process::Command::new("mkfifo")
        .arg(&fifo)
        .status()
        .unwrap()
        .success());
    fs::write(tmp.path().join("file.txt"), "needle").unwrap();
    let (hits, summary) = scan(
        tmp.path(),
        SearchFilter {
            content: "needle".into(),
            ..Default::default()
        },
    );
    assert_eq!(hits.len(), 1);
    assert_eq!(summary.error_count, 1);
    assert!(summary.errors[0].contains("special files"));
}
