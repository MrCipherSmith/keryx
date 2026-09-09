// Best-effort verification-URL opener for device-code login.
//
// `child_process.spawn` does NOT throw when the binary is missing: it emits
// `error` later. Without a listener that is an uncaught exception and it
// tears down the TUI (headless Linux, no `xdg-open` / no DISPLAY). Opening a
// browser is optional — the overlay already shows the URL and user code.

import { spawn } from "node:child_process";

export type BrowserOpenPlan = { cmd: string; args: string[] };

export type SpawnLike = {
  on: (event: "error", listener: (err: Error) => void) => unknown;
  unref: () => void;
};

/** Decide whether/how to open a URL. `undefined` = print the URL only. */
export function browserOpenPlan(
  url: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): BrowserOpenPlan | undefined {
  if (url.length === 0) {
    return undefined;
  }
  if (platform === "darwin") {
    return { cmd: "open", args: [url] };
  }
  if (platform === "win32") {
    return { cmd: "cmd", args: ["/c", "start", "", url] };
  }
  // Linux/BSD: only when a graphical session is actually present. A headless
  // SSH box often has no `xdg-open`, and spawning it uncaught-crashes the TUI.
  if (typeof env.DISPLAY === "string" && env.DISPLAY.length > 0) {
    return { cmd: "xdg-open", args: [url] };
  }
  if (typeof env.WAYLAND_DISPLAY === "string" && env.WAYLAND_DISPLAY.length > 0) {
    return { cmd: "xdg-open", args: [url] };
  }
  return undefined;
}

export function openVerificationUrl(
  url: string,
  deps: {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    spawn?: (cmd: string, args: readonly string[], options: { stdio: "ignore"; detached: true }) => SpawnLike;
  } = {},
): void {
  const plan = browserOpenPlan(url, deps.platform ?? process.platform, deps.env ?? process.env);
  if (plan === undefined) {
    return;
  }
  const spawnFn = deps.spawn ?? spawn;
  try {
    const child = spawnFn(plan.cmd, plan.args, { stdio: "ignore", detached: true });
    child.on("error", () => {
      // ENOENT / EACCES / no handler for this URL scheme — the URL is already shown.
    });
    child.unref();
  } catch {
    // Opening a browser is best-effort.
  }
}
