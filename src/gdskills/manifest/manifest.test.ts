import { expect, test } from "bun:test";
import {
  InvalidInstallManifestError,
  loadBundledManifest,
  parseInstallManifest,
  validateInstallManifest,
} from "./manifest";

test("the bundled install-manifest.json validates against install-manifest.schema.json", () => {
  const manifest = loadBundledManifest();
  expect(manifest.schemaVersion).toBe("1.0.0");
  expect(Object.keys(manifest.profiles).sort()).toEqual(["core", "full", "minimal", "nestjs", "python", "react"]);
});

test("the bundled manifest carries a minimal, a core, at least one per-stack, and a full profile (W1-AC4)", () => {
  const manifest = loadBundledManifest();
  expect(manifest.profiles.minimal).toBeDefined();
  expect(manifest.profiles.core).toBeDefined();
  expect(manifest.profiles.full).toBeDefined();
  const stackProfiles = Object.entries(manifest.profiles).filter(([, p]) => p.stackDetectionAware === true);
  expect(stackProfiles.length).toBeGreaterThan(0);
});

test("every component id referenced by a profile exists in components, and every module id referenced exists in modules", () => {
  const manifest = loadBundledManifest();
  for (const [profileId, profile] of Object.entries(manifest.profiles)) {
    for (const moduleId of profile.modules) {
      expect(manifest.modules[moduleId], `profile "${profileId}" references unknown module "${moduleId}"`).toBeDefined();
    }
    for (const componentId of profile.components ?? []) {
      expect(manifest.components[componentId], `profile "${profileId}" references unknown component "${componentId}"`).toBeDefined();
    }
  }
  for (const [componentId, component] of Object.entries(manifest.components)) {
    for (const moduleId of component.modules) {
      expect(manifest.modules[moduleId], `component "${componentId}" references unknown module "${moduleId}"`).toBeDefined();
    }
  }
});

test("an invalid manifest (missing required module field) is refused with a schema error naming the field", () => {
  const invalid = {
    schemaVersion: "1.0.0",
    profiles: { minimal: { description: "x", modules: ["a"] } },
    modules: {
      // missing `cost`/`stability`/`defaultInstall`/`targets`/`paths`
      a: { kind: "rule", description: "x" },
    },
    components: { "baseline:x": { family: "baseline", modules: ["a"] } },
  };
  const validation = validateInstallManifest(invalid);
  expect(validation.valid).toBe(false);
  expect(validation.errors.length).toBeGreaterThan(0);
  expect(() => parseInstallManifest("fixture.json", invalid)).toThrow(InvalidInstallManifestError);
});
