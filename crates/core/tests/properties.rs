use commander_core::{
    filesystem::LocalFs,
    properties::{self, Changes, SizeSummary},
};
use std::{
    fs,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};
use tempfile::TempDir;

fn scan(paths: &[String]) -> SizeSummary {
    let result = Mutex::new(SizeSummary::default());
    properties::calculate(&LocalFs, paths, &AtomicBool::new(false), &|value| {
        *result.lock().unwrap() = value;
    })
    .unwrap();
    result.into_inner().unwrap()
}

#[test]
fn metadata_revision_rejects_external_changes_before_applying_attributes() {
    let tmp = TempDir::new().unwrap();
    let file = tmp.path().join("Õunad.txt");
    fs::write(&file, "original").unwrap();
    let path = file.to_str().unwrap();
    let info = properties::get(&LocalFs, path).unwrap();
    assert_eq!(info.file.size, 8);
    assert!(!info.revision.is_empty());
    fs::write(&file, "changed by another application").unwrap();
    let result = properties::apply(&LocalFs, path, &info.revision, &Changes::default());
    assert!(result.unwrap_err().to_string().contains("changed"));
    assert_eq!(
        fs::read_to_string(&file).unwrap(),
        "changed by another application"
    );
}

#[test]
fn folder_size_deduplicates_overlapping_roots_and_reports_missing_items() {
    let tmp = TempDir::new().unwrap();
    let child = tmp.path().join("child");
    fs::create_dir(&child).unwrap();
    let file = child.join("one.txt");
    fs::write(&file, "12345").unwrap();
    fs::write(tmp.path().join("two.txt"), "123").unwrap();
    let paths = [tmp.path(), &child, &file, &tmp.path().join("missing")]
        .map(|p| p.to_str().unwrap().to_owned());
    let result = scan(&paths);
    assert_eq!((result.files, result.folders, result.bytes), (2, 2, 8));
    assert_eq!(result.error_count, 1);
    assert!(result.errors[0].contains("missing"));
    assert!(result.done && !result.cancelled);
}

#[test]
fn folder_size_can_be_cancelled_during_a_large_directory() {
    let tmp = TempDir::new().unwrap();
    for index in 0..600 {
        fs::write(tmp.path().join(index.to_string()), "x").unwrap();
    }
    let cancel = AtomicBool::new(false);
    let result = Mutex::new(SizeSummary::default());
    properties::calculate(
        &LocalFs,
        &[tmp.path().to_str().unwrap().into()],
        &cancel,
        &|value| {
            if !value.done && value.files >= 256 {
                cancel.store(true, Ordering::Relaxed);
            }
            *result.lock().unwrap() = value;
        },
    )
    .unwrap();
    let result = result.into_inner().unwrap();
    assert!(result.done && result.cancelled);
    assert!((256..600).contains(&result.files));
    assert_eq!(result.bytes, result.files);
}

#[cfg(unix)]
#[test]
fn permission_masks_preserve_untouched_bits_and_never_follow_links() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    let tmp = TempDir::new().unwrap();
    let file = tmp.path().join("file");
    fs::write(&file, "unchanged").unwrap();
    fs::set_permissions(&file, fs::Permissions::from_mode(0o1640)).unwrap();
    let path = file.to_str().unwrap();
    let original = properties::get(&LocalFs, path).unwrap();
    let changed = properties::apply(
        &LocalFs,
        path,
        &original.revision,
        &Changes {
            mode_set: 0o011,
            mode_clear: 0o040,
            ..Changes::default()
        },
    )
    .unwrap();
    assert_eq!(changed.mode, Some(0o1611));
    assert_eq!(fs::read_to_string(&file).unwrap(), "unchanged");
    assert!(properties::apply(
        &LocalFs,
        path,
        &original.revision,
        &Changes {
            mode: Some(0o777),
            ..Changes::default()
        }
    )
    .is_err());
    assert!(properties::apply(
        &LocalFs,
        path,
        &changed.revision,
        &Changes {
            mode: Some(0o10000),
            ..Changes::default()
        }
    )
    .is_err());
    let link = tmp.path().join("link");
    symlink(&file, &link).unwrap();
    let link = link.to_str().unwrap();
    let info = properties::get(&LocalFs, link).unwrap();
    assert!(info.file.is_symlink && !info.editable.mode);
    assert_eq!(info.link_target.as_deref(), Some(path));
    assert!(properties::apply(
        &LocalFs,
        link,
        &info.revision,
        &Changes {
            mode: Some(0o777),
            ..Changes::default()
        }
    )
    .is_err());
    assert_eq!(properties::get(&LocalFs, path).unwrap().mode, Some(0o1611));
    // A directory link, including a cycle, is counted but never traversed.
    symlink(tmp.path(), tmp.path().join("loop")).unwrap();
    let summary = scan(&[tmp.path().to_str().unwrap().into()]);
    assert_eq!(
        (summary.files, summary.folders, summary.links, summary.bytes),
        (1, 1, 2, 9)
    );
}

#[cfg(windows)]
#[test]
fn windows_flags_round_trip_preserves_content_and_other_flags() {
    use std::os::windows::fs::MetadataExt;
    let tmp = TempDir::new().unwrap();
    let file = tmp.path().join("file.txt");
    fs::write(&file, "untouched").unwrap();
    let path = file.to_str().unwrap();
    let before = fs::metadata(&file).unwrap().file_attributes();
    let info = properties::get(&LocalFs, path).unwrap();
    assert!(info.editable.readonly && info.editable.hidden && !info.editable.mode);
    let changed = properties::apply(
        &LocalFs,
        path,
        &info.revision,
        &Changes {
            readonly: Some(true),
            hidden: Some(true),
            ..Changes::default()
        },
    )
    .unwrap();
    let changed_flags = fs::metadata(&file).unwrap().file_attributes();
    let restored = properties::apply(
        &LocalFs,
        path,
        &changed.revision,
        &Changes {
            readonly: Some(false),
            hidden: Some(false),
            ..Changes::default()
        },
    )
    .unwrap();
    assert_eq!((changed.readonly, changed.hidden), (Some(true), Some(true)));
    assert_eq!(before & !0x83, changed_flags & !0x83);
    assert_eq!(
        (restored.readonly, restored.hidden),
        (Some(false), Some(false))
    );
    assert_eq!(fs::read_to_string(&file).unwrap(), "untouched");
    let folder = tmp.path().to_str().unwrap();
    let info = properties::get(&LocalFs, folder).unwrap();
    assert!(!info.editable.readonly && info.editable.hidden);
    assert!(properties::apply(
        &LocalFs,
        folder,
        &info.revision,
        &Changes {
            readonly: Some(true),
            ..Changes::default()
        }
    )
    .is_err());
    let changed = properties::apply(
        &LocalFs,
        folder,
        &info.revision,
        &Changes {
            hidden: Some(true),
            ..Changes::default()
        },
    )
    .unwrap();
    properties::apply(
        &LocalFs,
        folder,
        &changed.revision,
        &Changes {
            hidden: Some(false),
            ..Changes::default()
        },
    )
    .unwrap();
    assert_eq!(changed.hidden, Some(true));
    assert_eq!(fs::metadata(file).unwrap().file_attributes() & 3, 0);
}

#[test]
fn archive_properties_are_read_only_and_size_uses_uncompressed_content() {
    use std::io::Write;
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("archive.zip");
    let mut writer = zip::ZipWriter::new(fs::File::create(&path).unwrap());
    writer
        .start_file("folder/file.txt", zip::write::SimpleFileOptions::default())
        .unwrap();
    writer.write_all(b"123456").unwrap();
    writer.finish().unwrap();
    let zip = commander_core::archive::ZipFs::new(path.to_str().unwrap()).unwrap();
    let info = properties::get(&zip, "/folder/file.txt").unwrap();
    assert_eq!(info.file.size, 6);
    assert!(!info.editable.mode && !info.editable.readonly && !info.editable.hidden);
    assert!(properties::apply(
        &zip,
        "/folder/file.txt",
        &info.revision,
        &Changes {
            readonly: Some(false),
            ..Changes::default()
        }
    )
    .is_err());
    let summary = Mutex::new(SizeSummary::default());
    properties::calculate(
        &zip,
        &["/folder".into()],
        &AtomicBool::new(false),
        &|value| *summary.lock().unwrap() = value,
    )
    .unwrap();
    let summary = summary.into_inner().unwrap();
    assert_eq!((summary.files, summary.folders, summary.bytes), (1, 1, 6));
}
