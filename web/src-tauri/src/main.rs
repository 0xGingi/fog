// The desktop app is the web client in a native window. It loads only bundled files and grants the
// page no Tauri commands (no capabilities), so it has the same powers as the web app.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default().run(tauri::generate_context!()).expect("error while running Fog");
}
