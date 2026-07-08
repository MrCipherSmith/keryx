import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";

// AC1.5 (C0-2): `web-tree-sitter` is imported ONLY via `await import()` inside
// `src/gdgraph/treesitter/adapter.ts`. This is an ADDITIVE, gdgraph-specific
// assertion layered on the generic `src/capability/no-optional-imports.test.ts`
// (which already scans every optionalDependencies package across `src/`).

const SRC_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const ADAPTER = path.join(SRC_ROOT, "gdgraph", "treesitter", "adapter.ts");

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

test("no static import of web-tree-sitter anywhere in src/", async () => {
  const files = await tsFiles(SRC_ROOT);
  const staticImport = /\b(?:import|export)\b[^()]*?\bfrom\s*['"]web-tree-sitter['"]|\bimport\s*['"]web-tree-sitter['"]|\brequire\s*\(\s*['"]web-tree-sitter['"]\s*\)/;
  const violations: string[] = [];
  for (const file of files) {
    const content = await readFile(file, "utf8");
    if (staticImport.test(content)) {
      violations.push(path.relative(SRC_ROOT, file));
    }
  }
  expect(violations).toEqual([]);
});

test("adapter declares web-tree-sitter as a lazy optionalDependency, never a static import", async () => {
  const content = await readFile(ADAPTER, "utf8");
  // The dep is loaded lazily by the seam (`await import(spec.optionalDependency)`
  // in capability/seam.ts) using the id the adapter declares here.
  expect(content).toContain('optionalDependency: "web-tree-sitter"');
  // The adapter never statically imports the dep (types are structural).
  expect(/from\s*['"]web-tree-sitter['"]/.test(content)).toBe(false);

  const seam = await readFile(path.join(SRC_ROOT, "capability", "seam.ts"), "utf8");
  expect(seam).toContain("await import(spec.optionalDependency)");
});
