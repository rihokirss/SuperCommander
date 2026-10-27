use crate::SftpProfile;
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
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
    pub forwards: Vec<LocalForward>,
}
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalForward {
    pub local_port: u16,
    pub remote_host: String,
    pub remote_port: u16,
}
impl LocalForward {
    pub fn validate(&self) -> Result<()> {
        if self.local_port == 0
            || self.remote_port == 0
            || self.remote_host.is_empty()
            || self
                .remote_host
                .chars()
                .any(|c| c.is_whitespace() || c.is_control() || "#\"[]".contains(c))
        {
            bail!("A saved forward needs valid ports and a target host");
        }
        Ok(())
    }
}
fn parse_forward(values: &[String]) -> Result<LocalForward> {
    if values.len() != 3 {
        bail!("Only TCP LocalForward entries are supported");
    }
    let local = &values[1];
    let (bind, port) = local.rsplit_once(':').unwrap_or(("127.0.0.1", local));
    if !["127.0.0.1", "localhost", "[::1]"].contains(&bind) {
        bail!("Only loopback LocalForward bindings are supported");
    }
    let (host, port_target) = values[2]
        .rsplit_once(':')
        .context("Invalid LocalForward target")?;
    let forward = LocalForward {
        local_port: port.parse()?,
        remote_host: host.trim_start_matches('[').trim_end_matches(']').into(),
        remote_port: port_target.parse()?,
    };
    forward.validate()?;
    Ok(forward)
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
        let mut forwards = Vec::new();
        let mut forward_warnings = Vec::new();
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
            if key == "localforward" {
                match parse_forward(line) {
                    Ok(f) => {
                        if !forwards.contains(&f) {
                            forwards.push(f);
                        }
                    }
                    Err(e) => {
                        forward_warnings.push(format!("LocalForward preserved but not opened: {e}"))
                    }
                }
            } else if key == "identityfile" {
                identities.push(line[1].clone());
            } else {
                values.entry(key).or_insert_with(|| line[1..].join(" "));
            }
        }
        let mut issues = forward_warnings;
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
            forwards,
        });
    }
    Ok((hosts, warnings))
}

/// Change only one forward in one unshared Host block; never rewrite inherited/include options.
pub fn set_forward(
    path: &str,
    alias: &str,
    forward: &LocalForward,
    enabled: bool,
    revision: Option<&str>,
) -> Result<Catalog> {
    forward.validate()?;
    let catalog = read(Some(path))?;
    if catalog.revision.as_deref() != revision {
        bail!("SSH configuration changed outside SuperCommander. Reload before saving.");
    }
    let host = catalog
        .hosts
        .iter()
        .find(|h| h.alias == alias)
        .context("Save the SSH connection in the catalog first")?;
    let mut lines: Vec<String> = catalog.text.lines().map(str::to_owned).collect();
    let mut block = None;
    for (i, line) in lines.iter().enumerate() {
        let v = tokens(line)?;
        if v.first().is_some_and(|k| k.eq_ignore_ascii_case("host"))
            && v[1..].iter().any(|a| a.eq_ignore_ascii_case(alias))
        {
            if v.len() != 2 {
                bail!("Edit forwards for shared Host blocks in the SSH catalog editor");
            }
            let end = (i + 1..lines.len())
                .find(|j| {
                    tokens(&lines[*j]).is_ok_and(|v| {
                        v.first().is_some_and(|k| {
                            k.eq_ignore_ascii_case("host") || k.eq_ignore_ascii_case("match")
                        })
                    })
                })
                .unwrap_or(lines.len());
            block = Some((i, end));
            break;
        }
    }
    let (start, end) = block
        .context("This Host is in an included file. Open that file in the SSH catalog editor.")?;
    let found = (start + 1..end)
        .filter(|i| {
            tokens(&lines[*i]).is_ok_and(|v| {
                v.first()
                    .is_some_and(|k| k.eq_ignore_ascii_case("localforward"))
                    && parse_forward(&v).is_ok_and(|f| f == *forward)
            })
        })
        .collect::<Vec<_>>();
    if !enabled && found.is_empty() && host.forwards.contains(forward) {
        bail!("This forward is inherited. Edit its original Host or Include block in the SSH catalog editor.");
    }
    if enabled && !host.forwards.contains(forward) {
        let target = if forward.remote_host.contains(':') {
            format!("[{}]", forward.remote_host)
        } else {
            forward.remote_host.clone()
        };
        lines.insert(
            start + 1,
            format!(
                "    LocalForward 127.0.0.1:{} {}:{}",
                forward.local_port, target, forward.remote_port
            ),
        );
    } else if !enabled {
        for i in found.into_iter().rev() {
            let line = lines.remove(i);
            // Keep inline comments when removing the directive.
            if let Some((_, comment)) = line.split_once('#') {
                lines.insert(i, format!("    #{comment}"));
            }
        }
    }
    let newline = if catalog.text.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    save(path, &(lines.join(newline) + newline), revision)
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
                if let Err(restore) = fs::rename(&backup, target) {
                    bail!(
                        "{e}; original configuration is preserved at {}; restore failed: {restore}",
                        backup.display()
                    );
                }
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

pub fn upsert(
    path: Option<&str>,
    alias: &str,
    profile: &SftpProfile,
    expected_revision: Option<&str>,
) -> Result<Catalog> {
    if alias.is_empty()
        || alias
            .chars()
            .any(|c| c.is_whitespace() || c.is_control() || "*?!#\"=/\\".contains(c))
    {
        bail!("An SSH alias must not contain spaces, wildcards or path separators");
    }
    if profile.host.trim().is_empty()
        || profile.username.trim().is_empty()
        || profile.port == 0
        || [&profile.host, &profile.username, &profile.key_path]
            .iter()
            .any(|s| s.contains(['\n', '\r', '\0']))
    {
        bail!("A host, username and valid port are required");
    }
    let catalog = read(path)?;
    if catalog.revision.as_deref() != expected_revision {
        bail!("SSH configuration changed outside SuperCommander. Reload before saving.");
    }
    let newline = if catalog.text.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let mut lines: Vec<String> = catalog.text.lines().map(str::to_owned).collect();
    let mut block = None;
    for (index, line) in lines.iter().enumerate() {
        let values = tokens(line)?;
        if values
            .first()
            .is_some_and(|v| v.eq_ignore_ascii_case("host"))
            && values[1..].iter().any(|v| v.eq_ignore_ascii_case(alias))
        {
            if values.len() != 2 {
                bail!("This Host block contains multiple aliases. Edit the shared block in the SSH catalog editor.");
            }
            let end = (index + 1..lines.len())
                .find(|i| {
                    tokens(&lines[*i]).ok().is_some_and(|v| {
                        v.first().is_some_and(|k| {
                            k.eq_ignore_ascii_case("host") || k.eq_ignore_ascii_case("match")
                        })
                    })
                })
                .unwrap_or(lines.len());
            block = Some((index, end));
            break;
        }
    }
    if block.is_none()
        && catalog
            .hosts
            .iter()
            .any(|h| h.alias.eq_ignore_ascii_case(alias))
    {
        bail!(
            "This alias is defined in an included file. Open that file in the SSH catalog editor."
        );
    }
    let quote = |value: &str| format!("\"{}\"", value.replace('"', "\\\""));
    let directives = [
        ("hostname", "HostName", Some(quote(&profile.host))),
        ("user", "User", Some(quote(&profile.username))),
        ("port", "Port", Some(profile.port.to_string())),
        (
            "identityfile",
            "IdentityFile",
            (!profile.key_path.is_empty()).then(|| quote(&profile.key_path.replace('\\', "/"))),
        ),
    ];
    if let Some((start, end)) = block {
        let mut replaced = HashSet::new();
        let mut content = vec![lines[start].clone()];
        for line in &lines[start + 1..end] {
            let values = tokens(line)?;
            let key = values.first().map(|v| v.to_lowercase()).unwrap_or_default();
            if let Some((_, name, value)) =
                directives.iter().find(|(key_name, _, _)| *key_name == key)
            {
                if replaced.insert(key) {
                    if let Some(value) = value {
                        content.push(format!("    {name} {value}"));
                    }
                }
                let mut quoted = false;
                let mut previous = '\0';
                for (index, c) in line.char_indices() {
                    if c == '"' && previous != '\\' {
                        quoted = !quoted;
                    }
                    if c == '#' && !quoted {
                        content.push(format!("    {}", &line[index..]));
                        break;
                    }
                    previous = c;
                }
            } else {
                content.push(line.clone());
            }
        }
        for (key, name, value) in &directives {
            if !replaced.contains(*key) {
                if let Some(value) = value {
                    content.insert(1, format!("    {name} {value}"));
                }
            }
        }
        lines.splice(start..end, content);
    } else {
        let mut stanza = vec![format!("Host {alias}")];
        for (_, name, value) in &directives {
            if let Some(value) = value {
                stanza.push(format!("    {name} {value}"));
            }
        }
        stanza.push(String::new());
        stanza.extend(lines);
        lines = stanza;
    }
    let text = lines.join(newline) + newline;
    save(&catalog.path, &text, catalog.revision.as_deref())
}
