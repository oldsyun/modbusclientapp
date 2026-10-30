// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/**
 * src-tauri/src/main.rs — Tauri 壳
 *
 * 业务全在前端 webview（MQTT over WebSocket + 协议层 + UI），
 * Rust 侧只负责开窗口，不碰任何协议逻辑 —— 这样三平台行为一致、体积最小。
 */
fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
