// Shared entry point for desktop and mobile (Tauri v2). `main.rs` calls `run()`
// on desktop; mobile platforms call the `mobile_entry_point`-annotated `run()`.

/// Persists the player's frame-pacing choice.
///
/// Uncapping the frame rate needs Chromium flags, which can only be applied
/// before the webview is created — so the choice is stored on disk and read by
/// `main()` on the next launch. Accepted values: `"unlimited"` or `"vsync"`.
#[tauri::command]
fn set_fps_mode(mode: String) -> Result<(), String> {
    let normalised = if mode.eq_ignore_ascii_case("unlimited") {
        "unlimited"
    } else {
        "vsync"
    };

    #[cfg(target_os = "windows")]
    {
        let local = std::env::var("LOCALAPPDATA").map_err(|e| e.to_string())?;
        let dir = std::path::Path::new(&local).join("com.arenanova.app");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        std::fs::write(dir.join("fps-mode.txt"), normalised).map_err(|e| e.to_string())?;
    }

    #[cfg(not(target_os = "windows"))]
    let _ = normalised;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    // The updater and process plugins only exist on desktop targets.
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());

    builder
        .invoke_handler(tauri::generate_handler![set_fps_mode])
        .setup(|_app| Ok(()))
        .run(tauri::generate_context!())
        .expect("error while running Arena Nova");
}
