// Reading and changing the rendering mode in the remote config file (flow 395). The one writer
// behind `/rendering` and the `/settings` row: it goes through `saveRemoteConfig`, so the closed
// schema and the owner-only atomic write apply, and the token file is never opened.

import { type Loaded, loadRemoteConfig, saveRemoteConfig } from "./config";
import { DEFAULT_RENDER_MODE, isRenderMode, RENDER_MODE_CHOICES, type RenderMode } from "./rendering-mode";

export interface RenderingSetting {
  mode: RenderMode;
  /** `config`: the file names it. `default`: the file does not, or there is no remote config yet. */
  source: "config" | "default";
  /** There is a remote config, so a change can be saved. */
  saveable: boolean;
}

export function readRenderingSetting(dir?: string): RenderingSetting {
  const loaded = loadRemoteConfig(dir);
  if (!loaded.ok) {
    return { mode: DEFAULT_RENDER_MODE, source: "default", saveable: false };
  }
  const mode = loaded.value.rendering;
  return mode === undefined ? { mode: DEFAULT_RENDER_MODE, source: "default", saveable: true } : { mode, source: "config", saveable: true };
}

/** Validate `raw` and save it. A refusal names the valid values and never echoes the input. */
export function writeRenderingMode(raw: string, dir?: string): Loaded<RenderMode> {
  const wanted = raw.trim().toLowerCase();
  if (!isRenderMode(wanted)) {
    return { ok: false, reason: `rendering must be ${RENDER_MODE_CHOICES}` };
  }
  const loaded = loadRemoteConfig(dir);
  if (!loaded.ok) {
    return { ok: false, reason: `remote control is not set up on this machine, so the mode cannot be saved yet (${loaded.reason})` };
  }
  const saved = saveRemoteConfig({ ...loaded.value, rendering: wanted }, dir);
  return saved.ok ? { ok: true, value: wanted } : saved;
}
