import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { coverageErrors, coverageWarnings, decideRoundDepth, derivedFromFiles, globToRegExp, packageHasBlastRadius, packageRoundDepth, packageScopeFiles, projectRootOfPackage, requiredReviewers, widestDiff } from "./coverage";
import { commitFiles, git, initRepo } from "./git-fixture.test-helpers";

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

describe("round depth (light vs full)", () => {
  const small = ["src/a.ts", "src/b.ts"];
  const files = (n: number): string[] => Array.from({ length: n }, (_, i) => `src/f${i}.ts`);

  test("5 files and 300 lines is a light round, outside the risk class", async () => {
    const d = await decideRoundDepth(root, "auto", { files: files(5), changedLines: 300 });
    expect(d.depth).toBe("light");
    expect(d.reason).toContain("5 file(s), 300 changed line(s)");
  });

  test("6 files is full, and the reason names the limit", async () => {
    const d = await decideRoundDepth(root, "auto", { files: files(6), changedLines: 10 });
    expect(d.depth).toBe("full");
    expect(d.reason).toContain("6 files exceeds 5");
  });

  test("301 changed lines is full", async () => {
    const d = await decideRoundDepth(root, "auto", { files: small, changedLines: 301 });
    expect(d.depth).toBe("full");
    expect(d.reason).toContain("301 changed lines exceeds 300");
  });

  test("a risk-class path gate hit on a small diff is full", async () => {
    const d = await decideRoundDepth(root, "auto", { files: ["src/core/store.ts"], changedLines: 5 });
    expect(d.depth).toBe("full");
    expect(d.reason).toContain("review-core-boundaries");
  });

  test("a test file or a plain .ts file alone does not count as the risk class", async () => {
    expect((await decideRoundDepth(root, "auto", { files: ["src/a.test.ts", "src/a.ts"], changedLines: 40 })).depth).toBe("light");
  });

  test("--depth light is honoured only where auto would say light", async () => {
    expect((await decideRoundDepth(root, "light", { files: small, changedLines: 20 })).depth).toBe("light");
    const big = await decideRoundDepth(root, "light", { files: files(60), changedLines: 20 });
    expect(big).toMatchObject({ depth: "full", requested: "light" });
    expect(big.reason).toContain("--depth light not honoured");
    expect((await decideRoundDepth(root, "light", { files: ["src/core/store.ts"], changedLines: 5 })).depth).toBe("full");
    expect((await decideRoundDepth(root, "light", { files: small, changedLines: 1, forceFull: "--all" })).depth).toBe("full");
    expect((await decideRoundDepth(root, "light", { files: small })).reason).toContain("no line count");
  });

  test("--depth full overrides a small diff; --all and --gating force full; unknown size is full", async () => {
    expect((await decideRoundDepth(root, "full", { files: small, changedLines: 1 })).depth).toBe("full");
    expect((await decideRoundDepth(root, "auto", { files: small, changedLines: 1, forceFull: "--all" })).depth).toBe("full");
    expect((await decideRoundDepth(root, "auto", { files: small })).reason).toContain("changed-line count unknown");
  });

  test("the light set is logic, testing and one conventions reviewer; full is unchanged", async () => {
    const light = await requiredReviewers(root, "all", small, { depth: "light" });
    expect(light.depth).toBe("light");
    expect(light.required).toEqual(["review-clean-code", "review-logic", "review-testing-practices"]);
    expect(light.excluded.find((e) => e.reviewer === "review-style")?.reason).toContain("light round");
    const full = await requiredReviewers(root, "all", undefined);
    expect(full.depth).toBe("full");
    expect(full.required).toContain("review-style");
  });
});

describe("round-depth.json is tied to the package it was decided for", () => {
  const files = ["src/a.ts", "src/b.ts"];
  async function setup(recorded: Record<string, unknown>, scope: Record<string, unknown> = { version: 1, files, changedLines: 40 }): Promise<string> {
    const dir = path.join(root, ".metaproject", "reviews", "r1");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "scope-files.json"), JSON.stringify(scope));
    await writeFile(path.join(dir, "manifest.json"), JSON.stringify({ target: { head: "aaa" } }));
    await writeFile(path.join(dir, "round-depth.json"), JSON.stringify({ requested: "auto", depth: "light", reason: "auto: small", ...recorded }));
    return dir;
  }

  test("a matching record is read back as light", async () => {
    const dir = await setup({ head: "aaa", files, changedLines: 40 });
    expect(await packageRoundDepth(dir)).toMatchObject({ depth: "light" });
  });

  test("a scope that changed since falls back to full and says why", async () => {
    const dir = await setup({ head: "aaa", files, changedLines: 40 }, { version: 1, files: Array.from({ length: 60 }, (_, i) => `src/f${i}.ts`), changedLines: 40 });
    const decision = await packageRoundDepth(dir);
    expect(decision).toMatchObject({ depth: "full" });
    expect(decision?.stale).toContain("scope file list");
  });

  test("a different line count or head is stale; a record without a file list is stale", async () => {
    expect((await packageRoundDepth(await setup({ head: "aaa", files, changedLines: 41 })))?.stale).toContain("line count");
    expect((await packageRoundDepth(await setup({ head: "bbb", files, changedLines: 40 })))?.stale).toContain("head");
    expect((await packageRoundDepth(await setup({ head: "aaa" })))?.stale).toContain("scope file list");
  });
});

describe("mutation gate by round depth", () => {
  const attended = { attended: true, pendingMutants: 3 } as const;

  test("a full attended round with pending mutants is still refused", async () => {
    const full = await requiredReviewers(root, "all", undefined);
    const errors = await coverageErrors({ mode: "all", depth: "full", selected: full.required }, { root, ...attended });
    expect(errors.join("\n")).toContain("never run");
    const legacy = await coverageErrors({ mode: "all", selected: full.required }, { root, ...attended });
    expect(legacy.join("\n")).toContain("never run");
  });

  const lightScope = { files: ["src/a.ts", "src/b.ts"], changedLines: 40 } as const;
  const bigScope = { files: Array.from({ length: 60 }, (_, i) => `src/f${i}.ts`), changedLines: 40 } as const;

  test("a light round on a real light scope is not refused for pending mutants", async () => {
    const light = await requiredReviewers(root, "all", lightScope.files, { depth: "light" });
    expect(await coverageErrors({ mode: "all", depth: "light", selected: light.required }, { root, ...attended, ...lightScope })).toEqual([]);
  });

  test("a forged light depth on a 60-file scope gets the full-round rules", async () => {
    const light = await requiredReviewers(root, "all", bigScope.files, { depth: "light" });
    const errors = (await coverageErrors({ mode: "all", depth: "light", selected: light.required }, { root, ...attended, ...bigScope })).join("\n");
    expect(errors).toContain("missing: review-architecture");
    expect(errors).toContain("depth light, but the full set applies: 60 files exceeds 5");
    expect(errors).toContain("never run");
  });

  test("a forged light depth on a risk-path scope is refused", async () => {
    const files = ["src/core/store.ts"];
    const light = await requiredReviewers(root, "all", files, { depth: "light" });
    const errors = (await coverageErrors({ mode: "all", depth: "light", selected: light.required }, { root, ...attended, files, changedLines: 5 })).join("\n");
    expect(errors).toContain("review-core-boundaries");
    expect(errors).toContain("never run");
  });

  test("a light dispatch without a known line count is not accepted", async () => {
    const light = await requiredReviewers(root, "all", lightScope.files, { depth: "light" });
    const errors = await coverageErrors({ mode: "all", depth: "light", selected: light.required }, { root, ...attended, files: lightScope.files });
    expect(errors.join("\n")).toContain("no line count");
  });

  test("a light dispatch still must cover the light set", async () => {
    const errors = await coverageErrors({ mode: "all", depth: "light", selected: ["review-logic"] }, { root, ...attended });
    expect(errors.join("\n")).toContain("missing");
  });
});

describe("light depth cannot be forged", () => {
  const attended = { attended: true, pendingMutants: 3 } as const;
  const files = ["src/a.ts", "src/b.ts"];

  test("a forged changedLines is overruled by the diff recomputed from git", async () => {
    const light = await requiredReviewers(root, "all", files, { depth: "light" });
    const errors = (
      await coverageErrors(
        { mode: "all", depth: "light", selected: light.required },
        { root, ...attended, files, changedLines: 10, diffStats: async () => ({ files, changedLines: 3000 }) },
      )
    ).join("\n");
    expect(errors).toContain("3000 changed lines exceeds 300");
    expect(errors).toContain("never run");
  });

  test("an unresolvable diff is a full round", async () => {
    const light = await requiredReviewers(root, "all", files, { depth: "light" });
    const errors = (await coverageErrors({ mode: "all", depth: "light", selected: light.required }, { root, ...attended, files, changedLines: 10, diffStats: async () => undefined })).join("\n");
    expect(errors).toContain("could not be resolved");
  });

  test("a recomputed small diff keeps the light round", async () => {
    const light = await requiredReviewers(root, "all", files, { depth: "light" });
    expect(await coverageErrors({ mode: "all", depth: "light", selected: light.required }, { root, ...attended, files, changedLines: 10, diffStats: async () => ({ files, changedLines: 40 }) })).toEqual([]);
  });

  test("a recorded full round-depth binds over a light dispatch", async () => {
    const dir = path.join(root, "pkg");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "round-depth.json"), JSON.stringify({ requested: "full", depth: "full", reason: "--depth full" }));
    const light = await requiredReviewers(root, "all", files, { depth: "light" });
    const errors = (await coverageErrors({ mode: "all", depth: "light", selected: light.required }, { root, ...attended, files, changedLines: 10, packageDir: dir, diffStats: async () => ({ files, changedLines: 10 }) })).join("\n");
    expect(errors).toContain("binds");
    expect(errors).toContain("never run");
  });
});

describe("supersedes and overlap groups (flow 458 AC6)", () => {
  async function installWith(name: string, metadata: string, base: "bundled" | "project" = "bundled", paths?: string): Promise<void> {
    const dir = base === "bundled" ? path.join(root, ".metaproject", "skills", "gdskills", "review", name) : path.join(root, ".metaproject", "project-skills", "review", name);
    await mkdir(dir, { recursive: true });
    const meta = [metadata, paths === undefined ? "" : `  paths: "${paths}"`].filter(Boolean).join("\n");
    await writeFile(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: Use when testing ${name}.\nmetadata:\n${meta}\n---\n`, "utf8");
  }

  test("a project overlay removes the bundled reviewers it supersedes, recorded as excluded with the reason", async () => {
    await installWith("acme-frontend", '  supersedes: "review-frontend, review-style"', "project");
    const need = await requiredReviewers(root, "all", frontendFiles);
    expect(need.required).toContain("acme-frontend");
    expect(need.required).not.toContain("review-frontend");
    expect(need.required).not.toContain("review-style");
    expect(need.excluded).toEqual(expect.arrayContaining([
      { reviewer: "review-frontend", reason: "superseded by acme-frontend" },
      { reviewer: "review-style", reason: "superseded by acme-frontend" },
    ]));
  });

  test("a supersedes naming a reviewer the round does not require changes nothing", async () => {
    await installWith("acme-frontend", '  supersedes: "review-highload"', "project");
    const need = await requiredReviewers(root, "all", frontendFiles);
    expect(need.required).toContain("review-frontend");
    expect(need.excluded.some((entry) => entry.reason.startsWith("superseded"))).toBe(false);
  });

  test("an overlap group keeps its most specific member; a generic member it covers is excluded", async () => {
    await installWith("review-frontend", '  overlap_group: "frontend"');
    await installWith("review-frontend-conventions", '  overlap_group: "frontend"\n  overlap_rank: "generic"');
    const need = await requiredReviewers(root, "all", frontendFiles);
    expect(need.required).toContain("review-frontend");
    expect(need.required).not.toContain("review-frontend-conventions");
    expect(need.excluded).toContainEqual({ reviewer: "review-frontend-conventions", reason: "overlap group frontend: review-frontend reads the same lines" });
  });

  test("a project overlay in the group wins, but a path-gated one that covers only part of the diff leaves the bundled member", async () => {
    await installWith("review-frontend", '  overlap_group: "frontend"');
    await installWith("acme-ui", '  overlap_group: "frontend"', "project", "src/ui/**");
    const partial = await requiredReviewers(root, "all", ["src/ui/a.tsx", "src/app/b.tsx"]);
    expect(partial.required).toEqual(expect.arrayContaining(["acme-ui", "review-frontend"]));
    const covered = await requiredReviewers(root, "all", ["src/ui/a.tsx"]);
    expect(covered.required).toContain("acme-ui");
    expect(covered.required).not.toContain("review-frontend");
    expect(covered.excluded).toContainEqual({ reviewer: "review-frontend", reason: "overlap group frontend: acme-ui reads the same lines" });
  });

  test("M6: a supersedes or overlap group never removes a core role", async () => {
    await installWith("acme-everything", '  supersedes: "review-logic, review-architecture, review-style"', "project");
    const need = await requiredReviewers(root, "all", frontendFiles);
    for (const core of ["review-logic", "review-architecture"]) expect(need.required).toContain(core);
    expect(need.required).not.toContain("review-style");
    expect(need.excluded.filter((entry) => entry.reason.startsWith("superseded")).map((entry) => entry.reviewer)).toEqual(["review-style"]);
    expect(need.notes?.join("\n")).toContain("acme-everything supersedes review-logic, review-architecture: ignored");
    expect(need.notes?.join("\n")).toContain("core roles that always run");
  });

  test("M6: an overlay this round changes supersedes nothing, with a note; so does one when the changed files are unknown", async () => {
    await installWith("acme-frontend", '  supersedes: "review-frontend, review-style"', "project");
    const changed = await requiredReviewers(root, "all", [...frontendFiles, ".metaproject/project-skills/review/acme-frontend/SKILL.md"]);
    expect(changed.required).toEqual(expect.arrayContaining(["acme-frontend", "review-frontend", "review-style"]));
    expect(changed.notes?.join("\n")).toContain("acme-frontend supersedes review-frontend, review-style: ignored, acme-frontend is a project overlay this round changes (.metaproject/project-skills/review/acme-frontend/SKILL.md)");
    const unknown = await requiredReviewers(root, "all", undefined);
    expect(unknown.required).toContain("review-style");
    expect(unknown.notes?.join("\n")).toContain("changed files are not recorded");
  });

  test("a light round raises its conventions pick to the overlap group's top member", async () => {
    await installWith("review-frontend", '  overlap_group: "frontend"');
    await installWith("review-frontend-conventions", '  overlap_group: "frontend"\n  overlap_rank: "generic"');
    const need = await requiredReviewers(root, "all", ["src/app/page.tsx"], { depth: "light" });
    expect(need.required).toContain("review-frontend");
    expect(need.required).not.toContain("review-frontend-conventions");
  });
});

describe("projectRootOfPackage (flow 458 AC7)", () => {
  test("a flow-bound package resolves to the project, not to .metaproject/flows", async () => {
    const flowPackage = path.join(root, ".metaproject", "flows", "458-x", "reviews", "2026-10-16-pr-1");
    await mkdir(flowPackage, { recursive: true });
    expect(projectRootOfPackage(flowPackage)).toBe(root);
    expect(projectRootOfPackage(path.join(root, ".metaproject", "reviews", "r1"))).toBe(root);
  });

  test("a package outside any .metaproject falls back to the project found from it", async () => {
    const elsewhere = path.join(root, "tmp", "pkg");
    await mkdir(elsewhere, { recursive: true });
    expect(projectRootOfPackage(elsewhere)).toBe(root);
  });

  test("required reviewers of a flow-bound package read that project's reviewers", async () => {
    const flowPackage = path.join(root, ".metaproject", "flows", "458-x", "reviews", "p");
    await mkdir(flowPackage, { recursive: true });
    const need = await requiredReviewers(projectRootOfPackage(flowPackage), "all", undefined);
    expect(need.required).toContain("review-logic");
  });
});

describe("a pull-request package's diff is read at the repository top level against its base (flow 460 AC1)", () => {
  const PR = "https://github.com/o/r/pull/7975";
  const attended = { attended: true, pendingMutants: 3 } as const;
  const two = ["src/a.ts", "src/b.ts"];

  /** main with two files, a PR branch changing both (and `extra`); returns the PR head. */
  function repo(extra: Record<string, string> = {}): string {
    initRepo(root);
    commitFiles(root, { "src/a.ts": "export const a = 1;\n", "src/b.ts": "export const b = 1;\n" }, "base");
    git(root, "checkout", "-q", "-b", "pr");
    const head = commitFiles(root, { "src/a.ts": "export const a = 2;\n", "src/b.ts": "export const b = 2;\n", ...extra }, "pr change");
    git(root, "checkout", "-q", "main");
    return head;
  }

  async function pkgAt(project: string, target: Record<string, unknown>): Promise<string> {
    const dir = path.join(project, ".metaproject", "reviews", "r1");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "manifest.json"), JSON.stringify({ target: { kind: "pr", ref: PR, ...target } }));
    return dir;
  }

  async function nestedProject(): Promise<string> {
    const project = path.join(root, "output", "review-pr-7975");
    await mkdir(project, { recursive: true });
    await cp(path.join(root, ".metaproject"), path.join(project, ".metaproject"), { recursive: true });
    return project;
  }

  async function lightErrors(pkg: string): Promise<string> {
    const projectRoot = projectRootOfPackage(pkg);
    const light = await requiredReviewers(projectRoot, "all", two, { depth: "light" });
    return (await coverageErrors({ mode: "all", depth: "light", selected: light.required }, { root: projectRoot, packageDir: pkg, files: two, changedLines: 4, ...attended })).join("\n");
  }

  test("a light dispatch of a 2-file PR diff is accepted against target.base, never the PR URL", async () => {
    const head = repo();
    expect(await lightErrors(await pkgAt(root, { base: "main", head }))).toBe("");
  });

  test("without a recorded base the diff falls back to resolveBase (main here)", async () => {
    const head = repo();
    expect(await lightErrors(await pkgAt(root, { head }))).toBe("");
  });

  test("a package under a subdirectory's .metaproject reads the diff at the repository top level", async () => {
    const head = repo();
    expect(await lightErrors(await pkgAt(await nestedProject(), { base: "main", head }))).toBe("");
  });

  test("the nested package sees the top-level files: a risk-class path changed at the top makes it a full round", async () => {
    const head = repo({ "src/core/store.ts": "export const s = 1;\n" });
    const errors = await lightErrors(await pkgAt(await nestedProject(), { base: "main", head }));
    expect(errors).toContain("depth light, but the full set applies");
    expect(errors).toContain("review-core-boundaries");
  });

  test("when git cannot resolve the diff the refusal names the directory, the base and the head", async () => {
    repo();
    const missing = "0123456789abcdef0123456789abcdef01234567";
    const errors = await lightErrors(await pkgAt(root, { base: "main", head: missing }));
    expect(errors).toContain("could not be resolved");
    expect(errors).toContain(`cwd ${realpathSync(root)}`);
    expect(errors).toContain("base main");
    expect(errors).toContain(`head ${missing}`);
    expect(errors).not.toContain(PR);
  });

  test("an empty range (a merged PR read against its own target branch) refuses the light round instead of passing it on zero files", async () => {
    repo();
    const merged = git(root, "rev-parse", "main").trim();
    const errors = await lightErrors(await pkgAt(root, { head: merged }));
    expect(errors).toContain("empty review range");
    expect(errors).toContain("depth light, but the full set applies");
  });

  test("a branch target without a recorded base resolves a real base, never its own ref (which is the head)", async () => {
    // `pr...head` is empty (the ref is the head), which would pass a 32-file branch as a zero-line light round.
    const head = repo(Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`src/m${i}.ts`, `export const m${i} = ${i};\n`])));
    expect(await lightErrors(await pkgAt(root, { kind: "branch", ref: "pr", head }))).toContain("depth light, but the full set applies");
  });

  test("a small branch target without a recorded base is measured against main and stays light", async () => {
    const head = repo();
    expect(await lightErrors(await pkgAt(root, { kind: "branch", ref: "pr", head }))).toBe("");
  });

  test("a branch target whose head is its base's tip refuses with the empty-range warning", async () => {
    repo();
    const merged = git(root, "rev-parse", "main").trim();
    const errors = await lightErrors(await pkgAt(root, { kind: "branch", ref: "main", head: merged }));
    expect(errors).toContain("empty review range");
    expect(errors).toContain("depth light, but the full set applies");
  });

  test("a recorded base can only widen the check: --base head~1 on a large pull request does not make it light (SEC-001)", async () => {
    repo();
    git(root, "checkout", "-q", "pr");
    const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`src/m${i}.ts`, `export const m${i} = ${i};\n`]));
    const bulk = commitFiles(root, many, "a large change");
    const head = commitFiles(root, { "src/a.ts": "export const a = 3;\n" }, "a small last commit");
    git(root, "checkout", "-q", "main");
    const errors = await lightErrors(await pkgAt(root, { base: bulk, head }));
    expect(errors).toContain("depth light, but the full set applies");
  });

  test("a pull request's own base widens a narrower --base even where no main/master ref resolves (SEC-001)", async () => {
    repo();
    git(root, "branch", "-m", "main", "trunk");
    git(root, "checkout", "-q", "pr");
    const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`src/m${i}.ts`, `export const m${i} = ${i};\n`]));
    const bulk = commitFiles(root, many, "a large change");
    const head = commitFiles(root, { "src/a.ts": "export const a = 3;\n" }, "a small last commit");
    git(root, "checkout", "-q", "trunk");
    // Without prBase only the narrow --base resolves (no default branch exists), and the round would pass as light.
    expect(await lightErrors(await pkgAt(root, { base: bulk, head }))).toBe("");
    const nested = path.join(root, "again");
    await mkdir(nested, { recursive: true });
    await cp(path.join(root, ".metaproject"), path.join(nested, ".metaproject"), { recursive: true });
    expect(await lightErrors(await pkgAt(nested, { base: bulk, prBase: "trunk", head }))).toContain("depth light, but the full set applies");
  });

  test("a project reached through a symlink still excludes its committed review packages from the measured diff", async () => {
    // Four committed package files and two source files: six changed files, over the light limit unless the packages are excluded.
    const head = repo(Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`.metaproject/reviews/old-${i}/manifest.json`, "{}\n"])));
    const link = `${root}-link`;
    await symlink(root, link);
    try {
      expect(await lightErrors(await pkgAt(link, { base: "main", head }))).toBe("");
    } finally {
      await rm(link, { force: true });
    }
  });

  test("the widest diff is the widest in each dimension, not the one larger in either", () => {
    const recorded = { files: Array.from({ length: 10 }, (_, i) => `f${i}`), changedLines: 900 };
    const fallback = { files: [...recorded.files, "extra"], changedLines: 100 };
    expect(widestDiff([recorded, fallback])).toEqual({ files: fallback.files, changedLines: 900 });
    expect(widestDiff([fallback, recorded])).toEqual({ files: fallback.files, changedLines: 900 });
  });

  test("the light recheck's git diff is remembered per package and head: a second check in the same process runs no git", async () => {
    const head = repo();
    const pkg = await pkgAt(root, { base: "main", head });
    expect(await lightErrors(pkg)).toBe("");
    // With the repository gone, only the remembered result can answer.
    await rm(path.join(root, ".git"), { recursive: true, force: true });
    expect(await lightErrors(pkg)).toBe("");
    // Another head is another key: it is not answered from the cache.
    expect(await lightErrors(await pkgAt(root, { base: "main", head: "0123456789abcdef0123456789abcdef01234567" }))).toContain("could not be resolved");
  });
});
