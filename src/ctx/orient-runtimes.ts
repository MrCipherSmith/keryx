import {
  HARNESS_ADAPTERS,
  ORIENT_SENTINEL,
  UNSUPPORTED_ORIENT,
  installIntegration,
  surfacesOf,
  uninstallIntegration,
  type Confidence as IntegrationConfidence,
  type Settings as IntegrationSettings,
  type SettingsFileOwner,
  type SurfaceAdapter,
} from "../integrations";

const ORIENT_SURFACE_ID = "orient";

// Multi-harness registry for the graph+wiki ORIENTATION injector — the A+B
// enforcement layer (availability + freshness), distinct from the ctx guard.
// Where the guard intercepts a command (PreToolUse) and blocks, the injector
// runs at session/prompt start and ADDS a compact graph map + wiki index to the
// model's context. Only harnesses whose hooks can inject context are registered;
// harnesses with block-only hooks (e.g. Windsurf) are listed as unsupported.
//
// This module is a VIEW over `src/integrations` (flow 305, W5-a): `ORIENT_RUNTIMES`
// is BUILT by mapping over `HARNESS_ADAPTERS` + `surfacesOf(adapter,
// {subsystem:"orient"})` (flow 305 review fix, F4) — `label`/`relativePath`
// come from the surface, never a second hand-written literal — and
// `merge`/`strip`/`validate` below are the SAME function objects registered
// on the matching `SurfaceAdapter` in `src/integrations/surfaces.ts`. The
// walker logic lives once, in `src/integrations/settings-json.ts`.
//
// Verified against current official docs:
//   claude — UserPromptSubmit, stdout added as context (.claude/settings.json)
//   codex  — UserPromptSubmit, stdout added as context (.codex/hooks.json)
//   cursor — sessionStart, stdout JSON { additional_context } (.cursor/hooks.json)

export { ORIENT_SENTINEL };

export type Settings = IntegrationSettings;
export type Confidence = IntegrationConfidence;

export interface OrientRuntime {
  readonly id: string;
  readonly label: string;
  readonly confidence: Confidence;
  /** Path relative to the project root, for `SettingsFileOwner` lookup — the
   *  one true source, so nothing derives it from a second per-id switch (F8). */
  readonly relativePath: string;
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

// The injection-formatting mechanism differs per harness for a reason outside
// the registry's own concerns (it is about rendering the orientation text,
// not about the settings-file shape), so it stays a small local table keyed
// by harness id rather than a field forced onto every surface.
const FORMAT_BY_ID: Record<string, (orientation: string) => string> = {
  cursor: cursorAdditionalContext,
};

// --- runtime definitions: built from the registry's orient surfaces --------

function runtimeFromSurface(adapterId: string, surface: SurfaceAdapter): OrientRuntime {
  const relativePath = surface.relativePath!;
  return {
    id: adapterId,
    label: surface.label ?? `${relativePath} (orient)`,
    confidence: surface.confidence,
    relativePath,
    format: FORMAT_BY_ID[adapterId] ?? plainStdout,
    locate: (root) => surface.settingsFile!(root),
    merge: (s) => surface.merge!(s),
    strip: (s) => surface.strip!(s),
    validate: (s) => surface.validate!(s),
  };
}

const ORIENT_SURFACES: ReadonlyArray<{ adapterId: string; surface: SurfaceAdapter }> = HARNESS_ADAPTERS.flatMap(
  (adapter) => surfacesOf(adapter, { subsystem: "orient" }).map((surface) => ({ adapterId: adapter.id, surface })),
);

export const ORIENT_RUNTIMES: OrientRuntime[] = ORIENT_SURFACES.map(({ adapterId, surface }) =>
  runtimeFromSurface(adapterId, surface),
);

function runtimeFor(id: string): OrientRuntime {
  const runtime = ORIENT_RUNTIMES.find((r) => r.id === id);
  if (!runtime) throw new Error(`integrations registry: no orient surface registered for "${id}"`);
  return runtime;
}

// Named exports every existing caller/test imports directly, derived from the
// built list rather than declared a second time.
export const CLAUDE_ORIENT: OrientRuntime = runtimeFor("claude");
export const CODEX_ORIENT: OrientRuntime = runtimeFor("codex");
export const CURSOR_ORIENT: OrientRuntime = runtimeFor("cursor");

// Harnesses whose hooks CANNOT inject context (block-only / exit-code only), so
// the availability-injection approach does not apply.
export { UNSUPPORTED_ORIENT };

export function orientRuntimeIds(): string[] {
  return ORIENT_RUNTIMES.map((r) => r.id);
}
export function getOrientRuntime(id: string): OrientRuntime | undefined {
  return ORIENT_RUNTIMES.find((r) => r.id === id);
}
/**
 * Install the orient surface for one runtime, through the installer core
 * (flow 307, W5-b, T6: `installIntegration` in `src/integrations/installer.ts`)
 * so a re-install can never leave a ctx-guard/security surface sharing the
 * same file invalid without saying so, and so this and `keryx integrations`
 * share one implementation (and one install-state record). Returns the
 * rendered file's validation errors ([] = ok).
 */
export async function installOrientRuntime(
  projectRoot: string,
  runtimeId: string,
  ownerOverride?: SettingsFileOwner,
): Promise<string[]> {
  const runtime = getOrientRuntime(runtimeId);
  if (!runtime) return [`${runtimeId}: unknown orient runtime`];
  const { errors } = await installIntegration(projectRoot, runtimeId, {
    surfaces: [ORIENT_SURFACE_ID],
    ...(ownerOverride ? { ownerOverride } : {}),
  });
  return errors;
}

/**
 * The uninstall counterpart of `installOrientRuntime`. Throws when the owner
 * refuses (it would leave a sibling surface on the same settings file
 * invalid) — see `commands/orient.ts::handleUninstall`, which reports it.
 */
export async function uninstallOrientRuntime(
  projectRoot: string,
  runtimeId: string,
  ownerOverride?: SettingsFileOwner,
): Promise<void> {
  if (!getOrientRuntime(runtimeId)) return;
  const { errors } = await uninstallIntegration(projectRoot, runtimeId, {
    surfaces: [ORIENT_SURFACE_ID],
    ...(ownerOverride ? { ownerOverride } : {}),
  });
  if (errors.length > 0) {
    throw new Error(errors.join("; "));
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
