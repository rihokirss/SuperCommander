use crate::Entry;
use anyhow::Result;

pub fn is_server(path: &str) -> bool {
    path.strip_prefix(r"\\").is_some_and(|server| {
        let server = server.trim_end_matches('\\');
        !server.is_empty()
            && !server
                .chars()
                .any(|c| c.is_control() || "\\/:*?\"<>|".contains(c))
    })
}

/// Ask the Windows shell for shares of the explicitly opened server, including shell providers.
pub fn shares(path: &str) -> Result<Vec<Entry>> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let script = r#"
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
$shell=New-Object -ComObject Shell.Application
$root=$env:SUPERCOMMANDER_NETWORK_SERVER.TrimEnd('\')
$folder=$shell.Namespace($root)
if($null -eq $folder){throw 'The network server could not be opened. Check its name and Windows network credentials.'}
$items=@($folder.Items() | Where-Object { $_.IsFolder -and ([string]$_.Path).StartsWith($root+'\',[System.StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { @{name=[string]$_.Name;path=[string]$_.Path;isDir=$true;isSymlink=$false;size=0;modified=0;hidden=([string]$_.Name).EndsWith('$')} })
ConvertTo-Json -InputObject $items -Compress
"#;
        let output = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .env("SUPERCOMMANDER_NETWORK_SERVER", path)
            .creation_flags(0x08000000)
            .output()?;
        if !output.status.success() {
            anyhow::bail!("{}", String::from_utf8_lossy(&output.stderr).trim());
        }
        Ok(serde_json::from_slice(&output.stdout)?)
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        anyhow::bail!("Network server browsing requires Windows")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn distinguishes_server_roots_from_shares_and_device_paths() {
        assert!(is_server(r"\\ketas"));
        assert!(is_server("\\\\itk-server\\"));
        for path in [
            r"\\server\share",
            r"C:\folder",
            r"\\?\C:\",
            r"\\.\pipe",
            r"\\bad/name",
            "\\\\bad\nname",
        ] {
            assert!(!is_server(path), "{path}");
        }
    }
}
