pub mod appupdate;
pub mod bridge;
pub mod browser;
pub mod child;
pub mod chromium;
pub mod framing;
pub mod flows;
pub mod files;
pub mod fs;
pub mod images;
pub mod gitinfo;
pub mod issues;
pub mod locator;
pub mod metaproject;
pub mod navigation;
pub mod panel_mcp;
pub mod panels;
pub mod process;
pub mod projects;
pub mod pullrequest;
pub mod review;
pub mod pty;
pub mod settings;
pub mod telegram_serve;
pub mod telegram_channel;
pub mod shellenv;
mod slots;
pub mod version;
pub mod webkit;

use tauri::menu::{Menu, MenuItem, Submenu};
use tauri::{Emitter, Manager, RunEvent, WindowEvent};

const PANEL_MENU_PALETTE: &str = "panel-palette";
const PANEL_MENU_TERMINAL: &str = "panel-terminal";
const PANEL_MENU_BROWSER: &str = "panel-browser";

pub fn run() {
    // An import interrupted by a crash leaves a private copy of Chrome's cookie database behind.
    chromium::cookies::remove_stale_copies();
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(bridge::AppState::default())
        .manage(std::sync::Arc::new(telegram_serve::TelegramServe::default()))
        .manage(issues::IssueTransfers::default())
        .manage(flows::watch::FlowWatchers::default())
        .manage(pty::PtyManager::default())
        .manage(panels::PanelRoots::default())
        .manage(images::ChatImages::default())
        .manage(browser::Browsers::default())
        .manage(chromium::engine::Engines::default())
        .manage(chromium::consent::Consents::default())
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
            telegram_channel::telegram_channel_status,
            telegram_channel::telegram_channel_action,
            telegram_serve::telegram_serve_status,
            telegram_serve::telegram_serve_start,
            telegram_serve::telegram_serve_stop,
            telegram_serve::telegram_serve_restart,
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
            gitinfo::git_repository,
            files::project_files,
            files::project_file_read,
            gitinfo::git_changes,
            gitinfo::git_file_diff,
            pullrequest::pr_info,
            review::github_accounts,
            review::github_login,
            metaproject::metaproject_request,
            issues::issues_request,
            issues::issues_transfer,
            issues::issues_take_transfer,
            review::review_board,
            review::review_run,
            review::review_publish,
            review::review_watcher,
            review::review_rules,
            panels::pty_open,
            panels::pty_open_run,
            panels::pty_attach,
            panels::pty_write,
            panels::pty_resize,
            panels::pty_close,
            panels::pty_list,
            browser::browser_open,
            browser::browser_navigate,
            browser::browser_pick,
            browser::browser_pick_cancel,
            browser::browser_go,
            browser::browser_close,
            browser::browser_select,
            browser::browser_layout,
            browser::browser_list,
            browser::browser_engine,
            browser::browser_frames,
            browser::browser_frame,
            browser::browser_input,
            images::local_image,
            images::save_chat_image,
            images::save_chat_file,
            images::discard_chat_attachment,
            images::commit_chat_attachments,
            chromium::consent::browser_consent_answer,
            chromium::cookies::cookie_profiles,
            chromium::cookies::cookie_scan,
            chromium::cookies::cookie_import,
            panel_mcp::panel_mcp_entry,
            appupdate::app_update_check,
            appupdate::app_update_run,
        ])
        .build(tauri::generate_context!())
        .expect("error while building the Keryx app");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            handle.state::<std::sync::Arc<telegram_serve::TelegramServe>>().shutdown();
            handle.state::<pty::PtyManager>().close_all();
            chromium::engine::close_all(handle);
            let _ = std::fs::remove_file(std::env::temp_dir().join(format!("keryx-panels-{}.sock", std::process::id())));
            handle.state::<bridge::AppState>().stop_all();
            handle.state::<images::ChatImages>().clear();
        }
    });
}
