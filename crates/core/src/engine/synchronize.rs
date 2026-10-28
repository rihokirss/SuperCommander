use super::{transfer, ContextJob};
use crate::{
    comparison::{self, Action, Prepared},
    filesystem::{FileSystem, Sources},
    properties::Properties,
};
use anyhow::{bail, Context, Result};
use std::{collections::BTreeMap, sync::Arc};

struct Created {
    side: usize,
    path: String,
    canonical: String,
    marker: String,
    metadata: Properties,
    depth: usize,
}
fn validate_action(fs: [&dyn FileSystem; 2], action: &Action, ctx: &ContextJob) -> Result<()> {
    comparison::validate_node(fs[action.side], &action.source, &ctx.control.cancel)?;
    if let Some(target) = &action.target {
        comparison::validate_node(fs[1 - action.side], target, &ctx.control.cancel)?;
    } else if fs[1 - action.side].exists(&action.target_path)? {
        bail!(
            "Destination appeared since comparison: {}",
            action.target_path
        );
    }
    Ok(())
}
fn directories(
    fs: [&dyn FileSystem; 2],
    prepared: &Prepared,
    action: &Action,
    include_leaf: bool,
    created: &mut BTreeMap<(usize, String), Created>,
    ctx: &ContextJob,
) -> Result<()> {
    let side = 1 - action.side;
    let root = if side == 0 {
        &prepared.plan.left
    } else {
        &prepared.plan.right
    };
    comparison::validate_root(fs[side], root)?;
    let components: Vec<_> = action.target_relative.split('/').collect();
    let source_parts: Vec<_> = action.source.relative.split('/').collect();
    let count = components.len() - usize::from(!include_leaf);
    let mut path = root.location.path.clone();
    let mut relative = String::new();
    for (index, name) in components.iter().take(count).enumerate() {
        ctx.check()?;
        relative = if relative.is_empty() {
            (*name).into()
        } else {
            format!("{relative}/{name}")
        };
        path = fs[side].join(&path, name);
        if let Some(own) = created.get(&(side, relative.clone())) {
            if !fs[side].exists(&own.marker)? || fs[side].canonical_path(&path)? != own.canonical {
                bail!("Created synchronization directory changed: {path}");
            }
        } else if let Some(original) = prepared.plan.node_at(side, &relative) {
            let current = fs[side].stat(&path)?;
            if !current.is_dir
                || current.is_symlink
                || fs[side].canonical_path(&path)? != original.canonical
            {
                bail!("Destination directory changed since comparison: {path}");
            }
        } else {
            if fs[side].exists(&path)? {
                bail!("Destination directory appeared since comparison: {path}");
            }
            let source_relative = source_parts[..=index].join("/");
            let source_dir = prepared
                .plan
                .node_at(action.side, &source_relative)
                .context("Missing reviewed source directory")?;
            let metadata = fs[action.side].properties(&source_dir.entry.path)?;
            fs[side].private_mkdir(&path)?;
            let marker = fs[side].join(
                &path,
                &format!(".supercommander-{}.directory-check", uuid::Uuid::new_v4()),
            );
            let mut writer = fs[side].private_writer(&marker)?;
            writer.flush()?;
            drop(writer);
            let canonical = fs[side].canonical_path(&path)?;
            created.insert(
                (side, relative.clone()),
                Created {
                    side,
                    path: path.clone(),
                    canonical,
                    marker,
                    metadata,
                    depth: index,
                },
            );
        }
    }
    Ok(())
}
pub(super) fn run(sources: &Sources, prepared: Prepared, ctx: &mut ContextJob) -> Result<()> {
    let left = sources.get(&prepared.plan.left.location.source)?;
    let right = sources.get(&prepared.plan.right.location.source)?;
    let bindings: [Arc<dyn FileSystem>; 2] = [left, right];
    let fs = [bindings[0].as_ref(), bindings[1].as_ref()];
    comparison::validate_root(fs[0], &prepared.plan.left)?;
    comparison::validate_root(fs[1], &prepared.plan.right)?;
    // Validate the entire reviewed selection before any user data is written.
    for action in &prepared.actions {
        validate_action(fs, action, ctx)?;
    }
    ctx.event.total = prepared
        .actions
        .iter()
        .filter(|a| !a.source.entry.is_dir)
        .try_fold(0_u64, |total, a| {
            total
                .checked_add(a.source.entry.size)
                .context("Synchronization size overflow")
        })?;
    let mut created = BTreeMap::new();
    let result = (|| -> Result<()> {
        for action in &prepared.actions {
            ctx.check()?;
            ctx.event.current.clone_from(&action.source.entry.path);
            ctx.emit();
            validate_action(fs, action, ctx)?;
            directories(
                fs,
                &prepared,
                action,
                action.source.entry.is_dir,
                &mut created,
                ctx,
            )?;
            if !action.source.entry.is_dir {
                let total = ctx.event.total;
                let mut copy = transfer::Plan::build(
                    fs[action.side],
                    std::slice::from_ref(&action.source.entry.path),
                    ctx,
                    prepared.plan.left.location.source != prepared.plan.right.location.source,
                )?;
                ctx.event.total = total;
                ctx.expected_copy = Some(super::CopyExpectation {
                    source: action
                        .source
                        .digest
                        .clone()
                        .context("Missing reviewed source checksum")?,
                    target: action.target.as_ref().and_then(|node| node.digest.clone()),
                });
                let copied = copy.run_root(
                    0,
                    fs[action.side],
                    fs[1 - action.side],
                    &action.target_path,
                    false,
                    ctx,
                );
                ctx.expected_copy = None;
                copied?;
            }
            ctx.event.completed += 1;
        }
        Ok(())
    })();
    // An interrupted job keeps completed files and their previous versions.
    // Remove only our empty marker files, including when cancellation is set.
    let mut created: Vec<_> = created.into_values().collect();
    created.sort_by_key(|dir| std::cmp::Reverse(dir.depth));
    for dir in created {
        let cleanup = (|| -> Result<()> {
            if fs[dir.side].canonical_path(&dir.path)? != dir.canonical
                || !fs[dir.side].exists(&dir.marker)?
            {
                bail!("Directory ownership marker changed: {}", dir.path);
            }
            fs[dir.side].remove_file(&dir.marker)?;
            if result.is_ok() {
                fs[dir.side].transfer_metadata(&dir.path, &dir.metadata)?;
            }
            Ok(())
        })();
        if let Err(error) = cleanup {
            ctx.event.errors.push(format!("{}: {error:#}", dir.path));
        }
    }
    result
}
