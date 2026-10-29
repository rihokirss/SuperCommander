use sha2::{Digest, Sha256};
use std::{
    io::Write, os::windows::process::CommandExt, path::PathBuf, sync::Mutex, time::Duration,
};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

const INTERVAL: Duration = Duration::from_secs(12 * 60 * 60);
const UNINSTALL_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall\SuperCommander";
const PORTABLE_ENDPOINT: &str =
    "https://github.com/rihokirss/SuperCommander/releases/latest/download/portable.json";

struct Pending {
    update: Update,
    bytes: Vec<u8>,
    portable: bool,
}

#[derive(Default)]
struct Updates(Mutex<Option<Pending>>);

// The NSIS updater installs into its registered location, not beside a portable
// executable. Never silently turn a portable copy into a separate installation.
fn is_registered_install() -> bool {
    let location = windows_registry::CURRENT_USER
        .open(UNINSTALL_KEY)
        .and_then(|key| key.get_string("InstallLocation"));
    let Ok(location) = location else { return false };
    let expected = PathBuf::from(location.trim().trim_matches('"')).join("supercommander.exe");
    match (
        expected.canonicalize(),
        std::env::current_exe().and_then(|p| p.canonicalize()),
    ) {
        (Ok(expected), Ok(current)) => expected == current,
        _ => false,
    }
}

pub fn start(app: &AppHandle) {
    app.manage(Updates::default());
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            if let Err(error) = check(&app).await {
                // An offline machine or an older release without a manifest must
                // never interrupt startup, nor discard an already verified update.
                eprintln!("Update check failed: {error}");
            }
            tokio::time::sleep(INTERVAL).await;
        }
    });
}

async fn check(app: &AppHandle) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let portable = !is_registered_install();
    let mut builder = app
        .updater_builder()
        .timeout(Duration::from_secs(120))
        .restart_after_install(false);
    if portable {
        builder = builder.endpoints(vec![PORTABLE_ENDPOINT.parse()?])?;
    }
    let updater = builder.build()?;
    let Some(update) = updater.check().await? else {
        return Ok(());
    };
    if update.download_url.scheme() != "https" {
        return Err("The update download URL must use HTTPS".into());
    }
    if app
        .state::<Updates>()
        .0
        .lock()
        .unwrap()
        .as_ref()
        .is_some_and(|pending| pending.update.version == update.version)
    {
        return Ok(());
    }
    // The plugin verifies the signature before returning the downloaded bytes,
    // and again immediately before installation.
    let bytes = update.download(|_, _| {}, || {}).await?;
    let version = update.version.clone();
    *app.state::<Updates>().0.lock().unwrap() = Some(Pending {
        update,
        bytes,
        portable,
    });
    let _ = app.emit("update-ready", version);
    Ok(())
}

pub fn pending_version(app: &AppHandle) -> Option<String> {
    app.state::<Updates>()
        .0
        .lock()
        .unwrap()
        .as_ref()
        .map(|pending| pending.update.version.clone())
}

pub fn install_on_exit(app: &AppHandle) {
    let pending = app.state::<Updates>().0.lock().unwrap().take();
    if let Some(pending) = pending {
        if pending.portable {
            if let Err(error) = install_portable(app, &pending) {
                record_error(app, &error.to_string());
                eprintln!("Could not prepare the portable update: {error}");
            }
        } else if is_registered_install() && !other_instance_running() {
            if let Err(error) = pending.update.install(pending.bytes) {
                record_error(app, &error.to_string());
                eprintln!("Could not launch the update installer: {error}");
            }
        }
    }
}

// NSIS passive mode can force-close another instance. Skip the update when
// another copy of this executable is running or cannot be inspected.
fn other_instance_running() -> bool {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, INVALID_HANDLE_VALUE},
        System::{
            Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
                TH32CS_SNAPPROCESS,
            },
            Threading::{
                OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
            },
        },
    };
    let Ok(current) = std::env::current_exe() else {
        return true;
    };
    let Some(name) = current.file_name().and_then(|v| v.to_str()) else {
        return true;
    };
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return true;
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut found = false;
        let mut has_entry = Process32FirstW(snapshot, &mut entry) != 0;
        if !has_entry {
            found = true;
        }
        while has_entry && !found {
            let len = entry
                .szExeFile
                .iter()
                .position(|&v| v == 0)
                .unwrap_or(entry.szExeFile.len());
            let process_name = String::from_utf16_lossy(&entry.szExeFile[..len]);
            if entry.th32ProcessID != std::process::id() && process_name.eq_ignore_ascii_case(name)
            {
                let process =
                    OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, entry.th32ProcessID);
                if process.is_null() {
                    found = true;
                } else {
                    let mut buffer = vec![0u16; 32768];
                    let mut len = buffer.len() as u32;
                    if QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut len) == 0 {
                        found = true;
                    } else {
                        let path = PathBuf::from(String::from_utf16_lossy(&buffer[..len as usize]));
                        found = match (current.canonicalize(), path.canonicalize()) {
                            (Ok(a), Ok(b)) => a == b,
                            _ => true,
                        };
                    }
                    CloseHandle(process);
                }
            }
            has_entry = Process32NextW(snapshot, &mut entry) != 0;
        }
        CloseHandle(snapshot);
        found
    }
}

// Windows cannot overwrite a running executable. A hidden helper waits for
// this process to exit, rechecks the verified bytes and atomically replaces the
// original file. No shell interpolation is used for file paths.
fn install_portable(app: &AppHandle, pending: &Pending) -> Result<(), Box<dyn std::error::Error>> {
    pending.update.verify(&pending.bytes)?;
    let target = std::env::current_exe()?;
    let directory = target
        .parent()
        .ok_or("Executable has no parent directory")?;
    let mut staged = tempfile::Builder::new()
        .prefix(".supercommander-update-")
        .suffix(".exe")
        .tempfile_in(directory)?;
    staged.write_all(&pending.bytes)?;
    staged.as_file().sync_all()?;
    let hash: String = Sha256::digest(&pending.bytes)
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect();
    let error_file = error_path(app)?;
    let powershell = PathBuf::from(std::env::var_os("SystemRoot").ok_or("SystemRoot missing")?)
        .join(r"System32\WindowsPowerShell\v1.0\powershell.exe");
    let (_, path) = staged.keep()?;
    let result = std::process::Command::new(powershell)
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-WindowStyle",
            "Hidden",
            "-Command",
            PORTABLE_HELPER,
        ])
        .env("SC_UPDATE_TARGET", &target)
        .env("SC_UPDATE_STAGE", &path)
        .env("SC_UPDATE_HASH", hash)
        .env("SC_UPDATE_PID", std::process::id().to_string())
        .env("SC_UPDATE_ERROR", error_file)
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .spawn();
    if let Err(error) = result {
        let _ = std::fs::remove_file(path);
        return Err(error.into());
    }
    Ok(())
}

const PORTABLE_HELPER: &str = r#"
$ErrorActionPreference = 'Stop'
try {
  Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class SCUpdater { [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool MoveFileEx(string source, string destination, uint flags); }'
  Wait-Process -Id ([int]$env:SC_UPDATE_PID) -ErrorAction SilentlyContinue
  if ((Get-FileHash -LiteralPath $env:SC_UPDATE_STAGE -Algorithm SHA256).Hash -ne $env:SC_UPDATE_HASH) { throw 'Update file changed' }
  $replaced = $false
  $lastError = 0
  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    if ([SCUpdater]::MoveFileEx($env:SC_UPDATE_STAGE, $env:SC_UPDATE_TARGET, 9)) { $replaced = $true; break }
    $lastError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    Start-Sleep -Milliseconds 250
  }
  if (-not $replaced) { throw "Could not replace executable: $([ComponentModel.Win32Exception]::new($lastError).Message)" }
} catch {
  $message = $_.Exception.Message
  Remove-Item -LiteralPath $env:SC_UPDATE_STAGE -Force -ErrorAction SilentlyContinue
  if ($env:SC_UPDATE_ERROR) { Set-Content -LiteralPath $env:SC_UPDATE_ERROR -Value $message -ErrorAction SilentlyContinue }
}
"#;

fn error_path(_app: &AppHandle) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let dir = commander_core::settings::directory()?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join("update-error.txt"))
}

fn record_error(app: &AppHandle, error: &str) {
    if let Ok(path) = error_path(app) {
        let _ = std::fs::write(path, error);
    }
}

pub fn take_error(app: &AppHandle) -> Option<String> {
    let path = error_path(app).ok()?;
    let error = std::fs::read_to_string(&path).ok()?;
    let _ = std::fs::remove_file(path);
    Some(error)
}
