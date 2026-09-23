import { pathExists } from "../lib/fs";
import { installSurfaces, settingsFileOwnerFor, uninstallSurfaces } from "../integrations";
// Deep import, deliberately (F10 — see the note on `src/integrations/index.ts`):
// this is the one place outside `src/integrations` that reads the pre-merge
// settings directly, to report what an install would upgrade
// (`describeExistingGuard` below) before the write overwrites the evidence.
import { readSettingsFile } from "../integrations/settings-json";
import { describeExistingGuard, type CtxRuntime } from "./runtimes";

// Opt-in, merge-safe installer for the gdctx routing guard across harnesses.
// The per-runtime merge/strip is registered on the matching `SurfaceAdapter`
// in `src/integrations/surfaces.ts`; this module owns only the install/
// uninstall loop and routes every write through that surface's
// `SettingsFileOwner` (`src/integrations/settings-file.ts`) so a ctx-guard
// install can never leave another surface (orient, security) in the same
// file invalid without saying so.
//
// Never clobbers user config: managed entries carry the `ctx-agent-hooks`
// sentinel, so uninstall targets ONLY our entry and re-install is idempotent.

const CTX_GUARD_SURFACE_ID = "ctx-guard";

// Install the guard for one runtime; returns { path, errors } ([] errors = ok).
// JSON runtimes go through the owner; runtimes that own a non-JSON artifact
// (OpenCode plugin) delegate to customInstall.
export async function installRuntimeHook(
  projectRoot: string,
  runtime: CtxRuntime,
): Promise<{ path: string; errors: string[]; upgraded?: string }> {
  const file = runtime.locate(projectRoot);
  if (runtime.customInstall) {
    const errors = await runtime.customInstall(projectRoot);
    return { path: file, errors };
  }
  if (!runtime.merge || !runtime.validate || !runtime.relativePath) {
    return { path: file, errors: [`${runtime.id}: no installer defined`] };
  }
  const owner = settingsFileOwnerFor(runtime.relativePath);
  if (!owner) {
    return { path: file, errors: [`${runtime.id}: no settings-file owner registered for ${runtime.relativePath}`] };
  }
  // Read BEFORE the merge: this is the only moment the pre-install state
  // exists, and the drift it reports is overwritten by the very next write.
  const existing = await readSettingsFile(file);
  const upgraded = describeExistingGuard(existing, runtime);
  const { errors } = await installSurfaces(projectRoot, runtime.relativePath, [CTX_GUARD_SURFACE_ID], owner);
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
): Promise<boolean> {
  if (runtime.customUninstall) {
    return runtime.customUninstall(projectRoot);
  }
  const file = runtime.locate(projectRoot);
  if (!(await pathExists(file))) {
    return false;
  }
  if (!runtime.strip || !runtime.relativePath) {
    return false;
  }
  const owner = settingsFileOwnerFor(runtime.relativePath);
  if (!owner) {
    return false;
  }
  const { errors } = await uninstallSurfaces(projectRoot, runtime.relativePath, [CTX_GUARD_SURFACE_ID], owner);
  if (errors.length > 0) {
    throw new Error(errors.join("; "));
  }
  return true;
}
