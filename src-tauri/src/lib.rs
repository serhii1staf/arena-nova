// Shared entry point for desktop and mobile (Tauri v2). `main.rs` calls `run()`
// on desktop; mobile platforms call the `mobile_entry_point`-annotated `run()`.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    // The updater and process plugins only exist on desktop targets.
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());

    builder
        .setup(|_app| Ok(()))
        .run(tauri::generate_context!())
        .expect("error while running Arena Nova");
}
