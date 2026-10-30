//! Persist the normal Windows placement and maximized state separately from UI settings.
use commander_core::settings;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    mem::size_of,
    sync::{Arc, Mutex},
};
use tauri::{WebviewWindow, WindowEvent};
use windows_sys::Win32::{
    Foundation::{HWND, RECT},
    UI::WindowsAndMessaging::{
        GetWindowPlacement, SetWindowPlacement, SW_HIDE, SW_SHOWMAXIMIZED, SW_SHOWMINIMIZED,
        WINDOWPLACEMENT,
    },
};

#[derive(Clone, Debug, Deserialize, Serialize)]
struct WindowState {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
    maximized: bool,
}

impl WindowState {
    fn valid(&self) -> bool {
        let width = i64::from(self.right) - i64::from(self.left);
        let height = i64::from(self.bottom) - i64::from(self.top);
        (100..=32768).contains(&width) && (100..=32768).contains(&height)
    }
}

fn load() -> Option<WindowState> {
    let path = settings::directory().ok()?.join("window-state.json");
    let bytes = fs::read(path).ok()?;
    if bytes.len() > 4096 {
        return None;
    }
    let value: WindowState = serde_json::from_slice(&bytes).ok()?;
    value.valid().then_some(value)
}

fn save(value: &WindowState) -> anyhow::Result<()> {
    let directory = settings::directory()?;
    fs::create_dir_all(&directory)?;
    fs::write(
        directory.join("window-state.json"),
        serde_json::to_vec(value)?,
    )?;
    Ok(())
}

fn capture(hwnd: HWND, previous: Option<&WindowState>) -> Option<WindowState> {
    let mut placement = WINDOWPLACEMENT {
        length: size_of::<WINDOWPLACEMENT>() as u32,
        ..Default::default()
    };
    // SAFETY: hwnd belongs to the live application window and placement is initialized.
    if unsafe { GetWindowPlacement(hwnd, &mut placement) } == 0 {
        return None;
    }
    let rect = placement.rcNormalPosition;
    let maximized = match placement.showCmd as i32 {
        SW_SHOWMAXIMIZED => true,
        SW_SHOWMINIMIZED => previous.is_some_and(|old| old.maximized),
        _ => false,
    };
    let value = WindowState {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        maximized,
    };
    value.valid().then_some(value)
}

fn restore(hwnd: HWND, value: &WindowState) {
    let placement = WINDOWPLACEMENT {
        length: size_of::<WINDOWPLACEMENT>() as u32,
        // Restore the bounds while hidden. Showing here would expose the
        // default-positioned window before its saved placement is applied.
        showCmd: SW_HIDE as u32,
        rcNormalPosition: RECT {
            left: value.left,
            top: value.top,
            right: value.right,
            bottom: value.bottom,
        },
        ..Default::default()
    };
    // SAFETY: hwnd belongs to the live application window. Windows also moves a
    // completely off-screen placement onto an available monitor.
    let _ = unsafe { SetWindowPlacement(hwnd, &placement) };
}

pub fn install(window: &WebviewWindow) -> bool {
    let Ok(hwnd) = window.hwnd() else {
        return false;
    };
    let hwnd = hwnd.0 as HWND;
    let previous = load();
    let maximized = previous.as_ref().is_some_and(|value| value.maximized);
    if let Some(value) = &previous {
        restore(hwnd, value);
    }
    let latest = Arc::new(Mutex::new(capture(hwnd, previous.as_ref()).or(previous)));
    // HWND is only used while this window is alive; store its address as an
    // integer so the event callback can satisfy Tauri's Send bound.
    let handle = hwnd as isize;
    window.on_window_event(move |event| {
        let Ok(mut latest) = latest.lock() else {
            return;
        };
        match event {
            WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
                if let Some(value) = capture(handle as HWND, latest.as_ref()) {
                    *latest = Some(value);
                }
            }
            WindowEvent::CloseRequested { .. } => {
                if let Some(value) = capture(handle as HWND, latest.as_ref()) {
                    *latest = Some(value);
                }
                if let Some(value) = latest.as_ref() {
                    let _ = save(value);
                }
            }
            WindowEvent::Destroyed => {
                if let Some(value) = latest.as_ref() {
                    let _ = save(value);
                }
            }
            _ => {}
        }
    });
    maximized
}

pub fn show(window: &WebviewWindow, maximized: bool) {
    // Keep Tauri's visibility flags in sync with Win32. A direct ShowWindow
    // leaves the runtime believing this window is hidden, so minimizing it
    // later removes WS_VISIBLE and its taskbar button.
    if maximized {
        let _ = window.maximize();
    }
    let _ = window.show();
}
