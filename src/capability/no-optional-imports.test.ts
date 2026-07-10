import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";

// Static guard (AC0-2, C0-2): no optional dependency may be imported at module
// top-level anywhere in `src/`. Optional deps are loaded ONLY via `await
// import(...)` inside an adapter. This scans every `src/**/*.ts` for a static
// `import ... from "<dep>"`, side-effect `import "<dep>"`, `export ... from
// "<dep>"`, or `require("<dep>")` naming an `optionalDependencies` entry.

const SRC_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PKG_ROOT = path.join(SRC_ROOT, "..");

async function tsFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await tsFiles(full)));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Build patterns that match STATIC imports/requires of `dep` but never the
// sanctioned dynamic `await import("<dep>")` (which uses `import(`, not `from`).
function staticImportPatterns(dep: string): RegExp[] {
  const d = escapeRegExp(dep);
  return [
    new RegExp(`\\bimport\\b[^()]*?\\bfrom\\s*['"]${d}['"]`, "s"),
    new RegExp(`\\bexport\\b[^()]*?\\bfrom\\s*['"]${d}['"]`, "s"),
    new RegExp(`\\bimport\\s*['"]${d}['"]`),
    new RegExp(`\\brequire\\s*\\(\\s*['"]${d}['"]\\s*\\)`),
  ];
}

test("no top-level import of any optionalDependencies package exists in src/", async () => {
  const pkg = JSON.parse(await readFile(path.join(PKG_ROOT, "package.json"), "utf8")) as {
    optionalDependencies?: Record<string, string>;
  };
  const optionalDeps = Object.keys(pkg.optionalDependencies ?? {});
  expect(optionalDeps.length).toBeGreaterThan(0);

  const files = await tsFiles(SRC_ROOT);
  const violations: string[] = [];

  for (const file of files) {
    const content = await readFile(file, "utf8");
    for (const dep of optionalDeps) {
      for (const pattern of staticImportPatterns(dep)) {
        if (pattern.test(content)) {
          violations.push(`${path.relative(PKG_ROOT, file)} statically imports "${dep}"`);
        }
      }
    }
  }

  expect(violations).toEqual([]);
});

// Block C (C0-2, AC-C0): `@xenova/transformers` — the memory embedding runtime —
// must be imported ONLY via the seam's lazy `await import()`, never statically,
// and specifically not by the embedding adapter that consumes it.
test("@xenova/transformers is never statically imported (embedding runtime guard)", async () => {
  const dep = "@xenova/transformers";
  const pkg = JSON.parse(await readFile(path.join(PKG_ROOT, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };
  // `@xenova/transformers` (the ~230MB ONNX embedding runtime) was removed in
  // favour of the deterministic fallbacks — it must NOT be declared as any
  // dependency. Any remaining reference in src must be a lazy `await import()`.
  expect(Object.keys(pkg.dependencies ?? {})).not.toContain(dep);
  expect(Object.keys(pkg.optionalDependencies ?? {})).not.toContain(dep);

  const files = await tsFiles(SRC_ROOT);
  const violations: string[] = [];
  for (const file of files) {
    const content = await readFile(file, "utf8");
    for (const pattern of staticImportPatterns(dep)) {
      if (pattern.test(content)) {
        violations.push(`${path.relative(PKG_ROOT, file)} statically imports "${dep}"`);
      }
    }
  }
  expect(violations).toEqual([]);

  // The adapter that consumes it must not name it in a static import/require.
  const adapter = await readFile(
    path.join(SRC_ROOT, "memory", "embedding", "adapter.ts"),
    "utf8",
  );
  expect(/from\s*['"]@xenova\/transformers['"]/.test(adapter)).toBe(false);
  expect(/require\s*\(\s*['"]@xenova\/transformers['"]/.test(adapter)).toBe(false);
});

// Block E (E1 / E4-NER): the security model adapters reuse the same optional
// transformers runtime — imported ONLY via the seam's lazy `await import()`.
// Neither adapter, nor the detect pipeline that wires them, may name the runtime
// in a static import/require.
test("security injection + NER adapters never statically import the model runtime", async () => {
  const dep = "@xenova/transformers";
  const targets = [
    path.join(SRC_ROOT, "security", "detect", "injection", "adapter.ts"),
    path.join(SRC_ROOT, "security", "detect", "pii", "ner-adapter.ts"),
    path.join(SRC_ROOT, "security", "detect", "index.ts"),
  ];
  for (const file of targets) {
    const content = await readFile(file, "utf8");
    for (const pattern of staticImportPatterns(dep)) {
      expect(`${path.relative(PKG_ROOT, file)}:${pattern.test(content)}`).toBe(
        `${path.relative(PKG_ROOT, file)}:false`,
      );
    }
  }
});

test("dependencies block stays empty (zero-dep floor, AC0-1)", async () => {
  const pkg = JSON.parse(await readFile(path.join(PKG_ROOT, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    scripts?: Record<string, string>;
  };
  expect(Object.keys(pkg.dependencies ?? {})).toEqual([]);

  // AC0-18: no install hook downloads assets/dependencies.
  const scripts = pkg.scripts ?? {};
  expect(scripts.postinstall).toBeUndefined();
  expect(scripts.preinstall).toBeUndefined();
  expect(scripts.install).toBeUndefined();
});
