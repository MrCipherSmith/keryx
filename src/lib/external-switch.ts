// Flow 346 — the EXTERNAL switch: `/external on|off`, `keryx external on|off`.
//
// One general control that stops keryx from sending private work (code,
// diffs, CI logs, prompts, rule text) to third-party services and models the
// operator does not trust with it — Jev/TypeSafe, some OpenRouter-hosted
// model vendors, free-tier endpoints, and anything the operator names in
// `external-providers.json` (`./external-providers.ts`).
//
// State (design §1):
//   - a user-level setting, `ShellConfig.external` (`"on" | "off"`, default
//     `"on"`) — same file (`auth.json`), same helpers (`shell-config.ts`) as
//     every other per-user toggle (`turnGuard`, `routingClassifier`).
//   - an optional per-project override, the top-level `external` key of
//     `.metaproject/tasks.config.json` — the SAME file `review.jev.*`
//     already lives in, but this key is NOT nested under `review.jev`: the
//     switch is general, not Jev-specific. The project value wins.
//
// This module is `src/lib/` (SHARED zone, `import-zones.ts`) so both a CORE
// reader (`src/review/*-config.ts`, which needs "is external on for this
// project") and a CLIENT choke point (`src/harness/decision/jev-client.ts`)
// can import it without crossing the one forbidden direction (core -> client).
import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadShellConfig, saveShellConfig, type ShellConfig } from "./shell-config";
import { pathExists, writeFileAtomic } from "./fs";

/** The tasks.config.json path every `review.jev.*` reader already uses (`src/flow/review-gate.ts`). Duplicated here rather than imported: importing `../flow/review-gate` (CORE) from this SHARED module would be the only import into this file that isn't already shared/no-op, and the path is a stable, tiny literal, not logic worth sharing at the cost of a zone edge that never needs to exist. */
export const EXTERNAL_PROJECT_CONFIG_PATH = ".metaproject/tasks.config.json";

export type ExternalSetting = "on" | "off";

/** Which layer answered `resolveExternalSetting` — for `keryx external status`/`/external`. */
export type ExternalSettingSource = "project" | "user" | "default";

export interface ResolvedExternalSetting {
  readonly value: ExternalSetting;
  readonly source: ExternalSettingSource;
}

/** Absent a project or user setting, keryx defaults to sending private work nowhere it shouldn't — i.e. the switch defaults ON (external calls allowed), matching today's pre-flow-346 behavior byte-for-byte. */
export const DEFAULT_EXTERNAL_SETTING: ExternalSetting = "on";

function normalizeExternalValue(raw: unknown): ExternalSetting | undefined {
  return raw === "on" || raw === "off" ? raw : undefined;
}

/** The per-user setting alone (`ShellConfig.external`), or `undefined` when unset/malformed. Never throws — `loadShellConfig` already isn't. */
export function readUserExternalSetting(dir?: string): ExternalSetting | undefined {
  return normalizeExternalValue((loadShellConfig(dir) as ShellConfig).external);
}

/** Persist the per-user setting. Best-effort, like every other `shell-config.ts` writer. */
export function writeUserExternalSetting(value: ExternalSetting, dir?: string): void {
  saveShellConfig({ external: value }, dir);
}

/** The project override alone (`.metaproject/tasks.config.json`'s top-level `external`), or `undefined` when absent/unparsable/unset — never throws. */
export async function readProjectExternalSetting(cwd: string): Promise<ExternalSetting | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path.join(cwd, EXTERNAL_PROJECT_CONFIG_PATH), "utf8"));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    return normalizeExternalValue((parsed as Record<string, unknown>)["external"]);
  } catch {
    return undefined;
  }
}

/**
 * Merge-write the project override, preserving every other key of
 * `tasks.config.json` untouched — same read-modify-write contract as
 * `writeJevEditGuardEnabled` (`src/review/jev-edit-guard-config.ts`): an
 * existing file that is not valid JSON is refused rather than silently
 * discarded (an unparsable `tasks.config.json` may hold real content this
 * write must not clobber).
 */
export async function writeProjectExternalSetting(cwd: string, value: ExternalSetting): Promise<void> {
  const file = path.join(cwd, EXTERNAL_PROJECT_CONFIG_PATH);
  let root: Record<string, unknown> = {};
  if (await pathExists(file)) {
    try {
      const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        root = parsed as Record<string, unknown>;
      }
    } catch {
      throw new Error(`${EXTERNAL_PROJECT_CONFIG_PATH} exists but is not valid JSON — refusing to overwrite it.`);
    }
  }
  root["external"] = value;
  await writeFileAtomic(file, `${JSON.stringify(root, null, 2)}\n`);
}

/**
 * Resolve the effective setting: project override (`.metaproject/tasks.
 * config.json`'s `external`) wins over the per-user setting, which wins over
 * the built-in default (`"on"`). Mirrors the precedence every other
 * project-vs-user keryx toggle uses (`routing.config.json` over the per-user
 * routing table, PRD §5) — the project always has the last word about what
 * ITS own work sends where.
 */
export async function resolveExternalSetting(opts?: { readonly cwd?: string; readonly dir?: string }): Promise<ResolvedExternalSetting> {
  const cwd = opts?.cwd ?? process.cwd();
  const project = await readProjectExternalSetting(cwd);
  if (project !== undefined) {
    return { value: project, source: "project" };
  }
  const user = readUserExternalSetting(opts?.dir);
  if (user !== undefined) {
    return { value: user, source: "user" };
  }
  return { value: DEFAULT_EXTERNAL_SETTING, source: "default" };
}

/**
 * Thrown by `callJevSystemOne` (AC1) and by the routing choke point (AC3)
 * before any network I/O, when `/external off` blocks the destination named
 * in `what`. Every existing Jev caller already wraps `callJevSystemOne` in a
 * generic `catch (error) { … error.message … }` fail-open handler (or, for a
 * bare CLI command that lets it propagate, `cli.ts`'s own top-level
 * `main().catch` prints only `error.message`) — so this message IS the
 * "skipped: blocked by /external" text every surface ends up showing, not a
 * stack trace, with no per-caller edit required.
 */
export class ExternalBlockedError extends Error {
  constructor(
    readonly what: string,
    readonly reason: string | undefined,
  ) {
    super(
      `skipped: blocked by /external off — ${what}${reason !== undefined && reason.length > 0 ? ` (${reason})` : ""}. ` +
        "Turn it back on with `/external on` or `keryx external on`.",
    );
    this.name = "ExternalBlockedError";
  }
}
