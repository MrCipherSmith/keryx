// Environment isolation shared by every CLI leg.
//
// An arm's environment is part of the measurement, not scaffolding around it.
// The grok leg established this with numbers: under the operator's real HOME
// `grok inspect` reports three global instruction files (~16,600 tokens), 27
// permissions, 74 skills, six MCP servers and ~130 tools, and the same
// four-word prompt costs 27,863 input tokens instead of 12,975. Two of those
// are disqualifying rather than noisy — `~/.claude/CLAUDE.md` carries this
// project's own routing block, so a `context-off` arm is instructed to route
// through keryx into a tree where `.metaproject/` was just deleted, and a
// GitHub code searcher makes "without keryx" mean something else entirely.
//
// The claude leg had none of it. `buildClaudeEnv` copied the whole parent
// environment and overrode a single key, so every one of those files reached
// the control arm. That is the leg the published 2026-09-05 figures came from.
//
// A copy-and-override cannot be made safe by adding keys to it, because the
// dangerous ones are the ones nobody thought of: `CLAUDE_CONFIG_DIR` alone
// relocates the whole configuration and defeats a temporary HOME alone. So the
// rule here is an allowlist — an arm gets what it is given and nothing else.

import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

/**
 * What a process needs to run at all, and nothing that steers an agent.
 *
 * Deliberately short. Anything an individual leg needs beyond this is passed
 * explicitly by that leg, so it appears in a diff and can be argued with.
 */
export const BASE_ENV_KEYS: readonly string[] = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SHELL",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TZ",
  // TLS trust, not context. A machine behind an inspecting proxy needs its extra CA
  // or every Node/Bun process fails with "unable to get local issuer certificate" —
  // which is how this was found: `curl` reached the API because it reads the system
  // keychain, and `bun` threw because it does not. A Rust-built CLI survived the
  // allowlist and a Node-built one would not have, so the failure would have looked
  // like one harness being broken rather than one variable being absent.
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
];

/**
 * Keys that must never reach an arm, asserted rather than trusted.
 *
 * The allowlist already excludes them; this exists so a future widening of the
 * allowlist fails a test instead of silently reopening the hole. Two families
 * matter most: configuration redirectors, which relocate the very files the
 * temporary HOME was created to hide, and credentials for services that can
 * reach the answer.
 */
export const FORBIDDEN_ENV_KEYS: readonly string[] = [
  "CLAUDE_CONFIG_DIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_HOST",
  "GROK_HOME",
  "KERYX_CONFIG_DIR",
];

const FORBIDDEN_ENV_PREFIXES: readonly string[] = ["MCP_", "CLAUDE_CODE_"];

/**
 * Where Claude Code reads policy that lives OUTSIDE any HOME.
 *
 * A temporary HOME does not hide it, so an arm running on a managed machine
 * would silently inherit an operator's tool policy. Absent on this machine
 * today; asserted anyway, because "it was absent when I checked" is not a
 * property of the next machine.
 */
export const MANAGED_SETTINGS_PATHS: readonly string[] = [
  "/Library/Application Support/ClaudeCode/managed-settings.json",
  "/etc/claude-code/managed-settings.json",
];

export interface IsolatedEnvRequest {
  /** The environment to draw allowed values from. */
  readonly parent: Record<string, string | undefined>;
  /** The temporary HOME this arm runs under. */
  readonly home: string;
  /** Extra keys this leg needs, e.g. a credential variable. Still an allowlist. */
  readonly allowExtra?: readonly string[];
  /** Values written after the allowlist is applied. */
  readonly overrides?: Record<string, string>;
}

/**
 * Build an arm's environment by allowlist.
 *
 * Exported so the result is asserted rather than assumed — the same reason
 * `buildClaudeArgs` is. Both arms get exactly this, so it cannot favour either.
 */
export function buildIsolatedEnv(request: IsolatedEnvRequest): Record<string, string> {
  const allowed = new Set([...BASE_ENV_KEYS, ...(request.allowExtra ?? [])]);
  const env: Record<string, string> = {};
  for (const key of allowed) {
    const value = request.parent[key];
    if (value !== undefined) env[key] = value;
  }
  env.HOME = request.home;
  for (const [key, value] of Object.entries(request.overrides ?? {})) env[key] = value;
  return env;
}

/**
 * Refuse an environment that carries a key capable of steering the arm.
 *
 * Separate from the builder so it can be run over a hand-written environment in
 * a test, and so a leg that builds its own environment cannot skip it.
 */
export function assertEnvIsolated(
  env: Record<string, string>,
  harness: string,
  /**
   * Keys this leg sets ON PURPOSE, with the value it must hold.
   *
   * The keryx leg isolates itself by pointing `XDG_DATA_HOME` at a temporary
   * directory — the same variable that, inherited, would relocate the very
   * configuration the isolation exists to hide. So the exemption is by value,
   * not by name: an inherited `XDG_DATA_HOME` still fails.
   */
  deliberate: Readonly<Record<string, string>> = {},
): void {
  const leaked = Object.keys(env).filter((key) => {
    if (deliberate[key] !== undefined && deliberate[key] === env[key]) return false;
    return FORBIDDEN_ENV_KEYS.includes(key) || FORBIDDEN_ENV_PREFIXES.some((prefix) => key.startsWith(prefix));
  });
  if (leaked.length > 0) {
    throw new Error(
      `${harness}: the arm's environment carries ${leaked.sort().join(", ")} — ` +
        "these relocate configuration or reach services that hold the answer, " +
        "so the arm's context is not the one the measurement claims",
    );
  }
}

/**
 * Refuse a machine that applies tool policy from outside HOME.
 *
 * Not a warning. A managed settings file can add or remove tools, and an arm
 * whose roster was decided elsewhere is an arm whose environment is unverified.
 */
export function assertNoManagedSettings(paths: readonly string[] = MANAGED_SETTINGS_PATHS): void {
  const present = paths.filter((candidate) => existsSync(candidate));
  if (present.length > 0) {
    throw new Error(
      `managed settings present at ${present.join(", ")} — these apply tool policy from outside HOME, ` +
        "so a temporary HOME does not isolate this machine; move or disable them before a sweep",
    );
  }
}

export interface CredentialLink {
  /** Absolute path in the real home. */
  readonly from: string;
  /** Path relative to the isolated home. */
  readonly to: string;
  /**
   * When false, a missing source is tolerated.
   *
   * macOS Claude Code keeps its credential in the Keychain, which is scoped to
   * the user and not to HOME, so there is no file to link and an isolated HOME
   * authenticates normally. On Linux the same leg reads a file. One optional
   * link covers both rather than branching on platform.
   */
  readonly required: boolean;
  /** Shown when a required link is missing. */
  readonly hint?: string;
}

export interface IsolatedHome {
  readonly home: string;
  dispose(): void;
}

/**
 * A HOME holding nothing but the credentials named.
 *
 * Linked rather than copied: a credential is not duplicated to run a benchmark.
 * Sessions, memory and logs land in the temporary home and go with it, which
 * also keeps a sweep's throwaway sessions out of the operator's own history.
 */
export function createIsolatedHome(request: {
  readonly prefix: string;
  readonly credentials?: readonly CredentialLink[];
  readonly realHome?: string;
}): IsolatedHome {
  const realHome = request.realHome ?? homedir();
  const home = mkdtempSync(path.join(tmpdir(), request.prefix));
  const dispose = (): void => rmSync(home, { recursive: true, force: true });

  for (const credential of request.credentials ?? []) {
    const source = path.isAbsolute(credential.from) ? credential.from : path.join(realHome, credential.from);
    if (!existsSync(source)) {
      if (!credential.required) continue;
      dispose();
      throw new Error(
        `no credentials at ${source} — ${credential.hint ?? "the arm cannot authenticate and would be scored as one that found nothing"}`,
      );
    }
    const target = path.join(home, credential.to);
    mkdirSync(path.dirname(target), { recursive: true });
    symlinkSync(source, target);
  }

  return { home, dispose };
}
