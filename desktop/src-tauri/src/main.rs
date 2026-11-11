// Stops an extra console window opening on Windows release builds; harmless on macOS.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    ollieos_desktop_lib::run()
}
