fn main() {
    // No commands for the page: the app calls this plugin from Rust (see the app's lib.rs).
    tauri_plugin::Builder::new(&[]).android_path("android").ios_path("ios").build();
}
