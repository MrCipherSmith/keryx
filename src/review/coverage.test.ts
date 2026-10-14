import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { coverageErrors, coverageWarnings, derivedFromFiles, globToRegExp, packageHasBlastRadius, packageScopeFiles, projectRootOfPackage, requiredReviewers } from "./coverage";

let root: string;

async function install(name: string): Promise<void> {
  const dir = path.join(root, ".metaproject", "skills", "gdskills", "review", name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: Use when testing ${name}.\n---\n`, "utf8");
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "keryx-coverage-"));
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  await writeFile(path.join(root, ".metaproject", "metaproject.json"), `${JSON.stringify({ modules: { gdskills: {} } })}\n`, "utf8");
  for (const name of [
    "review-orchestrator",
    "review-verifier",
    "review-logic",
    "review-architecture",
    "review-frontend",
    "review-style",
    "review-clean-code",
    "review-testing-practices",
    "review-core-boundaries",
  ])
    await install(name);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const frontendFiles = ["src/app/page.tsx", "src/app/page.store.ts"];

describe("derivedFromFiles", () => {
  test("frontend files pick logic, frontend and style, plus the convention and layout gates", () => {
    expect([...derivedFromFiles(frontendFiles)].sort()).toEqual([
      "review-frontend",
      "review-frontend-conventions",
      "review-layout",
      "review-logic",
      "review-style",
    ]);
  });

  test("an unrecognised diff falls back to logic and architecture", () => {
    expect([...derivedFromFiles(["README.md"])].sort()).toEqual(["review-architecture", "review-logic"]);
  });

  test("a test file adds testing-practices through its path gate", () => {
    expect(derivedFromFiles(["src/a.test.ts"]).has("review-testing-practices")).toBe(true);
  });
});

describe("requiredReviewers", () => {
  test("mode all lists every roster reviewer and leaves out the router and the verifier", async () => {
    const need = await requiredReviewers(root, "all", undefined);
    expect(need.required).toEqual([
      "review-architecture",
      "review-clean-code",
      "review-core-boundaries",
      "review-frontend",
      "review-logic",
      "review-style",
      "review-testing-practices",
    ]);
    expect(need.filesKnown).toBe(false);
  });

  test("a known file list rules out path-gated reviewers with no matching path, with the reason", async () => {
    const need = await requiredReviewers(root, "all", frontendFiles);
    expect(need.required).not.toContain("review-core-boundaries");
    expect(need.required).not.toContain("review-testing-practices");
    expect(need.excluded.find((e) => e.reviewer === "review-core-boundaries")?.reason).toContain("no-matching-paths");
    expect(need.required).toContain("review-clean-code");
  });

  test("mode diff narrows to the derived set", async () => {
    const need = await requiredReviewers(root, "diff", frontendFiles);
    expect(need.required).toEqual(["review-frontend", "review-logic", "review-style"]);
  });
});

describe("review-regression and the blast radius", () => {
  const withRadius = async (name: string, body: unknown): Promise<string> => {
    const dir = path.join(root, ".metaproject", "reviews", name);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "blast-radius.json"), JSON.stringify(body), "utf8");
    return dir;
  };

  test("a computed blast radius makes review-regression required, in both modes", async () => {
    await install("review-regression");
    for (const mode of ["all", "diff"] as const) {
      const need = await requiredReviewers(root, mode, frontendFiles, { blastRadius: true });
      expect(need.required).toContain("review-regression");
    }
  });

  test("no blast radius leaves review-regression out with a recorded reason", async () => {
    await install("review-regression");
    const need = await requiredReviewers(root, "all", frontendFiles);
    expect(need.required).not.toContain("review-regression");
    expect(need.excluded.find((e) => e.reviewer === "review-regression")?.reason).toContain("no blast radius computed");
  });

  test("a dispatch that skips review-regression is refused when a radius exists and passes when none was computed", async () => {
    await install("review-regression");
    const all = (await requiredReviewers(root, "all", frontendFiles)).required;
    const dispatch = { mode: "all", selected: all };
    expect(await coverageErrors(dispatch, { root, files: frontendFiles, blastRadius: true })).toEqual([
      expect.stringContaining("missing: review-regression"),
    ]);
    expect(await coverageErrors(dispatch, { root, files: frontendFiles, blastRadius: false })).toEqual([]);
  });

  test("packageHasBlastRadius reads the record and rejects a malformed one", async () => {
    const good = await withRadius("good", { files: [], changedFiles: ["a.ts"] });
    const bad = await withRadius("bad", { nothing: true });
    expect(await packageHasBlastRadius(good)).toBe(true);
    expect(await packageHasBlastRadius(bad)).toBe(false);
    expect(await packageHasBlastRadius(path.join(root, "missing"))).toBe(false);
  });
});

describe("globToRegExp", () => {
  test("a trailing /** matches every file under the directory", () => {
    const glob = globToRegExp("src/pipelines/**");
    expect(glob.test("src/pipelines/index.ts")).toBe(true);
    expect(glob.test("src/pipelines/a/b.ts")).toBe(true);
    expect(glob.test("src/pipelines2/index.ts")).toBe(false);
    expect(glob.test("src/other/index.ts")).toBe(false);
  });

  test("a middle ** spans zero or more directories", () => {
    const glob = globToRegExp("src/**/*.tsx");
    expect(glob.test("src/a.tsx")).toBe(true);
    expect(glob.test("src/a/b/c.tsx")).toBe(true);
    expect(glob.test("src/a/b/c.ts")).toBe(false);
  });
});

describe("project reviewers with description-derived globs", () => {
  async function installProject(name: string, description: string): Promise<void> {
    const dir = path.join(root, ".metaproject", "project-skills", "review", name);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n# body\n`, "utf8");
  }

  test("are selected when the scope matches, in both modes, and gated out when it does not", async () => {
    await installProject("review-house-domains", "Use when reviewing domains. Dispatched for --house, --all, src/analytics/** or src/pipelines/** changes.");
    await installProject("review-house-core", "Use when reviewing core. Dispatched for --house, --all, or src/core/** changes.");
    const files = ["src/pipelines/index.ts", "src/pipelines/steps/load.ts"];
    for (const mode of ["all", "diff"] as const) {
      const need = await requiredReviewers(root, mode, files);
      expect(need.required).toContain("review-house-domains");
      expect(need.required).not.toContain("review-house-core");
      expect(need.excluded.find((e) => e.reviewer === "review-house-core")?.reason).toContain("no-matching-paths");
    }
    const core = await requiredReviewers(root, "all", ["src/core/x.ts"]);
    expect(core.required).toContain("review-house-core");
    expect(core.excluded.some((e) => e.reviewer === "review-house-core")).toBe(false);
  });
});

describe("coverageErrors", () => {
  const all = ["review-architecture", "review-clean-code", "review-core-boundaries", "review-frontend", "review-logic", "review-style", "review-testing-practices"];

  test("a dispatch with no mode is refused", async () => {
    const errors = await coverageErrors({ selected: all }, { root });
    expect(errors.join()).toContain("must declare mode");
  });

  test("mode all with a reviewer missing names it", async () => {
    const errors = await coverageErrors({ mode: "all", selected: all.filter((n) => n !== "review-clean-code") }, { root });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("missing: review-clean-code");
  });

  test("mode all with the full set passes", async () => {
    expect(await coverageErrors({ mode: "all", selected: all }, { root })).toEqual([]);
  });

  test("mode diff with the derived set passes when the operator named the narrower review, and extra reviewers are allowed", async () => {
    const selected = ["review-frontend", "review-logic", "review-style", "review-clean-code"];
    const operatorQuote = "только по диффу, без остального";
    expect(await coverageErrors({ mode: "diff", selected, operatorQuote }, { root, files: frontendFiles })).toEqual([]);
  });

  test("mode diff without the operator's quote is refused, whatever the set", async () => {
    const selected = ["review-frontend", "review-logic", "review-style"];
    for (const operatorQuote of [undefined, "", "  ", 3]) {
      const errors = await coverageErrors({ mode: "diff", selected, operatorQuote }, { root, files: frontendFiles });
      expect(errors.join()).toContain("needs operatorQuote");
    }
  });

  test("mode diff without a scope file list is refused", async () => {
    const errors = await coverageErrors({ mode: "diff", selected: ["review-logic"], operatorQuote: "только по диффу" }, { root });
    expect(errors.join()).toContain("scope-A file list");
  });

  test("a smaller set passes with an override that carries the operator's quote and a reason", async () => {
    const override = { operatorQuote: "только логика, остальное не нужно", reason: "operator asked for logic only" };
    expect(await coverageErrors({ mode: "all", selected: ["review-logic"], override }, { root })).toEqual([]);
  });

  test("an override without the quote or the reason does not excuse a smaller set", async () => {
    for (const override of [{ reason: "x" }, { operatorQuote: "x" }, { operatorQuote: " ", reason: "x" }, "yes"]) {
      const errors = await coverageErrors({ mode: "all", selected: ["review-logic"], override }, { root });
      expect(errors.join()).toContain("operatorQuote");
    }
  });
});

describe("package helpers", () => {
  test("scope-files.json round-trips and a missing or malformed file reads as unknown", async () => {
    const dir = path.join(root, ".metaproject", "reviews", "r1");
    await mkdir(dir, { recursive: true });
    expect(await packageScopeFiles(dir)).toBeUndefined();
    await writeFile(path.join(dir, "scope-files.json"), JSON.stringify({ version: 1, files: ["a.ts"] }), "utf8");
    expect(await packageScopeFiles(dir)).toEqual(["a.ts"]);
    await writeFile(path.join(dir, "scope-files.json"), JSON.stringify({ files: [1] }), "utf8");
    expect(await packageScopeFiles(dir)).toBeUndefined();
    expect(projectRootOfPackage(dir)).toBe(root);
  });
});

describe("review-pr-contract on packages already in flight", () => {
  const prFiles = ["src/app/page.tsx"];

  async function withoutIt(): Promise<string[]> {
    await install("review-pr-contract");
    return (await requiredReviewers(root, "all", prFiles)).required;
  }

  test("a dispatch that does not name the role is not refused, and warns that the package predates it", async () => {
    const dispatch = { mode: "all", selected: await withoutIt() };
    expect(await coverageErrors(dispatch, { root, files: prFiles, prContext: true })).toEqual([]);
    expect(coverageWarnings(dispatch, { prContext: true })).toEqual(["review-pr-contract not run (package predates the role)"]);
  });

  test("a dispatch written by a version that knows the role must cover it", async () => {
    const dispatch = { mode: "all", selected: await withoutIt(), roles: ["review-pr-contract"] };
    expect(await coverageErrors(dispatch, { root, files: prFiles, prContext: true })).toEqual([expect.stringContaining("missing: review-pr-contract")]);
    expect(coverageWarnings(dispatch, { prContext: true })).toEqual([]);
    const covered = { ...dispatch, selected: [...dispatch.selected, "review-pr-contract"] };
    expect(await coverageErrors(covered, { root, files: prFiles, prContext: true })).toEqual([]);
  });

  test("no warning without pr-context.md, or when the role was dispatched anyway", async () => {
    const selected = await withoutIt();
    expect(coverageWarnings({ mode: "all", selected }, { prContext: false })).toEqual([]);
    expect(coverageWarnings({ mode: "all", selected: [...selected, "review-pr-contract"] }, { prContext: true })).toEqual([]);
  });
});
