import { expect, test } from "bun:test";
import { codeOnly, isCodeFile, parseNameStatus, totalChanges } from "./diff";

test("parseNameStatus classifies A / M / D", () => {
  const out = ["A\tsrc/a.ts", "M\tsrc/b.ts", "D\tsrc/c.ts"].join("\n");
  const diff = parseNameStatus(out);
  expect(diff.added).toEqual(["src/a.ts"]);
  expect(diff.modified).toEqual(["src/b.ts"]);
  expect(diff.deleted).toEqual(["src/c.ts"]);
  expect(totalChanges(diff)).toBe(3);
});

test("parseNameStatus splits a rename into delete(old) + add(new)", () => {
  const diff = parseNameStatus("R100\tsrc/old.ts\tsrc/new.ts");
  expect(diff.deleted).toEqual(["src/old.ts"]);
  expect(diff.added).toEqual(["src/new.ts"]);
});

test("parseNameStatus ignores blank lines", () => {
  expect(totalChanges(parseNameStatus("\n\n"))).toBe(0);
});

test("codeOnly keeps source files, drops docs/config/assets", () => {
  const diff = parseNameStatus(
    ["A\tsrc/a.ts", "A\tREADME.md", "M\tpackage.json", "D\tsrc/b.tsx", "A\tlogo.svg"].join("\n"),
  );
  const code = codeOnly(diff);
  expect(code.added).toEqual(["src/a.ts"]);
  expect(code.deleted).toEqual(["src/b.tsx"]);
  expect(code.modified).toEqual([]); // package.json is not code
});

test("isCodeFile recognizes common source extensions", () => {
  expect(isCodeFile("src/x.ts")).toBe(true);
  expect(isCodeFile("a/b.vue")).toBe(true);
  expect(isCodeFile("notes.md")).toBe(false);
  expect(isCodeFile("data.json")).toBe(false);
});
