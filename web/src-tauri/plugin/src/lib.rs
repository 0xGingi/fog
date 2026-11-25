//! Fog's phone-only native code (Swift in ios/, Kotlin in android/): the push notification token,
//! and on Android, offering new releases. Only the app's Rust side calls it; the page can't.

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
