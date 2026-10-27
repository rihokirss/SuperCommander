//! Bounded, cooperative UTF-8/UTF-16 text reading shared by search and viewing.
use anyhow::{bail, Result};
use std::{
    collections::VecDeque,
    io::{BufRead, BufReader, Cursor, Read},
    sync::atomic::{AtomicBool, Ordering},
};

pub const MAX_LINE: usize = 8 * 1024 * 1024;
pub enum Line {
    Text(String),
    End,
    Cancelled,
    Unsupported,
    TooLong,
}
pub struct Reader {
    input: BufReader<Box<dyn Read + Send>>,
    pub encoding: &'static str,
    crlf: bool,
    lf: bool,
}
impl Reader {
    pub fn new(mut input: Box<dyn Read + Send>) -> Result<Self> {
        let mut prefix = Vec::new();
        input.by_ref().take(3).read_to_end(&mut prefix)?;
        let (encoding, skip) = if prefix.starts_with(&[0xff, 0xfe]) {
            ("UTF-16 LE", 2)
        } else if prefix.starts_with(&[0xfe, 0xff]) {
            ("UTF-16 BE", 2)
        } else if prefix.starts_with(&[0xef, 0xbb, 0xbf]) {
            ("UTF-8 BOM", 3)
        } else {
            ("UTF-8", 0)
        };
        Ok(Self {
            input: BufReader::with_capacity(
                64 * 1024,
                Box::new(Cursor::new(prefix[skip..].to_vec()).chain(input)),
            ),
            encoding,
            crlf: false,
            lf: false,
        })
    }
    pub fn more(&mut self) -> Result<bool> {
        Ok(!self.input.fill_buf()?.is_empty())
    }
    pub fn line_ending(&self) -> &'static str {
        if self.crlf && self.lf {
            "Mixed"
        } else if self.crlf {
            "CRLF"
        } else {
            "LF"
        }
    }
    pub fn next(&mut self, cancel: &AtomicBool) -> Result<Line> {
        if cancel.load(Ordering::Relaxed) {
            return Ok(Line::Cancelled);
        }
        let text = if self.encoding.starts_with("UTF-16") {
            let mut words = Vec::new();
            loop {
                if words.len() % 16384 == 0 && cancel.load(Ordering::Relaxed) {
                    return Ok(Line::Cancelled);
                }
                if self.input.fill_buf()?.is_empty() {
                    break;
                }
                let mut pair = [0; 2];
                if let Err(error) = self.input.read_exact(&mut pair) {
                    if error.kind() == std::io::ErrorKind::UnexpectedEof {
                        return Ok(Line::Unsupported);
                    }
                    return Err(error.into());
                }
                let word = if self.encoding == "UTF-16 LE" {
                    u16::from_le_bytes(pair)
                } else {
                    u16::from_be_bytes(pair)
                };
                if word == 0 {
                    return Ok(Line::Unsupported);
                }
                words.push(word);
                if words.len() * 2 > MAX_LINE {
                    return Ok(Line::TooLong);
                }
                if word == 10 {
                    break;
                }
            }
            match String::from_utf16(&words) {
                Ok(text) => text,
                Err(_) => return Ok(Line::Unsupported),
            }
        } else {
            let mut bytes = Vec::new();
            loop {
                if cancel.load(Ordering::Relaxed) {
                    return Ok(Line::Cancelled);
                }
                let available = self.input.fill_buf()?;
                if available.is_empty() {
                    break;
                }
                let length = available
                    .iter()
                    .position(|b| *b == b'\n')
                    .map_or(available.len(), |n| n + 1);
                if bytes.len() + length > MAX_LINE {
                    return Ok(Line::TooLong);
                }
                if available[..length].contains(&0) {
                    return Ok(Line::Unsupported);
                }
                let newline = available[length - 1] == b'\n';
                bytes.extend_from_slice(&available[..length]);
                self.input.consume(length);
                if newline {
                    break;
                }
            }
            match String::from_utf8(bytes) {
                Ok(text) => text,
                Err(_) => return Ok(Line::Unsupported),
            }
        };
        if text.is_empty() {
            return Ok(Line::End);
        }
        if text.ends_with("\r\n") {
            self.crlf = true;
        } else if text.ends_with('\n') {
            self.lf = true;
        }
        let text = match text.strip_suffix("\r\n") {
            Some(body) => format!("{body}\n"),
            None => text,
        };
        Ok(Line::Text(text))
    }
}

pub struct Window {
    pub text: String,
    pub encoding: String,
    pub line_ending: String,
    pub first_line: u64,
    pub last_line: u64,
    pub more: bool,
}
pub fn window(input: Box<dyn Read + Send>, requested: u64, cancel: &AtomicBool) -> Result<Window> {
    let mut reader = Reader::new(input)?;
    let first = requested.max(1);
    let mut index = 0_u64;
    let mut tail = VecDeque::new();
    let mut tail_bytes = 0;
    let mut lines = Vec::new();
    let mut bytes = 0;
    loop {
        match reader.next(cancel)? {
            Line::Text(text) => {
                index += 1;
                if index < first {
                    tail_bytes += text.len();
                    tail.push_back((index, text));
                    while tail.len() > 1 && (tail_bytes > 256 * 1024 || tail.len() > 2000) {
                        tail_bytes -= tail.pop_front().unwrap().1.len();
                    }
                } else {
                    bytes += text.len();
                    lines.push((index, text));
                    if bytes >= 256 * 1024 || lines.len() >= 2000 {
                        break;
                    }
                }
            }
            Line::End => break,
            Line::Cancelled => bail!("Cancelled"),
            Line::Unsupported => bail!("This is not supported UTF-8 or BOM-marked UTF-16 text"),
            Line::TooLong => bail!("Text lines over 8 MiB require an external viewer"),
        }
    }
    if lines.is_empty() {
        lines.extend(tail);
    }
    let first_line = lines.first().map_or(1, |line| line.0);
    let last_line = lines.last().map_or(1, |line| line.0);
    Ok(Window {
        text: lines.into_iter().map(|line| line.1).collect(),
        encoding: reader.encoding.into(),
        line_ending: reader.line_ending().into(),
        first_line,
        last_line,
        more: reader.more()?,
    })
}
