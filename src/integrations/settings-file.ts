// Flow 305 (W5-a): the `SettingsFileOwner` implementation and the on-disk
// installSurfaces/uninstallSurfaces every installer routes through.

import { rm } from "node:fs/promises";
import path from "node:path";
import { readSettingsFile, writeSettingsFile } from "./settings-json";
import type { Settings, SettingsFileOwner, SurfaceAdapter } from "./types";

/** A JSON round-trip clone: what actually survives `JSON.stringify`/parse. */
function roundTrip(settings: Settings): Settings {
  return JSON.parse(JSON.stringify(settings)) as Settings;
}

/**
 * Build the owner for one settings file from every surface that targets it.
 * `apply` runs each requested surface's own `merge`/`strip` (which already
 * carries its own sentinel-add / sibling-aware sentinel-remove logic — see
 * `surfaces.ts`), then validates: any surface that validated clean BEFORE the
 * operation and is not being uninstalled must still validate clean, and every
 * surface being installed must validate clean. Otherwise it returns errors and
 * leaves `settings` for the caller to discard rather than write.
 *
 * Both the before- and after-validation run against a JSON round-trip
 * (`JSON.parse(JSON.stringify(...))`) of the settings, not the in-memory
 * object a merge produced: a merge that writes into something that is
 * `typeof "object"` in memory but not a plain JSON object/array (e.g. a
 * pre-existing container value that is itself an array masquerading as the
 * expected object, so a property assignment "succeeds" in memory) can look
 * valid right up until it is serialized, at which point the property is
 * silently dropped and the on-disk file no longer matches what was
 * validated. Round-tripping before validating closes that gap, and the
 * round-tripped object — not the raw merge output — is what gets returned
 * for the caller to write, so what was validated is exactly what is written.
 */
export function createSettingsFileOwner(relativePath: string, surfaces: readonly SurfaceAdapter[]): SettingsFileOwner {
  const byId = new Map(surfaces.map((s) => [s.id, s] as const));
  return {
    relativePath,
    surfaces: () => surfaces,
    apply(existing, ops) {
      const install = ops.install ?? [];
      const uninstall = ops.uninstall ?? [];

      // Refuse outright on an id the owner does not list — no merge/strip
      // runs and nothing is written.
      const unknownIds = [...install, ...uninstall].filter((id) => !byId.has(id));
      if (unknownIds.length > 0) {
        return {
          settings: roundTrip(existing),
          errors: unknownIds.map((id) => `${relativePath}: unknown surface id "${id}" — refusing to write`),
        };
      }

      // Never mutate the caller's object; every surface's merge/strip mutates
      // and returns the settings object it is handed, so give them a clone.
      let settings: Settings = structuredClone(existing);

      const beforeRoundTripped = roundTrip(settings);
      const before = new Map<string, boolean>();
      for (const surface of surfaces) {
        if (surface.validate) before.set(surface.id, surface.validate(beforeRoundTripped).length === 0);
      }

      // Apply in the owner's own canonical order (`surfaces`), not the
      // caller's — so two callers requesting the same ops in a different
      // order still produce byte-identical output.
      for (const surface of surfaces) {
        if (install.includes(surface.id) && surface.merge) settings = surface.merge(settings);
      }
      for (const surface of surfaces) {
        if (uninstall.includes(surface.id) && surface.strip) settings = surface.strip(settings);
      }

      const afterRoundTripped = roundTrip(settings);

      const errors: string[] = [];
      for (const surface of surfaces) {
        if (!surface.validate) continue;
        const validNow = surface.validate(afterRoundTripped).length === 0;
        if (validNow) continue;
        if (install.includes(surface.id)) {
          errors.push(...surface.validate(afterRoundTripped));
        } else if (!uninstall.includes(surface.id) && before.get(surface.id) === true) {
          errors.push(
            `${surface.id}: this operation left a previously-valid surface invalid on ${relativePath} — refusing to write`,
          );
        }
      }
      return { settings: afterRoundTripped, errors };
    },
  };
}

function fileFor(root: string, relativePath: string): string {
  return path.join(root, ...relativePath.split("/"));
}

/**
 * Install the named surfaces of `relativePath`'s owner, reading and writing
 * that file once. Writes only when every touched/previously-valid surface
 * validates clean afterward (see `createSettingsFileOwner`).
 */
export async function installSurfaces(
  root: string,
  relativePath: string,
  surfaceIds: readonly string[],
  owner: SettingsFileOwner,
): Promise<{ file: string; errors: string[] }> {
  const file = fileFor(root, relativePath);
  const existing = await readSettingsFile(file);
  const { settings, errors } = owner.apply(existing, { install: surfaceIds });
  if (errors.length > 0) return { file, errors };
  await writeSettingsFile(file, settings);
  return { file, errors: [] };
}

/**
 * The uninstall counterpart of `installSurfaces`. When the strip leaves
 * `settings` completely empty AND this file is `ownsWholeFile` (review round
 * 1, F6 — a file Keryx itself creates and is the only writer of, e.g.
 * `.kiro/hooks/keryx-ctx-guard.json`), the file is deleted outright instead
 * of being left behind holding `{}`. A file any other surface on this owner
 * does NOT mark `ownsWholeFile` (e.g. `.claude/settings.json`, shared with
 * other tools/the user's own config) is never deleted this way, regardless of
 * whether stripping happened to empty it out.
 */
export async function uninstallSurfaces(
  root: string,
  relativePath: string,
  surfaceIds: readonly string[],
  owner: SettingsFileOwner,
): Promise<{ file: string; errors: string[] }> {
  const file = fileFor(root, relativePath);
  const existing = await readSettingsFile(file);
  const { settings, errors } = owner.apply(existing, { uninstall: surfaceIds });
  if (errors.length > 0) return { file, errors };
  const ownsWholeFile = owner.surfaces().some((s) => s.ownsWholeFile);
  if (ownsWholeFile && Object.keys(settings).length === 0) {
    await rm(file, { force: true });
  } else {
    await writeSettingsFile(file, settings);
  }
  return { file, errors: [] };
}
