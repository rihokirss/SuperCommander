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

#[cfg(windows)]
mod updates;
#[cfg(windows)]
mod window_state;

struct AppState {
    sources: Arc<Sources>,
    connections: Mutex<HashMap<String, Arc<core::remote::RemoteFs>>>,
    engine: Engine,
    terminals: Terminals,
    searches: core::tasks::Tasks,
    comparisons: Mutex<HashMap<String, ComparisonRecord>>,
    recovery_plans: Mutex<HashMap<String, (std::time::Instant, core::recovery::Prepared)>>,
    rename_plans: Mutex<HashMap<String, (std::time::Instant, String, core::rename::Prepared)>>,
    watchers: Mutex<HashMap<String, RecommendedWatcher>>,
}
struct ComparisonRecord {
    plan: Arc<core::comparison::Plan>,
    created: std::time::Instant,
}
#[derive(Serialize)]
struct ComparisonResult {
    id: String,
    plan: Arc<core::comparison::Plan>,
}
type Reply<T> = Result<T, String>;
#[derive(Clone, Serialize)]
struct RecoveryProgress {
    files: u64,
    bytes: u64,
}
#[derive(Serialize)]
struct RecoveryReview {
    id: String,
    summary: core::recovery::RestoreSummary,
}
#[derive(Serialize)]
struct RenameReview {
    id: String,
    items: Vec<RenameItem>,
}

#[tauri::command]
async fn scan_recovery(
    state: State<'_, AppState>,
    id: String,
    location: Location,
    recursive: bool,
    channel: Channel<core::recovery::Batch>,
) -> Reply<()> {
    let task = state.searches.start(id).map_err(error)?;
    let fs = state.sources.get(&location.source).map_err(error)?;
    blocking(move || {
        core::recovery::scan(
            fs.as_ref(),
            &location.path,
            recursive,
            &task.cancel,
            &|batch| {
                if channel.send(batch).is_err() {
                    task.cancel.store(true, Ordering::Relaxed);
                }
            },
        )
    })
    .await
}
#[tauri::command]
async fn plan_recovery(
    state: State<'_, AppState>,
    id: String,
    source: String,
    options: core::recovery::RestoreOptions,
    channel: Channel<RecoveryProgress>,
) -> Reply<RecoveryReview> {
    let task = state.searches.start(id.clone()).map_err(error)?;
    let cancel = task.cancel.clone();
    let fs = state.sources.get(&source).map_err(error)?;
    let dst = state
        .sources
        .get(&options.destination.source)
        .map_err(error)?;
    let prepared = blocking(move || {
        core::recovery::prepare(
            fs.as_ref(),
            &source,
            dst.as_ref(),
            &options,
            &task.cancel,
            &|files, bytes| {
                if channel.send(RecoveryProgress { files, bytes }).is_err() {
                    task.cancel.store(true, Ordering::Relaxed);
                }
            },
        )
    })
    .await?;
    if cancel.load(Ordering::Relaxed) {
        return Err("Cancelled".into());
    }
    let summary = prepared.summary.clone();
    let mut cache = state.recovery_plans.lock().unwrap();
    cache.retain(|_, (created, _)| created.elapsed().as_secs() < 1800);
    while cache.len() >= 4 {
        let oldest = cache
            .iter()
            .min_by_key(|(_, (created, _))| *created)
            .map(|(id, _)| id.clone())
            .unwrap();
        cache.remove(&oldest);
    }
    cache.insert(id.clone(), (std::time::Instant::now(), prepared));
    Ok(RecoveryReview { id, summary })
}
#[tauri::command]
fn release_recovery(state: State<AppState>, id: String) {
    state.recovery_plans.lock().unwrap().remove(&id);
}
#[tauri::command]
async fn enqueue_recovery(state: State<'_, AppState>, id: String, plan: String) -> Reply<()> {
    let (created, prepared) = state
        .recovery_plans
        .lock()
        .unwrap()
        .remove(&plan)
        .ok_or("Recovery review expired; prepare it again")?;
    if created.elapsed().as_secs() >= 1800 {
        return Err("Recovery review expired; prepare it again".into());
    }
    let engine = state.engine.clone();
    blocking(move || engine.enqueue_recovery(id, prepared)).await
}
#[tauri::command]
async fn remove_recovery(
    state: State<'_, AppState>,
    id: String,
    source: String,
    item: core::recovery::Item,
) -> Reply<()> {
    let engine = state.engine.clone();
    blocking(move || engine.enqueue_recovery_cleanup(id, source, item)).await
}
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

#[tauri::command]
fn pending_update(app: tauri::AppHandle) -> Option<String> {
    #[cfg(windows)]
    {
        updates::pending_version(&app)
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        None
    }
}

#[tauri::command]
fn take_update_error(app: tauri::AppHandle) -> Option<String> {
    #[cfg(windows)]
    {
        updates::take_error(&app)
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        None
    }
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
async fn bootstrap(include_network: Option<bool>) -> Reply<Bootstrap> {
    blocking(move || {
        let (home, places, drives) = filesystem::local_places();
        let (network, network_error) = match if include_network.unwrap_or(true) {
            filesystem::network_places()
        } else {
            Ok(vec![])
        } {
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
    palette: Option<String>,
) -> Reply<()> {
    #[cfg(windows)]
    {
        let alpha = if glass {
            (190.0 * (1.0 - transparency.min(70) as f32 / 100.0)) as u8
        } else {
            255
        };
        let color = match (light, palette.as_deref()) {
            (true, Some("ice")) => (241, 248, 255, alpha),
            (true, Some("azure")) => (216, 237, 252, alpha),
            (true, _) => (231, 243, 252, alpha),
            (false, Some("denim")) => (27, 45, 74, alpha),
            (false, Some("midnight")) => (17, 23, 34, alpha),
            (false, Some("sky")) => (20, 44, 70, alpha),
            (false, Some("midnightRed")) => (40, 16, 21, alpha),
            (false, Some("midnightClassicRed")) => (48, 14, 23, alpha),
            (false, Some("graphiteRed")) => (24, 27, 32, alpha),
            (false, Some("softGraphite")) => (25, 33, 46, alpha),
            (false, Some("midnightClassic")) => (16, 35, 65, alpha),
            (false, Some("graphiteBlue")) => (24, 27, 32, alpha),
            (false, _) => (16, 35, 65, alpha),
        };
        window_vibrancy::apply_acrylic(&window, Some(color)).map_err(error)?;
    }
    #[cfg(not(windows))]
    let _ = (window, glass, transparency, light, palette);
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
    channel: Channel<core::search::Batch>,
) -> Reply<()> {
    let task = state.searches.start(id).map_err(error)?;
    let fs = state.sources.get(&location.source).map_err(error)?;
    blocking(move || {
        let cancel = &task.cancel;
        core::search::run(fs.as_ref(), &location.path, &filter, cancel, &|batch| {
            if channel.send(batch).is_err() {
                cancel.store(true, Ordering::Relaxed);
            }
        })?;
        Ok(())
    })
    .await
}

#[tauri::command]
fn cancel_search(state: State<AppState>, id: String) {
    state.searches.cancel(id);
}
#[tauri::command]
async fn compare_directories(
    state: State<'_, AppState>,
    id: String,
    left: Location,
    right: Location,
    options: core::comparison::Options,
    channel: Channel<core::comparison::Progress>,
) -> Reply<ComparisonResult> {
    let task = state.searches.start(id.clone()).map_err(error)?;
    let left_fs = state.sources.get(&left.source).map_err(error)?;
    let right_fs = state.sources.get(&right.source).map_err(error)?;
    let cancel = task.cancel.clone();
    let plan = Arc::new(
        blocking(move || {
            core::comparison::scan(
                left_fs.as_ref(),
                right_fs.as_ref(),
                left,
                right,
                options,
                &task.cancel,
                &|progress| {
                    if channel.send(progress).is_err() {
                        task.cancel.store(true, Ordering::Relaxed);
                    }
                },
            )
        })
        .await?,
    );
    if !cancel.load(Ordering::Relaxed) && !plan.progress.cancelled && !plan.progress.limited {
        let mut cache = state.comparisons.lock().unwrap();
        cache.retain(|_, record| record.created.elapsed().as_secs() < 1800);
        while cache.len() >= 4 {
            let oldest = cache
                .iter()
                .min_by_key(|(_, record)| record.created)
                .map(|(id, _)| id.clone())
                .unwrap();
            cache.remove(&oldest);
        }
        cache.insert(
            id.clone(),
            ComparisonRecord {
                plan: plan.clone(),
                created: std::time::Instant::now(),
            },
        );
    }
    Ok(ComparisonResult { id, plan })
}
#[tauri::command]
fn release_comparison(state: State<AppState>, id: String) {
    state.comparisons.lock().unwrap().remove(&id);
}
#[tauri::command]
async fn enqueue_comparison(
    state: State<'_, AppState>,
    id: String,
    comparison: String,
    choices: Vec<core::comparison::Choice>,
) -> Reply<()> {
    let task = state.searches.start(id.clone()).map_err(error)?;
    let plan = state
        .comparisons
        .lock()
        .unwrap()
        .get(&comparison)
        .filter(|record| record.created.elapsed().as_secs() < 1800)
        .map(|record| record.plan.clone())
        .ok_or("Comparison expired; compare again")?;
    let left = state
        .sources
        .get(&plan.left.location.source)
        .map_err(error)?;
    let right = state
        .sources
        .get(&plan.right.location.source)
        .map_err(error)?;
    let prepared = blocking(move || {
        core::comparison::prepare(plan, &choices, left.as_ref(), right.as_ref(), &task.cancel)
    })
    .await?;
    state
        .engine
        .enqueue_synchronization(id, prepared)
        .map_err(error)?;
    state.comparisons.lock().unwrap().remove(&comparison);
    Ok(())
}

#[tauri::command]
async fn get_properties(
    state: State<'_, AppState>,
    location: Location,
) -> Reply<core::properties::Properties> {
    let fs = state.sources.get(&location.source).map_err(error)?;
    blocking(move || core::properties::get(fs.as_ref(), &location.path)).await
}
#[tauri::command]
async fn apply_properties(
    state: State<'_, AppState>,
    location: Location,
    revision: String,
    changes: core::properties::Changes,
) -> Reply<core::properties::Properties> {
    let fs = state.sources.get(&location.source).map_err(error)?;
    blocking(move || core::properties::apply(fs.as_ref(), &location.path, &revision, &changes))
        .await
}
#[tauri::command]
async fn calculate_size(
    state: State<'_, AppState>,
    source: String,
    paths: Vec<String>,
    id: String,
    channel: Channel<core::properties::SizeSummary>,
) -> Reply<()> {
    let task = state.searches.start(id).map_err(error)?;
    let fs = state.sources.get(&source).map_err(error)?;
    blocking(move || {
        let cancel = &task.cancel;
        core::properties::calculate(fs.as_ref(), &paths, cancel, &|value| {
            if channel.send(value).is_err() {
                cancel.store(true, Ordering::Relaxed);
            }
        })
    })
    .await
}

#[tauri::command]
async fn calculate_folder_sizes(
    state: State<'_, AppState>,
    source: String,
    paths: Vec<String>,
    id: String,
    channel: Channel<FolderSizeProgress>,
) -> Reply<()> {
    let task = state.searches.start(id).map_err(error)?;
    // One filesystem/session is retained for the entire scan, including reconnects.
    let fs = state.sources.get(&source).map_err(error)?;
    blocking(move || {
        for (index, path) in paths.iter().enumerate() {
            if task.cancel.load(Ordering::Relaxed) {
                break;
            }
            core::properties::calculate(
                fs.as_ref(),
                std::slice::from_ref(path),
                &task.cancel,
                &|summary| {
                    if channel
                        .send(FolderSizeProgress {
                            path: path.clone(),
                            index: index + 1,
                            total: paths.len(),
                            summary,
                        })
                        .is_err()
                    {
                        task.cancel.store(true, Ordering::Relaxed);
                    }
                },
            )?;
        }
        Ok(())
    })
    .await
}
#[derive(Clone, Serialize)]
struct FolderSizeProgress {
    path: String,
    index: usize,
    total: usize,
    summary: core::properties::SizeSummary,
}
#[tauri::command]
async fn enqueue_job(state: State<'_, AppState>, request: JobRequest) -> Reply<()> {
    let engine = state.engine.clone();
    blocking(move || engine.enqueue(request)).await
}
#[tauri::command]
fn cancel_job(state: State<AppState>, id: String) {
    state.searches.cancel(id.clone());
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
    id: String,
    source: String,
    paths: Vec<String>,
    rules: RenameRules,
) -> Reply<RenameReview> {
    let task = state.searches.start(id.clone()).map_err(error)?;
    let cancel = task.cancel.clone();
    let fs = state.sources.get(&source).map_err(error)?;
    let prepared =
        blocking(move || core::rename::prepare(fs.as_ref(), &paths, &rules, &task.cancel)).await?;
    if cancel.load(Ordering::Relaxed) {
        return Err("Cancelled".into());
    }
    let items = prepared.items().to_vec();
    let mut cache = state.rename_plans.lock().unwrap();
    cache.retain(|_, (created, _, _)| created.elapsed().as_secs() < 1800);
    while cache.len() >= 4 {
        let oldest = cache
            .iter()
            .min_by_key(|(_, (created, _, _))| *created)
            .map(|(id, _)| id.clone())
            .unwrap();
        cache.remove(&oldest);
    }
    cache.insert(id.clone(), (std::time::Instant::now(), source, prepared));
    Ok(RenameReview { id, items })
}
#[tauri::command]
fn release_rename(state: State<AppState>, id: String) {
    state.rename_plans.lock().unwrap().remove(&id);
}
#[tauri::command]
async fn rename_apply(state: State<'_, AppState>, id: String, plan: String) -> Reply<()> {
    let task = state.searches.start(id).map_err(error)?;
    let (created, source, prepared) = state
        .rename_plans
        .lock()
        .unwrap()
        .remove(&plan)
        .ok_or("Rename preview expired; prepare it again")?;
    if created.elapsed().as_secs() >= 1800 {
        return Err("Rename preview expired; prepare it again".into());
    }
    let fs = state.sources.get(&source).map_err(error)?;
    blocking(move || core::rename::apply_prepared(fs.as_ref(), &prepared, &task.cancel)).await
}
#[tauri::command]
async fn get_preview(
    state: State<'_, AppState>,
    location: Location,
    line: Option<u64>,
    connection: Option<String>,
    id: Option<String>,
) -> Reply<Preview> {
    let task = id
        .map(|id| state.searches.start(id))
        .transpose()
        .map_err(error)?;
    let fs = state.sources.get(&location.source).map_err(error)?;
    if connection.is_some() {
        editor_connection(fs.as_ref(), connection.as_deref()).map_err(error)?;
    }
    blocking(move || {
        let cancel = task.as_ref().map_or_else(
            || Arc::new(AtomicBool::new(false)),
            |task| task.cancel.clone(),
        );
        filesystem::preview_at(fs.as_ref(), &location.path, line.unwrap_or(1), &cancel)
    })
    .await
}
#[derive(Serialize)]
struct TextFind {
    hit: Option<core::text::Match>,
    preview: Option<Preview>,
}
#[tauri::command]
async fn find_text(
    state: State<'_, AppState>,
    id: String,
    location: Location,
    query: String,
    from: core::text::Position,
    previous: bool,
    connection: Option<String>,
) -> Reply<TextFind> {
    let task = state.searches.start(id).map_err(error)?;
    let fs = state.sources.get(&location.source).map_err(error)?;
    editor_connection(fs.as_ref(), connection.as_deref()).map_err(error)?;
    blocking(move || {
        if task.cancel.load(Ordering::Relaxed) {
            anyhow::bail!("Cancelled");
        }
        let hit = core::text::find(
            fs.reader(&location.path)?,
            &query,
            &from,
            previous,
            &task.cancel,
        )?;
        let preview = hit
            .as_ref()
            .map(|hit| filesystem::preview_at(fs.as_ref(), &location.path, hit.line, &task.cancel))
            .transpose()?;
        Ok(TextFind { hit, preview })
    })
    .await
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
async fn read_file_clipboard(
    state: State<'_, AppState>,
    window: tauri::Window,
) -> Reply<Option<core::clipboard::Files>> {
    let owner = clipboard_owner(&window)?;
    let sources = state.sources.clone();
    blocking(move || {
        let value = core::clipboard::read(owner)?;
        Ok(value.filter(|value| {
            !value.source.starts_with("sftp:")
                || sources
                    .get(&value.source)
                    .is_ok_and(|source| value.validate_source(source.as_ref()).is_ok())
        }))
    })
    .await
}
#[tauri::command]
async fn write_file_clipboard(
    state: State<'_, AppState>,
    window: tauri::Window,
    webview: tauri::Webview,
    mut value: core::clipboard::Files,
    id: Option<String>,
    channel: Option<tauri::ipc::JavaScriptChannelId>,
) -> Reply<core::clipboard::Files> {
    value.validate().map_err(error)?;
    let fs = state.sources.get(&value.source).map_err(error)?;
    if value.cut && !fs.writable() {
        return Err("Source is read-only".into());
    }
    let task = id
        .map(|id| state.searches.start(id))
        .transpose()
        .map_err(error)?;
    let cancel = task
        .as_ref()
        .map(|task| task.cancel.clone())
        .unwrap_or_default();
    let channel = channel.map(|channel| channel.channel_on(webview));
    let revision = core::clipboard::revision();
    let owner = clipboard_owner(&window)?;
    blocking(move || {
        let _task = task;
        value.capture_selection(fs.as_ref(), &cancel, &|progress| {
            if channel
                .as_ref()
                .is_some_and(|channel| channel.send(progress).is_err())
            {
                cancel.store(true, Ordering::Relaxed);
            }
        })?;
        if cancel.load(Ordering::Relaxed) {
            anyhow::bail!("Cancelled");
        }
        core::clipboard::write_captured(owner, &value, revision, &cancel)
    })
    .await
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
    value.validate_source(source.as_ref()).map_err(error)?;
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
                    source.canonical_path(&parent)? == dest.canonical_path(&destination.path)?
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
                source_connection: source.connection_id().map(str::to_owned),
                destination_connection: dest.connection_id().map(str::to_owned),
                source_bindings: value.bindings.clone(),
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
    clipboard.validate_source(fs.as_ref()).map_err(error)?;
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
    connection: Option<String>,
) -> Reply<core::editor::Document> {
    let fs = state.sources.get(&location.source).map_err(error)?;
    if connection.is_some() {
        editor_connection(fs.as_ref(), connection.as_deref()).map_err(error)?;
    }
    blocking(move || core::editor::read(fs.as_ref(), &location.path)).await
}
fn editor_connection(
    fs: &dyn filesystem::FileSystem,
    connection: Option<&str>,
) -> anyhow::Result<()> {
    if fs.connection_id().is_some() && connection != fs.connection_id() {
        anyhow::bail!("The SSH connection changed. Your edits are still here; use Save As to another connected location.");
    }
    Ok(())
}
#[tauri::command]
async fn new_document(
    state: State<'_, AppState>,
    folder: Location,
) -> Reply<core::editor::Document> {
    let fs = state.sources.get(&folder.source).map_err(error)?;
    blocking(move || core::editor::blank(fs.as_ref(), &folder.path)).await
}
#[tauri::command]
async fn document_target(
    state: State<'_, AppState>,
    location: Location,
    connection: Option<String>,
) -> Reply<core::editor::Target> {
    let fs = state.sources.get(&location.source).map_err(error)?;
    if connection.is_some() {
        editor_connection(fs.as_ref(), connection.as_deref()).map_err(error)?;
    }
    blocking(move || core::editor::target(fs.as_ref(), &location.path)).await
}
#[tauri::command]
async fn write_document(
    state: State<'_, AppState>,
    location: Location,
    text: String,
    revision: Option<String>,
    format: core::editor::Format,
    connection: Option<String>,
) -> Reply<core::editor::Document> {
    let fs = state.sources.get(&location.source).map_err(error)?;
    editor_connection(fs.as_ref(), connection.as_deref()).map_err(error)?;
    blocking(move || {
        core::editor::write(
            fs.as_ref(),
            &location.path,
            &text,
            revision.as_deref(),
            &format,
        )
    })
    .await
}
#[tauri::command]
async fn save_document(
    state: State<'_, AppState>,
    location: Location,
    text: String,
    revision: String,
    connection: Option<String>,
) -> Reply<core::editor::Document> {
    let fs = state.sources.get(&location.source).map_err(error)?;
    editor_connection(fs.as_ref(), connection.as_deref()).map_err(error)?;
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
    marker: Option<String>,
) -> Reply<String> {
    if marker.as_ref().is_some_and(|value| {
        value.len() != 32 || !value.bytes().all(|byte| byte.is_ascii_hexdigit())
    }) {
        return Err("Invalid terminal integration marker".into());
    }
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
        return connection
            .open_terminal_with_marker(output, marker.as_deref())
            .await
            .map_err(error);
    }
    state
        .terminals
        .open_with_marker(&path, output, marker.as_deref())
        .map_err(error)
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
        .plugin(tauri_plugin_updater::Builder::new().build())
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
                searches: core::tasks::Tasks::default(),
                comparisons: Mutex::default(),
                recovery_plans: Mutex::default(),
                rename_plans: Mutex::default(),
                watchers: Mutex::default(),
            });
            #[cfg(windows)]
            if let Some(window) = app.get_webview_window("main") {
                let maximized = window_state::install(&window);
                let _ = window_vibrancy::apply_acrylic(&window, Some((17, 23, 34, 210)));
                window_state::show(&window, maximized);
            }
            #[cfg(not(windows))]
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
            }
            #[cfg(windows)]
            updates::start(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            bootstrap,
            pending_update,
            take_update_error,
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
            compare_directories,
            release_comparison,
            scan_recovery,
            plan_recovery,
            release_recovery,
            enqueue_recovery,
            remove_recovery,
            enqueue_comparison,
            get_properties,
            apply_properties,
            calculate_size,
            calculate_folder_sizes,
            enqueue_job,
            cancel_job,
            resolve_conflict,
            create_directory,
            rename_preview,
            release_rename,
            rename_apply,
            get_preview,
            find_text,
            clipboard_revision,
            read_file_clipboard,
            write_file_clipboard,
            write_clipboard_text,
            plan_file_paste,
            finish_file_paste,
            cancel_file_cut,
            read_document,
            new_document,
            document_target,
            write_document,
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
            #[cfg(windows)]
            updates::install_on_exit(handle);
        }
    });
}
