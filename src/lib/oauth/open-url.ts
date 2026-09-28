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

// S-10 (flow 355, AC6): the old win32 plan, `cmd /c start "" <url>`, spawns
// `cmd.exe` — a SHELL, which re-tokenises its whole command line. A
// `verification_uri` containing `&` ends the `start` command there and runs
// whatever follows as a second one: `https://a/?x=1&calc.exe&` opened a
// calculator. Every OTHER platform branch below spawns its opener directly
// (`spawn` with no `shell: true`), so the url is one argv entry Windows'
// `CreateProcess` passes through whole — this file's only shell was win32's.
//
// `&` is a legal RFC 3986 sub-delim and a common query separator in general,
// but this function opens exactly one shape of url — a device-code
// `verification_uri` from the hard-coded provider catalog (`catalog.ts`),
// never a caller-assembled multi-param url — so excluding it here costs
// nothing real. `ALLOWED_URL_CHARS` is deliberately a STRICTER allowlist than
// full RFC 3986: it omits `&` along with the other cmd.exe metacharacters
// (`|<>^` and the backtick) that mattered only because the shell they ran
// through is now gone.
const ALLOWED_URL_CHARS = /^[A-Za-z0-9\-._~:/?#[\]@!$'()*+,;=%]+$/;

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

/**
 * Whether `url` is safe to hand a win32 launcher: `https:` always, `http:`
 * only to loopback (a local callback listener, never a bare-HTTP catalog
 * endpoint), and no character outside {@link ALLOWED_URL_CHARS}.
 */
function isSafeVerificationUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const schemeOk = parsed.protocol === "https:" || (parsed.protocol === "http:" && isLoopbackHost(parsed.hostname));
  return schemeOk && ALLOWED_URL_CHARS.test(url);
}

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
    // Refuse rather than fall through to any opener: printing the url (the
    // overlay already shows it) is strictly safer than guessing at a launcher
    // for something that failed its own validation.
    if (!isSafeVerificationUrl(url)) {
      return undefined;
    }
    // `rundll32`, not a shell: the url is ONE argv entry a non-shell `spawn`
    // hands whole to `url.dll`'s `FileProtocolHandler`, which never re-parses
    // it as a command line the way `cmd /c start` did.
    return { cmd: "rundll32", args: ["url.dll,FileProtocolHandler", url] };
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
