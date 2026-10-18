import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { keywordOccurs, resolveReferences } from "./reference-entries";

test("keywordOccurs: a keyword starting or ending with a symbol still matches where it stands", () => {
  expect(keywordOccurs("rename the .css files", ".css")).toBe(true);
  expect(keywordOccurs("use @apply in the sheet", "@apply")).toBe(true);
  expect(keywordOccurs("add c++ bindings", "c++")).toBe(true);
  expect(keywordOccurs("USE @APPLY", "@apply")).toBe(true);
});

test("keywordOccurs: no boundary is demanded on a symbol edge, one is kept on the word side", () => {
  expect(keywordOccurs("fix styles.css please", ".css")).toBe(true);
  expect(keywordOccurs("a@apply", "@apply")).toBe(true);
  expect(keywordOccurs("c++x", "c++")).toBe(true);
  expect(keywordOccurs("xc++", "c++")).toBe(false);
  expect(keywordOccurs("the .cssx file", ".css")).toBe(false);
  expect(keywordOccurs("the .css3 file", ".css")).toBe(false);
});

test("keywordOccurs: a word keyword is a whole word, digits and underscore count as word characters", () => {
  expect(keywordOccurs("fix the css", "css")).toBe(true);
  expect(keywordOccurs("fix the css.", "css")).toBe(true);
  expect(keywordOccurs("upgrade to css3", "css")).toBe(false);
  expect(keywordOccurs("rename my_css", "css")).toBe(false);
  expect(keywordOccurs("rename css_modules", "css")).toBe(false);
  expect(keywordOccurs("тёмная тема", "тема")).toBe(true);
  expect(keywordOccurs("подтема", "тема")).toBe(false);
  expect(keywordOccurs("anything", "")).toBe(false);
});

test("keywordOccurs: regular-expression characters in a keyword are literal", () => {
  expect(keywordOccurs("see axb here", "a.b")).toBe(false);
  expect(keywordOccurs("see a.b here", "a.b")).toBe(true);
  expect(keywordOccurs("(draft)", "(draft)")).toBe(true);
  expect(keywordOccurs("aaa", "a+")).toBe(false);
});

test("resolveReferences: a declaration naming an already-listed path is skipped with a warning, the others stay", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-reference-entries-"));
  try {
    await mkdir(path.join(root, "docs"), { recursive: true });
    await writeFile(path.join(root, "TAKEN.md"), "# Taken\n\nSome text.\n", "utf8");
    await writeFile(path.join(root, "docs", "FREE.md"), "# Free\n\nOther text.\n", "utf8");
    const declare = (file: string) => ({ path: file, when: { globs: [] as string[], keywords: ["dark mode"] }, description: `Notes in ${file}.` });
    const result = await resolveReferences({
      projectRoot: root,
      declarations: [declare("TAKEN.md"), declare("docs/FREE.md")],
      files: [],
      taskText: "Add a dark mode switch",
      taken: new Set(["TAKEN.md"]),
      maxFileBytes: 1_000_000,
    });
    expect(result.entries.map((entry) => entry.path)).toEqual(["docs/FREE.md"]);
    expect(result.entries[0]).toMatchObject({ tier: "must_read", reason: "condition:keyword:dark mode" });
    expect(result.warnings.some((warning) => warning.startsWith("TAKEN.md:") && warning.includes("already listed"))).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
