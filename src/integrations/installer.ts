// Flow 307 (W5-b), T6: the installer core every per-runtime install/uninstall/
// doctor path routes through — the legacy `ctx install-hook`/`orient
// install-hook`/`security hooks install` commands (via their own modules'
// thin delegation) AND the future `keryx integrations` CLI (a later task).
// Core logic only: no CLI arg parsing, no console output.
//
// A "surface" installs one of three ways (see `SurfaceAdapter` in
// `types.ts`):
//   - JSON: `relativePath` + `merge`/`strip`/`validate` — routed through that
//     file's `SettingsFileOwner`, one file read/write per relative path even
//     when several requested surfaces share it (`installSurfaces`/
//     `uninstallSurfaces` already batch this).
//   - custom: `customInstall`/`customUninstall` — a non-JSON artifact (a
//     managed markdown block, a generated plugin file).
//   - satisfied-by-runtime: neither of the above (zed's `acp-permission`) —
//     there is nothing to write; `probe` (if present) reports its health.
//
// Every surface that actually wrote a file gets one install-state record
// (`install-state.ts`); a satisfied-by-runtime surface never does.

import path from "node:path";
import { getHarnessAdapter, harnessAdapterIds, settingsFileOwnerFor } from "./registry";
import { installSurfaces, uninstallSurfaces } from "./settings-file";
import { arrayAt, isManagedBy, readSettingsFile } from "./settings-json";
import {
  recordSurfaceInstalled,
  recordSurfaceUninstalled,
  readInstallState,
  installStatePath,
  installStateIsUnreadable,
  sha256OfFile,
  type InstalledModuleRecord,
} from "./install-state";
import { pathExists } from "../lib/fs";
import type { Confidence, HarnessAdapter, Settings, SettingsFileOwner, SurfaceAdapter, SurfaceFlag } from "./types";

// ---------------------------------------------------------------------------
// Surface selection
// ---------------------------------------------------------------------------

/**
 * Resolve `selectors` (each a `SurfaceFlag` OR a surface id) against one
 * adapter's surfaces. Empty `selectors` selects every surface. Throws,
 * naming every unresolved selector alongside the valid flags/ids for THIS
 * runtime, on the first selector that matches nothing.
 */
export function resolveSurfaceSelection(
  adapter: HarnessAdapter,
  selectors: readonly string[] = [],
): SurfaceAdapter[] {
  // F10 (flow 310, W2): an opt-in surface (`agents`) is excluded from the
  // empty-selector default — it is only reached by naming its flag or id
  // explicitly, below. `keryx integrations install --runtime <id>` with no
  // `--surface` therefore keeps installing exactly what it always has.
  if (selectors.length === 0) return adapter.surfaces.filter((s) => !s.optIn);

  const resolved: SurfaceAdapter[] = [];
  const unknown: string[] = [];
  for (const selector of selectors) {
    const matches = adapter.surfaces.filter((s) => s.flag === selector || s.id === selector);
    if (matches.length === 0) {
      unknown.push(selector);
      continue;
    }
    for (const match of matches) {
      if (!resolved.includes(match)) resolved.push(match);
    }
  }
  if (unknown.length > 0) {
    const flags = [...new Set(adapter.surfaces.map((s) => s.flag))];
    const ids = adapter.surfaces.map((s) => s.id);
    throw new Error(
      `${adapter.id}: unknown surface selector(s) ${unknown.join(", ")} — valid flags: ${flags.join(", ") || "(none)"}; valid ids: ${ids.join(", ") || "(none)"}`,
    );
  }
  return resolved;
}

/**
 * Lenient counterpart to `resolveSurfaceSelection` for a multi-runtime
 * selection (`--runtime all`/a comma list, combined with `--surface`) (F3):
 * a selector that matches nothing on THIS adapter is silently dropped
 * instead of throwing — a runtime legitimately does not carry every surface
 * every other selected runtime does. Returns `[]` when NONE of `selectors`
 * match anything on this adapter; the caller (`installIntegration`/
 * `uninstallIntegration` with `lenientSelectors: true`) turns that into a
 * `noMatchingSurface` result instead of an error, so a multi-runtime run
 * only fails outright when not a single selected runtime matched. A single
 * explicit runtime still goes through `resolveSurfaceSelection` above and
 * throws on an unknown selector, unchanged.
 */
export function resolveSurfaceSelectionLenient(
  adapter: HarnessAdapter,
  selectors: readonly string[] = [],
): SurfaceAdapter[] {
  // F10 (flow 310, W2): same opt-in exclusion as `resolveSurfaceSelection` above.
  if (selectors.length === 0) return adapter.surfaces.filter((s) => !s.optIn);
  const resolved: SurfaceAdapter[] = [];
  for (const selector of selectors) {
    for (const match of adapter.surfaces.filter((s) => s.flag === selector || s.id === selector)) {
      if (!resolved.includes(match)) resolved.push(match);
    }
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Shared result shapes
// ---------------------------------------------------------------------------

export type InstallSurfaceStatus = "installed" | "would-install" | "satisfied-by-runtime" | "failed";
export type UninstallSurfaceStatus = "removed" | "nothing-to-remove" | "would-remove" | "satisfied-by-runtime" | "failed";

export interface SurfaceResult<Status extends string = InstallSurfaceStatus | UninstallSurfaceStatus> {
  readonly surfaceId: string;
  readonly flag: SurfaceFlag;
  readonly subsystem: string;
  readonly confidence: Confidence;
  /** Project-relative path this surface writes/reads, when it has one. */
  readonly file?: string;
  readonly status: Status;
  readonly errors: string[];
  readonly warnings: string[];
}

export interface InstallIntegrationResult {
  readonly runtimeId: string;
  readonly results: readonly SurfaceResult<InstallSurfaceStatus>[];
  readonly errors: string[];
  /** F3: set (with empty `results`/`errors`) when `lenientSelectors` found no surface on this runtime matching any requested selector. */
  readonly noMatchingSurface?: boolean;
}

export interface UninstallIntegrationResult {
  readonly runtimeId: string;
  readonly results: readonly SurfaceResult<UninstallSurfaceStatus>[];
  readonly errors: string[];
  /** F3: set (with empty `results`/`errors`) when `lenientSelectors` found no surface on this runtime matching any requested selector. */
  readonly noMatchingSurface?: boolean;
}

export interface DoctorSurfaceResult {
  readonly surfaceId: string;
  readonly flag: SurfaceFlag;
  readonly recorded: InstalledModuleRecord | undefined;
  readonly live: "valid" | "missing" | "invalid" | "not-applicable";
  readonly problems: string[];
  readonly drift: string | undefined;
}

export interface DoctorIntegrationResult {
  readonly runtimeId: string;
  readonly surfaces: readonly DoctorSurfaceResult[];
  /** F7: top-level problems not tied to any one surface — e.g. an unreadable install-state file. */
  readonly problems: readonly string[];
  readonly ok: boolean;
}

export interface InstallOptions {
  readonly surfaces?: readonly string[];
  readonly dryRun?: boolean;
  readonly ownerOverride?: SettingsFileOwner;
  /** F3: resolve `surfaces` leniently (see `resolveSurfaceSelectionLenient`) — for a multi-runtime `--runtime all`/comma-list selection, not a single explicit runtime. */
  readonly lenientSelectors?: boolean;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function fileFor(root: string, relativePath: string): string {
  return path.join(root, ...relativePath.split("/"));
}

/** `experimental — verify on a live install` plus the surface's own riskNotes, for anything experimental. */
function warningsFor(surface: SurfaceAdapter): string[] {
  return surface.confidence === "experimental"
    ? ["experimental — verify on a live install", ...(surface.riskNotes ?? [])]
    : [];
}

function baseResult(surface: SurfaceAdapter, file?: string): Pick<SurfaceResult, "surfaceId" | "flag" | "subsystem" | "confidence" | "file"> {
  return {
    surfaceId: surface.id,
    flag: surface.flag,
    subsystem: surface.subsystem,
    confidence: surface.confidence,
    ...(file !== undefined ? { file } : {}),
  };
}

/** Adapter lookup shared by install/uninstall: unknown id or a zero-surface adapter both refuse up front. */
function resolveAdapterOrError(runtimeId: string): { adapter: HarnessAdapter } | { errors: string[] } {
  const adapter = getHarnessAdapter(runtimeId);
  if (!adapter) {
    return { errors: [`unknown runtime "${runtimeId}" — valid runtimes: ${harnessAdapterIds().join(", ")}`] };
  }
  if (adapter.surfaces.length === 0) {
    const reasons = [...new Set(Object.values(adapter.unsupported))];
    return { errors: [`"${runtimeId}" has no installable surfaces — ${reasons.join(" ")}`] };
  }
  return { adapter };
}

/**
 * Whether `surface` was already installed in `settings` (review round 3,
 * M2): judged in two steps, neither of which is "diff `strip`'s before/after
 * and see if anything changed" — that approach (review round 2, N2's fix)
 * over-reported "installed" the moment `strip` did ANY cleanup on the file,
 * including pruning an empty container this surface never wrote (the round-3
 * repro: `{hooks:{PreToolUse:[]}, x:1}` + uninstall `--surface ctx-guard`
 * reported "removed" for a surface that was never installed, because
 * `stripFromHookArray` deletes an empty `hooks` object regardless of who
 * emptied it).
 *
 * 1. `surface.validate` (when present) returning no problems means a
 *    healthy, correctly-shaped install — done, present.
 * 2. Otherwise, fall back to a direct look at `surface.groupKey` (+
 *    `groupContainer`/`groupMatchField`, when the surface carries them): a
 *    group tagged with THIS surface's own sentinel at that exact key is
 *    "installed but stale/malformed" — still something an uninstall must
 *    report as "removed" once it strips it (mirrors the historical-shape
 *    coverage in `src/ctx/hook-install.test.ts`: a stale matcher, an inert
 *    `type:"prompt"` entry, a flat `command` instead of nested `hooks[]`, a
 *    missing `matcher` — every one of these fails `validate` yet must still
 *    read as present). A surface with no `groupKey` (and no `validate`) has
 *    no generic way to answer this and reports absent.
 *
 * `matchField`-equivalent disambiguation for two surfaces sharing one array
 * (the flat security surfaces' `securityHooks`, told apart only by each
 * entry's `on`) is `surface.groupMatchField` — never a second, surface-id-
 * keyed special case here.
 */
function wasSurfaceInstalled(settings: Settings, surface: SurfaceAdapter): boolean {
  if (surface.validate && surface.validate(structuredClone(settings)).length === 0) return true;
  if (!surface.groupKey) return false;
  const isManaged = isManagedBy(surface.sentinel);
  return arrayAt(settings, surface.groupContainer, surface.groupKey).some((entry) => {
    if (!isManaged(entry)) return false;
    if (!surface.groupMatchField) return true;
    const value =
      typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>)[surface.groupMatchField.key] : undefined;
    return value === surface.groupMatchField.value;
  });
}

/**
 * Dry-run presence check for a custom (non-JSON) surface's UNINSTALL (F4):
 * mirrors what the real `customUninstall` would find, so dry-run and the
 * real run never disagree. A surface with a structured `inspect` (review
 * round 2 — markdown-block `instructions` surfaces wire this to
 * `inspectMarkdownBlock`) is judged off that typed state rather than
 * string-matching a `probe` message, and a `"malformed"` file (an
 * unterminated block) reports `failed` — the same outcome the real uninstall
 * would hit, instead of silently disagreeing with it. A surface without
 * `inspect` (the OpenCode plugin, which owns its whole file outright) falls
 * back to plain file existence: any content present means there is something
 * to remove.
 */
async function customUninstallDryRun(
  root: string,
  surface: SurfaceAdapter,
  file: string | undefined,
): Promise<{ status: UninstallSurfaceStatus; errors: string[] }> {
  if (surface.inspect) {
    const inspection = await surface.inspect(root);
    if (inspection.state === "malformed") return { status: "failed", errors: [inspection.message ?? "malformed"] };
    if (inspection.state === "absent-file" || inspection.state === "no-block") return { status: "nothing-to-remove", errors: [] };
    return { status: "would-remove", errors: [] };
  }
  const wouldRemove = file ? await pathExists(file) : false;
  return { status: wouldRemove ? "would-remove" : "nothing-to-remove", errors: [] };
}

/**
 * Dry-run presence check for a custom (non-JSON) surface's INSTALL (F4):
 * a surface with `inspect` reports `failed` when the file is currently
 * malformed (the real install would find the same thing and refuse), since
 * an install always attempts to write the block regardless of the surface's
 * current state, everything else reports `would-install`.
 */
async function customInstallDryRun(root: string, surface: SurfaceAdapter): Promise<{ status: InstallSurfaceStatus; errors: string[] }> {
  if (surface.inspect) {
    const inspection = await surface.inspect(root);
    if (inspection.state === "malformed") return { status: "failed", errors: [inspection.message ?? "malformed"] };
  }
  return { status: "would-install", errors: [] };
}

/** Partition a resolved surface list into JSON-owned (grouped by file), custom-install, and satisfied-by-runtime. */
function partitionSurfaces(surfaces: readonly SurfaceAdapter[]): {
  jsonByPath: Map<string, SurfaceAdapter[]>;
  custom: SurfaceAdapter[];
  satisfied: SurfaceAdapter[];
} {
  const jsonByPath = new Map<string, SurfaceAdapter[]>();
  const custom: SurfaceAdapter[] = [];
  const satisfied: SurfaceAdapter[] = [];
  for (const surface of surfaces) {
    if (surface.relativePath && surface.merge && surface.strip) {
      const list = jsonByPath.get(surface.relativePath) ?? [];
      list.push(surface);
      jsonByPath.set(surface.relativePath, list);
    } else if (surface.customInstall || surface.customUninstall) {
      custom.push(surface);
    } else {
      satisfied.push(surface);
    }
  }
  return { jsonByPath, custom, satisfied };
}

/**
 * F14: the preamble `installIntegration`/`uninstallIntegration` both ran
 * verbatim — resolve the adapter, resolve (strictly or leniently, per
 * `opts.lenientSelectors`) which of its surfaces are in scope, then
 * partition them — collapsed into one place so the two entry points differ
 * only in what they DO with a resolved surface, not in how they get there.
 */
type ResolvedSurfaces =
  | ({ readonly kind: "ok" } & ReturnType<typeof partitionSurfaces>)
  | { readonly kind: "adapter-error"; readonly errors: string[] }
  | { readonly kind: "no-match" };

function resolveAndPartitionSurfaces(runtimeId: string, opts: InstallOptions): ResolvedSurfaces {
  const resolvedAdapter = resolveAdapterOrError(runtimeId);
  if ("errors" in resolvedAdapter) return { kind: "adapter-error", errors: resolvedAdapter.errors };
  const { adapter } = resolvedAdapter;

  let surfaces: SurfaceAdapter[];
  if (opts.lenientSelectors) {
    surfaces = resolveSurfaceSelectionLenient(adapter, opts.surfaces ?? []);
    if (surfaces.length === 0 && (opts.surfaces?.length ?? 0) > 0) {
      return { kind: "no-match" };
    }
  } else {
    try {
      surfaces = resolveSurfaceSelection(adapter, opts.surfaces ?? []);
    } catch (error) {
      return { kind: "adapter-error", errors: [(error as Error).message] };
    }
  }

  return { kind: "ok", ...partitionSurfaces(surfaces) };
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

export async function installIntegration(
  root: string,
  runtimeId: string,
  opts: InstallOptions = {},
): Promise<InstallIntegrationResult> {
  const resolved = resolveAndPartitionSurfaces(runtimeId, opts);
  if (resolved.kind === "adapter-error") return { runtimeId, results: [], errors: resolved.errors };
  if (resolved.kind === "no-match") return { runtimeId, results: [], errors: [], noMatchingSurface: true };

  const { jsonByPath, custom, satisfied } = resolved;
  const results: SurfaceResult<InstallSurfaceStatus>[] = [];
  const errors: string[] = [];

  for (const [relativePath, groupSurfaces] of jsonByPath) {
    const owner = opts.ownerOverride ?? settingsFileOwnerFor(relativePath);
    if (!owner) {
      const message = `no settings-file owner registered for ${relativePath}`;
      errors.push(message);
      for (const surface of groupSurfaces) {
        results.push({
          ...baseResult(surface, relativePath),
          status: "failed",
          errors: [message],
          warnings: warningsFor(surface),
        });
      }
      continue;
    }

    const ids = groupSurfaces.map((s) => s.id);
    if (opts.dryRun) {
      const existing = await readSettingsFile(fileFor(root, relativePath));
      const { errors: applyErrors } = owner.apply(existing, { install: ids });
      if (applyErrors.length > 0) errors.push(...applyErrors);
      for (const surface of groupSurfaces) {
        results.push(
          applyErrors.length > 0
            ? { ...baseResult(surface, relativePath), status: "failed", errors: applyErrors, warnings: warningsFor(surface) }
            : { ...baseResult(surface, relativePath), status: "would-install", errors: [], warnings: warningsFor(surface) },
        );
      }
      continue;
    }

    const { errors: writeErrors } = await installSurfaces(root, relativePath, ids, owner);
    if (writeErrors.length > 0) {
      errors.push(...writeErrors);
      for (const surface of groupSurfaces) {
        results.push({ ...baseResult(surface, relativePath), status: "failed", errors: writeErrors, warnings: warningsFor(surface) });
      }
      continue;
    }
    // F5: only a file owned by exactly one surface gets its sha256 recorded
    // — a file several surfaces share would otherwise flag "changed since
    // install" the moment a SIBLING surface, not this one, next touches it.
    const hashPaths = owner.surfaces().length > 1 ? [] : [relativePath];
    for (const surface of groupSurfaces) {
      results.push({ ...baseResult(surface, relativePath), status: "installed", errors: [], warnings: warningsFor(surface) });
      await recordSurfaceInstalled(root, runtimeId, {
        moduleId: surface.id,
        surface: surface.flag,
        writtenPaths: [relativePath],
        managedSentinel: true,
        hashPaths,
      });
    }
  }

  for (const surface of custom) {
    if (opts.dryRun) {
      // F4: judge off the surface's own structured `inspect` (falling back to
      // "would-install") instead of always reporting "would-install"
      // regardless of whether the real install would actually fail.
      const dryRun = await customInstallDryRun(root, surface);
      if (dryRun.errors.length > 0) errors.push(...dryRun.errors);
      results.push({ ...baseResult(surface, surface.relativePath), status: dryRun.status, errors: dryRun.errors, warnings: warningsFor(surface) });
      continue;
    }
    // N1: a thrown error from `customInstall` (an `UnterminatedInstructionsBlockError`
    // escaping a bug, or any other unexpected throw) becomes a `failed`
    // SurfaceResult instead of escaping `installIntegration` — this happens
    // AFTER the jsonByPath loop above has already written/stripped every JSON
    // surface, and it must not stop a LATER custom surface, or the
    // satisfied-by-runtime loop below, from being processed.
    let customErrors: string[];
    try {
      customErrors = surface.customInstall ? await surface.customInstall(root) : [];
    } catch (error) {
      customErrors = [(error as Error).message];
    }
    if (customErrors.length > 0) {
      errors.push(...customErrors);
      results.push({ ...baseResult(surface, surface.relativePath), status: "failed", errors: customErrors, warnings: warningsFor(surface) });
      continue;
    }
    results.push({ ...baseResult(surface, surface.relativePath), status: "installed", errors: [], warnings: warningsFor(surface) });
    if (surface.relativePath) {
      await recordSurfaceInstalled(root, runtimeId, {
        moduleId: surface.id,
        surface: surface.flag,
        writtenPaths: [surface.relativePath],
        managedSentinel: true,
      });
    }
  }

  // F2: a surface with neither merge/strip nor customInstall/customUninstall
  // is satisfied entirely by keryx's own runtime behaviour — there is
  // nothing to write and it is never a failure. `probe`'s problems (if any)
  // are reported as warnings, never errors. It is also never recorded in
  // install-state; when `!opts.dryRun`, clear any STALE record left behind
  // by a build that used to install this surface a different way (e.g. zed's
  // `instructions` surface before this fix), so `doctor` never carries a
  // drift note for something that no longer writes anything.
  for (const surface of satisfied) {
    const info = surface.probe ? await surface.probe(root) : [];
    results.push({
      ...baseResult(surface, surface.relativePath),
      status: "satisfied-by-runtime",
      errors: [],
      warnings: [...warningsFor(surface), ...info],
    });
    if (!opts.dryRun) await recordSurfaceUninstalled(root, runtimeId, surface.id);
  }

  return { runtimeId, results, errors };
}

// ---------------------------------------------------------------------------
// Uninstall
// ---------------------------------------------------------------------------

export async function uninstallIntegration(
  root: string,
  runtimeId: string,
  opts: InstallOptions = {},
): Promise<UninstallIntegrationResult> {
  const resolved = resolveAndPartitionSurfaces(runtimeId, opts);
  if (resolved.kind === "adapter-error") return { runtimeId, results: [], errors: resolved.errors };
  if (resolved.kind === "no-match") return { runtimeId, results: [], errors: [], noMatchingSurface: true };

  const { jsonByPath, custom, satisfied } = resolved;
  const results: SurfaceResult<UninstallSurfaceStatus>[] = [];
  const errors: string[] = [];

  for (const [relativePath, groupSurfaces] of jsonByPath) {
    const owner = opts.ownerOverride ?? settingsFileOwnerFor(relativePath);
    if (!owner) {
      const message = `no settings-file owner registered for ${relativePath}`;
      errors.push(message);
      for (const surface of groupSurfaces) {
        results.push({
          ...baseResult(surface, relativePath),
          status: "failed",
          errors: [message],
          warnings: warningsFor(surface),
        });
      }
      continue;
    }

    const file = fileFor(root, relativePath);
    const fileIsPresent = await pathExists(file);
    const existing = fileIsPresent ? await readSettingsFile(file) : {};
    const wasPresent = new Map(groupSurfaces.map((s) => [s.id, wasSurfaceInstalled(existing, s)]));
    const ids = groupSurfaces.map((s) => s.id);

    if (!fileIsPresent) {
      for (const surface of groupSurfaces) {
        results.push({ ...baseResult(surface, relativePath), status: "nothing-to-remove", errors: [], warnings: warningsFor(surface) });
      }
      continue;
    }

    if (opts.dryRun) {
      const { errors: applyErrors } = owner.apply(existing, { uninstall: ids });
      if (applyErrors.length > 0) errors.push(...applyErrors);
      for (const surface of groupSurfaces) {
        results.push(
          applyErrors.length > 0
            ? { ...baseResult(surface, relativePath), status: "failed", errors: applyErrors, warnings: warningsFor(surface) }
            : {
                ...baseResult(surface, relativePath),
                status: wasPresent.get(surface.id) ? "would-remove" : "nothing-to-remove",
                errors: [],
                warnings: warningsFor(surface),
              },
        );
      }
      continue;
    }

    const { errors: writeErrors } = await uninstallSurfaces(root, relativePath, ids, owner);
    if (writeErrors.length > 0) {
      errors.push(...writeErrors);
      for (const surface of groupSurfaces) {
        results.push({ ...baseResult(surface, relativePath), status: "failed", errors: writeErrors, warnings: warningsFor(surface) });
      }
      continue;
    }
    for (const surface of groupSurfaces) {
      const removed = wasPresent.get(surface.id) === true;
      results.push({
        ...baseResult(surface, relativePath),
        status: removed ? "removed" : "nothing-to-remove",
        errors: [],
        warnings: warningsFor(surface),
      });
      if (removed) await recordSurfaceUninstalled(root, runtimeId, surface.id);
    }
  }

  for (const surface of custom) {
    const file = surface.relativePath ? fileFor(root, surface.relativePath) : undefined;
    if (opts.dryRun) {
      // F4: dry-run parity — use the surface's own structured `inspect` (or
      // plain file existence, when it has none) instead of string-matching a
      // `probe` message, so dry-run and the real uninstall never disagree —
      // including on a malformed (unterminated) block, which must report
      // `failed` here exactly as the real run would.
      const dryRun = await customUninstallDryRun(root, surface, file);
      if (dryRun.errors.length > 0) errors.push(...dryRun.errors);
      results.push({ ...baseResult(surface, surface.relativePath), status: dryRun.status, errors: dryRun.errors, warnings: warningsFor(surface) });
      continue;
    }
    // N1: a thrown error from `customUninstall` (markdown-block surfaces
    // throw `UnterminatedInstructionsBlockError` rather than return a false —
    // see `markdown-block.ts`) becomes a `failed` SurfaceResult instead of
    // escaping `uninstallIntegration`. This runs AFTER the jsonByPath loop
    // above has already stripped every JSON surface, and a throw here must
    // not stop a LATER custom surface, or the satisfied-by-runtime loop
    // below, from being processed.
    let removed = false;
    let customError: string | undefined;
    try {
      removed = surface.customUninstall ? await surface.customUninstall(root) : false;
    } catch (error) {
      customError = (error as Error).message;
    }
    if (customError !== undefined) {
      errors.push(customError);
      results.push({ ...baseResult(surface, surface.relativePath), status: "failed", errors: [customError], warnings: warningsFor(surface) });
      continue;
    }
    results.push({
      ...baseResult(surface, surface.relativePath),
      status: removed ? "removed" : "nothing-to-remove",
      errors: [],
      warnings: warningsFor(surface),
    });
    if (removed) await recordSurfaceUninstalled(root, runtimeId, surface.id);
  }

  // F2: satisfied-by-runtime surfaces are always "satisfied-by-runtime" on
  // uninstall too (there is nothing to remove), and this ALSO clears any
  // stale install-state record left behind by a build that used to install
  // this surface a different way, whether or not this call is a dry run's
  // read-only sibling — a dry run must write nothing, so the clear is
  // skipped there, matching every other branch above.
  for (const surface of satisfied) {
    results.push({
      ...baseResult(surface, surface.relativePath),
      status: "satisfied-by-runtime",
      errors: [],
      warnings: warningsFor(surface),
    });
    if (!opts.dryRun) await recordSurfaceUninstalled(root, runtimeId, surface.id);
  }

  return { runtimeId, results, errors };
}

// ---------------------------------------------------------------------------
// Doctor
// ---------------------------------------------------------------------------

async function liveStatusOf(
  root: string,
  surface: SurfaceAdapter,
): Promise<{ live: "valid" | "missing" | "invalid" | "not-applicable"; problems: string[] }> {
  if (surface.relativePath && surface.validate) {
    const file = surface.settingsFile ? surface.settingsFile(root) : fileFor(root, surface.relativePath);
    if (!(await pathExists(file))) {
      return { live: "missing", problems: [`${surface.relativePath}: file is missing`] };
    }
    // review round 3, M3: `readSettingsFile` throws on invalid JSON —
    // uncaught, that escaped `doctorIntegration` entirely and aborted
    // `keryx integrations doctor --runtime all` on the FIRST corrupt file,
    // printing nothing for every runtime after it. A parse failure is a live
    // fact about this surface, exactly like a missing file: report it as
    // `invalid` (so a recorded surface here shows as drift, same as any
    // other live-vs-recorded mismatch) instead of throwing.
    let settings: Settings;
    try {
      settings = await readSettingsFile(file);
    } catch (error) {
      return { live: "invalid", problems: [(error as Error).message] };
    }
    const problems = surface.validate(settings);
    return { live: problems.length === 0 ? "valid" : "invalid", problems };
  }
  if (surface.probe) {
    const problems = await surface.probe(root);
    return { live: problems.length === 0 ? "valid" : "invalid", problems };
  }
  return { live: "not-applicable", problems: [] };
}

async function shaDriftedSinceInstall(root: string, recorded: InstalledModuleRecord): Promise<boolean> {
  for (const [relativePath, expected] of Object.entries(recorded.sha256)) {
    const current = await sha256OfFile(root, relativePath);
    if (current !== expected) return true;
  }
  return false;
}

function driftMessage(surface: SurfaceAdapter, recorded: InstalledModuleRecord, live: string, problems: string[]): string {
  const when = recorded.installedAt ? recorded.installedAt.slice(0, 10) : "an unknown date";
  const version = recorded.keryxVersion ? `Keryx ${recorded.keryxVersion}` : "Keryx";
  const detail = problems.length > 0 ? problems.join("; ") : `now ${live}`;
  return `${surface.id} (${surface.flag}) was installed by ${version} on ${when} and is now ${live}: ${detail}`;
}

export interface DoctorOptions {
  /**
   * R1-F8: surface flags/ids explicitly of interest — when given, an opt-in
   * surface named here is doctored even with no install record (matching
   * `resolveSurfaceSelection`'s "opt-in only when named explicitly" rule).
   * Optional and additive: omitting it keeps every pre-flow-310 caller's
   * behavior for every NON-opt-in surface unchanged.
   */
  readonly surfaces?: readonly string[];
}

export async function doctorIntegration(root: string, runtimeId: string, opts: DoctorOptions = {}): Promise<DoctorIntegrationResult> {
  const adapter = getHarnessAdapter(runtimeId);
  if (!adapter) {
    throw new Error(`unknown runtime "${runtimeId}" — valid runtimes: ${harnessAdapterIds().join(", ")}`);
  }
  if (adapter.surfaces.length === 0) {
    const reasons = [...new Set(Object.values(adapter.unsupported))];
    throw new Error(`"${runtimeId}" has no installable surfaces — ${reasons.join(" ")}`);
  }

  // F7: a state file that exists but fails to parse/validate is reported as
  // a top-level problem, not thrown — `readInstallState` already treats it
  // the same as "nothing recorded" for every surface below, so doctor still
  // runs a full live check; this just makes the malformed file itself
  // visible instead of silently vanishing into "not recorded".
  const problems: string[] = [];
  if (await installStateIsUnreadable(root, runtimeId)) {
    problems.push(`install-state unreadable: ${installStatePath(root, runtimeId)}`);
  }

  const explicitlySelected = new Set(opts.surfaces ?? []);
  const state = await readInstallState(root, runtimeId);
  const surfaces: DoctorSurfaceResult[] = [];
  for (const surface of adapter.surfaces) {
    const recorded = state?.installedModules.find((r) => r.moduleId === surface.id);
    // R1-F8: a never-installed opt-in surface (e.g. `agents`, before anyone
    // ran `--surface agents`) is not something the default, no-selector
    // `doctor` should judge "invalid (not recorded)" — that regressed the
    // default output for every runtime the moment this surface was
    // registered. Skip it entirely unless it is already recorded (drift on
    // an installed opt-in surface is still worth reporting) or the caller
    // named it explicitly.
    if (surface.optIn && !recorded && !explicitlySelected.has(surface.flag) && !explicitlySelected.has(surface.id)) {
      continue;
    }
    const { live, problems: surfaceProblems } = await liveStatusOf(root, surface);

    let drift: string | undefined;
    if (recorded && live !== "valid") {
      drift = driftMessage(surface, recorded, live, surfaceProblems);
    } else if (recorded && live === "valid" && (await shaDriftedSinceInstall(root, recorded))) {
      drift = "file changed since install (still valid)";
    }

    surfaces.push({ surfaceId: surface.id, flag: surface.flag, recorded, live, problems: surfaceProblems, drift });
  }

  const ok = problems.length === 0 && !surfaces.some((s) => s.recorded && s.live !== "valid");
  return { runtimeId, surfaces, problems, ok };
}
