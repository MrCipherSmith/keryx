// Flow 457 AC7: the blast radius of a package is measured over base...pinned head, never the working tree, and the
// layers base comes from the PR base, falling back to `<head>~1` only with a stated warning.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { computeSymbolReach, gitSourceReader, parseDiffHunks } from "../gdgraph/symbol-reach";
import { defaultLayerDeps, resolveLayersBase } from "../review/layers";
import { changedFilesArgv, radiusDiffArgv, radiusRange } from "../review/radius-range";

const CLI = path.join(import.meta.dir, "..", "cli.ts");
/** The fixture commits take the committer from the environment (or git's own config); none is hard-coded here. */
const IDENTITY = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

let repo: string;
let baseSha: string;
let headSha: string;

function git(...args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, ...IDENTITY },
  }).trim();
}

function write(file: string, text: string): void {
  mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  writeFileSync(path.join(repo, file), text);
}

beforeAll(() => {
  repo = realpathSync(mkdtempSync(path.join(tmpdir(), "keryx-radius-base-")));
  git("init", "-q", "-b", "main");
  write("src/core.ts", "export function alpha(): number {\n  return 1;\n}\n\nexport function beta(): number {\n  return 2;\n}\n");
  write("src/uses-alpha.ts", 'import { alpha } from "./core";\nexport const a = alpha();\n');
  write("src/uses-beta.ts", 'import { beta } from "./core";\nexport const b = beta();\n');
  write("src/uses-alpha.test.ts", 'import { a } from "./uses-alpha";\ntest("a", () => a);\n');
  write("package.json", JSON.stringify({ scripts: { test: "bun test" } }));
  git("add", ".");
  git("commit", "-qm", "base");
  baseSha = git("rev-parse", "HEAD");
  git("checkout", "-qb", "feature");
  write("src/core.ts", "export function alpha(): number {\n  return 10;\n}\n\nexport function beta(): number {\n  return 2;\n}\n");
  git("commit", "-qam", "change alpha");
  write("src/extra.ts", "export const extra = 1;\n");
  git("add", ".");
  git("commit", "-qm", "second commit of the PR");
  headSha = git("rev-parse", "HEAD");
  // The branch moved on after the review pinned its head: its tip is a descendant of the head, never a base.
  git("checkout", "-qb", "feature-moved");
  write("src/later.ts", "export const later = 1;\n");
  git("add", ".");
  git("commit", "-qm", "a commit after the pinned head");
  git("checkout", "-q", "feature");
  // The checkout moves away from the reviewed head, and the working tree carries an unrelated edit.
  git("checkout", "-q", "main");
  write("src/uses-beta.ts", 'import { beta } from "./core";\nexport const b = beta() + 1;\n');
});

afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe("the radius range (AC7)", () => {
  test("a pinned head uses the layers' PR base; --ref overrides it; no pinned head means the working tree", () => {
    const layers = { prHead: headSha, base: baseSha, baseSource: "pr" as const };
    expect(radiusRange({ layers })).toEqual({ base: baseSha, head: headSha, baseSource: "pr" });
    expect(radiusRange({ ref: "main", layers })).toEqual({ base: "main", head: headSha, baseSource: "flag" });
    expect(radiusRange({ layers: { prHead: null, base: null } })).toBeUndefined();
    expect(radiusRange({ layers: null })).toBeUndefined();
  });

  test("a `<head>~1` base is announced, never silent", () => {
    const fallback = radiusRange({ layers: { prHead: headSha, base: `${headSha}~1`, baseSource: "fallback" } });
    expect(fallback?.warning).toContain("the head commit only");
    // A record written before baseSource existed is recognised by its shape.
    expect(radiusRange({ layers: { prHead: headSha, base: `${headSha}~1` } })?.warning).toContain("--base <sha>");
    expect(radiusRange({ layers: { prHead: headSha, base: null } })?.warning).toContain("records no base");
  });

  test("the changed files come from base...head, not the working tree or the checkout's branch", () => {
    const range = radiusRange({ layers: { prHead: headSha, base: baseSha, baseSource: "manifest" } });
    const argv = changedFilesArgv(range, undefined);
    expect(argv).toEqual(["git", "diff", "--name-only", "--diff-filter=d", "--end-of-options", `${baseSha}...${headSha}`]);
    expect(git(...argv.slice(1)).split("\n").sort()).toEqual(["src/core.ts", "src/extra.ts"]);
    // The working-tree form (no pinned head) sees the unrelated edit instead: the bug this replaces.
    expect(git(...changedFilesArgv(undefined, undefined).slice(1))).toBe("src/uses-beta.ts");
    expect(radiusDiffArgv(range, undefined)).toContain("--unified=0");
  });

  test("a dash-leading base or ref is refused before git runs", () => {
    expect(() => changedFilesArgv({ base: "--output=x", head: headSha, baseSource: "flag" }, undefined)).toThrow("Refusing the revision");
    expect(() => changedFilesArgv(undefined, "--output=x")).toThrow("Refusing the revision");
  });
});

describe("the layers base (AC7)", () => {
  const packageWith = (target: object): string => {
    const dir = mkdtempSync(path.join(tmpdir(), "keryx-radius-pkg-"));
    writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ target }));
    return dir;
  };
  const deps = (overrides: Partial<typeof defaultLayerDeps> = {}) => {
    const warnings: string[] = [];
    return { warnings, deps: { git: defaultLayerDeps.git, prBase: async () => null, warn: (message: string) => void warnings.push(message), ...overrides } };
  };

  test("the manifest's target.base wins over everything but the caller", async () => {
    const { deps: d, warnings } = deps();
    const pkg = packageWith({ kind: "pr", ref: "https://example.invalid/pull/1", head: headSha, base: baseSha });
    expect(await resolveLayersBase({ projectRoot: repo, packageDir: pkg, prHead: headSha }, d)).toEqual({ base: baseSha, source: "manifest" });
    expect(await resolveLayersBase({ projectRoot: repo, packageDir: pkg, prHead: headSha, base: "main" }, d)).toEqual({ base: baseSha, source: "input" });
    expect(warnings).toEqual([]);
  });

  test("a pull request target asks the host for its base", async () => {
    const asked: string[] = [];
    const { deps: d } = deps({ prBase: async (_root, ref) => (asked.push(ref), baseSha) });
    const pkg = packageWith({ kind: "pr", ref: "https://example.invalid/pull/2", head: headSha });
    expect(await resolveLayersBase({ projectRoot: repo, packageDir: pkg, prHead: headSha }, d)).toEqual({ base: baseSha, source: "pr" });
    expect(asked).toEqual(["https://example.invalid/pull/2"]);
  });

  test("without a PR base the merge base with the default branch is used", async () => {
    const { deps: d, warnings } = deps();
    const pkg = packageWith({ kind: "pr", ref: "https://example.invalid/pull/3", head: headSha });
    expect(await resolveLayersBase({ projectRoot: repo, packageDir: pkg, prHead: headSha }, d)).toEqual({ base: baseSha, source: "merge-base" });
    expect(warnings).toEqual([]);
  });

  test("`<head>~1` is the last resort and is printed as a warning", async () => {
    // The branch resolves (to a commit past the pinned head); only the default branches are hidden.
    const hidden = ["origin/HEAD", "origin/main", "origin/master", "main", "master"].map((name) => `${name}^{commit}`);
    const { deps: d, warnings } = deps({ git: async (cwd, args) => (args[0] === "rev-parse" && hidden.some((rev) => args.includes(rev)) ? null : defaultLayerDeps.git(cwd, args)) });
    const pkg = packageWith({ kind: "branch", ref: "feature-moved", head: headSha });
    expect(await resolveLayersBase({ projectRoot: repo, packageDir: pkg, prHead: headSha }, d)).toEqual({ base: `${headSha}~1`, source: "fallback" });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("falling back to");
    expect(warnings[0]).toContain("Pass --base <sha>");
  });

  test("a branch target never takes its own branch as the base (review M2)", async () => {
    const { deps: d, warnings } = deps();
    const pkg = packageWith({ kind: "branch", ref: "feature-moved", head: headSha });
    expect(await resolveLayersBase({ projectRoot: repo, packageDir: pkg, prHead: headSha }, d)).toEqual({ base: baseSha, source: "merge-base" });
    expect(warnings).toEqual([]);
  });

  test("a target ref that is not an ancestor of the head is skipped with a warning (review M2)", async () => {
    const { deps: d, warnings } = deps();
    const pkg = packageWith({ kind: "commit", ref: "feature-moved", head: headSha });
    expect(await resolveLayersBase({ projectRoot: repo, packageDir: pkg, prHead: headSha }, d)).toEqual({ base: baseSha, source: "merge-base" });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("is not an ancestor of the head");
    const ancestor = packageWith({ kind: "commit", ref: "main", head: headSha });
    expect(await resolveLayersBase({ projectRoot: repo, packageDir: ancestor, prHead: headSha }, d)).toEqual({ base: baseSha, source: "target-ref" });
  });
});

describe("the base text is read where the diff's hunks are numbered (review M3)", () => {
  test("main changed the file after the fork: the base is read at the merge base, and the seed names stay right", () => {
    git("branch", "-f", "main-later", baseSha);
    git("checkout", "-q", "main-later");
    // main moves on: lines inserted above alpha shift every line number of the file at the base branch's tip.
    const later = "// one\n// two\n// three\nexport function zeta(): number {\n  return 0;\n}\n\nexport function alpha(): number {\n  return 1;\n}\n\nexport function beta(): number {\n  return 2;\n}\n";
    writeFileSync(path.join(repo, "src/core.ts"), later);
    // Only core.ts: the working tree also carries the unrelated uses-beta.ts edit.
    git("commit", "-qm", "main later", "--", "src/core.ts");
    const laterSha = git("rev-parse", "HEAD");
    git("checkout", "-q", "main");
    const read = gitSourceReader(repo, headSha, laterSha);
    expect(read.base?.("src/core.ts")?.trimEnd()).toBe(git("show", `${baseSha}:src/core.ts`));
    const patch = git("diff", "--no-color", "--unified=0", `${laterSha}...${headSha}`, "--", "src/core.ts");
    const result = computeSymbolReach({ graph: { nodes: [], edges: [] }, seeds: ["src/core.ts"], changedFiles: ["src/core.ts"], diff: parseDiffHunks(`${patch}\n`), read, depth: 1 });
    expect(result.seeds[0]).toMatchObject({ mode: "symbol", names: ["alpha"] });
  });
});

describe("keryx review blast-radius --package (AC7, end to end)", () => {
  test("measures the pinned range with the symbol radius while the checkout is elsewhere", () => {
    const pkg = path.join(repo, ".metaproject", "reviews", "r1");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(path.join(pkg, "manifest.json"), JSON.stringify({ target: { kind: "branch", ref: "feature", head: headSha, base: baseSha } }));
    const child = Bun.spawnSync(["bun", CLI, "review", "blast-radius", "--package", pkg, "--json", "--no-related-tests"], {
      cwd: repo,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...IDENTITY },
    });
    const stderr = child.stderr.toString();
    expect(child.exitCode).toBe(0);
    const radius = JSON.parse(child.stdout.toString()) as { changedFiles: string[]; files: Array<{ file: string }>; dropped: Array<{ file: string; reason: string }> };
    expect(radius.changedFiles).toEqual(["src/core.ts", "src/extra.ts"]);
    expect(radius.files.map((entry) => entry.file)).toEqual(["src/uses-alpha.ts"]);
    expect(radius.dropped).toEqual([
      expect.objectContaining({ file: "src/uses-alpha.test.ts", hop: 2, reason: "test-consumer" }),
      expect.objectContaining({ file: "src/uses-beta.ts", reason: "unrelated-symbol" }),
    ]);
    expect(stderr).toContain("base from manifest");
    // The reached test is on the package's run list, with the project's runner.
    expect(JSON.parse(readFileSync(path.join(pkg, "tests-to-run.json"), "utf8"))).toEqual([{ file: "src/uses-alpha.test.ts", reason: "graph-consumer", symbols: ["a"] }]);
    expect(stderr).toContain("1 tests exercise the changed code — run them: `bun test src/uses-alpha.test.ts`");
  }, 120_000);
});
