// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/// Configures the embedded browser engine before the webview is created.
///
/// By default a WebView2/Chromium webview paces `requestAnimationFrame` to the
/// display's refresh rate, which caps the game at the monitor's Hz no matter how
/// much headroom the GPU has. Passing these Chromium flags removes that cap so
/// the native build can push well past the refresh rate — lower input latency and
/// a much higher reported frame rate.
///
/// Trade-off: without vsync you can get screen tearing. Set `ARENA_NOVA_VSYNC=1`
/// before launching to keep the frame rate locked to the display instead.
#[cfg(target_os = "windows")]
fn configure_webview_flags() {
    if std::env::var("ARENA_NOVA_VSYNC").is_ok() {
        return; // player opted back into vsync
    }

    let mut args = String::from("--disable-gpu-vsync --disable-frame-rate-limit");

    // Respect any flags the environment already set instead of clobbering them.
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
