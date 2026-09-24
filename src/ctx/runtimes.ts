import { buildBlockMessage, classifyCommand, type HookClassification } from "./hook-classify";
import {
  CTX_HOOK_SENTINEL,
  HARNESS_ADAPTERS,
  MANAGED_KEY,
  UNSUPPORTED_CTX_GUARD,
  allowAction,
  ctxHookCommand,
  managedGroups,
  parseToolName,
  preToolUseMatcher as registryPreToolUseMatcher,
  refusalAction,
  surfacesOf,
  type Confidence as IntegrationConfidence,
  type DecisionCodec,
  type HarnessAdapter,
  type HookAction,
  type Settings as IntegrationSettings,
  type SurfaceAdapter,
} from "../integrations";

// Multi-harness registry for the gdctx routing guard. This module is a VIEW
// over `src/integrations` (flow 305, W5-a): `CTX_RUNTIMES` below is BUILT by
// mapping over `HARNESS_ADAPTERS` + `surfacesOf(adapter, {subsystem:
// "ctx-guard"})` (flow 305 review fix, F4) rather than a second hand-written
// per-runtime literal list — every per-harness fact (confidence, label,
// paths, group shape/key/container, native search tools, payload codec) lives
// on the `SurfaceAdapter` in `src/integrations/surfaces.ts` (the decision
// codec lives one level up, on the `HarnessAdapter` itself — R3-F1), and
// every merge/strip/validate function below is the SAME function object
// registered there. There is exactly one
// copy of the walker logic (`src/integrations/settings-json.ts`) and exactly
// one copy of the per-runtime facts; this file only re-shapes them into the
// `CtxRuntime` interface every existing caller and test already imports.
//
// What differs per harness is only:
//   1. WHERE the pre-exec hook is configured (settings path + schema),
//   2. HOW the harness hands the command to the hook (payload format),
//   3. HOW the hook signals BLOCK vs ALLOW back to the harness,
//   4. WHAT install artifact is written (a JSON config group, or a plugin file).
//
// Contracts confirmed against first-party docs are `confidence: "verified"`;
// those from community docs are `confidence: "experimental"` and print a
// warning at install time. Harnesses with no scriptable pre-exec gate (e.g.
// Zed today) are NOT registered.
//
// Sentinel discipline: managed JSON groups carry `_keryxManaged:"ctx-agent-hooks"`
// so uninstall removes ONLY our entry and re-install is idempotent.

export { CTX_HOOK_SENTINEL, MANAGED_KEY };

export type Settings = IntegrationSettings;
export type { HookAction };
export type Confidence = IntegrationConfidence;

/** How a runtime spells an installed hook — see `CtxRuntime.groupShape`. */
export type GroupShape = "flat" | "nested";

export interface CtxRuntime {
  readonly id: string;
  readonly label: string;
  readonly confidence: Confidence;
  parseCommand(payload: string): string | null;
  readonly nativeSearchTools?: readonly string[];
  readonly groupShape: GroupShape;
  readonly groupKey: string;
  readonly groupContainer?: string;
  /** Path relative to the project root, for `SettingsFileOwner` lookup. Absent for non-JSON artifacts. */
  readonly relativePath?: string;
  block(command: string, classification: HookClassification): HookAction;
  allow(classification: HookClassification): HookAction;
  locate(projectRoot: string): string;
  merge?(settings: Settings): Settings;
  strip?(settings: Settings): Settings;
  validate?(settings: Settings): string[];
  customInstall?(projectRoot: string): Promise<string[]>;
  customUninstall?(projectRoot: string): Promise<boolean>;
}

/** The matcher a runtime installs: the shell, plus its own native search tools. */
export function preToolUseMatcher(runtime: Pick<CtxRuntime, "nativeSearchTools">): string {
  return registryPreToolUseMatcher(runtime.nativeSearchTools);
}

/**
 * What an install would REPLACE, read before the merge — or null if nothing
 * stale is there. See `src/integrations/settings-json.ts::managedGroups` for
 * the shared presence/staleness walker this is built from.
 */
export function describeExistingGuard(settings: Settings, runtime: CtxRuntime): string | null {
  const expected = preToolUseMatcher(runtime);
  const present = managedGroups(settings, {
    sentinel: CTX_HOOK_SENTINEL,
    container: runtime.groupContainer ?? "hooks",
    key: runtime.groupKey,
    shape: runtime.groupShape,
    commandMatches: (c) => c === ctxHookCommand(runtime.id),
  });
  if (present.length === 0) return null;
  const stale = present.some((g) => typeof g.matcher !== "string" || g.matcher !== expected);
  if (!stale) return null;
  const found = present.map((group) => (typeof group.matcher === "string" ? group.matcher : "(no matcher)")).join(", ");
  return `upgraded an existing guard: ${found} -> ${expected}`;
}

/**
 * Refusal for a native search tool. It names the replacement rather than only
 * denying, and it is escapable in practice even though it carries no in-line
 * marker of its own: `keryx ctx rg` does the same job, and a Bash command with
 * `# keryx:raw <reason>` remains available for anything raw.
 */
export function nativeSearchMessage(tool: string): string {
  return [
    `[keryx ctx] The \`${tool}\` tool searches project code without the gdctx routing layer.`,
    `Use instead:  keryx ctx rg "<pattern>" [path]`,
    `The routed form is compressed and recorded in the routing audit (ctx_used).`,
    `Structural question (callers, usages, blast radius)? Use gdgraph first.`,
    `If raw output is genuinely required, run it through Bash with an escape marker:`,
    `  rg "<pattern>" <path>   # keryx:raw <why raw is needed>`,
  ].join("\n");
}

export { parseToolName, refusalAction, allowAction };

// --- runtime definitions: built from the registry's ctx-guard surfaces ------
//
// One `CtxRuntime` per (adapter, ctx-guard surface) pair. A surface's `id` is
// only unique WITHIN its own adapter (every JSON ctx-guard surface uses the
// shared id `"ctx-guard"`), so the runtime's own `id` — the harness id every
// caller keys off — comes from the adapter, never the surface. The decision
// codec (R3-F1) comes from the adapter too — `HarnessAdapter.decisionCodec` is
// now the ONLY decision codec in the registry, so there is nothing on the
// surface itself to read or fall back to.
function runtimeFromSurface(adapterId: string, surface: SurfaceAdapter, decisionCodec: DecisionCodec): CtxRuntime {
  return {
    id: adapterId,
    label: surface.label ?? adapterId,
    confidence: surface.confidence,
    groupShape: surface.groupShape ?? "nested",
    groupKey: surface.groupKey ?? "",
    ...(surface.groupContainer !== undefined ? { groupContainer: surface.groupContainer } : {}),
    ...(surface.relativePath !== undefined ? { relativePath: surface.relativePath } : {}),
    ...(surface.nativeSearchTools !== undefined ? { nativeSearchTools: surface.nativeSearchTools } : {}),
    parseCommand: surface.payloadCodec ?? (() => null),
    block: (command, c) => {
      const message = buildBlockMessage(command, c);
      return decisionCodec.refuse(adapterId, message);
    },
    // The escape-reason stderr note only applies to the exit-code signalling
    // style (claude/codex/windsurf/opencode): cursor/antigravity answer via
    // `stdout` JSON instead, so a `stdout`-carrying allow action never gets
    // the note appended — matching the pre-refactor `cursorAllow`/
    // `antigravityAllow`, which ignored `escapeReason` outright.
    allow: (c) => {
      const base = decisionCodec.allow(adapterId);
      if (c.escapeReason !== undefined && base.stdout === undefined) {
        const reason = c.escapeReason || "(no reason given)";
        return { ...base, stderr: `[keryx ctx] raw command allowed via escape marker — reason: ${reason}\n` };
      }
      return base;
    },
    locate: (root) => surface.settingsFile!(root),
    ...(surface.merge !== undefined ? { merge: surface.merge } : {}),
    ...(surface.strip !== undefined ? { strip: surface.strip } : {}),
    ...(surface.validate !== undefined ? { validate: surface.validate } : {}),
    ...(surface.customInstall !== undefined ? { customInstall: surface.customInstall } : {}),
    ...(surface.customUninstall !== undefined ? { customUninstall: surface.customUninstall } : {}),
  };
}

const CTX_GUARD_SURFACES: ReadonlyArray<{ adapterId: string; surface: SurfaceAdapter; decisionCodec: DecisionCodec }> =
  HARNESS_ADAPTERS.flatMap((adapter) =>
    surfacesOf(adapter, { subsystem: "ctx-guard" }).map((surface) => ({
      adapterId: adapter.id,
      surface,
      decisionCodec: adapter.decisionCodec,
    })),
  );

export const CTX_RUNTIMES: CtxRuntime[] = CTX_GUARD_SURFACES.map(({ adapterId, surface, decisionCodec }) =>
  runtimeFromSurface(adapterId, surface, decisionCodec),
);

function runtimeFor(id: string): CtxRuntime {
  const runtime = CTX_RUNTIMES.find((r) => r.id === id);
  if (!runtime) throw new Error(`integrations registry: no ctx-guard surface registered for "${id}"`);
  return runtime;
}

// Named exports every existing caller/test imports directly, derived from the
// built list rather than declared a second time.
export const CLAUDE_RUNTIME: CtxRuntime = runtimeFor("claude");
export const CODEX_RUNTIME: CtxRuntime = runtimeFor("codex");
export const CURSOR_RUNTIME: CtxRuntime = runtimeFor("cursor");
export const WINDSURF_RUNTIME: CtxRuntime = runtimeFor("windsurf");
export const ANTIGRAVITY_RUNTIME: CtxRuntime = runtimeFor("antigravity");
export const OPENCODE_RUNTIME: CtxRuntime = runtimeFor("opencode");

// Harnesses with NO scriptable pre-exec gate today. Registered only so the CLI
// can give a precise "unsupported" message instead of "unknown runtime".
export const UNSUPPORTED_RUNTIMES: Record<string, string> = UNSUPPORTED_CTX_GUARD;

export function runtimeIds(): string[] {
  return CTX_RUNTIMES.map((r) => r.id);
}

export function getRuntime(id: string): CtxRuntime | undefined {
  return CTX_RUNTIMES.find((r) => r.id === id);
}

export function resolveRuntimes(ids: string[]): {
  runtimes: CtxRuntime[];
  unknown: string[];
  unsupported: string[];
} {
  const wanted = ids.includes("all") ? runtimeIds() : ids;
  const runtimes: CtxRuntime[] = [];
  const unknown: string[] = [];
  const unsupported: string[] = [];
  for (const id of wanted) {
    const runtime = getRuntime(id);
    if (runtime) runtimes.push(runtime);
    else if (UNSUPPORTED_RUNTIMES[id]) unsupported.push(id);
    else unknown.push(id);
  }
  return { runtimes, unknown, unsupported };
}

export { classifyCommand, buildBlockMessage, type HookClassification };
export type { HarnessAdapter };
