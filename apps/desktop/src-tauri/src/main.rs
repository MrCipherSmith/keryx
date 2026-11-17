// Prevents an extra console window on Windows in release; harmless on macOS.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Started by keryx as the side panel's MCP server (D-13): relay, no window.
    #[cfg(unix)]
    if std::env::args().nth(1).as_deref() == Some("--panel-mcp") {
        std::process::exit(keryx_desktop_lib::panel_mcp::relay());
    }
    keryx_desktop_lib::run()
}
