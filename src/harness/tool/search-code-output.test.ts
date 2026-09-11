// K-008 (arena, flow 249): what `search_code` hands the model.
//
// Every match line carried the checkout's absolute root, because the confined path
// went to ripgrep absolute; a search for `6435` returned 8 KB from one SVG line;
// and a clipped result said only `…(truncated)`. Run against the real adapter and
// the real ripgrep, since the defect was in the argv, not in any stub.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createMetaprojectAdapter } from "./metaproject-adapter";

let root: string;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "search-code-output-"));
  mkdirSync(path.join(root, "src", "nested"), { recursive: true });
  writeFileSync(path.join(root, "src", "nested", "a.ts"), "export const needle = 1;\n");
  // One enormous line, the shape of a minified bundle or an inlined SVG.
  writeFileSync(path.join(root, "src", "logo.svg"), `<svg>${"M0 0L1 1 ".repeat(2000)}needle</svg>\n`);
  // Enough matching lines to overflow the 20,000-byte cap.
  writeFileSync(
    path.join(root, "src", "many.ts"),
    Array.from({ length: 2000 }, (_, i) => `const haystack${i} = "haystack";`).join("\n"),
  );
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

test("paths are project-relative when a path is given", async () => {
  const result = await createMetaprojectAdapter(root).searchCode({ pattern: "needle", path: "src" });
  expect(result.isError).toBe(false);
  expect(result.output).toContain("src/nested/a.ts:1:");
  // No line may carry the absolute root — not the mkdtemp path, not its realpath.
  for (const line of result.output.split("\n")) {
    expect(line.startsWith("/")).toBe(false);
    expect(line).not.toContain(root);
  }
});

test("a path of the project root itself still searches, relatively", async () => {
  const result = await createMetaprojectAdapter(root).searchCode({ pattern: "needle", path: "." });
  expect(result.output).toContain("src/nested/a.ts");
  expect(result.output).not.toContain(root);
});

test("an enormous matching line is capped, not returned whole", async () => {
  const result = await createMetaprojectAdapter(root).searchCode({ pattern: "needle", path: "src/logo.svg" });
  expect(result.isError).toBe(false);
  const longest = Math.max(...result.output.split("\n").map((line) => line.length));
  // 400 columns of preview plus ripgrep's own path:line:col prefix and omission note.
  expect(longest).toBeLessThan(600);
  expect(result.output.length).toBeLessThan(2000);
});

test("a clipped result says how many lines were shown out of how many", async () => {
  const result = await createMetaprojectAdapter(root).searchCode({ pattern: "haystack", path: "src" });
  expect(result.truncated).toBe(true);
  const note = /…\(truncated: showing (\d+) of (\d+) lines/.exec(result.output);
  expect(note).not.toBeNull();
  const shown = Number(note?.[1]);
  const total = Number(note?.[2]);
  expect(total).toBe(2000);
  expect(shown).toBeGreaterThan(0);
  expect(shown).toBeLessThan(total);
  // The cut is at a line boundary: the line before the note is a whole match line.
  const lines = result.output.split("\n");
  expect(lines.at(-2)).toMatch(/^src\/many\.ts:\d+:\d+:const haystack\d+ = "haystack";$/);
});
