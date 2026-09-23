// Flow 305 (W5-a): the `SettingsFileOwner` implementation and the on-disk
// installSurfaces/uninstallSurfaces every installer routes through.

import path from "node:path";
import { readSettingsFile, writeSettingsFile } from "./settings-json";
import type { Settings, SettingsFileOwner, SurfaceAdapter } from "./types";

/**
 * Build the owner for one settings file from every surface that targets it.
 * `apply` runs each requested surface's own `merge`/`strip` (which already
 * carries its own sentinel-add / sibling-aware sentinel-remove logic — see
 * `surfaces.ts`), then validates: any surface that validated clean BEFORE the
 * operation and is not being uninstalled must still validate clean, and every
 * surface being installed must validate clean. Otherwise it returns errors and
 * leaves `settings` for the caller to discard rather than write.
 */
export function createSettingsFileOwner(relativePath: string, surfaces: readonly SurfaceAdapter[]): SettingsFileOwner {
  const byId = new Map(surfaces.map((s) => [s.id, s] as const));
  return {
    relativePath,
    surfaces: () => surfaces,
    apply(existing, ops) {
      const install = ops.install ?? [];
      const uninstall = ops.uninstall ?? [];

      const before = new Map<string, boolean>();
      for (const surface of surfaces) {
        if (surface.validate) before.set(surface.id, surface.validate(existing).length === 0);
      }

      let settings: Settings = existing;
      for (const id of install) {
        const surface = byId.get(id);
        if (surface?.merge) settings = surface.merge(settings);
      }
      for (const id of uninstall) {
        const surface = byId.get(id);
        if (surface?.strip) settings = surface.strip(settings);
      }

      const errors: string[] = [];
      for (const surface of surfaces) {
        if (!surface.validate) continue;
        const validNow = surface.validate(settings).length === 0;
        if (validNow) continue;
        if (install.includes(surface.id)) {
          errors.push(...surface.validate(settings));
        } else if (!uninstall.includes(surface.id) && before.get(surface.id) === true) {
          errors.push(
            `${surface.id}: this operation left a previously-valid surface invalid on ${relativePath} — refusing to write`,
          );
        }
      }
      return { settings, errors };
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

/** The uninstall counterpart of `installSurfaces`. */
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
  await writeSettingsFile(file, settings);
  return { file, errors: [] };
}
