use crate::{
    filesystem::{valid_name, FileSystem},
    RenameItem, RenameRules,
};
use anyhow::{bail, Result};
use std::collections::HashSet;

pub fn plan(fs: &dyn FileSystem, paths: &[String], rules: &RenameRules) -> Result<Vec<RenameItem>> {
    let regex = if rules.regex && !rules.find.is_empty() {
        Some(regex::Regex::new(&rules.find)?)
    } else {
        None
    };
    let mut used = HashSet::new();
    let mut output = Vec::new();
    for (i, path) in paths.iter().enumerate() {
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
        if name != meta.name && fs.exists(&dest)? {
            error = Some("Target already exists".into());
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
    let items = plan(fs, paths, rules)?;
    if items.iter().any(|i| i.error.is_some()) {
        bail!("Resolve rename conflicts before applying");
    }
    let mut applied: Vec<(String, String)> = Vec::new();
    for item in items.into_iter().filter(|i| i.before != i.after) {
        let target = fs.join(&parent(&item.path), &item.after);
        if fs.exists(&target)? {
            bail!("Target appeared while renaming: {target}");
        }
        if let Err(e) = fs.rename(&item.path, &target) {
            let mut rollback_errors = Vec::new();
            for (from, to) in applied.iter().rev() {
                if let Err(e) = fs.rename(to, from) {
                    rollback_errors.push(e.to_string());
                }
            }
            bail!("{e}; rollback errors: {}", rollback_errors.join("; "));
        }
        applied.push((item.path, target));
    }
    Ok(())
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
