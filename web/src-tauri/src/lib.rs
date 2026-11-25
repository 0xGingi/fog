// Fog's native apps (desktop, iOS, Android) are the web client in a native window. They load only
// bundled files, and the page can call exactly three native commands (below): show a notification,
// set the unread count, and get the phone's push token. No other Tauri APIs are granted (no
// capabilities). On desktop, updates are handled here, outside the page: signed releases from GitHub,
// verified against the public key in tauri.conf.json before anything installs. iPhones update
// through TestFlight; the Android app offers new APKs itself (plugin/).

use tauri::AppHandle;
#[cfg(desktop)]
use tauri::Manager;
use tauri_plugin_notification::NotificationExt;

#[cfg(desktop)]
use desktop::*;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default().plugin(tauri_plugin_notification::init()).invoke_handler(tauri::generate_handler![notify, set_unread, push_token]);
    #[cfg(mobile)]
    let builder = builder
        .plugin(tauri_plugin_fog::init())
        .plugin(tauri_plugin_deep_link::init())
        .setup(|app| {
            links::watch(app.handle());
            Ok(())
        })
        .on_page_load(|webview, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Finished {
                links::deliver(webview);
            }
        });
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
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
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        });
    builder
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
    #[cfg(desktop)]
    if let Some(tray) = app.tray_by_id(TRAY) {
        if cfg!(target_os = "macos") {
            let _ = tray.set_title((count > 0).then(|| count.to_string()));
        }
        let _ = tray.set_tooltip(Some(if count > 0 { format!("Fog: {count} unread") } else { "Fog".into() }));
    }
    #[cfg(desktop)]
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_badge_count((count > 0).then_some(count as i64));
    }
    #[cfg(mobile)]
    let _ = (app, count);
}

/// Phones: this install's push token, so the server can wake it when a message arrives while Fog is
/// closed (asks for notification permission the first time). `on: false` turns push off (an empty
/// token). Desktop: nothing; it stays running in the tray instead.
#[tauri::command]
async fn push_token(app: AppHandle, on: bool) -> Option<serde_json::Value> {
    #[cfg(mobile)]
    {
        if !on {
            return Some(serde_json::json!({ "kind": "", "token": "" }));
        }
        return tauri_plugin_fog::push_token(&app).await.and_then(|t| serde_json::to_value(t).ok());
    }
    #[cfg(desktop)]
    {
        let _ = (app, on);
        None
    }
}

/// Phones: invite links (https://getfog.org/app/#add=<account id>) tapped in other apps open Fog
/// (universal links on iOS, app links on Android). The invite goes to the page as its URL fragment,
/// exactly as the link would in a browser; only a well-formed account id gets through.
#[cfg(mobile)]
mod links {
    use std::sync::Mutex;
    use tauri::{AppHandle, Manager, Url, Webview};
    use tauri_plugin_deep_link::DeepLinkExt;

    /// An invite that arrived before the page finished loading (the link launched the app).
    static PENDING: Mutex<Option<String>> = Mutex::new(None);

    pub fn watch(app: &AppHandle) {
        if let Ok(Some(urls)) = app.deep_link().get_current() {
            open(app, &urls);
        }
        let handle = app.clone();
        app.deep_link().on_open_url(move |e| open(&handle, &e.urls()));
    }

    fn open(app: &AppHandle, urls: &[Url]) {
        let Some(id) = urls.iter().find_map(invite) else { return };
        *PENDING.lock().unwrap() = Some(id.clone());
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.eval(script(&id));
        }
    }

    pub fn deliver(webview: &Webview) {
        if let Some(id) = PENDING.lock().unwrap().take() {
            let _ = webview.eval(script(&id));
        }
    }

    fn invite(url: &Url) -> Option<String> {
        let id = url.fragment()?.strip_prefix("add=")?;
        (id.len() == 43 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')).then(|| id.to_owned())
    }

    fn script(id: &str) -> String {
        format!("location.hash = '#add={id}'")
    }
}

#[cfg(desktop)]
mod desktop {
    use super::*;
    use std::time::Duration;
    use tauri::image::Image;
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    use tauri_plugin_updater::UpdaterExt;

    pub const CHECK_EVERY: Duration = Duration::from_secs(6 * 3600);
    pub const TRAY: &str = "main";

    pub fn show(app: &AppHandle) {
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.unminimize();
            let _ = w.show();
            let _ = w.set_focus();
        }
    }

    /// Menu bar icon (macOS: monochrome template, recoloured for light/dark bars) or tray icon.
    pub fn tray(app: &AppHandle) -> tauri::Result<()> {
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

    /// Download and install a newer release in the background, then offer to restart into it.
    /// Returns true once an update is installed (it applies on the next launch if you choose Later).
    pub async fn update(app: &AppHandle) -> tauri_plugin_updater::Result<bool> {
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
}
