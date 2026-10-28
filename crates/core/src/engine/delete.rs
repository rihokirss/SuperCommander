//! Permanent deletion uses the frozen selection and removes only privately
//! claimed entries. A recursive backend removal never sees unreviewed children.
use super::{
    snapshot::{Node, Snapshot},
    ContextJob,
};
use crate::{filesystem::FileSystem, recovery::Claim};
use anyhow::{Context, Result};
use std::{
    fs::File,
    io::{BufRead, BufReader, Seek, SeekFrom},
};

fn next(input: &mut BufReader<File>) -> Result<Option<Node>> {
    let mut line = String::new();
    anyhow::ensure!(
        input.read_line(&mut line)? > 0,
        "Incomplete deletion manifest"
    );
    Ok(serde_json::from_str(&line)?)
}
fn validate_children(
    input: &mut BufReader<File>,
    fs: &dyn FileSystem,
    parent: &str,
    ctx: &ContextJob,
) -> Result<()> {
    while let Some(node) = next(input)? {
        let path = fs.join(parent, &node.entry.name);
        node.validate_claim(fs, &path, ctx, false)?;
        if node.entry.is_dir && !node.entry.is_symlink {
            validate_children(input, fs, &path, ctx)?;
        }
    }
    Ok(())
}
fn remove(
    input: &mut BufReader<File>,
    fs: &dyn FileSystem,
    node: Node,
    path: &str,
    root: bool,
    ctx: &mut ContextJob,
) -> Result<()> {
    ctx.check()?;
    ctx.event.current.clone_from(&node.entry.path);
    ctx.emit();
    node.validate_claim(fs, path, ctx, false)?;
    let directory = node.entry.is_dir && !node.entry.is_symlink;
    let claim = Claim::checked(
        fs,
        path,
        if directory {
            "delete-directory"
        } else {
            "delete-source"
        },
        node.digest.as_deref(),
    )?;
    let result = (|| -> Result<()> {
        node.validate_claim(fs, &claim.preserved, ctx, !directory)?;
        if directory {
            if root {
                let children = input.stream_position()?;
                validate_children(input, fs, &claim.preserved, ctx)?;
                input.seek(SeekFrom::Start(children))?;
            }
            while let Some(child) = next(input)? {
                let path = fs.join(&claim.preserved, &child.entry.name);
                remove(input, fs, child, &path, false, ctx)?;
            }
            ctx.check()?;
            fs.remove_empty_dir(&claim.preserved)?;
        } else {
            ctx.check()?;
            fs.remove_file(&claim.preserved)?;
            ctx.progress(
                if node.digest.is_some() {
                    node.entry.size
                } else {
                    0
                },
                &node.entry.path,
            );
        }
        Ok(())
    })();
    if let Err(error) = result {
        return Err(claim.restore(error));
    }
    // Finalized removals must clear their records even after cancellation.
    claim.clear()
}
pub(super) fn run(
    snapshot: &mut Snapshot,
    fs: &dyn FileSystem,
    index: usize,
    ctx: &mut ContextJob,
) -> Result<()> {
    snapshot
        .input
        .seek(SeekFrom::Start(snapshot.roots[index]))?;
    let node = next(&mut snapshot.input)?.context("Missing deletion root")?;
    let path = node.entry.path.clone();
    remove(&mut snapshot.input, fs, node, &path, true, ctx)
}
