use crate::{
    filesystem::FileSystem,
    text::{Line, Reader},
    Entry, SearchFilter,
};
use anyhow::{bail, Context, Result};
use regex::{Regex, RegexBuilder};
use serde::Serialize;
use std::{
    collections::HashSet,
    sync::atomic::{AtomicBool, Ordering},
    time::Instant,
};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    pub entry: Entry,
    pub line: Option<u64>,
    pub column: Option<usize>,
    pub preview: Option<String>,
    pub start: usize,
    pub end: usize,
}
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Batch {
    pub matches: Vec<Hit>,
    pub scanned: u64,
    pub folders: u64,
    pub found: usize,
    pub skipped_binary: u64,
    pub skipped_long_lines: u64,
    pub errors: Vec<String>,
    pub error_count: u64,
    pub done: bool,
    pub cancelled: bool,
    pub limited: bool,
    pub connection: Option<String>,
}
impl Batch {
    fn error(&mut self, path: &str, error: impl std::fmt::Display) {
        self.error_count += 1;
        if self.errors.len() < 10 {
            self.errors.push(format!("{path}: {error:#}"));
        }
    }
    fn flush(&mut self, send: &dyn Fn(Batch)) {
        let mut batch = self.clone();
        batch.matches = std::mem::take(&mut self.matches);
        send(batch);
    }
}
enum Name {
    Regex(Regex),
    Glob(Vec<glob::Pattern>, bool),
}
impl Name {
    fn new(query: &str, mode: &str, sensitive: bool) -> Result<Self> {
        match mode {
            "glob" => {
                let query = if sensitive {
                    query.into()
                } else {
                    query.to_lowercase()
                };
                Ok(Self::Glob(
                    query
                        .split(';')
                        .map(str::trim)
                        .filter(|part| !part.is_empty())
                        .map(glob::Pattern::new)
                        .collect::<std::result::Result<_, _>>()?,
                    sensitive,
                ))
            }
            "contains" | "" | "regex" => Ok(Self::Regex(
                RegexBuilder::new(&if mode == "regex" {
                    query.into()
                } else {
                    regex::escape(query)
                })
                .case_insensitive(!sensitive)
                .size_limit(2 * 1024 * 1024)
                .build()?,
            )),
            _ => bail!("Unknown filename matching mode"),
        }
    }
    fn matches(&self, name: &str) -> bool {
        match self {
            Self::Regex(regex) => regex.is_match(name),
            Self::Glob(patterns, sensitive) => {
                let name = if *sensitive {
                    name.into()
                } else {
                    name.to_lowercase()
                };
                patterns.is_empty() || patterns.iter().any(|pattern| pattern.matches(&name))
            }
        }
    }
}
enum Content {
    Match {
        line: u64,
        column: usize,
        preview: String,
        start: usize,
        end: usize,
    },
    None,
    Binary,
    LongLine,
    Cancelled,
}
fn content(fs: &dyn FileSystem, path: &str, query: &Regex, cancel: &AtomicBool) -> Result<Content> {
    let mut reader = Reader::new(fs.reader(path)?)?;
    let mut line = 0;
    loop {
        match reader.next(cancel)? {
            Line::Text(text) => {
                line += 1;
                let text = text.trim_end_matches(['\r', '\n']);
                if let Some(found) = query.find(text) {
                    let column = text[..found.start()].chars().count();
                    let first = column.saturating_sub(60);
                    let from = text
                        .char_indices()
                        .nth(first)
                        .map_or(text.len(), |item| item.0);
                    let to = text
                        .char_indices()
                        .nth(first + 180)
                        .map_or(text.len(), |item| item.0);
                    let prefix = if first > 0 { "…" } else { "" };
                    let preview = format!(
                        "{prefix}{}{}",
                        &text[from..to],
                        if to < text.len() { "…" } else { "" }
                    );
                    let start = prefix.len().min(1)
                        + text[from..found.start().min(to)].encode_utf16().count();
                    let end = prefix.len().min(1)
                        + text[from..found.end().min(to)].encode_utf16().count();
                    return Ok(Content::Match {
                        line,
                        column: column + 1,
                        preview,
                        start,
                        end,
                    });
                }
            }
            Line::End => return Ok(Content::None),
            Line::Cancelled => return Ok(Content::Cancelled),
            Line::Unsupported => return Ok(Content::Binary),
            Line::TooLong => return Ok(Content::LongLine),
        }
    }
}

pub fn run(
    fs: &dyn FileSystem,
    path: &str,
    filter: &SearchFilter,
    cancel: &AtomicBool,
    send: &dyn Fn(Batch),
) -> Result<()> {
    if filter.query.len() > 4096 || filter.content.len() > 4096 || filter.exclude.len() > 4096 {
        bail!("Search patterns must not exceed 4096 bytes");
    }
    if !(1..=100_000).contains(&filter.max_results) {
        bail!("Result limit must be between 1 and 100000");
    }
    if filter
        .min_size
        .zip(filter.max_size)
        .is_some_and(|(min, max)| min > max)
        || filter
            .after
            .zip(filter.before)
            .is_some_and(|(after, before)| after > before)
    {
        bail!("The search filter range is invalid");
    }
    if !["all", "files", "folders"].contains(&filter.kind.as_str()) {
        bail!("Unknown item type");
    }
    let name = Name::new(&filter.query, &filter.name_mode, filter.case_sensitive)?;
    let exclude = Name::new(&filter.exclude, "glob", filter.case_sensitive)?;
    let text = if filter.content.is_empty() {
        None
    } else {
        let pattern = if filter.content_regex {
            filter.content.clone()
        } else {
            regex::escape(&filter.content)
        };
        Some(
            RegexBuilder::new(&if filter.whole_word {
                format!("\\b(?:{pattern})\\b")
            } else {
                pattern
            })
            .case_insensitive(!filter.case_sensitive)
            .size_limit(2 * 1024 * 1024)
            .build()?,
        )
    };
    let root = path.to_owned();
    if !fs.stat(&fs.canonical_path(path)?)?.is_dir {
        bail!("Choose a folder to search");
    }
    let mut batch = Batch {
        connection: fs.connection_id().map(str::to_owned),
        ..Batch::default()
    };
    let mut folders = vec![root.clone()];
    let mut visited = HashSet::new();
    let mut last = Instant::now();
    while let Some(folder) = folders.pop() {
        if cancel.load(Ordering::Relaxed) || batch.limited {
            break;
        }
        let canonical = match fs.canonical_path(&folder) {
            Ok(path) => path,
            Err(error) => {
                batch.error(&folder, error);
                continue;
            }
        };
        if !visited.insert(canonical.clone()) {
            continue;
        }
        batch.folders += 1;
        let stop = AtomicBool::new(false);
        let result = fs.visit_entries(&folder, &stop, &mut |entry| {
            if cancel.load(Ordering::Relaxed) || batch.limited {
                stop.store(true, Ordering::Relaxed);
                return;
            }
            let inspect = || -> Result<()> {
                let entry = entry?;
                batch.scanned += 1;
                if entry.hidden && !filter.show_hidden {
                    return Ok(());
                }
                let relative = entry
                    .path
                    .strip_prefix(&root)
                    .unwrap_or(&entry.path)
                    .replace('\\', "/");
                if !filter.exclude.trim().is_empty()
                    && (exclude.matches(&entry.name)
                        || exclude.matches(relative.trim_start_matches('/')))
                {
                    return Ok(());
                }
                if entry.is_dir && !entry.is_symlink && filter.recursive {
                    folders.push(entry.path.clone());
                }
                if !name.matches(&entry.name)
                    || (entry.is_dir && (filter.min_size.is_some() || filter.max_size.is_some()))
                    || (filter.kind == "files" && entry.is_dir)
                    || (filter.kind == "folders" && !entry.is_dir)
                    || filter.min_size.is_some_and(|n| entry.size < n)
                    || filter.max_size.is_some_and(|n| entry.size > n)
                    || filter.after.is_some_and(|n| entry.modified < n)
                    || filter.before.is_some_and(|n| entry.modified > n)
                {
                    return Ok(());
                }
                let mut hit = Hit {
                    entry: entry.clone(),
                    line: None,
                    column: None,
                    preview: None,
                    start: 0,
                    end: 0,
                };
                if let Some(query) = &text {
                    if entry.is_dir || entry.is_symlink {
                        return Ok(());
                    }
                    match content(fs, &entry.path, query, cancel)
                        .with_context(|| entry.path.clone())?
                    {
                        Content::Match {
                            line,
                            column,
                            preview,
                            start,
                            end,
                        } => {
                            hit.line = Some(line);
                            hit.column = Some(column);
                            hit.preview = Some(preview);
                            hit.start = start;
                            hit.end = end;
                        }
                        Content::None | Content::Cancelled => return Ok(()),
                        Content::Binary => {
                            batch.skipped_binary += 1;
                            return Ok(());
                        }
                        Content::LongLine => {
                            batch.skipped_long_lines += 1;
                            return Ok(());
                        }
                    }
                }
                batch.found += 1;
                batch.matches.push(hit);
                batch.limited = batch.found >= filter.max_results;
                if batch.limited {
                    stop.store(true, Ordering::Relaxed);
                }
                Ok(())
            };
            if let Err(error) = inspect() {
                batch.error(&canonical, error);
            }
            if batch.matches.len() >= 128 || last.elapsed().as_millis() >= 100 {
                batch.flush(send);
                last = Instant::now();
            }
        });
        if let Err(error) = result {
            batch.error(&folder, error);
        }
    }
    batch.cancelled = cancel.load(Ordering::Relaxed);
    batch.done = true;
    batch.flush(send);
    Ok(())
}
