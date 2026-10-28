use commander_core::clipboard::{self, Files};

#[test]
fn rejects_invalid_clipboard_payloads_and_cutting_archives() {
    let value = Files {
        source: "sftp:test".into(),
        paths: vec!["/path/Õun.txt".into()],
        cut: false,
        revision: 0,
        connection: None,
        bindings: None,
    };
    assert!(value.validate().is_ok());
    assert!(Files {
        paths: vec![],
        ..value.clone()
    }
    .validate()
    .is_err());
    assert!(Files {
        paths: vec!["bad\0path".into()],
        ..value.clone()
    }
    .validate()
    .is_err());
    assert!(Files {
        source: "zip:archive.zip".into(),
        cut: true,
        ..value
    }
    .validate()
    .is_err());
}

#[cfg(not(windows))]
#[test]
fn clipboard_revisions_prevent_old_jobs_from_overwriting_new_copies() {
    let value = Files {
        source: "local".into(),
        paths: vec!["/tmp/a".into(), "/tmp/b".into()],
        cut: true,
        revision: 0,
        connection: None,
        bindings: None,
    };
    let first = clipboard::write(0, &value).unwrap();
    let remaining = clipboard::replace_if_unchanged(0, &first, vec!["/tmp/b".into()])
        .unwrap()
        .unwrap();
    assert_eq!(remaining.paths, vec!["/tmp/b"]);
    assert_ne!(remaining.revision, first.revision);
    let newer = clipboard::write(
        0,
        &Files {
            paths: vec!["/tmp/new".into()],
            cut: false,
            ..value
        },
    )
    .unwrap();
    assert_eq!(
        clipboard::replace_if_unchanged(0, &remaining, vec![]).unwrap(),
        Some(newer)
    );
    clipboard::text(0, "a new text selection").unwrap();
    assert_eq!(clipboard::read(0).unwrap(), None);
    assert!(clipboard::write_captured(
        0,
        &remaining,
        clipboard::revision(),
        &std::sync::atomic::AtomicBool::new(true)
    )
    .is_err());
    assert!(clipboard::write_at_revision(0, &remaining, Some(remaining.revision)).is_err());
    assert_eq!(clipboard::read(0).unwrap(), None);
    // Partial moves retain the binding belonging to each remaining path.
    let root = tempfile::TempDir::new().unwrap();
    let paths: Vec<String> = ["one.txt", "two.txt"]
        .iter()
        .map(|name| {
            let path = root.path().join(name);
            std::fs::write(&path, name).unwrap();
            path.to_string_lossy().into()
        })
        .collect();
    let mut bound = Files {
        source: "local".into(),
        paths,
        cut: true,
        revision: 0,
        connection: None,
        bindings: None,
    };
    bound
        .capture_selection(
            &commander_core::filesystem::LocalFs,
            &std::sync::atomic::AtomicBool::new(false),
            &|_| {},
        )
        .unwrap();
    let written = clipboard::write(0, &bound).unwrap();
    let partial = clipboard::replace_if_unchanged(0, &written, vec![bound.paths[1].clone()])
        .unwrap()
        .unwrap();
    assert_eq!(partial.bindings.as_ref().unwrap().len(), 1);
    partial
        .validate_selection(
            &commander_core::filesystem::LocalFs,
            &std::sync::atomic::AtomicBool::new(false),
            &|_| {},
        )
        .unwrap();
}

#[cfg(windows)]
#[test]
#[ignore = "Writes the Windows clipboard; run only in a dedicated CI desktop"]
fn windows_file_clipboard_interoperates_with_shell_formats() {
    use std::ptr;
    use windows_sys::Win32::{
        Foundation::POINT,
        System::{DataExchange::*, Memory::*, Ole::CF_HDROP},
        UI::{
            Shell::{DragQueryFileW, DROPFILES},
            WindowsAndMessaging::*,
        },
    };
    assert_eq!(
        std::env::var("CI").as_deref(),
        Ok("true"),
        "This test owns its dedicated CI clipboard"
    );
    let class: Vec<u16> = "STATIC\0".encode_utf16().collect();
    let window = unsafe {
        CreateWindowExW(
            0,
            class.as_ptr(),
            class.as_ptr(),
            0,
            0,
            0,
            0,
            0,
            HWND_MESSAGE,
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null(),
        )
    };
    assert!(!window.is_null());
    let owner = window as usize;
    let paths = vec![
        "C:\\temporary\\Õun🚀.txt".to_string(),
        "\\\\server\\share\\file.txt".to_string(),
    ];
    let data = Files {
        source: "local".into(),
        paths: paths.clone(),
        cut: true,
        revision: 0,
        connection: None,
        bindings: None,
    };
    let copied = clipboard::write(owner, &data).unwrap();
    assert_eq!(clipboard::read(owner).unwrap(), Some(copied.clone()));
    // Check the public shell representation, independently of our private JSON payload.
    unsafe {
        assert_ne!(OpenClipboard(window), 0);
        assert_ne!(IsClipboardFormatAvailable(CF_HDROP as u32), 0);
        let drop = GetClipboardData(CF_HDROP as u32);
        assert_eq!(DragQueryFileW(drop, u32::MAX, ptr::null_mut(), 0), 2);
        let mut buffer = vec![0u16; 32769];
        let size = DragQueryFileW(drop, 0, buffer.as_mut_ptr(), buffer.len() as u32);
        assert_eq!(
            String::from_utf16(&buffer[..size as usize]).unwrap(),
            paths[0]
        );
        let effect_name: Vec<u16> = "Preferred DropEffect\0".encode_utf16().collect();
        let effect = GetClipboardData(RegisterClipboardFormatW(effect_name.as_ptr()));
        let pointer = GlobalLock(effect).cast::<u32>();
        assert!(!pointer.is_null());
        assert_eq!(*pointer, 2);
        GlobalUnlock(effect);
        CloseClipboard();
    }
    let partial = clipboard::replace_if_unchanged(owner, &copied, vec![paths[1].clone()])
        .unwrap()
        .unwrap();
    assert_eq!(partial.paths, vec![paths[1].clone()]);
    assert_eq!(clipboard::read(owner).unwrap(), Some(partial.clone()));
    let new = clipboard::write(
        owner,
        &Files {
            paths: vec!["C:\\new.txt".into()],
            cut: false,
            ..data
        },
    )
    .unwrap();
    assert_eq!(
        clipboard::replace_if_unchanged(owner, &partial, vec![]).unwrap(),
        Some(new)
    );
    // Simulate an external producer such as Explorer: CF_HDROP + drop effect, without our format.
    unsafe {
        assert_ne!(OpenClipboard(window), 0);
        assert_ne!(EmptyClipboard(), 0);
        let header = DROPFILES {
            pFiles: std::mem::size_of::<DROPFILES>() as u32,
            pt: POINT { x: 0, y: 0 },
            fNC: 0,
            fWide: 1,
        };
        let mut bytes = std::slice::from_raw_parts(
            (&header as *const DROPFILES).cast::<u8>(),
            std::mem::size_of::<DROPFILES>(),
        )
        .to_vec();
        for path in &paths {
            bytes.extend(
                path.encode_utf16()
                    .chain(Some(0))
                    .flat_map(u16::to_le_bytes),
            );
        }
        bytes.extend([0, 0]);
        let block = GlobalAlloc(GMEM_MOVEABLE, bytes.len());
        let target = GlobalLock(block);
        assert!(!target.is_null());
        ptr::copy_nonoverlapping(bytes.as_ptr(), target.cast(), bytes.len());
        GlobalUnlock(block);
        assert!(!SetClipboardData(CF_HDROP as u32, block).is_null());
        CloseClipboard();
    }
    let imported = clipboard::read(owner).unwrap().unwrap();
    assert_eq!(imported.paths, paths);
    assert!(!imported.cut);
    assert_eq!(imported.source, "local");
    // A shell-optimized move has already consumed these paths even if CF_HDROP remains.
    unsafe {
        assert_ne!(OpenClipboard(window), 0);
        let name: Vec<u16> = "Logical Performed DropEffect\0".encode_utf16().collect();
        let block = GlobalAlloc(GMEM_MOVEABLE, 4);
        let pointer = GlobalLock(block).cast::<u32>();
        assert!(!pointer.is_null());
        *pointer = 2;
        GlobalUnlock(block);
        assert!(!SetClipboardData(RegisterClipboardFormatW(name.as_ptr()), block).is_null());
        CloseClipboard();
    }
    assert_eq!(clipboard::read(owner).unwrap(), None);
    // A malformed external DROPFILES list must be rejected before invoking shell readers.
    unsafe {
        assert_ne!(OpenClipboard(window), 0);
        assert_ne!(EmptyClipboard(), 0);
        let block = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, 24);
        let pointer = GlobalLock(block).cast::<u32>();
        assert!(!pointer.is_null());
        *pointer = u32::MAX;
        GlobalUnlock(block);
        assert!(!SetClipboardData(CF_HDROP as u32, block).is_null());
        CloseClipboard();
    }
    assert!(clipboard::read(owner).is_err());
    let remote = Files {
        source: "sftp:session".into(),
        paths: vec!["/remote/file".into()],
        cut: false,
        revision: 0,
        connection: None,
        bindings: None,
    };
    clipboard::write(owner, &remote).unwrap();
    assert_eq!(unsafe { IsClipboardFormatAvailable(CF_HDROP as u32) }, 0);
    assert_eq!(clipboard::read(owner).unwrap().unwrap().paths, remote.paths);
    clipboard::text(owner, "plain text replaces file selection").unwrap();
    assert_eq!(clipboard::read(owner).unwrap(), None);
    assert!(clipboard::write_captured(
        owner,
        &remote,
        clipboard::revision(),
        &std::sync::atomic::AtomicBool::new(true)
    )
    .is_err());
    let revision = clipboard::revision();
    clipboard::text(owner, "a newer clipboard selection").unwrap();
    assert!(clipboard::write_at_revision(owner, &remote, Some(revision)).is_err());
    assert_eq!(clipboard::read(owner).unwrap(), None);
    let root = tempfile::TempDir::new().unwrap();
    let paths: Vec<String> = ["one.txt", "two.txt"]
        .iter()
        .map(|name| {
            let path = root.path().join(name);
            std::fs::write(&path, name).unwrap();
            path.to_string_lossy().into()
        })
        .collect();
    let mut bound = Files {
        source: "local".into(),
        paths,
        cut: true,
        revision: 0,
        connection: None,
        bindings: None,
    };
    bound
        .capture_selection(
            &commander_core::filesystem::LocalFs,
            &std::sync::atomic::AtomicBool::new(false),
            &|_| {},
        )
        .unwrap();
    let written = clipboard::write(owner, &bound).unwrap();
    let partial = clipboard::replace_if_unchanged(owner, &written, vec![bound.paths[1].clone()])
        .unwrap()
        .unwrap();
    assert_eq!(partial.bindings.as_ref().unwrap().len(), 1);
    partial
        .validate_selection(
            &commander_core::filesystem::LocalFs,
            &std::sync::atomic::AtomicBool::new(false),
            &|_| {},
        )
        .unwrap();
    unsafe {
        DestroyWindow(window);
    }
}
