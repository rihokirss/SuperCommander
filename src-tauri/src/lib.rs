use commander_core::{
    self as core,
    engine::Engine,
    filesystem::{self, Sources},
    terminal::Terminals,
    *,
};
use notify::{RecommendedWatcher, Watcher};
use serde::Serialize;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tauri::{ipc::Channel, Emitter, Manager, State};

struct AppState {
    sources: Arc<Sources>,
    connections: Mutex<HashMap<String, Arc<core::remote::RemoteFs>>>,
    engine: Engine,
    terminals: Terminals,
    searches: Mutex<HashMap<String, Arc<AtomicBool>>>,
    watchers: Mutex<HashMap<String, RecommendedWatcher>>,
}
type Reply<T> = Result<T, String>;
fn error(e: impl std::fmt::Display) -> String {
    format!("{e:#}")
}
async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> anyhow::Result<T> + Send + 'static,
) -> Reply<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(error)?
        .map_err(error)
}

#[derive(Serialize)]
struct Bootstrap {
    home: String,
    places: Vec<Place>,
    drives: Vec<Place>,
    network: Vec<Place>,
    #[serde(rename = "networkError")]
    network_error: Option<String>,
    settings: Option<serde_json::Value>,
    locale: String,
}

#[tauri::command]
async fn bootstrap() -> Reply<Bootstrap> {
    blocking(|| {
        let (home, places, drives) = filesystem::local_places();
        let (network, network_error) = match filesystem::network_places() {
            Ok(v) => (v, None),
            Err(e) => (vec![], Some(error(e))),
        };
        Ok(Bootstrap {
            home,
            places,
            drives,
            network,
            network_error,
            settings: core::settings::load()?,
            locale: std::env::var("LANG").unwrap_or_else(|_| "en".into()),
        })
    })
    .await
}
#[tauri::command]
fn set_window_appearance(
    window: tauri::Window,
    glass: bool,
    transparency: u8,
    light: bool,
) -> Reply<()> {
    #[cfg(windows)]
    {
        let alpha = if glass {
            (190.0 * (1.0 - transparency.min(70) as f32 / 100.0)) as u8
        } else {
            255
        };
        let color = if light {
            (239, 244, 252, alpha)
        } else {
            (16, 20, 31, alpha)
        };
        window_vibrancy::apply_acrylic(&window, Some(color)).map_err(error)?;
    }
    #[cfg(not(windows))]
    let _ = (window, glass, transparency, light);
    Ok(())
}

#[tauri::command]
async fn list_directory(
    state: State<'_, AppState>,
    location: Location,
    channel: Channel<Listing>,
) -> Reply<()> {
    let fs = state.sources.get(&location.source).map_err(error)?;
    blocking(move || {
        filesystem::stream_listing(fs.as_ref(), &location.path, &|batch| {
            let _ = channel.send(batch);
        })?;
        Ok(())
    })
    .await
}

#[tauri::command]
async fn search_files(
    state: State<'_, AppState>,
    id: String,
    location: Location,
    filter: SearchFilter,
    channel: Channel<Listing>,
) -> Reply<()> {
    let fs = state.sources.get(&location.source).map_err(error)?;
    let cancel = Arc::new(AtomicBool::new(false));
    state
        .searches
        .lock()
        .unwrap()
        .insert(id.clone(), cancel.clone());
    let result = blocking(move || {
        filesystem::search(fs.as_ref(), &location.path, &filter, &cancel, &|batch| {
            let _ = channel.send(batch);
        })?;
        Ok(())
    })
    .await;
    state.searches.lock().unwrap().remove(&id);
    result
}

#[tauri::command]
fn cancel_search(state: State<AppState>, id: String) {
    if let Some(c) = state.searches.lock().unwrap().get(&id) {
        c.store(true, Ordering::Relaxed);
    }
}

#[tauri::command]
fn enqueue_job(state: State<AppState>, request: JobRequest) -> Reply<()> {
    state.engine.enqueue(request).map_err(error)
}
#[tauri::command]
fn cancel_job(state: State<AppState>, id: String) {
    state.engine.cancel(&id);
}
#[tauri::command]
fn resolve_conflict(state: State<AppState>, id: String, policy: Conflict, all: bool) -> Reply<()> {
    state.engine.resolve(&id, policy, all).map_err(error)
}

#[tauri::command]
async fn create_directory(
    state: State<'_, AppState>,
    location: Location,
    name: String,
) -> Reply<()> {
    filesystem::valid_name(&name).map_err(error)?;
    let fs = state.sources.get(&location.source).map_err(error)?;
    blocking(move || {
        fs.mkdir(&fs.join(&location.path, &name))?;
        Ok(())
    })
    .await
}
#[tauri::command]
async fn rename_preview(
    state: State<'_, AppState>,
    source: String,
    paths: Vec<String>,
    rules: RenameRules,
) -> Reply<Vec<RenameItem>> {
    let fs = state.sources.get(&source).map_err(error)?;
    blocking(move || core::rename::plan(fs.as_ref(), &paths, &rules)).await
}
#[tauri::command]
async fn rename_apply(
    state: State<'_, AppState>,
    source: String,
    paths: Vec<String>,
    rules: RenameRules,
) -> Reply<()> {
    let fs = state.sources.get(&source).map_err(error)?;
    blocking(move || {
        core::rename::apply(fs.as_ref(), &paths, &rules)?;
        Ok(())
    })
    .await
}
#[tauri::command]
async fn get_preview(state: State<'_, AppState>, location: Location) -> Reply<Preview> {
    let fs = state.sources.get(&location.source).map_err(error)?;
    blocking(move || filesystem::preview(fs.as_ref(), &location.path)).await
}
fn clipboard_owner(window: &tauri::Window) -> Reply<usize> {
    #[cfg(windows)]
    {
        window.hwnd().map(|h| h.0 as usize).map_err(error)
    }
    #[cfg(not(windows))]
    {
        let _ = window;
        Ok(0)
    }
}
#[tauri::command]
fn clipboard_revision() -> u32 {
    core::clipboard::revision()
}
#[tauri::command]
async fn read_file_clipboard(window: tauri::Window) -> Reply<Option<core::clipboard::Files>> {
    let owner = clipboard_owner(&window)?;
    blocking(move || core::clipboard::read(owner)).await
}
#[tauri::command]
async fn write_file_clipboard(
    state: State<'_, AppState>,
    window: tauri::Window,
    value: core::clipboard::Files,
) -> Reply<core::clipboard::Files> {
    value.validate().map_err(error)?;
    let fs = state.sources.get(&value.source).map_err(error)?;
    if value.cut && !fs.writable() {
        return Err("Source is read-only".into());
    }
    let owner = clipboard_owner(&window)?;
    blocking(move || core::clipboard::write(owner, &value)).await
}
#[tauri::command]
async fn write_clipboard_text(window: tauri::Window, text: String) -> Reply<()> {
    let owner = clipboard_owner(&window)?;
    blocking(move || core::clipboard::text(owner, &text)).await
}
#[derive(Serialize)]
struct ClipboardPaste {
    clipboard: core::clipboard::Files,
    request: JobRequest,
}
#[tauri::command]
async fn plan_file_paste(
    state: State<'_, AppState>,
    window: tauri::Window,
    destination: Location,
    id: String,
) -> Reply<ClipboardPaste> {
    let owner = clipboard_owner(&window)?;
    let value = blocking(move || {
        core::clipboard::read(owner)?
            .ok_or_else(|| anyhow::anyhow!("The clipboard does not contain files"))
    })
    .await?;
    let source = state.sources.get(&value.source).map_err(error)?;
    let dest = state.sources.get(&destination.source).map_err(error)?;
    blocking(move || {
        if !dest.writable() || value.cut && !source.writable() {
            anyhow::bail!("This location is read-only");
        }
        if !dest.stat(&destination.path)?.is_dir {
            anyhow::bail!("Paste into a directory");
        }
        let mut same_folder = false;
        if value.source == destination.source {
            let parents: std::collections::HashSet<_> = value
                .paths
                .iter()
                .map(|p| core::rename::parent(p))
                .collect();
            for parent in parents {
                let same = if value.source == "local" {
                    core::filesystem::same_directory(&parent, &destination.path)?
                } else {
                    parent.trim_end_matches('/') == destination.path.trim_end_matches('/')
                };
                same_folder |= same;
            }
        }
        if same_folder && value.cut {
            anyhow::bail!("The files are already in this directory");
        }
        Ok(ClipboardPaste {
            request: JobRequest {
                id,
                operation: if value.cut {
                    Operation::Move
                } else {
                    Operation::Copy
                },
                source: value.source.clone(),
                paths: value.paths.clone(),
                destination,
                conflict: if same_folder {
                    Conflict::KeepBoth
                } else {
                    Conflict::Ask
                },
            },
            clipboard: value,
        })
    })
    .await
}
#[tauri::command]
async fn finish_file_paste(
    state: State<'_, AppState>,
    window: tauri::Window,
    clipboard: core::clipboard::Files,
) -> Reply<Option<core::clipboard::Files>> {
    clipboard.validate().map_err(error)?;
    let owner = clipboard_owner(&window)?;
    let fs = state.sources.get(&clipboard.source).map_err(error)?;
    blocking(move || {
        let mut remaining = Vec::new();
        for path in &clipboard.paths {
            // Retain inaccessible sources as well as skipped/failed files, while
            // removing paths already moved by a partially successful operation.
            if fs.exists(path).unwrap_or(true) {
                remaining.push(path.clone());
            }
        }
        core::clipboard::replace_if_unchanged(owner, &clipboard, remaining)
    })
    .await
}
#[tauri::command]
async fn cancel_file_cut(
    window: tauri::Window,
    clipboard: core::clipboard::Files,
) -> Reply<Option<core::clipboard::Files>> {
    clipboard.validate().map_err(error)?;
    let owner = clipboard_owner(&window)?;
    blocking(move || core::clipboard::replace_if_unchanged(owner, &clipboard, vec![])).await
}
#[tauri::command]
async fn read_document(
    state: State<'_, AppState>,
    location: Location,
) -> Reply<core::editor::Document> {
    let fs = state.sources.get(&location.source).map_err(error)?;
    blocking(move || core::editor::read(fs.as_ref(), &location.path)).await
}
#[tauri::command]
async fn save_document(
    state: State<'_, AppState>,
    location: Location,
    text: String,
    revision: String,
) -> Reply<core::editor::Document> {
    let fs = state.sources.get(&location.source).map_err(error)?;
    blocking(move || core::editor::save(fs.as_ref(), &location.path, &text, &revision)).await
}
#[tauri::command]
async fn save_settings(value: serde_json::Value) -> Reply<()> {
    blocking(move || {
        core::settings::save(&value)?;
        Ok(())
    })
    .await
}

#[tauri::command]
async fn read_ssh_config(path: Option<String>) -> Reply<core::ssh_config::Catalog> {
    blocking(move || core::ssh_config::read(path.as_deref())).await
}
#[tauri::command]
async fn save_ssh_config(
    path: String,
    text: String,
    revision: Option<String>,
) -> Reply<core::ssh_config::Catalog> {
    blocking(move || core::ssh_config::save(&path, &text, revision.as_deref())).await
}
#[tauri::command]
async fn save_ssh_host(
    path: Option<String>,
    alias: String,
    profile: SftpProfile,
    revision: Option<String>,
) -> Reply<core::ssh_config::Catalog> {
    blocking(move || {
        core::ssh_config::upsert(path.as_deref(), &alias, &profile, revision.as_deref())
    })
    .await
}
#[tauri::command]
async fn save_ssh_forward(
    path: String,
    alias: String,
    forward: core::ssh_config::LocalForward,
    enabled: bool,
    revision: Option<String>,
) -> Reply<core::ssh_config::Catalog> {
    blocking(move || {
        core::ssh_config::set_forward(&path, &alias, &forward, enabled, revision.as_deref())
    })
    .await
}
#[tauri::command]
async fn has_connection_secret(id: String) -> Reply<bool> {
    blocking(move || Ok(core::settings::secret(&id)?.is_some())).await
}
#[tauri::command]
async fn save_connection_secret(id: String, secret: String, remember: bool) -> Reply<()> {
    blocking(move || {
        if remember {
            if !secret.is_empty() {
                core::settings::save_secret(&id, &secret)?;
            }
        } else {
            core::settings::delete_secret(&id)?;
        }
        Ok(())
    })
    .await
}

#[tauri::command]
async fn start_forward(
    state: State<'_, AppState>,
    source: String,
    local_port: u16,
    remote_host: String,
    remote_port: u16,
) -> Reply<core::remote::ForwardInfo> {
    let connection = state
        .connections
        .lock()
        .unwrap()
        .get(&source)
        .cloned()
        .ok_or("Open an SSH connection first")?;
    connection
        .start_forward(local_port, remote_host, remote_port)
        .await
        .map_err(error)
}
#[tauri::command]
fn list_forwards(state: State<AppState>, source: String) -> Reply<Vec<core::remote::ForwardInfo>> {
    state
        .connections
        .lock()
        .unwrap()
        .get(&source)
        .map(|c| c.forwards())
        .ok_or_else(|| "SSH connection is not active".into())
}
#[tauri::command]
async fn stop_forward(state: State<'_, AppState>, source: String, id: String) -> Reply<()> {
    let connection = state
        .connections
        .lock()
        .unwrap()
        .get(&source)
        .cloned()
        .ok_or("SSH connection is not active")?;
    connection.stop_forward(&id).await.map_err(error)
}

#[tauri::command]
async fn connect_sftp(
    state: State<'_, AppState>,
    profile: SftpProfile,
    secret: String,
    expected: Option<String>,
    config_path: Option<String>,
) -> Reply<core::remote::ConnectionResult> {
    let secret = if secret.is_empty() {
        let id = profile.id.clone();
        blocking(move || Ok(core::settings::secret(&id)?.unwrap_or_default())).await?
    } else {
        secret
    };
    let (mut result, fs) = core::remote::connect(&profile, &secret, expected)
        .await
        .map_err(error)?;
    if let Some(fs) = fs {
        if profile.save_secret {
            let id = profile.id.clone();
            blocking(move || {
                core::settings::save_secret(&id, &secret)?;
                Ok(())
            })
            .await?;
        }
        let id = format!("sftp:{}", profile.id);
        let previous = state.connections.lock().unwrap().remove(&id);
        if let Some(previous) = previous {
            let _ = previous.close().await;
        }
        state.sources.insert(id.clone(), fs.clone());
        state.connections.lock().unwrap().insert(id, fs.clone());
        let saved_profile = profile.clone();
        let saved = blocking(move || {
            let catalog = core::ssh_config::read(config_path.as_deref())?;
            Ok(catalog
                .hosts
                .into_iter()
                .find(|h| {
                    h.profile.id == saved_profile.id
                        && h.profile.host == saved_profile.host
                        && h.profile.port == saved_profile.port
                        && h.profile.username == saved_profile.username
                })
                .map(|h| h.forwards)
                .unwrap_or_default())
        })
        .await;
        match saved {
            Ok(forwards) => {
                for forward in forwards {
                    if let Err(e) = fs
                        .start_forward(forward.local_port, forward.remote_host, forward.remote_port)
                        .await
                    {
                        result
                            .forward_errors
                            .push(format!("127.0.0.1:{}: {e:#}", forward.local_port));
                    }
                }
            }
            Err(e) => result.forward_errors.push(e),
        }
    }
    Ok(result)
}
#[tauri::command]
async fn disconnect_sftp(state: State<'_, AppState>, source: String) -> Reply<()> {
    state.connections.lock().unwrap().remove(&source);
    let sources = state.sources.clone();
    blocking(move || sources.disconnect(&source)).await
}
#[tauri::command]
async fn forget_secret(id: String) -> Reply<()> {
    blocking(move || {
        core::settings::delete_secret(&id)?;
        Ok(())
    })
    .await
}

#[tauri::command]
async fn terminal_open(
    state: State<'_, AppState>,
    path: String,
    source: String,
    channel: Channel<Vec<u8>>,
) -> Reply<String> {
    let output: Arc<dyn Fn(Vec<u8>) + Send + Sync> = Arc::new(move |data| {
        let _ = channel.send(data);
    });
    if source != "local" {
        let connection = state
            .connections
            .lock()
            .unwrap()
            .get(&source)
            .cloned()
            .ok_or("SSH connection is not active")?;
        return connection.open_terminal(output).await.map_err(error);
    }
    state.terminals.open(&path, output).map_err(error)
}
#[tauri::command]
async fn terminal_write(
    state: State<'_, AppState>,
    source: String,
    id: String,
    data: String,
) -> Reply<()> {
    if source != "local" {
        let connection = state
            .connections
            .lock()
            .unwrap()
            .get(&source)
            .cloned()
            .ok_or("SSH connection is not active")?;
        return connection
            .write_terminal(&id, data.into_bytes())
            .await
            .map_err(error);
    }
    state.terminals.write(&id, data.as_bytes()).map_err(error)
}
#[tauri::command]
async fn terminal_resize(
    state: State<'_, AppState>,
    source: String,
    id: String,
    rows: u16,
    cols: u16,
) -> Reply<()> {
    if source != "local" {
        let connection = state
            .connections
            .lock()
            .unwrap()
            .get(&source)
            .cloned()
            .ok_or("SSH connection is not active")?;
        return connection
            .resize_terminal(&id, rows, cols)
            .await
            .map_err(error);
    }
    state.terminals.resize(&id, rows, cols).map_err(error)
}
#[tauri::command]
async fn terminal_close(state: State<'_, AppState>, source: String, id: String) -> Reply<()> {
    if source != "local" {
        let connection = state.connections.lock().unwrap().get(&source).cloned();
        if let Some(connection) = connection {
            return connection.close_terminal(&id).await.map_err(error);
        }
        return Ok(());
    }
    state.terminals.close(&id).map_err(error)
}

#[tauri::command]
fn watch_directory(
    state: State<AppState>,
    app: tauri::AppHandle,
    id: String,
    path: Option<String>,
) -> Reply<()> {
    let mut watchers = state.watchers.lock().unwrap();
    watchers.remove(&id);
    if let Some(path) = path {
        let watcher_id = id.clone();
        let mut watcher =
            notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
                if let Ok(event) = event {
                    if !matches!(event.kind, notify::EventKind::Access(_)) {
                        let _ = app.emit("directory-changed", &id);
                    }
                }
            })
            .map_err(error)?;
        watcher
            .watch(
                std::path::Path::new(&path),
                notify::RecursiveMode::NonRecursive,
            )
            .map_err(error)?;
        watchers.insert(watcher_id, watcher);
    }
    Ok(())
}

#[tauri::command]
async fn open_file(path: String, edit: bool) -> Reply<()> {
    blocking(move || {
        let path = std::fs::canonicalize(path)?;
        if edit {
            #[cfg(windows)]
            let editor = std::env::var("EDITOR").unwrap_or_else(|_| "notepad.exe".into());
            #[cfg(not(windows))]
            let editor = std::env::var("EDITOR").unwrap_or_else(|_| "xdg-open".into());
            std::process::Command::new(editor).arg(path).spawn()?;
        } else {
            open::that_detached(path)?;
        }
        Ok(())
    })
    .await
}

pub fn run() {
    let app = tauri::Builder::default()
        .setup(|app| {
            let sources = Arc::new(Sources::default());
            let handle = app.handle().clone();
            let engine = Engine::new(
                sources.clone(),
                Arc::new(move |event| {
                    let _ = handle.emit("job-progress", event);
                }),
            );
            app.manage(AppState {
                sources,
                connections: Mutex::default(),
                engine,
                terminals: Terminals::default(),
                searches: Mutex::default(),
                watchers: Mutex::default(),
            });
            #[cfg(windows)]
            if let Some(window) = app.get_webview_window("main") {
                let _ = window_vibrancy::apply_acrylic(&window, Some((16, 20, 31, 210)));
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            bootstrap,
            set_window_appearance,
            read_ssh_config,
            save_ssh_config,
            save_ssh_host,
            save_ssh_forward,
            has_connection_secret,
            save_connection_secret,
            start_forward,
            list_forwards,
            stop_forward,
            list_directory,
            search_files,
            cancel_search,
            enqueue_job,
            cancel_job,
            resolve_conflict,
            create_directory,
            rename_preview,
            rename_apply,
            get_preview,
            clipboard_revision,
            read_file_clipboard,
            write_file_clipboard,
            write_clipboard_text,
            plan_file_paste,
            finish_file_paste,
            cancel_file_cut,
            read_document,
            save_document,
            save_settings,
            connect_sftp,
            disconnect_sftp,
            forget_secret,
            terminal_open,
            terminal_write,
            terminal_resize,
            terminal_close,
            watch_directory,
            open_file
        ])
        .build(tauri::generate_context!())
        .expect("Could not start SuperCommander");
    app.run(|handle, event| {
        if let tauri::RunEvent::Exit = event {
            handle.state::<AppState>().terminals.close_all();
        }
    });
}
