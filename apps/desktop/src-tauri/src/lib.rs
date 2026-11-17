pub mod bridge;
pub mod framing;
pub mod flows;
pub mod fs;
pub mod locator;
pub mod process;
pub mod settings;
pub mod shellenv;
pub mod version;

use tauri::{Manager, RunEvent, WindowEvent};

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(bridge::AppState::default())
        .manage(flows::watch::FlowWatchers::default())
        .setup(|app| {
            // Capture the login-shell environment in the background so the
            // first project window does not wait for it.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let _ = handle.state::<bridge::AppState>().environment();
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::Destroyed = event {
                // Never wait out the stop grace period on the event loop.
                window.app_handle().state::<bridge::AppState>().window_destroyed(window.label());
                window.app_handle().state::<flows::watch::FlowWatchers>().stop_window(window.label());
            }
        })
        .invoke_handler(tauri::generate_handler![
            bridge::acp_start,
            bridge::acp_send,
            bridge::acp_stop,
            bridge::settings_get,
            bridge::settings_set,
            bridge::settings_add_recent,
            bridge::version_check,
            bridge::window_open_project,
            bridge::window_initial_cwd,
            flows::flows_list,
            flows::flows_get,
            flows::flows_action,
            flows::flows_watch,
        ])
        .build(tauri::generate_context!())
        .expect("error while building the Keryx app");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            handle.state::<bridge::AppState>().stop_all();
        }
    });
}
