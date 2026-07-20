// macOS Seatbelt launcher builder (flow 093, T2).
//
// Pure: builds the `sandbox-exec` profile text (.sb SBPL) and the wrapped argv
// for a workspace-write / read-only OS sandbox. No spawning, no fs, no clock.
//
// v1 posture — ALLOW-DEFAULT + TARGETED-DENY (not deny-default): far less
// brittle for real toolchains (dyld, /usr, temp caches) while still enforcing
// the two boundaries that matter — no writes outside the workspace roots, and no
// network when the profile says network:off. Deny-default Seatbelt profiles à la
// Codex are a later hardening pass; this is validated on real macOS by the
// flag-gated live smoke (T7). `danger-full-access` never reaches this module —
// the wrap dispatcher skips containment for it.
//
// Seatbelt evaluates rules top-to-bottom, LAST match wins, so "deny all writes"
// followed by "allow <roots>" yields writes only under the roots.

import type { ContainedCommand } from "../executor";
import type { SandboxProfile } from "./profile";

/** Absolute path to the macOS sandbox launcher. */
export const SANDBOX_EXEC_PATH = "/usr/bin/sandbox-exec";

/** Character-literal escape for an SBPL string token. */
function sbplString(value: string): string {
  // SBPL string literals are double-quoted; backslash and quote must be escaped.
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** stdio / tty device writes every shell tool needs even under a write-deny. */
const DEVICE_WRITE_LITERALS = [
  "/dev/null",
  "/dev/zero",
  "/dev/stdin",
  "/dev/stdout",
  "/dev/stderr",
  "/dev/tty",
  "/dev/dtracehelper",
  "/dev/random",
  "/dev/urandom",
];

/**
 * Build the Seatbelt (.sb) profile text for `profile`. Allow-default, then:
 *   - deny all writes, re-allow writable roots + stdio devices;
 *   - deny reads of the secret deny-list;
 *   - deny all network when `profile.network === "off"`.
 */
export function buildSeatbeltProfile(profile: SandboxProfile): string {
  const lines: string[] = [
    "(version 1)",
    "(allow default)",
    "",
    ";; --- filesystem writes: deny everything, then re-allow workspace roots ---",
    "(deny file-write* (subpath \"/\"))",
  ];

  for (const root of profile.writableRoots) {
    lines.push(`(allow file-write* (subpath ${sbplString(root)}))`);
  }

  // stdio/tty devices must stay writable regardless of mode.
  lines.push(
    `(allow file-write-data ${DEVICE_WRITE_LITERALS.map((d) => `(literal ${sbplString(d)})`).join(" ")})`,
  );

  if (profile.readDenyList.length > 0) {
    lines.push("", ";; --- secret read-deny ---");
    for (const secret of profile.readDenyList) {
      lines.push(`(deny file-read* (subpath ${sbplString(secret)}))`);
    }
  }

  if (profile.network === "off") {
    lines.push("", ";; --- network off ---", "(deny network*)");
  } else if (profile.network === "restricted") {
    // Deny all network, then re-allow ONLY the loopback allowlist proxy socket.
    // Without a proxy address the profile denies all network (fail-safe).
    lines.push("", ";; --- network restricted to loopback allowlist proxy ---", "(deny network*)");
    if (profile.proxy) {
      // Seatbelt's `remote ip` host must be `*` or `localhost` (a literal IP is a
      // parse error), so the loopback proxy is allowed via `localhost:<port>`.
      lines.push(`(allow network-outbound (remote ip ${sbplString(`localhost:${profile.proxy.port}`)}))`);
    }
  }

  return `${lines.join("\n")}\n`;
}

/**
 * Wrap a contained command under `sandbox-exec -p <profile> <cmd> [args...]`.
 * `env`/`cwd` are preserved; `argv[0]` stays the launcher name by convention
 * (RealProcessAdapter runs `spawnSync(path, argv.slice(1))`).
 */
export function wrapSeatbelt(command: ContainedCommand, profile: SandboxProfile): ContainedCommand {
  const profileText = buildSeatbeltProfile(profile);
  return {
    path: SANDBOX_EXEC_PATH,
    argv: ["sandbox-exec", "-p", profileText, command.path, ...command.argv.slice(1)],
    env: command.env,
    cwd: command.cwd,
  };
}
