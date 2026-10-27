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
    settings: Option<serde_json::Value>,
    locale: String,
}

#[tauri::command]
async fn bootstrap() -> Reply<Bootstrap> {
    blocking(|| {
        let (home, places, drives) = filesystem::local_places();
        Ok(Bootstrap {
            home,
            places,
            drives,
            settings: core::settings::load()?,
            locale: std::env::var("LANG").unwrap_or_else(|_| "en".into()),
        })
    })
    .await
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
) -> Reply<core::remote::ConnectionResult> {
    let secret = if secret.is_empty() {
        let id = profile.id.clone();
        blocking(move || Ok(core::settings::secret(&id)?.unwrap_or_default())).await?
    } else {
        secret
    };
    let (result, fs) = core::remote::connect(&profile, &secret, expected)
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
        state.connections.lock().unwrap().insert(id, fs);
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
    channel: Channel<Vec<u8>>,
) -> Reply<String> {
    state
        .terminals
        .open(
            &path,
            Arc::new(move |data| {
                let _ = channel.send(data);
            }),
        )
        .map_err(error)
}
#[tauri::command]
fn terminal_write(state: State<AppState>, id: String, data: String) -> Reply<()> {
    state.terminals.write(&id, data.as_bytes()).map_err(error)
}
#[tauri::command]
fn terminal_resize(state: State<AppState>, id: String, rows: u16, cols: u16) -> Reply<()> {
    state.terminals.resize(&id, rows, cols).map_err(error)
}
#[tauri::command]
fn terminal_close(state: State<AppState>, id: String) -> Reply<()> {
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
            read_ssh_config,
            save_ssh_config,
            save_ssh_host,
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
