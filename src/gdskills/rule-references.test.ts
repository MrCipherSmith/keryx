import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  literalRulePath,
  projectRulePath,
  resolveRuleReference,
  ruleReferences,
  shadowedRuleReferences,
  unresolvedRuleReferences,
} from "./rule-references";

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "keryx-rule-references-"));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

async function writeRule(relative: string, content = "x"): Promise<void> {
  const file = path.join(cwd, ".metaproject", "rules", relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, "utf8");
}

describe("the project slot of a rule reference", () => {
  test("is keyed on the whole reference, so two rules that share a filename get two slots", () => {
    expect(projectRulePath("core/x.mdc")).toBe(".metaproject/rules/project/core/x.mdc");
    expect(projectRulePath("house/x.mdc")).toBe(".metaproject/rules/project/house/x.mdc");
    expect(literalRulePath("core/x.mdc")).toBe(".metaproject/rules/core/x.mdc");
  });

  test("answers before the file the reference names, and only then is the reference shadowed", async () => {
    await writeRule("core/x.mdc");
    expect(await resolveRuleReference(cwd, "core/x.mdc")).toEqual({
      ref: "core/x.mdc",
      project: ".metaproject/rules/project/core/x.mdc",
      literal: ".metaproject/rules/core/x.mdc",
      resolved: ".metaproject/rules/core/x.mdc",
      shadowed: false,
    });

    await writeRule("project/core/x.mdc");
    expect(await resolveRuleReference(cwd, "core/x.mdc")).toMatchObject({
      resolved: ".metaproject/rules/project/core/x.mdc",
      shadowed: true,
    });
    // The slot belongs to `core/x.mdc` alone.
    expect(await resolveRuleReference(cwd, "house/x.mdc")).toMatchObject({ shadowed: false });
    expect((await resolveRuleReference(cwd, "house/x.mdc")).resolved).toBeUndefined();
  });

  test("a file lying directly in rules/project resolves no reference into another directory", async () => {
    // The basename layout this replaced: `rules/project/x.mdc` answered
    // `core/x.mdc` and `house/x.mdc` alike.
    await writeRule("project/x.mdc");
    const content = "Standards: `core/x.mdc`, `house/x.mdc`.";
    expect(await unresolvedRuleReferences(cwd, content)).toEqual(["core/x.mdc", "house/x.mdc"]);
    expect(await shadowedRuleReferences(cwd, content)).toEqual([]);
  });

  test("a reference that names rules/project itself reads that file, and is not shadowed", async () => {
    await writeRule("project/x.mdc");
    expect(await resolveRuleReference(cwd, "project/x.mdc")).toMatchObject({
      resolved: ".metaproject/rules/project/x.mdc",
      shadowed: false,
    });
    expect(await shadowedRuleReferences(cwd, "Standard: `project/x.mdc`.")).toEqual([]);
    expect(await unresolvedRuleReferences(cwd, "Standard: `project/x.mdc`.")).toEqual([]);
  });
});

describe("a reference whose directory differs only in case from the one keryx installs", () => {
  test("is read as that directory, so every caller sees one reference", () => {
    // `Core/` is `core/` on a case-insensitive filesystem: the directory
    // `keryx init`, `update` and `skills install` overwrite.
    expect(ruleReferences("`Core/security-baseline.mdc`, `CORE/x.mdc`, `.metaproject/rules/cOrE/y.mdc`")).toEqual([
      "core/security-baseline.mdc",
      "core/x.mdc",
      "core/y.mdc",
    ]);
    // Two spellings of one rule are one reference.
    expect(ruleReferences("`core/x.mdc` and `Core/x.mdc`")).toEqual(["core/x.mdc"]);
    // A directory keryx does not install keeps its spelling.
    expect(ruleReferences("`House/Naming.mdc`")).toEqual(["House/Naming.mdc"]);
  });
});

describe("a cited path that exists but is not a regular file", () => {
  test("resolves no reference, and is named in the resolution", async () => {
    await mkdir(path.join(cwd, ".metaproject", "rules", "house", "x.mdc"), { recursive: true });
    expect(await resolveRuleReference(cwd, "house/x.mdc")).toEqual({
      ref: "house/x.mdc",
      project: ".metaproject/rules/project/house/x.mdc",
      literal: ".metaproject/rules/house/x.mdc",
      shadowed: false,
      notRegularFiles: [".metaproject/rules/house/x.mdc"],
    });
    expect(await unresolvedRuleReferences(cwd, "Read `house/x.mdc`.")).toEqual(["house/x.mdc"]);
  });

  test("a directory in the project slot gives way to the file the reference names", async () => {
    await mkdir(path.join(cwd, ".metaproject", "rules", "project", "house", "x.mdc"), { recursive: true });
    await writeRule("house/x.mdc");
    expect(await resolveRuleReference(cwd, "house/x.mdc")).toMatchObject({
      resolved: ".metaproject/rules/house/x.mdc",
      shadowed: false,
      notRegularFiles: [".metaproject/rules/project/house/x.mdc"],
    });
    expect(await shadowedRuleReferences(cwd, "Read `house/x.mdc`.")).toEqual([]);
  });
});
