// Desktop entry point; the app itself lives in lib.rs (shared with iOS and Android).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    fog_app_lib::run()
}
