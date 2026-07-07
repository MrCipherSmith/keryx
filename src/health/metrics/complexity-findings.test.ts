import { test, expect } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getComplexityFindings } from "./complexity-findings";
import { DEFAULT_HEALTH_CONFIG } from "../config";
import { listSourceFiles } from "../util";

test("emits one P2 finding per file with functions over the threshold", async () => {
  const root = path.join(import.meta.dir, "..", "..", "..", ".tmp-cx-findings");
  await rm(root, { recursive: true, force: true });
  await mkdir(path.join(root, "src"), { recursive: true });

  // 14 `&&` + 1 ternary -> complexity 16, above the default threshold of 10.
  const conditions = Array.from({ length: 14 }, (_, i) => `a > ${i} && `).join("");
  await writeFile(
    path.join(root, "src", "complex.ts"),
    `export function big(a: number) { return ${conditions}true ? 1 : 2; }\n`,
  );
  await writeFile(path.join(root, "src", "simple.ts"), "export const x = 1;\n");

  try {
    const findings = await getComplexityFindings(
      root,
      ["src/complex.ts", "src/simple.ts"],
      DEFAULT_HEALTH_CONFIG,
    );
    expect(findings.length).toBe(1);
    expect(findings[0]?.file).toBe("src/complex.ts");
    expect(findings[0]?.priority).toBe("P2");
    expect(findings[0]?.category).toBe("complexity");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source file discovery ignores generated and static output paths", async () => {
  const root = path.join(import.meta.dir, "..", "..", "..", ".tmp-health-ignore");
  await rm(root, { recursive: true, force: true });
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "storybook-static", "assets"), { recursive: true });
  await mkdir(path.join(root, "public", "assets"), { recursive: true });
  await mkdir(path.join(root, "apps", "web", "public", "assets"), { recursive: true });
  await mkdir(path.join(root, "assets"), { recursive: true });
  await writeFile(path.join(root, "src", "keep.ts"), "export const keep = 1;\n");
  await writeFile(path.join(root, "storybook-static", "assets", "bundle.js"), "function generated() {}\n");
  await writeFile(path.join(root, "public", "worker.js"), "function generated() {}\n");
  await writeFile(path.join(root, "public", "assets", "generated.js"), "function generated() {}\n");
  await writeFile(path.join(root, "apps", "web", "public", "assets", "chunk.js"), "function generated() {}\n");
  await writeFile(path.join(root, "assets", "bundle.js"), "function generated() {}\n");

  try {
    await expect(listSourceFiles(root, DEFAULT_HEALTH_CONFIG.ignore.paths)).resolves.toEqual([
      "src/keep.ts",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
