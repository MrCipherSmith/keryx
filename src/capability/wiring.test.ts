import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  deepMerge,
  loadCapabilityConfig,
  parseCapabilitySelections,
  reconcileManifestCapability,
  type CapabilityDescriptor,
} from "./wiring";
import {
  applyCapabilitySelections,
  reconcileCapabilitiesOnUpdate,
  REFERENCE_CAPABILITY_DESCRIPTOR,
} from "./registry";

let root: string;
const registry: readonly CapabilityDescriptor[] = [REFERENCE_CAPABILITY_DESCRIPTOR];

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "keryx-wiring-"));
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeManifest(manifest: Record<string, unknown>): Promise<void> {
  await writeFile(
    path.join(root, ".metaproject", "metaproject.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
}

async function readManifest(): Promise<Record<string, unknown>> {
  return JSON.parse(
    await readFile(path.join(root, ".metaproject", "metaproject.json"), "utf8"),
  ) as Record<string, unknown>;
}

test("parseCapabilitySelections maps --<cap>/--no-<cap>; omits unset (default OFF)", () => {
  expect(parseCapabilitySelections(["--gdref"], registry)).toEqual([
    { descriptor: REFERENCE_CAPABILITY_DESCRIPTOR, enabled: true },
  ]);
  expect(parseCapabilitySelections(["--no-gdref"], registry)).toEqual([
    { descriptor: REFERENCE_CAPABILITY_DESCRIPTOR, enabled: false },
  ]);
  expect(parseCapabilitySelections([], registry)).toEqual([]);
});

test("init: --<cap> writes the enriched manifest entry + module config; modules stay enabled", async () => {
  await writeManifest({
    modules: {
      gdgraph: { enabled: true, commands: ["build"] },
      security: { enabled: true },
    },
  });

  await applyCapabilitySelections(root, parseCapabilitySelections(["--gdref"], registry));

  const manifest = await readManifest();
  const gdgraph = (manifest.modules as Record<string, { enabled?: boolean; capabilities?: unknown[] }>)
    .gdgraph;
  expect(gdgraph?.enabled).toBe(true);
  const entry = gdgraph?.capabilities?.[0] as { id: string; enabled: boolean; kind: string };
  expect(entry.id).toBe("gdref.transform");
  expect(entry.enabled).toBe(true);
  expect(entry.kind).toBe("ceiling");
  // Other modules untouched.
  expect(
    (manifest.modules as Record<string, { enabled?: boolean }>).security?.enabled,
  ).toBe(true);

  const config = JSON.parse(
    await readFile(path.join(root, ".metaproject", "gdref.config.json"), "utf8"),
  ) as { capabilities: { transform: { enabled: boolean } } };
  expect(config.capabilities.transform.enabled).toBe(true);
});

test("init: empty selections leave the manifest byte-identical (golden rule)", async () => {
  const original = {
    modules: { gdgraph: { enabled: true, commands: ["build"] } },
  };
  await writeManifest(original);
  const before = await readFile(path.join(root, ".metaproject", "metaproject.json"), "utf8");

  await applyCapabilitySelections(root, parseCapabilitySelections([], registry));

  const after = await readFile(path.join(root, ".metaproject", "metaproject.json"), "utf8");
  expect(after).toBe(before);
});

test("config deep-merge overlays partial user config; malformed JSON falls back to defaults", async () => {
  // Partial user config: override one field, keep defaults for the rest.
  await writeFile(
    path.join(root, ".metaproject", "gdref.config.json"),
    JSON.stringify({ capabilities: { transform: { grammarsPath: "/custom" } } }),
    "utf8",
  );
  const merged = await loadCapabilityConfig(root, REFERENCE_CAPABILITY_DESCRIPTOR, true);
  const transform = (merged.capabilities as Record<string, Record<string, unknown>>).transform!;
  expect(transform.grammarsPath).toBe("/custom");
  expect(transform.enabled).toBe(true); // default preserved via deep-merge

  // Malformed JSON → defaults (never throws).
  await writeFile(
    path.join(root, ".metaproject", "gdref.config.json"),
    "{ not valid json",
    "utf8",
  );
  const fallback = await loadCapabilityConfig(root, REFERENCE_CAPABILITY_DESCRIPTOR, false);
  const fallbackTransform = (fallback.capabilities as Record<string, Record<string, unknown>>)
    .transform!;
  expect(fallbackTransform.enabled).toBe(false);
});

test("update: reconciles a new capability disabled without disabling enabled modules", async () => {
  await writeManifest({
    modules: {
      gdgraph: { enabled: true, commands: ["build"] },
      security: { enabled: true },
    },
  });

  await reconcileCapabilitiesOnUpdate(root, registry);

  const manifest = await readManifest();
  const modules = manifest.modules as Record<string, { enabled?: boolean; capabilities?: unknown[] }>;
  expect(modules.gdgraph?.enabled).toBe(true);
  expect(modules.security?.enabled).toBe(true);
  const entry = modules.gdgraph?.capabilities?.[0] as { id: string; enabled: boolean };
  expect(entry.id).toBe("gdref.transform");
  expect(entry.enabled).toBe(false); // ceilings default OFF on reconcile
});

test("update: preserves an operator-enabled capability's state", async () => {
  await writeManifest({
    modules: {
      gdgraph: {
        enabled: true,
        capabilities: [{ id: "gdref.transform", enabled: true, kind: "ceiling" }],
      },
    },
  });

  await reconcileCapabilitiesOnUpdate(root, registry);

  const manifest = await readManifest();
  const modules = manifest.modules as Record<string, { capabilities?: unknown[] }>;
  const entry = modules.gdgraph?.capabilities?.[0] as { enabled: boolean };
  expect(entry.enabled).toBe(true);
});

test("reconcileManifestCapability skips a selection whose module is absent", () => {
  const manifest: Record<string, unknown> = { modules: { security: { enabled: true } } };
  const changed = reconcileManifestCapability(manifest, {
    descriptor: REFERENCE_CAPABILITY_DESCRIPTOR,
    enabled: true,
  });
  expect(changed).toBe(false);
});

test("deepMerge merges nested objects and replaces arrays/scalars", () => {
  const base: Record<string, unknown> = { a: { x: 1, y: 2 }, list: [1] };
  const override: Record<string, unknown> = { a: { y: 9 }, list: [2, 3] };
  expect(deepMerge(base, override)).toEqual({
    a: { x: 1, y: 9 },
    list: [2, 3],
  });
});
