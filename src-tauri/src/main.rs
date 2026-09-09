// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/// Path of the small preference file the game writes when the player picks an
/// FPS mode. Chromium flags can only be set before the webview exists, so the
/// choice has to be read from disk at startup rather than from the page.
#[cfg(target_os = "windows")]
fn fps_pref_path() -> Option<std::path::PathBuf> {
    let local = std::env::var("LOCALAPPDATA").ok()?;
    Some(
        std::path::Path::new(&local)
            .join("com.arenanova.app")
            .join("fps-mode.txt"),
    )
}

/// Configures the embedded browser engine before the webview is created.
///
/// By default we leave vsync alone: the display can only ever show frames at its
/// refresh rate, and rendering hundreds of extra frames just saturates the GPU,
/// which makes frame delivery uneven and *feels* worse despite a big FPS number.
///
/// Players who want an uncapped frame rate anyway (lower input latency, at the
/// cost of possible tearing) can select "Unlimited" in the settings, which writes
/// `unlimited` to the preference file read here. `ARENA_NOVA_UNCAP=1` forces it.
#[cfg(target_os = "windows")]
fn configure_webview_flags() {
    let forced = std::env::var("ARENA_NOVA_UNCAP").is_ok();
    let opted_in = fps_pref_path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|s| s.trim().eq_ignore_ascii_case("unlimited"))
        .unwrap_or(false);

    if !forced && !opted_in {
        return;
    }

    let mut args = String::from("--disable-gpu-vsync --disable-frame-rate-limit");
    if let Ok(existing) = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS") {
        if !existing.trim().is_empty() {
            args.push(' ');
            args.push_str(&existing);
        }
    }
    std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", args);
}

#[cfg(not(target_os = "windows"))]
fn configure_webview_flags() {}

fn main() {
    configure_webview_flags();
    arena_nova_lib::run()
}
