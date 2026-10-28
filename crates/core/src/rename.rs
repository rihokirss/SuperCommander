use crate::{
    filesystem::{valid_name, FileSystem},
    recovery::Claim,
    RenameItem, RenameRules,
};
use anyhow::{bail, Context, Result};
use std::{
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};

static APPLY: Mutex<()> = Mutex::new(());

fn check(cancel: &AtomicBool) -> Result<()> {
    anyhow::ensure!(!cancel.load(Ordering::Relaxed), "Cancelled");
    Ok(())
}

/// A rename moves a selected object, rather than copying a frozen tree. Native
/// IDs allow edits to that object; other backends require a conservative version.
struct Version {
    identity: Option<String>,
    portable: String,
    digest: Option<String>,
    directory: bool,
    link: bool,
}
impl Version {
    fn capture(fs: &dyn FileSystem, path: &str, cancel: &AtomicBool) -> Result<Self> {
        check(cancel)?;
        let info = fs.properties(path)?;
        let mut version = Self {
            identity: fs.fingerprint(path)?.map(|(id, _)| id),
            directory: info.file.is_dir,
            link: info.file.is_symlink,
            portable: crate::recovery::metadata_signature(info)?,
            digest: None,
        };
        if version.identity.is_none() && !version.link {
            version.digest = if version.directory {
                let mut names = Vec::new();
                let mut bytes = 0;
                let mut failure = None;
                let stop = AtomicBool::new(false);
                fs.visit_entries(path, &stop, &mut |entry| {
                    if failure.is_some() {
                        return;
                    }
                    let result = check(cancel).and(entry).and_then(|entry| {
                        bytes += entry.name.len();
                        anyhow::ensure!(
                            names.len() < 200_000 && bytes <= 16 * 1024 * 1024,
                            "Folder is too large for rename verification"
                        );
                        names.push((entry.name, entry.is_dir, entry.is_symlink));
                        Ok(())
                    });
                    if let Err(error) = result {
                        failure = Some(error);
                        stop.store(true, Ordering::Relaxed);
                    }
                })?;
                if let Some(error) = failure {
                    return Err(error);
                }
                names.sort();
                use sha2::{Digest, Sha256};
                Some(
                    Sha256::digest(serde_json::to_vec(&names)?)
                        .iter()
                        .map(|b| format!("{b:02x}"))
                        .collect(),
                )
            } else if fs.regular_file(path)? {
                Some(crate::comparison::hash(fs, path, cancel, |_| {})?)
            } else {
                None
            };
        }
        check(cancel)?;
        anyhow::ensure!(
            version.identity == fs.fingerprint(path)?.map(|(id, _)| id)
                && (version.identity.is_some()
                    || version.portable
                        == crate::recovery::metadata_signature(fs.properties(path)?)?),
            "Source changed while preparing rename: {path}"
        );
        Ok(version)
    }
    fn validate(&self, fs: &dyn FileSystem, path: &str, cancel: &AtomicBool) -> Result<()> {
        let current = Self::capture(fs, path, cancel)?;
        anyhow::ensure!(
            self.identity == current.identity
                && self.directory == current.directory
                && self.link == current.link
                && (self.identity.is_some()
                    || self.portable == current.portable && self.digest == current.digest),
            "Rename source changed; prepare the rename again: {path}"
        );
        Ok(())
    }
}
struct Root {
    version: Version,
    canonical: Option<String>,
    parent: String,
    parent_canonical: String,
    parent_identity: Option<String>,
}
impl Root {
    fn validate_parent(&self, fs: &dyn FileSystem) -> Result<()> {
        anyhow::ensure!(
            fs.canonical_path(&self.parent)? == self.parent_canonical
                && fs.fingerprint(&self.parent)?.map(|(id, _)| id) == self.parent_identity,
            "Rename parent folder changed; prepare the rename again: {}",
            self.parent
        );
        Ok(())
    }
}
pub struct Prepared {
    items: Vec<RenameItem>,
    roots: Vec<Root>,
    connection: Option<String>,
}
impl Prepared {
    pub fn items(&self) -> &[RenameItem] {
        &self.items
    }
}

pub fn prepare(
    fs: &dyn FileSystem,
    paths: &[String],
    rules: &RenameRules,
    cancel: &AtomicBool,
) -> Result<Prepared> {
    anyhow::ensure!(fs.writable(), "This source is read-only");
    anyhow::ensure!(
        !paths.is_empty() && paths.len() <= 100_000,
        "Choose files to rename (up to 100,000)"
    );
    let items = plan_checked(fs, paths, rules, cancel)?;
    let mut roots = Vec::with_capacity(paths.len());
    let mut seen = HashSet::new();
    for path in paths {
        check(cancel)?;
        let parent = parent(path);
        anyhow::ensure!(
            parent != *path && !path.split(['/', '\\']).any(|p| p == ".."),
            "Choose an unambiguous non-root path to rename"
        );
        valid_name(&fs.stat(path)?.name)?;
        let version = Version::capture(fs, path, cancel)?;
        let canonical = if version.link {
            None
        } else {
            Some(fs.canonical_path(path)?)
        };
        let key = canonical.as_deref().unwrap_or(path).to_string();
        anyhow::ensure!(
            seen.insert(key),
            "The same source was selected more than once"
        );
        let parent_canonical = fs.canonical_path(&parent)?;
        let parent_identity = fs.fingerprint(&parent)?.map(|(id, _)| id);
        roots.push(Root {
            version,
            canonical,
            parent,
            parent_canonical,
            parent_identity,
        });
    }
    // Moving a selected parent would invalidate the paths of selected children.
    for root in &roots {
        let mut ancestor = root.parent_canonical.clone();
        loop {
            anyhow::ensure!(
                !seen.contains(&ancestor),
                "Rename selected folders separately from their children"
            );
            let next = parent(&ancestor);
            if next == ancestor {
                break;
            }
            ancestor = next;
        }
    }
    Ok(Prepared {
        items,
        roots,
        connection: fs.connection_id().map(str::to_owned),
    })
}

fn rename_one(
    fs: &dyn FileSystem,
    from: &str,
    to: &str,
    root: &Root,
    cancel: &AtomicBool,
) -> Result<()> {
    check(cancel)?;
    root.validate_parent(fs)?;
    root.version.validate(fs, from, cancel)?;
    let claim = Claim::checked(fs, from, "rename-source", root.version.digest.as_deref())?;
    let result = (|| {
        root.version.validate(fs, &claim.preserved, cancel)?;
        root.validate_parent(fs)?;
        check(cancel)?;
        fs.rename_new(&claim.preserved, to)
    })();
    if let Err(error) = result {
        return Err(claim.restore(error));
    }
    claim
        .clear()
        .with_context(|| format!("Renamed {from} to {to}"))
}

pub fn apply_prepared(fs: &dyn FileSystem, prepared: &Prepared, cancel: &AtomicBool) -> Result<()> {
    let _lock = APPLY.lock().unwrap();
    anyhow::ensure!(
        fs.connection_id() == prepared.connection.as_deref(),
        "Connection changed; prepare the rename again"
    );
    anyhow::ensure!(fs.writable(), "This source is read-only");
    anyhow::ensure!(
        !prepared.items.iter().any(|i| i.error.is_some()),
        "Resolve rename conflicts before applying"
    );
    // Validate the entire reviewed selection before changing its first name.
    for (item, root) in prepared.items.iter().zip(&prepared.roots) {
        valid_name(&item.after)?;
        root.validate_parent(fs)?;
        root.version.validate(fs, &item.path, cancel)?;
        if let Some(canonical) = &root.canonical {
            anyhow::ensure!(
                fs.canonical_path(&item.path)? == *canonical,
                "Rename source path changed: {}",
                item.path
            );
        }
    }
    let mut applied: Vec<(&RenameItem, &Root, String)> = Vec::new();
    for (item, root) in prepared
        .items
        .iter()
        .zip(&prepared.roots)
        .filter(|(item, _)| item.before != item.after)
    {
        let target = fs.join(&root.parent, &item.after);
        if let Err(error) = rename_one(fs, &item.path, &target, root, cancel) {
            let mut errors = Vec::new();
            for (item, root, target) in applied.into_iter().rev() {
                if let Err(rollback) =
                    rename_one(fs, &target, &item.path, root, &AtomicBool::new(false))
                {
                    errors.push(format!("{target} -> {}: {rollback:#}", item.path));
                }
            }
            if errors.is_empty() {
                return Err(error);
            }
            bail!(
                "{error:#}; some names could not be restored: {}",
                errors.join("; ")
            );
        }
        applied.push((item, root, target));
    }
    Ok(())
}

pub fn plan(fs: &dyn FileSystem, paths: &[String], rules: &RenameRules) -> Result<Vec<RenameItem>> {
    plan_checked(fs, paths, rules, &AtomicBool::new(false))
}
fn plan_checked(
    fs: &dyn FileSystem,
    paths: &[String],
    rules: &RenameRules,
    cancel: &AtomicBool,
) -> Result<Vec<RenameItem>> {
    let regex = if rules.regex && !rules.find.is_empty() {
        Some(regex::Regex::new(&rules.find)?)
    } else {
        None
    };
    let mut used = HashSet::new();
    let mut parent_names: HashMap<String, HashSet<String>> = HashMap::new();
    let (mut checked_names, mut checked_bytes) = (0, 0);
    let mut output = Vec::new();
    for (i, path) in paths.iter().enumerate() {
        check(cancel)?;
        let meta = fs.stat(path)?;
        let replaced = if let Some(re) = &regex {
            re.replace_all(&meta.name, rules.replace.as_str())
                .into_owned()
        } else if !rules.find.is_empty() {
            meta.name.replace(&rules.find, &rules.replace)
        } else {
            meta.name.clone()
        };
        let mut name = match rules.case_mode.as_str() {
            "lower" => replaced.to_lowercase(),
            "upper" => replaced.to_uppercase(),
            _ => replaced,
        };
        name = format!("{}{name}", rules.prefix);
        if rules.numbering {
            let n = rules
                .start
                .checked_add(i as u64)
                .ok_or_else(|| anyhow::anyhow!("Number overflow"))?;
            if !meta.is_dir {
                if let Some((stem, ext)) = name.rsplit_once('.') {
                    name = format!("{stem}_{n:03}.{ext}");
                } else {
                    name = format!("{name}_{n:03}");
                }
            } else {
                name = format!("{name}_{n:03}");
            }
        }
        let parent = parent(path);
        let dest = fs.join(&parent, &name);
        let mut error = valid_name(&name).err().map(|e| e.to_string());
        if !used.insert(dest.to_lowercase()) {
            error = Some("Duplicate target name".into());
        }
        // Case-insensitive backends resolve a spelling-only target to the
        // source. After claiming the source the new spelling is available.
        if name != meta.name && fs.exists(&dest)? {
            let spelling_only = if name.to_lowercase() == meta.name.to_lowercase() {
                if !parent_names.contains_key(&parent) {
                    let mut names = HashSet::new();
                    let mut failure = None;
                    let stop = AtomicBool::new(false);
                    fs.visit_entries(&parent, &stop, &mut |entry| {
                        if failure.is_some() {
                            return;
                        }
                        let result = check(cancel).and(entry).and_then(|entry| {
                            checked_names += 1;
                            checked_bytes += entry.name.len();
                            anyhow::ensure!(
                                checked_names <= 200_000 && checked_bytes <= 16 * 1024 * 1024,
                                "Folder listing is too large for case-only rename verification"
                            );
                            names.insert(entry.name);
                            Ok(())
                        });
                        if let Err(error) = result {
                            failure = Some(error);
                            stop.store(true, Ordering::Relaxed);
                        }
                    })?;
                    if let Some(error) = failure {
                        return Err(error);
                    }
                    parent_names.insert(parent.clone(), names);
                }
                !parent_names[&parent].contains(&name)
            } else {
                false
            };
            if !spelling_only {
                error = Some("Target already exists".into());
            }
        }
        output.push(RenameItem {
            path: path.clone(),
            before: meta.name,
            after: name,
            error,
        });
    }
    Ok(output)
}

pub fn apply(fs: &dyn FileSystem, paths: &[String], rules: &RenameRules) -> Result<()> {
    let cancel = AtomicBool::new(false);
    apply_prepared(fs, &prepare(fs, paths, rules, &cancel)?, &cancel)
}

pub fn parent(path: &str) -> String {
    if path.contains('\\') {
        std::path::Path::new(path)
            .parent()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.to_string())
    } else {
        match path.trim_end_matches('/').rsplit_once('/') {
            Some(("", _)) => "/".into(),
            Some((p, _)) => p.into(),
            None => "/".into(),
        }
    }
}
