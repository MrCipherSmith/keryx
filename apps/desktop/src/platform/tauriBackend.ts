import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { Backend } from "./backend";

export const tauriBackend: Backend = {
  kind: "tauri",
  invoke: (command, args) => invoke(command, args),
  async listen(event, handler, scope = "window") {
    // Window scope: each project window owns its own keryx process.
    if (scope === "app") return listen(event, (e) => handler(e.payload as never));
    return getCurrentWebviewWindow().listen(event, (e) => handler(e.payload as never));
  },
};
