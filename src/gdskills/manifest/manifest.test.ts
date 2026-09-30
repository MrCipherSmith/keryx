import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  bundledManifestPath,
  defaultBundledSourceRoot,
  InvalidInstallManifestError,
  loadBundledManifest,
  parseInstallManifest,
  validateInstallManifest,
} from "./manifest";

test("the bundled install-manifest.json validates against install-manifest.schema.json", () => {
  const manifest = loadBundledManifest();
  expect(manifest.schemaVersion).toBe("1.0.0");
  expect(Object.keys(manifest.profiles).sort()).toEqual([
    "angular",
    "c-cpp",
    "ci-github-gitlab",
    "core",
    "csharp-dotnet",
    "django",
    "docker-k8s-terraform",
    "fastapi",
    "flutter-dart",
    "full",
    "go",
    "java-kotlin-spring",
    "kotlin-android",
    "minimal",
    "nestjs",
    "nextjs-nuxt",
    "php-laravel",
    "python",
    "react",
    "ruby-rails",
    "rust",
    "sql-db",
    "swift-ios",
    "ts-js-node",
    "vue",
  ]);
});

// Flow 360 (AC10). The published package is a FLAT bundle: every module is
// inlined into `<pkg>/dist/cli.js`, so "this module's directory" is `<pkg>/dist`
// — not `<pkg>/src/gdskills/manifest`. The manifest itself ships at
// `<pkg>/src/gdskills/bundled/install-manifest.json`. These build that layout on
// disk and resolve from it; the source layout is covered by every other test in
// this file, which is why it never caught the published ENOENT.
function flatPackage(): { pkg: string; dist: string; manifest: string } {
  const pkg = mkdtempSync(path.join(tmpdir(), "keryx-flat-pkg-"));
  const dist = path.join(pkg, "dist");
  const bundled = path.join(pkg, "src", "gdskills", "bundled");
  mkdirSync(dist, { recursive: true });
  mkdirSync(bundled, { recursive: true });
  const manifest = path.join(bundled, "install-manifest.json");
  writeFileSync(manifest, "{}\n");
  return { pkg, dist, manifest };
}

test("bundledManifestPath resolves the shipped manifest from the flat published dist/ layout", () => {
  const { pkg, dist, manifest } = flatPackage();
  try {
    const resolved = bundledManifestPath(dist);
    expect(path.resolve(resolved)).toBe(manifest);
    expect(existsSync(resolved)).toBe(true);
  } finally {
    rmSync(pkg, { recursive: true, force: true });
  }
});

test("defaultBundledSourceRoot is the package root from the flat published dist/ layout", () => {
  const { pkg, dist } = flatPackage();
  try {
    expect(path.resolve(defaultBundledSourceRoot(dist))).toBe(pkg);
  } finally {
    rmSync(pkg, { recursive: true, force: true });
  }
});

// The packaged candidate is tried FIRST. From `<pkg>/dist` the source-layout
// candidate is three directories up — outside the package, in whatever the
// package is installed under. When that directory also holds a
// `src/gdskills/bundled` (keryx installed into a checkout of keryx, which is
// how it is developed), source-first would read the host's tree and not the
// installed package's.
test("defaultBundledSourceRoot prefers the package's own bundled tree over one three levels up", () => {
  const host = mkdtempSync(path.join(tmpdir(), "keryx-host-"));
  try {
    const pkg = path.join(host, "node_modules", "keryx");
    const dist = path.join(pkg, "dist");
    mkdirSync(dist, { recursive: true });
    mkdirSync(path.join(pkg, "src", "gdskills", "bundled"), { recursive: true });
    mkdirSync(path.join(host, "src", "gdskills", "bundled"), { recursive: true });
    // Both candidates exist; only the order decides.
    expect(path.resolve(dist, "..", "..", "..")).toBe(host);
    expect(path.resolve(defaultBundledSourceRoot(dist))).toBe(pkg);
    expect(path.resolve(bundledManifestPath(dist))).toBe(
      path.join(pkg, "src", "gdskills", "bundled", "install-manifest.json"),
    );
  } finally {
    rmSync(host, { recursive: true, force: true });
  }
});

test("both resolvers still resolve from the source layout, and agree with each other", () => {
  const manifest = bundledManifestPath();
  expect(existsSync(manifest)).toBe(true);
  expect(path.resolve(manifest)).toBe(
    path.join(path.resolve(defaultBundledSourceRoot()), "src", "gdskills", "bundled", "install-manifest.json"),
  );
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
