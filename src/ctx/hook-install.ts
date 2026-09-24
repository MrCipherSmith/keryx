import { getHarnessAdapter, installIntegration, uninstallIntegration, type SettingsFileOwner } from "../integrations/service";
// Deep import, deliberately (F10 — see the note on `src/integrations/service.ts`):
// this is the one place outside `src/integrations` that reads the pre-merge
// settings directly, to report what an install would upgrade
// (`describeExistingGuard` below) before the write overwrites the evidence.
import { readSettingsFile } from "../integrations/settings-json";
import { describeExistingGuard, type CtxRuntime } from "./runtimes";

// Opt-in, merge-safe installer for the gdctx routing guard across harnesses.
// The per-runtime merge/strip is registered on the matching `SurfaceAdapter`
// in `src/integrations/surfaces.ts`; this module owns only the drift-message
// computation that has to happen BEFORE a write, then delegates the actual
// install/uninstall (JSON through a `SettingsFileOwner`, non-JSON through
// `customInstall`/`customUninstall`, and install-state recording) to the
// installer core (flow 307, W5-b, T6) — `installIntegration`/
// `uninstallIntegration` in `src/integrations/installer.ts` — so this and the
// `keryx integrations` CLI share one implementation.
//
// Never clobbers user config: managed entries carry the `ctx-agent-hooks`
// sentinel, so uninstall targets ONLY our entry and re-install is idempotent.

const CTX_GUARD_SURFACE_ID = "ctx-guard";

// Install the guard for one runtime; returns { path, errors } ([] errors = ok).
// JSON runtimes go through the owner; runtimes that own a non-JSON artifact
// (OpenCode plugin) delegate to customInstall — both routed through
// `installIntegration` now, which resolves the same "ctx-guard" surface id on
// this runtime's `HarnessAdapter`.
export async function installRuntimeHook(
  projectRoot: string,
  runtime: CtxRuntime,
  ownerOverride?: SettingsFileOwner,
): Promise<{ path: string; errors: string[]; upgraded?: string }> {
  const file = runtime.locate(projectRoot);
  if (!getHarnessAdapter(runtime.id)) {
    return { path: file, errors: [`${runtime.id}: no installer defined`] };
  }
  // Read BEFORE the merge: this is the only moment the pre-install state
  // exists, and the drift it reports is overwritten by the very next write.
  // Only meaningful for the JSON/merge path — a runtime whose ctx-guard
  // surface installs via `customInstall` (OpenCode) has no settings file to
  // diff against here.
  let upgraded: string | undefined;
  if (!runtime.customInstall && runtime.merge && runtime.validate && runtime.relativePath) {
    const existing = await readSettingsFile(file);
    upgraded = describeExistingGuard(existing, runtime) ?? undefined;
  }
  const { errors } = await installIntegration(projectRoot, runtime.id, {
    surfaces: [CTX_GUARD_SURFACE_ID],
    ...(ownerOverride ? { ownerOverride } : {}),
  });
  return { path: file, errors, ...(upgraded ? { upgraded } : {}) };
}

// Remove ONLY the managed guard for one runtime; false if nothing was present.
// Throws when the owner refuses the uninstall (it would leave a sibling
// surface on the same settings file invalid) — the boolean-only success shape
// is unchanged, but a caller must not treat a thrown error as "nothing to
// remove"; see `commands/ctx.ts::handleUninstallHook`.
export async function uninstallRuntimeHook(
  projectRoot: string,
  runtime: CtxRuntime,
  ownerOverride?: SettingsFileOwner,
): Promise<boolean> {
  if (!getHarnessAdapter(runtime.id)) {
    return false;
  }
  const { results, errors } = await uninstallIntegration(projectRoot, runtime.id, {
    surfaces: [CTX_GUARD_SURFACE_ID],
    ...(ownerOverride ? { ownerOverride } : {}),
  });
  if (errors.length > 0) {
    throw new Error(errors.join("; "));
  }
  return results.some((r) => r.status === "removed");
}
