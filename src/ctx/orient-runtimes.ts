import {
  ORIENT_CLAUDE,
  ORIENT_CODEX,
  ORIENT_CURSOR,
  ORIENT_SENTINEL,
  UNSUPPORTED_ORIENT,
  installSurfaces,
  settingsFileOwnerFor,
  uninstallSurfaces,
  type Settings as IntegrationSettings,
} from "../integrations";

const ORIENT_SURFACE_ID = "orient";

// Multi-harness registry for the graph+wiki ORIENTATION injector — the A+B
// enforcement layer (availability + freshness), distinct from the ctx guard.
// Where the guard intercepts a command (PreToolUse) and blocks, the injector
// runs at session/prompt start and ADDS a compact graph map + wiki index to the
// model's context. Only harnesses whose hooks can inject context are registered;
// harnesses with block-only hooks (e.g. Windsurf) are listed as unsupported.
//
// This module is a VIEW over `src/integrations` (flow 305, W5-a): `merge` /
// `strip` / `validate` below are the SAME function objects registered on the
// matching `SurfaceAdapter` in `src/integrations/surfaces.ts` — the walker
// logic lives once, in `src/integrations/settings-json.ts`.
//
// Verified against current official docs:
//   claude — UserPromptSubmit, stdout added as context (.claude/settings.json)
//   codex  — UserPromptSubmit, stdout added as context (.codex/hooks.json)
//   cursor — sessionStart, stdout JSON { additional_context } (.cursor/hooks.json)

export { ORIENT_SENTINEL };

export type Settings = IntegrationSettings;
export type Confidence = "verified" | "experimental";

export interface OrientRuntime {
  readonly id: string;
  readonly label: string;
  readonly confidence: Confidence;
  // Format the orientation Markdown for this harness's injection mechanism.
  format(orientation: string): string;
  locate(projectRoot: string): string;
  merge(settings: Settings): Settings;
  strip(settings: Settings): Settings;
  validate(settings: Settings): string[];
}

// --- formatting mechanisms ---------------------------------------------------

// Claude / Codex: plain stdout from the hook is added to context verbatim.
function plainStdout(orientation: string): string {
  return orientation;
}
// Cursor sessionStart: stdout JSON with the documented `additional_context` field.
function cursorAdditionalContext(orientation: string): string {
  return JSON.stringify({ additional_context: orientation });
}

// --- runtime definitions: shaped views over the registry's orient surfaces --

export const CLAUDE_ORIENT: OrientRuntime = {
  id: "claude",
  label: ".claude/settings.json (UserPromptSubmit)",
  confidence: "verified",
  format: plainStdout,
  locate: (root) => ORIENT_CLAUDE.settingsFile!(root),
  merge: (s) => ORIENT_CLAUDE.merge!(s),
  strip: (s) => ORIENT_CLAUDE.strip!(s),
  validate: (s) => ORIENT_CLAUDE.validate!(s),
};

export const CODEX_ORIENT: OrientRuntime = {
  id: "codex",
  label: ".codex/hooks.json (UserPromptSubmit)",
  confidence: "verified",
  format: plainStdout,
  locate: (root) => ORIENT_CODEX.settingsFile!(root),
  merge: (s) => ORIENT_CODEX.merge!(s),
  strip: (s) => ORIENT_CODEX.strip!(s),
  validate: (s) => ORIENT_CODEX.validate!(s),
};

export const CURSOR_ORIENT: OrientRuntime = {
  id: "cursor",
  label: ".cursor/hooks.json (sessionStart)",
  confidence: "verified",
  format: cursorAdditionalContext,
  locate: (root) => ORIENT_CURSOR.settingsFile!(root),
  merge: (s) => ORIENT_CURSOR.merge!(s),
  strip: (s) => ORIENT_CURSOR.strip!(s),
  validate: (s) => ORIENT_CURSOR.validate!(s),
};

// Harnesses whose hooks CANNOT inject context (block-only / exit-code only), so
// the availability-injection approach does not apply.
export { UNSUPPORTED_ORIENT };

export const ORIENT_RUNTIMES: OrientRuntime[] = [CLAUDE_ORIENT, CODEX_ORIENT, CURSOR_ORIENT];

export function orientRuntimeIds(): string[] {
  return ORIENT_RUNTIMES.map((r) => r.id);
}
export function getOrientRuntime(id: string): OrientRuntime | undefined {
  return ORIENT_RUNTIMES.find((r) => r.id === id);
}
/**
 * Install the orient surface for one runtime through its `SettingsFileOwner`
 * (`src/integrations/settings-file.ts`), so a re-install can never leave a
 * ctx-guard/security surface sharing the same file invalid without saying so.
 * Returns the rendered file's validation errors ([] = ok).
 */
export async function installOrientRuntime(projectRoot: string, runtimeId: string): Promise<string[]> {
  const runtime = getOrientRuntime(runtimeId);
  if (!runtime) return [`${runtimeId}: unknown orient runtime`];
  const relativePath = relativePathFor(runtime);
  const owner = settingsFileOwnerFor(relativePath);
  if (!owner) return [`${runtimeId}: no settings-file owner registered for ${relativePath}`];
  const { errors } = await installSurfaces(projectRoot, relativePath, [ORIENT_SURFACE_ID], owner);
  return errors;
}

/** The uninstall counterpart of `installOrientRuntime`. */
export async function uninstallOrientRuntime(projectRoot: string, runtimeId: string): Promise<void> {
  const runtime = getOrientRuntime(runtimeId);
  if (!runtime) return;
  const relativePath = relativePathFor(runtime);
  const owner = settingsFileOwnerFor(relativePath);
  if (!owner) return;
  await uninstallSurfaces(projectRoot, relativePath, [ORIENT_SURFACE_ID], owner);
}

function relativePathFor(runtime: OrientRuntime): string {
  switch (runtime.id) {
    case "claude":
      return ".claude/settings.json";
    case "codex":
      return ".codex/hooks.json";
    case "cursor":
      return ".cursor/hooks.json";
    default:
      return runtime.locate("");
  }
}

export function resolveOrientRuntimes(ids: string[]): {
  runtimes: OrientRuntime[];
  unknown: string[];
  unsupported: string[];
} {
  const wanted = ids.includes("all") ? orientRuntimeIds() : ids;
  const runtimes: OrientRuntime[] = [];
  const unknown: string[] = [];
  const unsupported: string[] = [];
  for (const id of wanted) {
    const r = getOrientRuntime(id);
    if (r) runtimes.push(r);
    else if (UNSUPPORTED_ORIENT[id]) unsupported.push(id);
    else unknown.push(id);
  }
  return { runtimes, unknown, unsupported };
}
