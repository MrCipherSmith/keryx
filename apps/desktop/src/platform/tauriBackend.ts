import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { Backend } from "./backend";

export const tauriBackend: Backend = {
  kind: "tauri",
  invoke: (command, args) => invoke(command, args),
  async listen(event, handler, scope = "window") {
    // Window scope: each project view owns its own keryx process. Several project views share
    // one host window, so this listens on the view (the host emits to its label), not the window.
    if (scope === "app") return listen(event, (e) => handler(e.payload as never));
    return getCurrentWebview().listen(event, (e) => handler(e.payload as never));
  },
};
