//! Immediate clipboard rendering with native Explorer file-drop interoperability.
//! Formats and ownership: https://learn.microsoft.com/windows/win32/shell/clipboard
//! https://learn.microsoft.com/windows/win32/dataxchg/clipboard-operations
use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};

const MAX_BYTES: usize = 64 * 1024 * 1024;
const MAX_PATHS: usize = 100_000;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Files {
    pub source: String,
    pub paths: Vec<String>,
    pub cut: bool,
    #[serde(default)]
    pub revision: u32,
}
impl Files {
    pub fn validate(&self) -> Result<()> {
        if self.source.is_empty()
            || self.source.len() > 32768
            || self.source.contains('\0')
            || self.paths.is_empty()
            || self.paths.len() > MAX_PATHS
            || self
                .paths
                .iter()
                .any(|p| p.is_empty() || p.contains('\0') || p.encode_utf16().count() > 32768)
            || self.paths.iter().map(String::len).sum::<usize>() > MAX_BYTES / 3
        {
            bail!("Invalid or oversized file clipboard");
        }
        if self.cut && self.source.starts_with("zip:") {
            bail!("An archive is read-only");
        }
        #[cfg(windows)]
        if self.source == "local"
            && self
                .paths
                .iter()
                .any(|p| !std::path::Path::new(p).is_absolute())
        {
            bail!("File clipboard paths must be absolute");
        }
        Ok(())
    }
}

#[cfg(windows)]
mod platform {
    use super::*;
    use anyhow::Context;
    use std::{ptr, sync::Mutex, time::Duration};
    use windows_sys::Win32::{
        Foundation::{GlobalFree, HGLOBAL, HWND},
        System::{
            DataExchange::*,
            Memory::*,
            Ole::{CF_HDROP, CF_UNICODETEXT},
        },
        UI::Shell::DragQueryFileW,
    };
    static ACCESS: Mutex<()> = Mutex::new(());
    struct Open;
    impl Open {
        fn new(owner: usize) -> Result<Self> {
            if owner == 0 {
                bail!("Clipboard requires an application window");
            }
            for _ in 0..20 {
                if unsafe { OpenClipboard(owner as HWND) } != 0 {
                    return Ok(Self);
                }
                std::thread::sleep(Duration::from_millis(5));
            }
            bail!("The clipboard is busy. Try again.")
        }
    }
    impl Drop for Open {
        fn drop(&mut self) {
            unsafe {
                CloseClipboard();
            }
        }
    }
    struct Memory(HGLOBAL);
    impl Memory {
        fn new(bytes: &[u8]) -> Result<Self> {
            if bytes.len() > MAX_BYTES {
                bail!("Clipboard content is too large");
            }
            let handle = unsafe { GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, bytes.len().max(1)) };
            if handle.is_null() {
                return Err(std::io::Error::last_os_error())
                    .context("Cannot allocate clipboard memory");
            }
            let memory = Self(handle);
            let target = unsafe { GlobalLock(handle) };
            if target.is_null() {
                return Err(std::io::Error::last_os_error())
                    .context("Cannot lock clipboard memory");
            }
            unsafe {
                ptr::copy_nonoverlapping(bytes.as_ptr(), target.cast(), bytes.len());
                GlobalUnlock(handle);
            }
            Ok(memory)
        }
        fn publish(mut self, format: u32) -> Result<()> {
            if unsafe { SetClipboardData(format, self.0) }.is_null() {
                return Err(std::io::Error::last_os_error()).context("Cannot write clipboard data");
            }
            self.0 = ptr::null_mut(); // The system owns the allocation after SetClipboardData succeeds.
            Ok(())
        }
    }
    impl Drop for Memory {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe {
                    GlobalFree(self.0);
                }
            }
        }
    }
    fn format(name: &str) -> Result<u32> {
        let name: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
        let value = unsafe { RegisterClipboardFormatW(name.as_ptr()) };
        if value == 0 {
            bail!("Cannot register clipboard format");
        }
        Ok(value)
    }
    fn bytes(format: u32) -> Result<Option<Vec<u8>>> {
        if unsafe { IsClipboardFormatAvailable(format) } == 0 {
            return Ok(None);
        }
        let handle = unsafe { GetClipboardData(format) };
        if handle.is_null() {
            return Err(std::io::Error::last_os_error()).context("Cannot read clipboard data");
        }
        let size = unsafe { GlobalSize(handle) };
        if size == 0 || size > MAX_BYTES {
            bail!("Invalid or oversized clipboard data");
        }
        let data = unsafe { GlobalLock(handle) };
        if data.is_null() {
            return Err(std::io::Error::last_os_error()).context("Cannot lock clipboard data");
        }
        let value = unsafe { std::slice::from_raw_parts(data.cast::<u8>(), size).to_vec() };
        unsafe {
            GlobalUnlock(handle);
        }
        Ok(Some(value))
    }
    fn read_open() -> Result<Option<Files>> {
        // Explorer can leave the original formats after a completed move. The logical
        // result (unlike Performed DropEffect, which may be NONE for optimized moves)
        // tells us these paths have already been consumed. Never move them twice.
        for name in ["Logical Performed DropEffect", "Paste Succeeded"] {
            if bytes(format(name)?)?
                .filter(|v| v.len() >= 4)
                .is_some_and(|v| u32::from_le_bytes(v[..4].try_into().unwrap()) & 2 != 0)
            {
                return Ok(None);
            }
        }
        if let Some(bytes) = bytes(format("SuperCommander.Files.v1")?)? {
            let end = bytes.iter().position(|b| *b == 0).unwrap_or(bytes.len());
            if let Ok(mut value) = serde_json::from_slice::<Files>(&bytes[..end]) {
                value.validate()?;
                value.revision = revision();
                return Ok(Some(value));
            }
        }
        let Some(drop) = bytes(CF_HDROP as u32)? else {
            return Ok(None);
        };
        if drop.len() < 22 {
            bail!("Invalid file clipboard header");
        }
        let offset = u32::from_le_bytes(drop[..4].try_into().unwrap()) as usize;
        if offset < 20 || offset >= drop.len() {
            bail!("Invalid file clipboard offset");
        }
        let wide = u32::from_le_bytes(drop[16..20].try_into().unwrap()) != 0;
        let tail = &drop[offset..];
        let terminated = if wide {
            offset.is_multiple_of(2)
                && tail
                    .as_chunks::<2>()
                    .0
                    .windows(2)
                    .any(|w| w == [[0, 0], [0, 0]])
        } else {
            tail.windows(2).any(|w| w == [0, 0])
        };
        if !terminated {
            bail!("Unterminated file clipboard");
        }
        let handle = unsafe { GetClipboardData(CF_HDROP as u32) };
        let count = unsafe { DragQueryFileW(handle, u32::MAX, ptr::null_mut(), 0) } as usize;
        if count == 0 || count > MAX_PATHS {
            bail!("Invalid file clipboard count");
        }
        let mut paths = Vec::with_capacity(count);
        for index in 0..count {
            let len = unsafe { DragQueryFileW(handle, index as u32, ptr::null_mut(), 0) };
            if len == 0 || len > 32768 {
                bail!("Invalid file clipboard path");
            }
            let mut path = vec![0u16; len as usize + 1];
            let written =
                unsafe { DragQueryFileW(handle, index as u32, path.as_mut_ptr(), len + 1) };
            if written != len {
                bail!("Cannot read file clipboard path");
            }
            paths.push(String::from_utf16(&path[..len as usize])?);
        }
        let effect = bytes(format("Preferred DropEffect")?)?
            .filter(|v| v.len() >= 4)
            .map(|v| u32::from_le_bytes(v[..4].try_into().unwrap()))
            .unwrap_or(1);
        let value = Files {
            source: "local".into(),
            paths,
            cut: effect & 2 != 0,
            revision: revision(),
        };
        value.validate()?;
        Ok(Some(value))
    }
    fn write_open(value: &Files) -> Result<()> {
        value.validate()?;
        let private = format("SuperCommander.Files.v1")?;
        let effect = format("Preferred DropEffect")?;
        let mut formats = vec![(private, Memory::new(&serde_json::to_vec(value)?)?)];
        if value.source == "local" {
            // DROPFILES: pFiles=20, POINT=(0,0), fNC=0, fWide=1, followed by a UTF-16 double-NUL list.
            let mut drop = vec![0u8; 20];
            drop[..4].copy_from_slice(&20u32.to_le_bytes());
            drop[16..20].copy_from_slice(&1u32.to_le_bytes());
            for path in &value.paths {
                drop.extend(
                    path.encode_utf16()
                        .chain(Some(0))
                        .flat_map(u16::to_le_bytes),
                );
            }
            drop.extend([0, 0]);
            formats.push((CF_HDROP as u32, Memory::new(&drop)?));
            formats.push((
                effect,
                Memory::new(&(if value.cut { 2u32 } else { 1u32 }).to_le_bytes())?,
            ));
        }
        let text: Vec<u8> = value
            .paths
            .join("\r\n")
            .encode_utf16()
            .chain(Some(0))
            .flat_map(u16::to_le_bytes)
            .collect();
        formats.push((CF_UNICODETEXT as u32, Memory::new(&text)?));
        // Allocate and validate all formats before replacing the user's previous clipboard.
        if unsafe { EmptyClipboard() } == 0 {
            bail!("Cannot empty the clipboard");
        }
        for (id, data) in formats {
            data.publish(id)?;
        }
        Ok(())
    }
    pub fn revision() -> u32 {
        unsafe { GetClipboardSequenceNumber() }
    }
    pub fn read(owner: usize) -> Result<Option<Files>> {
        let _lock = ACCESS.lock().unwrap();
        let _open = Open::new(owner)?;
        read_open()
    }
    pub fn write(owner: usize, value: &Files) -> Result<Files> {
        let _lock = ACCESS.lock().unwrap();
        {
            let _open = Open::new(owner)?;
            write_open(value)?;
        }
        // Closing a Unicode-text clipboard adds synthesized text formats and
        // advances its sequence number. Reopen and read the actual clipboard:
        // sampling the sequence before CloseClipboard produces a stale receipt,
        // while sampling afterwards alone could claim another application's data.
        let _open = Open::new(owner)?;
        read_open()?.context("The clipboard changed while copying files")
    }
    pub fn text(owner: usize, value: &str) -> Result<()> {
        if value.contains('\0') {
            bail!("Clipboard text contains NUL");
        }
        let data: Vec<u8> = value
            .encode_utf16()
            .chain(Some(0))
            .flat_map(u16::to_le_bytes)
            .collect();
        let memory = Memory::new(&data)?;
        let _lock = ACCESS.lock().unwrap();
        let _open = Open::new(owner)?;
        if unsafe { EmptyClipboard() } == 0 {
            bail!("Cannot empty the clipboard");
        }
        memory.publish(CF_UNICODETEXT as u32)
    }
    pub fn replace_if_unchanged(
        owner: usize,
        expected: &Files,
        remaining: Vec<String>,
    ) -> Result<Option<Files>> {
        let _lock = ACCESS.lock().unwrap();
        let open = Open::new(owner)?;
        let current = read_open()?;
        if current.as_ref() != Some(expected) || !expected.cut {
            return Ok(current);
        }
        if remaining == expected.paths {
            return Ok(current);
        }
        if remaining.is_empty() {
            if unsafe { EmptyClipboard() } == 0 {
                bail!("Cannot empty the clipboard");
            }
            return Ok(None);
        }
        write_open(&Files {
            paths: remaining,
            ..expected.clone()
        })?;
        drop(open);
        let _open = Open::new(owner)?;
        read_open()
    }
}

#[cfg(not(windows))]
mod platform {
    use super::*;
    use std::sync::Mutex;
    static MEMORY: Mutex<(u32, Option<Files>)> = Mutex::new((1, None));
    pub fn revision() -> u32 {
        MEMORY.lock().unwrap().0
    }
    pub fn read(_: usize) -> Result<Option<Files>> {
        Ok(MEMORY.lock().unwrap().1.clone())
    }
    pub fn write(_: usize, value: &Files) -> Result<Files> {
        value.validate()?;
        let mut data = MEMORY.lock().unwrap();
        data.0 = data.0.wrapping_add(1);
        let result = Files {
            revision: data.0,
            ..value.clone()
        };
        data.1 = Some(result.clone());
        Ok(result)
    }
    pub fn text(_: usize, _: &str) -> Result<()> {
        let mut data = MEMORY.lock().unwrap();
        data.0 = data.0.wrapping_add(1);
        data.1 = None;
        Ok(())
    }
    pub fn replace_if_unchanged(
        owner: usize,
        expected: &Files,
        remaining: Vec<String>,
    ) -> Result<Option<Files>> {
        let mut data = MEMORY.lock().unwrap();
        if data.1.as_ref() != Some(expected) || !expected.cut || remaining == expected.paths {
            return Ok(data.1.clone());
        }
        data.0 = data.0.wrapping_add(1);
        data.1 = if remaining.is_empty() {
            None
        } else {
            Some(Files {
                paths: remaining,
                revision: data.0,
                ..expected.clone()
            })
        };
        let _ = owner;
        Ok(data.1.clone())
    }
}
pub use platform::{read, replace_if_unchanged, revision, text, write};
