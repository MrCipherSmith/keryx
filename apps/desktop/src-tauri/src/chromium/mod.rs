//! The Chromium engine of the browser panel (Phase 1 of
//! docs/requirements/desktop-browser/analysis.md): a Chrome process per
//! project window, driven over the Chrome DevTools Protocol.
//!
//! - `launch`: find Chrome, start it with a per-project profile and a debugging
//!   port on 127.0.0.1, stop it with the window.
//! - `cdp`: a CDP client over that port's WebSocket (calls, flat sessions, events).
//! - `page`: one tab: navigation, an accessibility snapshot with refs, real input,
//!   screenshots, and console and network logs.
//! - `snapshot`: the accessibility tree as the outline the agent reads.
//!
//! The panel's WebKit engine stays as the fallback (owner decision 3).

pub mod cdp;
pub mod consent;
pub mod cookies;
pub mod engine;
pub mod launch;
pub mod page;
pub mod snapshot;
pub mod tools;
