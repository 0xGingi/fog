// The desktop app is the web client in a native window. It loads only bundled files, and the page can
// call exactly two native commands (below): show a notification, and set the unread count. No other
// Tauri APIs are granted (no capabilities). Updates are handled here, outside the page: signed
// releases from GitHub, verified against the public key in tauri.conf.json before anything installs.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::time::Duration;
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_updater::UpdaterExt;

const CHECK_EVERY: Duration = Duration::from_secs(6 * 3600);
const TRAY: &str = "main";

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![notify, set_unread])
        .setup(|app| {
            tray(app.handle())?;
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    // Offline or a failed check: try again next time.
                    if let Ok(true) = update(&handle).await {
                        break;
                    }
                    tokio::time::sleep(CHECK_EVERY).await;
                }
            });
            Ok(())
        })
        // Closing the window keeps Fog running in the menu bar / tray, like Telegram: messages and
        // calls keep arriving. Quit from the tray menu (or Cmd+Q on macOS).
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Fog")
        .run(|_app, _event| {
            // macOS: clicking the Dock icon brings the window back. (Reopen exists only on macOS.)
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = _event {
                show(_app);
            }
        });
}

fn show(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Menu bar icon (macOS: monochrome template, recoloured for light/dark bars) or tray icon.
fn tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Fog", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Fog", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &PredefinedMenuItem::separator(app)?, &quit])?;
    let icon = if cfg!(target_os = "macos") { Image::from_bytes(include_bytes!("../icons/tray-template@2x.png"))? } else { app.default_window_icon().cloned().expect("app icon") };
    TrayIconBuilder::with_id(TRAY)
        .icon(icon)
        .icon_as_template(cfg!(target_os = "macos"))
        .tooltip("Fog")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, e| match e.id().as_ref() {
            "open" => show(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, e| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                show(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

/// A native notification for a new message. The page decides what's shown (it can hide previews).
#[tauri::command]
fn notify(app: AppHandle, title: String, body: String) {
    let clip = |s: String, n: usize| s.chars().filter(|c| !c.is_control()).take(n).collect::<String>();
    let _ = app.notification().builder().title(clip(title, 80)).body(clip(body, 240)).show();
}

/// Unread count: next to the menu bar icon and on the Dock icon (macOS), in the tray tooltip elsewhere.
#[tauri::command]
fn set_unread(app: AppHandle, count: u32) {
    let count = count.min(99_999);
    if let Some(tray) = app.tray_by_id(TRAY) {
        if cfg!(target_os = "macos") {
            let _ = tray.set_title((count > 0).then(|| count.to_string()));
        }
        let _ = tray.set_tooltip(Some(if count > 0 { format!("Fog: {count} unread") } else { "Fog".into() }));
    }
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_badge_count((count > 0).then_some(count as i64));
    }
}

/// Download and install a newer release in the background, then offer to restart into it.
/// Returns true once an update is installed (it applies on the next launch if you choose Later).
async fn update(app: &AppHandle) -> tauri_plugin_updater::Result<bool> {
    let Some(update) = app.updater()?.check().await? else { return Ok(false) };
    update.download_and_install(|_, _| {}, || {}).await?;
    // Hidden in the menu bar: don't pop up; it applies the next time Fog starts.
    let Some(window) = app.get_webview_window("main").filter(|w| w.is_visible().unwrap_or(false)) else { return Ok(true) };
    let handle = app.clone();
    app.dialog()
        .message(format!("Fog {} is installed. Restart now to start using it?", update.version))
        .title("Update ready")
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom("Restart now".into(), "Later".into()))
        .parent(&window)
        .show(move |restart| {
            if restart {
                handle.restart();
            }
        });
    Ok(true)
}
