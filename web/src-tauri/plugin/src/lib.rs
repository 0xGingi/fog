//! Fog's phone-only native code (Swift in ios/, Kotlin in android/): the push notification token,
//! and on Android, offering new releases and keeping calls going in the background. Only the app's
//! Rust side calls it; the page can't.

use serde::{Deserialize, Serialize};
use tauri::plugin::{Builder, PluginHandle, TauriPlugin};
use tauri::{AppHandle, Manager, Runtime};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_fog);

struct Native<R: Runtime>(PluginHandle<R>);

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("fog")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            let handle = api.register_android_plugin("org.getfog.plugin", "FogPlugin")?;
            #[cfg(target_os = "ios")]
            let handle = api.register_ios_plugin(init_plugin_fog)?;
            app.manage(Native(handle));
            Ok(())
        })
        .build()
}

/// Where the server sends this install's pushes: "fcm" (Android), "apns" or "apns-dev" (iOS
/// release / debug builds, which Apple routes through different servers).
#[derive(Serialize)]
pub struct Token {
    pub kind: &'static str,
    pub token: String,
}

/// Ask for notification permission (the first time only) and get this install's push token.
pub async fn push_token<R: Runtime>(app: &AppHandle<R>) -> Option<Token> {
    #[derive(Deserialize)]
    struct Reply {
        token: String,
    }
    let kind = if cfg!(target_os = "android") { "fcm" } else if cfg!(debug_assertions) { "apns-dev" } else { "apns" };
    let r: Reply = app.state::<Native<R>>().0.run_mobile_plugin_async("token", ()).await.ok()?;
    Some(Token { kind, token: r.token })
}

/// A call started or ended. Android: start or stop the foreground service that keeps the microphone
/// (and camera, for video) working while Fog is in the background. iOS needs nothing here: the app's
/// background audio mode keeps the call's audio session running.
pub async fn call_active<R: Runtime>(app: &AppHandle<R>, on: bool, video: bool) {
    #[cfg(target_os = "android")]
    {
        #[derive(Serialize)]
        struct Args {
            on: bool,
            video: bool,
        }
        let _ = app.state::<Native<R>>().0.run_mobile_plugin_async::<()>("call", Args { on, video }).await;
    }
    #[cfg(not(target_os = "android"))]
    let _ = (app, on, video);
}
