pub mod appupdate;
pub mod bridge;
pub mod browser;
pub mod child;
pub mod framing;
pub mod flows;
pub mod fs;
pub mod gitinfo;
pub mod locator;
pub mod navigation;
pub mod panel_mcp;
pub mod panels;
pub mod process;
pub mod projects;
pub mod pullrequest;
pub mod pty;
pub mod settings;
pub mod shellenv;
pub mod version;
pub mod webkit;

use tauri::menu::{Menu, MenuItem, Submenu};
use tauri::{Emitter, Manager, RunEvent, WindowEvent};

const PANEL_MENU_PALETTE: &str = "panel-palette";
const PANEL_MENU_TERMINAL: &str = "panel-terminal";
const PANEL_MENU_BROWSER: &str = "panel-browser";

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(bridge::AppState::default())
        .manage(flows::watch::FlowWatchers::default())
        .manage(pty::PtyManager::default())
        .manage(panels::PanelRoots::default())
        .manage(browser::Browsers::default())
        .manage(panel_mcp::PanelMcp::default())
        .manage(projects::ProjectWindows::default())
        .setup(|app| {
            // The main window is declared in tauri.conf.json with `create: false`
            // and built here as a bare host window with one project view (the
            // welcome screen), like every other window (see `projects`).
            let handle = app.handle();
            projects::create_main_window(handle)?;

            // Panel shortcuts as menu key equivalents: they also fire while a browser tab of the side
            // panel has the keyboard, where the app page's own key handler never sees the keys.
            let menu = Menu::default(handle)?;
            let panels = Submenu::with_items(
                handle,
                "Panels",
                true,
                &[
                    &MenuItem::with_id(handle, PANEL_MENU_PALETTE, "Commands…", true, Some("CmdOrCtrl+K"))?,
                    &MenuItem::with_id(handle, PANEL_MENU_TERMINAL, "Terminal", true, Some("Ctrl+`"))?,
                    &MenuItem::with_id(handle, PANEL_MENU_BROWSER, "Browser", true, Some("CmdOrCtrl+Shift+B"))?,
                ],
            )?;
            menu.append(&panels)?;
            app.set_menu(menu)?;

            // Capture the login-shell environment in the background so the
            // first project window does not wait for it.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let _ = handle.state::<bridge::AppState>().environment();
            });
            Ok(())
        })
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            if ![PANEL_MENU_PALETTE, PANEL_MENU_TERMINAL, PANEL_MENU_BROWSER].contains(&id) {
                return;
            }
            // To the project in front of the focused window: the others of that window are hidden.
            let focused = app.windows().into_values().find(|w| w.is_focused().unwrap_or(false));
            let front = focused.and_then(|w| app.state::<projects::ProjectWindows>().front_of(w.label()));
            if let Some(view) = front {
                let _ = app.emit_to(view.as_str(), "menu://panel", id.trim_start_matches("panel-"));
            }
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // Only the project in front closes while the window holds another one.
                projects::on_close_requested(window.app_handle(), window, api);
            }
            if let WindowEvent::Destroyed = event {
                projects::on_window_destroyed(window.app_handle(), window.label());
            }
        })
        .invoke_handler(tauri::generate_handler![
            bridge::acp_start,
            bridge::acp_send,
            bridge::acp_stop,
            settings::settings_get,
            settings::settings_set,
            settings::settings_add_recent,
            bridge::version_check,
            bridge::window_open_project,
            bridge::window_initial_cwd,
            projects::project_register,
            projects::project_activity,
            projects::project_switch,
            projects::project_title,
            projects::projects_state,
            flows::flows_list,
            flows::flows_get,
            flows::flows_action,
            flows::flows_watch,
            gitinfo::git_info,
            pullrequest::pr_info,
            panels::pty_open,
            panels::pty_open_run,
            panels::pty_attach,
            panels::pty_write,
            panels::pty_resize,
            panels::pty_close,
            panels::pty_list,
            browser::browser_open,
            browser::browser_navigate,
            browser::browser_go,
            browser::browser_close,
            browser::browser_select,
            browser::browser_layout,
            browser::browser_list,
            panel_mcp::panel_mcp_entry,
            appupdate::app_update_check,
            appupdate::app_update_run,
        ])
        .build(tauri::generate_context!())
        .expect("error while building the Keryx app");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            handle.state::<pty::PtyManager>().close_all();
            let _ = std::fs::remove_file(std::env::temp_dir().join(format!("keryx-panels-{}.sock", std::process::id())));
            handle.state::<bridge::AppState>().stop_all();
        }
    });
}
