// Capability registry + init/update integration (specification.md §9; AC0-12).
//
// The shipped registry is EMPTY: Block 0 ships no end-user capability (NG0-1),
// so `init`/`update` offer no capability flags today and remain byte-identical
// to their current behavior. Blocks A–E append descriptors here to gain uniform
// `--<cap>` / `--no-<cap>` wiring for free. `REFERENCE_CAPABILITY_DESCRIPTOR` is
// a non-shipping fixture used by the wiring + reference tests to exercise the
// exact code path `init`/`update` run.

import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { pathExists } from "../lib/fs";
import {
  loadCapabilityConfig,
  parseCapabilitySelections,
  reconcileManifestCapability,
  renderCapabilityConfig,
  type CapabilityDescriptor,
  type CapabilitySelection,
} from "./wiring";

// The shipped registry — intentionally empty (Block 0 ships no feature).
export const CAPABILITY_REGISTRY: readonly CapabilityDescriptor[] = [];

// A non-shipping reference descriptor: proves the wiring end-to-end in tests.
export const REFERENCE_CAPABILITY_DESCRIPTOR: CapabilityDescriptor = {
  id: "gdref.transform",
  flag: "gdref",
  module: "gdgraph",
  kind: "ceiling",
  optionalDependency: "web-tree-sitter",
  asset: "gdref-fixture",
  config: ".metaproject/gdref.config.json",
  configDefaults: {
    schemaVersion: 1,
    capabilities: { transform: { enabled: false, asset: "gdref-fixture" } },
  },
};

// Apply capability selections to a workspace: reconcile enriched manifest
// entries and write each module config (deep-merged over defaults). Reads and
// rewrites `metaproject.json` in place; never disables an enabled module. A
// selection whose owning module is absent is skipped. No-op when `selections`
// is empty (the Block 0 default), keeping `init` output byte-identical.
export async function applyCapabilitySelections(
  cwd: string,
  selections: CapabilitySelection[],
): Promise<void> {
  if (selections.length === 0) {
    return;
  }
  const manifestPath = path.join(cwd, ".metaproject", "metaproject.json");
  if (!(await pathExists(manifestPath))) {
    return;
  }
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  } catch {
    return;
  }

  let changed = false;
  for (const selection of selections) {
    if (reconcileManifestCapability(manifest, selection)) {
      changed = true;
      if (selection.descriptor.config) {
        await writeFile(
          path.join(cwd, selection.descriptor.config),
          renderCapabilityConfig(selection.descriptor, selection.enabled),
          "utf8",
        );
      }
    }
  }

  if (changed) {
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }
}

// `init` entry: parse capability flags against a registry and apply them. Used
// by `src/commands/init.ts`; with the empty shipped registry this is a no-op.
export async function registerCapabilitiesFromArgs(
  cwd: string,
  args: string[],
  registry: readonly CapabilityDescriptor[] = CAPABILITY_REGISTRY,
): Promise<void> {
  await applyCapabilitySelections(cwd, parseCapabilitySelections(args, registry));
}

// `update` entry: reconcile registered capabilities into an existing manifest
// without changing their enabled state (mirror `moduleEnabled` reconciliation).
// A capability already present is refreshed; a newly-registered one is added
// disabled (ceilings default OFF). Ensures each capability's config exists.
export async function reconcileCapabilitiesOnUpdate(
  cwd: string,
  registry: readonly CapabilityDescriptor[] = CAPABILITY_REGISTRY,
): Promise<void> {
  if (registry.length === 0) {
    return;
  }
  const manifestPath = path.join(cwd, ".metaproject", "metaproject.json");
  if (!(await pathExists(manifestPath))) {
    return;
  }
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  } catch {
    return;
  }

  let changed = false;
  for (const descriptor of registry) {
    const enabled = capabilityCurrentlyEnabled(manifest, descriptor);
    const selection: CapabilitySelection = { descriptor, enabled };
    if (reconcileManifestCapability(manifest, selection)) {
      changed = true;
      if (descriptor.config && !(await pathExists(path.join(cwd, descriptor.config)))) {
        // Materialize the config using the on-disk (or default) merged state.
        const merged = await loadCapabilityConfig(cwd, descriptor, enabled);
        await writeFile(
          path.join(cwd, descriptor.config),
          `${JSON.stringify(merged, null, 2)}\n`,
          "utf8",
        );
      }
    }
  }

  if (changed) {
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }
}

// Read the current enabled state of a descriptor's capability from a manifest
// object (false when absent). Used so `update` preserves an operator's choice.
function capabilityCurrentlyEnabled(
  manifest: Record<string, unknown>,
  descriptor: CapabilityDescriptor,
): boolean {
  const modules = (manifest.modules ?? {}) as Record<string, unknown>;
  const moduleEntry = modules[descriptor.module];
  if (!moduleEntry || typeof moduleEntry !== "object") {
    return false;
  }
  const capabilities = (moduleEntry as { capabilities?: unknown }).capabilities;
  if (!Array.isArray(capabilities)) {
    return false;
  }
  for (const capability of capabilities) {
    if (capability && typeof capability === "object") {
      const entry = capability as { id?: unknown; enabled?: unknown };
      if (entry.id === descriptor.id) {
        return entry.enabled === true;
      }
    }
  }
  return false;
}
