use crate::SftpProfile;
use anyhow::{bail, Context, Result};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
};

static SAVE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigHost {
    pub alias: String,
    pub profile: SftpProfile,
    pub warnings: Vec<String>,
    pub disabled: bool,
}
#[derive(Serialize)]
pub struct Catalog {
    pub path: String,
    pub text: String,
    pub revision: Option<String>,
    pub hosts: Vec<ConfigHost>,
    pub warnings: Vec<String>,
}

pub fn default_path() -> Result<PathBuf> {
    Ok(dirs::home_dir()
        .context("No home directory")?
        .join(".ssh")
        .join("config"))
}
fn hash(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

// Preserve the original document. Tokenisation is only used to resolve entries.
fn tokens(line: &str) -> Result<Vec<String>> {
    let mut out = Vec::new();
    let mut token = String::new();
    let mut quoted = false;
    let mut chars = line.trim_start_matches('\u{feff}').chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' => quoted = !quoted,
            '#' if !quoted => break,
            '\\' if chars.peek() == Some(&'"') => {
                token.push('"');
                chars.next();
            }
            c if c.is_whitespace() && !quoted => {
                if !token.is_empty() {
                    out.push(std::mem::take(&mut token));
                }
            }
            '=' if !quoted && (out.is_empty() || (out.len() == 1 && token.is_empty())) => {
                if !token.is_empty() {
                    out.push(std::mem::take(&mut token));
                }
            }
            _ => token.push(c),
        }
    }
    if quoted {
        bail!("Unclosed quote in SSH configuration");
    }
    if !token.is_empty() {
        out.push(token);
    }
    Ok(out)
}

fn expand(value: &str, home: &Path, base: &Path) -> PathBuf {
    let value = value.replace("%d", &home.to_string_lossy());
    if value == "~" {
        home.into()
    } else if let Some(rest) = value
        .strip_prefix("~/")
        .or_else(|| value.strip_prefix("~\\"))
    {
        home.join(rest)
    } else {
        let p = PathBuf::from(value);
        if p.is_absolute() {
            p
        } else {
            base.join(p)
        }
    }
}

fn flatten(
    path: &Path,
    text: &str,
    home: &Path,
    seen: &mut HashSet<PathBuf>,
    warnings: &mut Vec<String>,
    depth: usize,
) -> Result<Vec<Vec<String>>> {
    if depth > 8 {
        bail!("SSH Include nesting exceeds eight files");
    }
    let key = fs::canonicalize(path).unwrap_or_else(|_| path.into());
    if !seen.insert(key.clone()) {
        bail!("Cyclic SSH Include: {}", path.display());
    }
    let mut lines = Vec::new();
    for (index, line) in text.lines().enumerate() {
        let values = tokens(line).with_context(|| format!("{}:{}", path.display(), index + 1))?;
        if values.is_empty() {
            continue;
        }
        if values[0].eq_ignore_ascii_case("include") {
            for pattern in &values[1..] {
                let expanded = expand(pattern, home, path.parent().unwrap_or(home));
                for file in glob::glob(&expanded.to_string_lossy())? {
                    let file = file?;
                    let meta = fs::metadata(&file)?;
                    if meta.len() > 2 * 1024 * 1024 {
                        bail!("SSH Include is too large");
                    }
                    let included = fs::read_to_string(&file)?;
                    lines.extend(flatten(&file, &included, home, seen, warnings, depth + 1)?);
                }
            }
        } else {
            if values[0].eq_ignore_ascii_case("match") {
                warnings.push(
                    "Match sections are preserved but are not executed by the connection catalog."
                        .into(),
                );
            }
            lines.push(values);
        }
    }
    seen.remove(&key);
    Ok(lines)
}

fn matches(patterns: &[String], alias: &str) -> bool {
    let mut positive = false;
    for pattern in patterns {
        let (negative, pattern) = pattern
            .strip_prefix('!')
            .map_or((false, pattern.as_str()), |p| (true, p));
        let expression = format!(
            "(?i)^{}$",
            pattern
                .chars()
                .map(|c| match c {
                    '*' => ".*".into(),
                    '?' => ".".into(),
                    c => regex::escape(&c.to_string()),
                })
                .collect::<String>()
        );
        if regex::Regex::new(&expression).is_ok_and(|r| r.is_match(alias)) {
            if negative {
                return false;
            }
            positive = true;
        }
    }
    positive
}

fn resolve(path: &Path, text: &str) -> Result<(Vec<ConfigHost>, Vec<String>)> {
    let mut warnings = Vec::new();
    let home = if path
        .parent()
        .and_then(Path::file_name)
        .is_some_and(|p| p == ".ssh")
    {
        path.parent().and_then(Path::parent).map(Path::to_path_buf)
    } else {
        dirs::home_dir()
    }
    .context("No SSH home directory")?;
    let lines = flatten(path, text, &home, &mut HashSet::new(), &mut warnings, 0)?;
    let mut aliases = Vec::new();
    let mut seen = HashSet::new();
    for line in &lines {
        if line[0].eq_ignore_ascii_case("host") {
            for alias in &line[1..] {
                if !alias.contains(['*', '?', '!']) && seen.insert(alias.to_lowercase()) {
                    aliases.push(alias.clone());
                }
            }
        }
    }
    let mut hosts = Vec::new();
    for alias in aliases {
        let mut applies = true;
        let mut values = HashMap::<String, String>::new();
        let mut identities = Vec::new();
        for line in &lines {
            let key = line[0].to_lowercase();
            if key == "host" {
                applies = matches(&line[1..], &alias);
                continue;
            }
            if key == "match" {
                applies = false;
                continue;
            }
            if !applies || line.len() < 2 {
                continue;
            }
            if key == "identityfile" {
                identities.push(line[1].clone());
            } else {
                values.entry(key).or_insert_with(|| line[1..].join(" "));
            }
        }
        let mut issues = Vec::new();
        let mut disabled = false;
        for key in ["proxyjump", "proxycommand"] {
            if values.get(key).is_some_and(|v| v != "none") {
                disabled = true;
                issues.push(format!(
                    "{key} is preserved; this connection currently requires a direct SSH route."
                ));
            }
        }
        if !warnings.is_empty() {
            disabled = true;
            issues.push("Review unsupported Match sections before connecting.".into());
        }
        let port = values
            .get("port")
            .map(|p| p.parse::<u16>())
            .transpose()?
            .unwrap_or(22);
        if port == 0 {
            bail!("Invalid SSH port for {alias}");
        }
        let host = values
            .get("hostname")
            .cloned()
            .unwrap_or_else(|| alias.clone())
            .replace("%h", &alias);
        let username = values.get("user").cloned().unwrap_or_else(|| {
            std::env::var("USERNAME")
                .or_else(|_| std::env::var("USER"))
                .unwrap_or_default()
        });
        let identities: Vec<_> = identities
            .iter()
            .filter(|p| p.as_str() != "none")
            .map(|p| {
                expand(
                    &p.replace("%h", &host).replace("%r", &username),
                    &home,
                    path.parent().unwrap_or(&home),
                )
            })
            .collect();
        let key_path = identities
            .iter()
            .find(|p| p.exists())
            .or(identities.first())
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();
        let id = format!(
            "config-{}",
            &hash(format!("{}\0{alias}", path.display()).as_bytes())[..20]
        );
        hosts.push(ConfigHost {
            alias: alias.clone(),
            profile: SftpProfile {
                id,
                name: alias,
                host,
                port,
                username,
                key_path,
                save_secret: false,
            },
            warnings: issues,
            disabled,
        });
    }
    Ok((hosts, warnings))
}

pub fn read(path: Option<&str>) -> Result<Catalog> {
    let path = path
        .filter(|p| !p.trim().is_empty())
        .map(PathBuf::from)
        .map(Ok)
        .unwrap_or_else(default_path)?;
    if !path.is_absolute() {
        bail!("SSH config path must be absolute");
    }
    let bytes = match fs::read(&path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Catalog {
                path: path.to_string_lossy().into(),
                text: String::new(),
                revision: None,
                hosts: vec![],
                warnings: vec![],
            })
        }
        Err(e) => return Err(e.into()),
    };
    if bytes.len() > 2 * 1024 * 1024 {
        bail!("SSH configuration is too large");
    }
    let text = String::from_utf8(bytes.clone())?;
    let (hosts, warnings) =
        resolve(&path, &text).unwrap_or_else(|e| (vec![], vec![format!("{e:#}")]));
    Ok(Catalog {
        path: path.to_string_lossy().into(),
        text,
        revision: Some(hash(&bytes)),
        hosts,
        warnings,
    })
}

pub fn save(path: &str, text: &str, expected_revision: Option<&str>) -> Result<Catalog> {
    let _guard = SAVE_LOCK.lock().unwrap();
    if text.len() > 2 * 1024 * 1024 {
        bail!("SSH configuration is too large");
    }
    let target = Path::new(path);
    if !target.is_absolute() {
        bail!("SSH config path must be absolute");
    }
    resolve(target, text)?;
    let original = match fs::read(target) {
        Ok(b) => Some(b),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.into()),
    };
    if original.as_ref().map(|b| hash(b)).as_deref() != expected_revision {
        bail!("SSH configuration changed outside SuperCommander. Reload before saving.");
    }
    let parent = target.parent().context("Missing configuration directory")?;
    fs::create_dir_all(parent)?;
    let temp = parent.join(format!(".supercommander-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> Result<()> {
        use std::io::Write;
        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&temp, fs::Permissions::from_mode(0o600))?;
        }
        file.write_all(text.as_bytes())?;
        file.sync_all()?;
        drop(file);
        let backup = parent.join(format!(
            "config.supercommander-{}.bak",
            uuid::Uuid::new_v4()
        ));
        if original.is_some() {
            fs::set_permissions(&temp, fs::metadata(target)?.permissions())?;
            fs::rename(target, &backup)?;
        }
        if let Err(e) = fs::rename(&temp, target) {
            if original.is_some() {
                let _ = fs::rename(&backup, target);
            }
            return Err(e.into());
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result?;
    read(Some(path))
}
