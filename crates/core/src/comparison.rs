//! Reviewed, cancellable directory comparison. Synchronization copies reviewed
//! snapshots; it never interprets a missing row as permission to delete a file.
use crate::{filesystem::FileSystem, properties, Entry, Location};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashSet},
    io::Read,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Instant,
};

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Options {
    pub content: bool,
    pub recursive: bool,
    pub show_hidden: bool,
    pub case_sensitive: bool,
    pub exclude: String,
    pub max_entries: usize,
    pub time_tolerance: u64,
}
impl Default for Options {
    fn default() -> Self {
        Self {
            content: true,
            recursive: true,
            show_hidden: false,
            case_sensitive: true,
            exclude: String::new(),
            max_entries: 200_000,
            time_tolerance: 2,
        }
    }
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Root {
    pub location: Location,
    pub connection: Option<String>,
    pub writable: bool,
    #[serde(skip)]
    pub canonical: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Node {
    pub relative: String,
    pub entry: Entry,
    pub error: Option<String>,
    pub empty: bool,
    #[serde(skip)]
    pub revision: String,
    #[serde(skip)]
    pub canonical: String,
    #[serde(skip)]
    pub digest: Option<String>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub id: usize,
    pub path: String,
    pub status: String,
    pub left: Option<Arc<Node>>,
    pub right: Option<Arc<Node>>,
    pub blocked: Option<String>,
    pub to_left: bool,
    pub to_right: bool,
}
#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub scanned: u64,
    pub bytes: u64,
    pub side: usize,
    pub current: String,
    pub done: bool,
    pub cancelled: bool,
    pub limited: bool,
    pub errors: Vec<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub left: Root,
    pub right: Root,
    pub options: Options,
    pub rows: Vec<Row>,
    pub progress: Progress,
    #[serde(skip)]
    pub trees: [BTreeMap<String, Arc<Node>>; 2],
    #[serde(skip)]
    pub indexes: [BTreeMap<String, Vec<Arc<Node>>>; 2],
}
#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Direction {
    LeftToRight,
    RightToLeft,
}
#[derive(Clone, Deserialize)]
pub struct Choice {
    pub id: usize,
    pub direction: Direction,
}
#[derive(Clone)]
pub struct Action {
    pub relative: String,
    pub side: usize,
    pub source: Node,
    pub target: Option<Node>,
    pub target_path: String,
    pub target_relative: String,
}
pub struct Prepared {
    pub plan: Arc<Plan>,
    pub actions: Vec<Action>,
}

fn check(cancel: &AtomicBool) -> Result<()> {
    if cancel.load(Ordering::Relaxed) {
        bail!("Cancelled");
    }
    Ok(())
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn key(path: &str, sensitive: bool) -> String {
    if sensitive {
        path.into()
    } else {
        path.to_lowercase()
    }
}
fn internal(name: &str) -> bool {
    name.starts_with(".supercommander-")
        && [
            ".part",
            ".backup",
            ".move-source",
            ".move-directory",
            ".check-directory",
            ".directory-check",
            ".recovery.json",
        ]
        .iter()
        .any(|ending| name.ends_with(ending))
}
pub fn hash(
    fs: &dyn FileSystem,
    path: &str,
    cancel: &AtomicBool,
    mut progress: impl FnMut(u64),
) -> Result<String> {
    check(cancel)?;
    let mut input = fs.reader(path)?;
    let mut hash = Sha256::new();
    let mut buffer = vec![0; 256 * 1024];
    loop {
        check(cancel)?;
        let n = input.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        hash.update(&buffer[..n]);
        progress(n as u64);
    }
    Ok(hex(&hash.finalize()))
}
fn root(fs: &dyn FileSystem, location: Location) -> Result<Root> {
    let canonical = fs.canonical_path(&location.path)?;
    if !fs.stat(&canonical)?.is_dir {
        bail!("Choose a directory to compare");
    }
    Ok(Root {
        location,
        canonical,
        connection: fs.connection_id().map(str::to_owned),
        writable: fs.writable(),
    })
}
struct Scanner<'a> {
    fs: &'a dyn FileSystem,
    options: &'a Options,
    cancel: &'a AtomicBool,
    progress: &'a mut Progress,
    send: &'a dyn Fn(Progress),
    last: Instant,
    exclusions: &'a [glob::Pattern],
    tree: BTreeMap<String, Arc<Node>>,
    entries: usize,
}
impl Scanner<'_> {
    fn report(&mut self) {
        if self.last.elapsed().as_millis() >= 100 {
            (self.send)(self.progress.clone());
            self.last = Instant::now();
        }
    }
    fn children(&mut self, directory: &str, prefix: &str, depth: usize) -> Result<usize> {
        if depth > 256 {
            bail!("Directory nesting exceeds 256 levels; possible alias cycle");
        }
        let stop = AtomicBool::new(false);
        let mut count = 0;
        let mut failure = None;
        self.fs.visit_entries(directory, &stop, &mut |entry| {
            if self.cancel.load(Ordering::Relaxed) || self.progress.limited {
                stop.store(true, Ordering::Relaxed);
                return;
            }
            match entry.and_then(|entry| {
                count += 1;
                if internal(&entry.name) || !self.options.show_hidden && entry.hidden {
                    return Ok(());
                }
                let relative = if prefix.is_empty() {
                    entry.name.clone()
                } else {
                    format!("{prefix}/{}", entry.name)
                };
                if self.exclusions.iter().any(|p| {
                    p.matches_path_with(
                        std::path::Path::new(&relative),
                        glob::MatchOptions {
                            case_sensitive: self.options.case_sensitive,
                            ..Default::default()
                        },
                    ) || p.matches_with(
                        &entry.name,
                        glob::MatchOptions {
                            case_sensitive: self.options.case_sensitive,
                            ..Default::default()
                        },
                    )
                }) {
                    return Ok(());
                }
                if self.entries >= self.options.max_entries {
                    self.progress.limited = true;
                    stop.store(true, Ordering::Relaxed);
                    return Ok(());
                }
                self.entries += 1;
                self.progress.scanned += 1;
                self.progress.current.clone_from(&entry.path);
                self.report();
                let mut node = Node {
                    relative: relative.clone(),
                    entry,
                    error: None,
                    empty: false,
                    revision: String::new(),
                    canonical: String::new(),
                    digest: None,
                };
                let inspected = (|| -> Result<()> {
                    if node.entry.is_symlink {
                        bail!("Symbolic links and junctions are not synchronized");
                    }
                    let info = properties::get(self.fs, &node.entry.path)?;
                    node.revision = info.revision;
                    node.entry = info.file;
                    node.canonical = self.fs.canonical_path(&node.entry.path)?;
                    if node.entry.is_dir {
                        if self.options.recursive {
                            node.empty =
                                self.children(&node.entry.path, &relative, depth + 1)? == 0;
                        } else {
                            node.empty = self.fs.list(&node.entry.path)?.is_empty();
                        }
                    } else if self.options.content {
                        node.digest =
                            Some(hash(self.fs, &node.entry.path, self.cancel, |bytes| {
                                self.progress.bytes += bytes;
                                self.report();
                            })?);
                        if properties::get(self.fs, &node.entry.path)?.revision != node.revision {
                            bail!("File changed during comparison");
                        }
                    }
                    Ok(())
                })();
                if let Err(error) = inspected {
                    if self.cancel.load(Ordering::Relaxed) {
                        return Err(error);
                    }
                    node.error = Some(format!("{error:#}"));
                    if self.progress.errors.len() < 10 {
                        self.progress
                            .errors
                            .push(format!("{}: {error:#}", node.entry.path));
                    }
                }
                self.tree.insert(relative, Arc::new(node));
                Ok(())
            }) {
                Ok(()) => {}
                Err(error) => {
                    failure = Some(error);
                    stop.store(true, Ordering::Relaxed);
                }
            }
        })?;
        if let Some(error) = failure {
            return Err(error);
        }
        Ok(count)
    }
}
pub fn scan(
    left_fs: &dyn FileSystem,
    right_fs: &dyn FileSystem,
    left: Location,
    right: Location,
    options: Options,
    cancel: &AtomicBool,
    send: &dyn Fn(Progress),
) -> Result<Plan> {
    if options.max_entries == 0
        || options.max_entries > 1_000_000
        || options.exclude.len() > 4096
        || options.time_tolerance > 86_400
    {
        bail!("Invalid comparison options");
    }
    check(cancel)?;
    let roots = [root(left_fs, left)?, root(right_fs, right)?];
    let exclusions = options
        .exclude
        .split(';')
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(glob::Pattern::new)
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let mut progress = Progress::default();
    let mut trees = [BTreeMap::new(), BTreeMap::new()];
    for (side, fs) in [left_fs, right_fs].into_iter().enumerate() {
        progress.side = side;
        if cancel.load(Ordering::Relaxed) || progress.limited {
            break;
        }
        let mut scanner = Scanner {
            fs,
            options: &options,
            cancel,
            progress: &mut progress,
            send,
            last: Instant::now(),
            exclusions: &exclusions,
            tree: BTreeMap::new(),
            entries: 0,
        };
        let scanned = scanner.children(&roots[side].location.path, "", 0);
        trees[side] = scanner.tree;
        if let Err(error) = scanned {
            if !cancel.load(Ordering::Relaxed) {
                return Err(error);
            }
        }
    }
    progress.done = true;
    progress.cancelled = cancel.load(Ordering::Relaxed);
    send(progress.clone());
    type Matched<'a> = [Vec<(&'a String, &'a Arc<Node>)>; 2];
    let mut matched: BTreeMap<String, Matched<'_>> = BTreeMap::new();
    for (side, tree) in trees.iter().enumerate() {
        for (path, node) in tree {
            matched
                .entry(key(path, options.case_sensitive))
                .or_default()[side]
                .push((path, node));
        }
    }
    let blocked_prefixes: HashSet<String> = matched.iter().filter_map(|(path, nodes)| {
        let invalid = nodes.iter().any(|n| n.len() > 1 || n.iter().any(|(_, node)| node.error.is_some())) || matches!((&nodes[0].first(), &nodes[1].first()), (Some((_, left)), Some((_, right))) if left.entry.is_dir != right.entry.is_dir);
        invalid.then(|| path.clone())
    }).collect();
    let mut rows = Vec::new();
    for (path_key, nodes) in matched {
        let left = nodes[0].first().map(|(_, node)| Arc::clone(node));
        let right = nodes[1].first().map(|(_, node)| Arc::clone(node));
        let ambiguous = nodes.iter().any(|n| n.len() > 1);
        let blocked = if ambiguous {
            Some(format!(
                "Ambiguous case matching: {}",
                nodes
                    .iter()
                    .flatten()
                    .map(|(p, _)| p.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            ))
        } else if blocked_parent(&path_key, &blocked_prefixes) {
            Some(
                "A path or its parent has a type conflict, unreadable entries or ambiguous names"
                    .into(),
            )
        } else {
            None
        };
        let status = if blocked.is_some() {
            if ambiguous {
                "ambiguous"
            } else {
                "conflict"
            }
        } else {
            match (&left, &right) {
                (Some(left), Some(right)) => {
                    if left.entry.is_dir || options.content && left.digest == right.digest {
                        "same"
                    } else if !options.content
                        && left.entry.size == right.entry.size
                        && left.entry.modified.abs_diff(right.entry.modified)
                            <= options.time_tolerance
                    {
                        "same_metadata"
                    } else if left.entry.modified
                        > right.entry.modified.saturating_add(options.time_tolerance)
                    {
                        "left_newer"
                    } else if right.entry.modified
                        > left.entry.modified.saturating_add(options.time_tolerance)
                    {
                        "right_newer"
                    } else {
                        "different"
                    }
                }
                (Some(_), None) => "left_only",
                (None, Some(_)) => "right_only",
                _ => unreachable!(),
            }
        };
        let actionable = blocked.is_none() && !matches!(status, "same" | "same_metadata");
        rows.push(Row {
            id: rows.len(),
            path: nodes[0].first().or(nodes[1].first()).unwrap().0.to_string(),
            status: status.into(),
            to_left: actionable && right.is_some() && roots[0].writable,
            to_right: actionable && left.is_some() && roots[1].writable,
            left,
            right,
            blocked,
        });
    }
    let mut different_parents = HashSet::new();
    for row in &rows {
        if !matches!(row.status.as_str(), "same" | "same_metadata") {
            let mut path = key(&row.path, options.case_sensitive);
            while let Some((parent, _)) = path.rsplit_once('/') {
                let parent = parent.to_string();
                different_parents.insert(parent.clone());
                path = parent;
            }
        }
    }
    for row in &mut rows {
        if row.blocked.is_none()
            && row.left.as_ref().is_some_and(|n| n.entry.is_dir)
            && row.right.as_ref().is_some_and(|n| n.entry.is_dir)
        {
            row.status = if different_parents.contains(&key(&row.path, options.case_sensitive)) {
                "folder_different"
            } else {
                "folder"
            }
            .into();
            row.to_left = false;
            row.to_right = false;
        }
    }
    let indexes = std::array::from_fn(|side| {
        let mut index: BTreeMap<String, Vec<Arc<Node>>> = BTreeMap::new();
        for (relative, node) in &trees[side] {
            index
                .entry(key(relative, options.case_sensitive))
                .or_default()
                .push(node.clone());
        }
        index
    });
    Ok(Plan {
        left: roots[0].clone(),
        right: roots[1].clone(),
        options,
        rows,
        progress,
        trees,
        indexes,
    })
}
fn blocked_parent(path: &str, blocked: &HashSet<String>) -> bool {
    let mut current = path;
    loop {
        if blocked.contains(current) {
            return true;
        }
        let Some((parent, _)) = current.rsplit_once('/') else {
            return false;
        };
        current = parent;
    }
}
pub fn validate_root(fs: &dyn FileSystem, root: &Root) -> Result<()> {
    if fs.connection_id() != root.connection.as_deref()
        || fs.canonical_path(&root.location.path)? != root.canonical
    {
        bail!("A comparison location or SSH connection changed. Compare again.");
    }
    Ok(())
}
pub fn validate_node(fs: &dyn FileSystem, node: &Node, cancel: &AtomicBool) -> Result<()> {
    check(cancel)?;
    if properties::get(fs, &node.entry.path)?.revision != node.revision
        || fs.canonical_path(&node.entry.path)? != node.canonical
    {
        bail!(
            "File changed since comparison; compare again: {}",
            node.entry.path
        );
    }
    if let Some(expected) = &node.digest {
        if &hash(fs, &node.entry.path, cancel, |_| {})? != expected {
            bail!(
                "File contents changed since comparison; compare again: {}",
                node.entry.path
            );
        }
    }
    if node.entry.is_dir && node.empty && !fs.list(&node.entry.path)?.is_empty() {
        bail!("Empty folder changed since comparison: {}", node.entry.path);
    }
    Ok(())
}
pub fn path_at(fs: &dyn FileSystem, root: &str, relative: &str) -> Result<String> {
    let mut path = root.to_string();
    for name in relative.split('/') {
        crate::filesystem::valid_name(name)?;
        path = fs.join(&path, name);
    }
    Ok(path)
}
impl Plan {
    pub fn node_at(&self, side: usize, relative: &str) -> Option<&Node> {
        self.indexes[side]
            .get(&key(relative, self.options.case_sensitive))
            .filter(|nodes| nodes.len() == 1)
            .map(|nodes| nodes[0].as_ref())
    }
    pub fn destination(
        &self,
        fs: &dyn FileSystem,
        side: usize,
        relative: &str,
    ) -> Result<(String, String)> {
        let root = if side == 0 { &self.left } else { &self.right };
        let mut path = root.location.path.clone();
        let mut actual = String::new();
        for name in relative.split('/') {
            crate::filesystem::valid_name(name)?;
            actual = if actual.is_empty() {
                name.into()
            } else {
                format!("{actual}/{name}")
            };
            if let Some(node) = self.node_at(side, &actual) {
                path.clone_from(&node.entry.path);
                actual.clone_from(&node.relative);
            } else {
                path = fs.join(&path, name);
            }
        }
        Ok((path, actual))
    }
}
pub fn prepare(
    plan: Arc<Plan>,
    choices: &[Choice],
    left_fs: &dyn FileSystem,
    right_fs: &dyn FileSystem,
    cancel: &AtomicBool,
) -> Result<Prepared> {
    if plan.progress.cancelled || plan.progress.limited {
        bail!("Finish an unrestricted comparison before synchronizing");
    }
    if choices.is_empty() || choices.len() > plan.rows.len() {
        bail!("Choose files to synchronize");
    }
    validate_root(left_fs, &plan.left)?;
    validate_root(right_fs, &plan.right)?;
    if plan.left.location.source == plan.right.location.source {
        let left = plan.left.canonical.trim_end_matches(['/', '\\']);
        let right = plan.right.canonical.trim_end_matches(['/', '\\']);
        if left == right
            || left.starts_with(&format!("{right}/"))
            || right.starts_with(&format!("{left}/"))
            || left.starts_with(&format!("{right}\\"))
            || right.starts_with(&format!("{left}\\"))
        {
            bail!("Choose separate, non-overlapping folders for synchronization");
        }
    }
    let fs = [left_fs, right_fs];
    let roots = [&plan.left, &plan.right];
    let mut actions = Vec::new();
    let mut seen = HashSet::new();
    for choice in choices {
        check(cancel)?;
        if !seen.insert(choice.id) {
            bail!("Duplicate synchronization row");
        }
        let row = plan
            .rows
            .get(choice.id)
            .filter(|r| r.id == choice.id)
            .context("Unknown comparison row")?;
        let side = if choice.direction == Direction::LeftToRight {
            0
        } else {
            1
        };
        if side == 0 && !row.to_right || side == 1 && !row.to_left {
            bail!(
                "This comparison row cannot be copied in that direction: {}",
                row.path
            );
        }
        let mut source = if side == 0 {
            row.left.as_deref()
        } else {
            row.right.as_deref()
        }
        .unwrap()
        .clone();
        let mut target = if side == 0 {
            row.right.as_deref()
        } else {
            row.left.as_deref()
        }
        .cloned();
        validate_node(fs[side], &source, cancel)?;
        if !source.entry.is_dir && source.digest.is_none() {
            source.digest = Some(hash(fs[side], &source.entry.path, cancel, |_| {})?);
        }
        let (target_path, target_relative) = if let Some(target) = &mut target {
            validate_node(fs[1 - side], target, cancel)?;
            if !target.entry.is_dir && target.digest.is_none() {
                target.digest = Some(hash(fs[1 - side], &target.entry.path, cancel, |_| {})?);
            }
            (target.entry.path.clone(), target.relative.clone())
        } else {
            let (path, actual) = plan.destination(fs[1 - side], 1 - side, &row.path)?;
            if fs[1 - side].exists(&path)? {
                bail!("Destination appeared since comparison: {path}");
            }
            (path, actual)
        };
        // Validate every component even when the destination already exists.
        path_at(fs[1 - side], &roots[1 - side].location.path, &row.path)?;
        actions.push(Action {
            relative: row.path.clone(),
            side,
            source,
            target,
            target_path,
            target_relative,
        });
    }
    actions.sort_by(|left, right| {
        (
            left.relative.split('/').count(),
            !left.source.entry.is_dir,
            &left.relative,
        )
            .cmp(&(
                right.relative.split('/').count(),
                !right.source.entry.is_dir,
                &right.relative,
            ))
    });
    Ok(Prepared { plan, actions })
}
