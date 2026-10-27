use crate::filesystem::FileSystem;
use anyhow::{bail, Context, Result};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::io::Read;

const LIMIT: usize = 4 * 1024 * 1024;
static SAVE: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Document {
    pub text: String,
    pub revision: String,
    pub encoding: String,
    pub line_ending: String,
}
fn revision(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
fn bytes(fs: &dyn FileSystem, path: &str) -> Result<Vec<u8>> {
    let meta = fs.stat(path)?;
    if meta.is_dir || meta.is_symlink {
        bail!("Choose a regular text file; symbolic links cannot be edited");
    }
    if meta.size > LIMIT as u64 {
        bail!("The quick editor supports text files up to 4 MiB");
    }
    let mut bytes = Vec::new();
    fs.reader(path)?
        .take((LIMIT + 1) as u64)
        .read_to_end(&mut bytes)?;
    if bytes.len() > LIMIT {
        bail!("The file grew beyond the editor limit");
    }
    Ok(bytes)
}
pub fn read(fs: &dyn FileSystem, path: &str) -> Result<Document> {
    let bytes = bytes(fs, path)?;
    let (encoding, text) = if bytes.starts_with(&[0xff, 0xfe]) || bytes.starts_with(&[0xfe, 0xff]) {
        let le = bytes[0] == 0xff;
        if bytes.len() % 2 != 0 {
            bail!("Invalid UTF-16 text");
        }
        let words = bytes[2..]
            .as_chunks::<2>()
            .0
            .iter()
            .map(|b| {
                if le {
                    u16::from_le_bytes([b[0], b[1]])
                } else {
                    u16::from_be_bytes([b[0], b[1]])
                }
            })
            .collect::<Vec<_>>();
        (
            if le { "UTF-16 LE" } else { "UTF-16 BE" },
            String::from_utf16(&words).context("Invalid UTF-16 text")?,
        )
    } else if let Some(body) = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]) {
        (
            "UTF-8 BOM",
            String::from_utf8(body.to_vec()).context("This file is not UTF-8 text")?,
        )
    } else {
        (
            "UTF-8",
            String::from_utf8(bytes.clone()).context("This file is not UTF-8 text")?,
        )
    };
    if text.contains('\0') {
        bail!("Binary files cannot be edited as text");
    }
    let crlf = text.matches("\r\n").count();
    let lf = text.matches('\n').count();
    if crlf > 0 && crlf != lf || text.replace("\r\n", "").contains('\r') {
        bail!("Mixed or legacy line endings: use an external editor to preserve this file");
    }
    Ok(Document {
        text: text.replace("\r\n", "\n"),
        revision: revision(&bytes),
        encoding: encoding.into(),
        line_ending: if crlf > 0 { "CRLF" } else { "LF" }.into(),
    })
}
pub fn save(fs: &dyn FileSystem, path: &str, text: &str, expected: &str) -> Result<Document> {
    let _guard = SAVE.lock().unwrap();
    if !fs.writable() {
        bail!("This source is read-only");
    }
    let original = read(fs, path)?;
    if original.revision != expected {
        bail!("The file changed outside the editor. Reopen it before saving; your edits are still here.");
    }
    if text.contains(['\0', '\r']) {
        bail!("Invalid text content");
    }
    let normalized = if original.line_ending == "CRLF" {
        text.replace('\n', "\r\n")
    } else {
        text.into()
    };
    let encoded: Vec<u8> = match original.encoding.as_str() {
        "UTF-16 LE" => [
            vec![0xff, 0xfe],
            normalized
                .encode_utf16()
                .flat_map(u16::to_le_bytes)
                .collect(),
        ]
        .concat(),
        "UTF-16 BE" => [
            vec![0xfe, 0xff],
            normalized
                .encode_utf16()
                .flat_map(u16::to_be_bytes)
                .collect(),
        ]
        .concat(),
        "UTF-8 BOM" => [vec![0xef, 0xbb, 0xbf], normalized.into_bytes()].concat(),
        _ => normalized.into_bytes(),
    };
    if encoded.len() > LIMIT {
        bail!("The edited file exceeds 4 MiB");
    }
    let parent = crate::rename::parent(path);
    let temp = fs.join(
        &parent,
        &format!(".supercommander-{}.part", uuid::Uuid::new_v4()),
    );
    let backup = fs.join(
        &parent,
        &format!(".supercommander-{}.backup", uuid::Uuid::new_v4()),
    );
    let result = (|| -> Result<()> {
        let mut writer = fs.writer(&temp)?;
        writer.write_all(&encoded)?;
        writer.flush()?;
        drop(writer);
        fs.copy_permissions(path, &temp)?;
        if revision(&bytes(fs, path)?) != expected {
            bail!("The file changed while saving. Your edits were not written over it.");
        }
        fs.rename(path, &backup)?;
        if let Err(e) = fs.rename(&temp, path) {
            if let Err(restore) = fs.rename(&backup, path) {
                bail!("{e}; original preserved at {backup}; restore failed: {restore}");
            }
            return Err(e);
        }
        fs.remove(&backup)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs.remove(&temp);
    }
    result?;
    read(fs, path)
}
