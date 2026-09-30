import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultEntrypointTargets, localTargetPaths } from "../rules/entrypoint-targets";
import { ContainedWriteError } from "./contained-write";
import {
  findLegacyMemoryArtifacts,
  formatLegacyMemoryMigrationAdvisory,
  renderMetaprojectGitignoreBlock,
  syncMetaprojectIgnoreRules,
} from "./metaproject-gitignore";

// Flow 313 (W4): the bundle ledger (applied-state.json) and any staged bundle
// artifacts under .metaproject/data/bundles/ are local runtime state, not
// something a project commits.
test("the managed gitignore block covers the bundle ledger runtime state", () => {
  const block = renderMetaprojectGitignoreBlock();

  expect(block).toContain(".metaproject/data/bundles/");
});

test("legacy memory migration diagnostics classify paths without mutating them", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-memory-migration-"));
  try {
    Bun.spawnSync(["git", "init", "-q"], { cwd: root, stdout: "ignore", stderr: "ignore" });
    Bun.spawnSync(["git", "config", "user.email", "test@example.invalid"], { cwd: root, stdout: "ignore", stderr: "ignore" });
    Bun.spawnSync(["git", "config", "user.name", "test"], { cwd: root, stdout: "ignore", stderr: "ignore" });
    const artifactRoot = path.join(root, ".metaproject", "data", "memory", "artifacts");
    await mkdir(artifactRoot, { recursive: true });
    await writeFile(path.join(artifactRoot, "latest.md"), "user report\n", "utf8");
    await writeFile(path.join(artifactRoot, "latest.json"), "{}\n", "utf8");
    Bun.spawnSync(["git", "add", "--", ".metaproject/data/memory/artifacts/latest.md"], { cwd: root, stdout: "ignore", stderr: "ignore" });
    Bun.spawnSync(["git", "commit", "-qm", "legacy"], { cwd: root, stdout: "ignore", stderr: "ignore" });

    const artifacts = await findLegacyMemoryArtifacts(root);
    expect(artifacts).toEqual([
      { path: ".metaproject/data/memory/artifacts/latest.md", tracked: true },
      { path: ".metaproject/data/memory/artifacts/latest.json", tracked: false },
    ]);
    const advisory = formatLegacyMemoryMigrationAdvisory(artifacts);
    expect(advisory).toContain("tracked legacy reports");
    expect(advisory).toContain("existing legacy reports");
    expect(advisory).toContain("never delete files or mutate the Git index");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the managed block ignores the self-learning loop's per-machine paths", () => {
  const block = renderMetaprojectGitignoreBlock();
  expect(block).toContain(".metaproject/data/learning/observations/\n");
  expect(block).toContain(".metaproject/data/learning/candidates/\n");
});

// R700-06/R700-10: skills stocktake writes dated reports plus a cache file
// under .metaproject/data/skills/stocktake/ — per-machine runtime output,
// not something a project commits.
test("the managed block ignores skills stocktake reports and cache", () => {
  const block = renderMetaprojectGitignoreBlock();
  expect(block).toContain(".metaproject/data/skills/stocktake/\n");
});

// R700-10: the managed block's comments used to carry internal program
// labels ("Flow 313 (W4)", "(W3-AC9)") that meant nothing to a user reading
// their own .gitignore. They must be gone from the rendered block.
test("the managed block carries no internal program labels", () => {
  const block = renderMetaprojectGitignoreBlock();
  expect(block).not.toMatch(/\bW\d\b/);
  expect(block).not.toMatch(/\bW\d-AC\d+\b/);
  expect(block).not.toMatch(/Flow \d{3}/);
});

// Flow 361 T7: `keryx init` / `keryx update` no longer write the tracked
// `.gitignore`. The managed block lives in `<git-common-dir>/info/exclude`,
// always holds the full entry set, and a block an older keryx left in
// `.gitignore` is moved out.
describe("syncMetaprojectIgnoreRules", () => {
  const LOCAL_TARGETS = ["CLAUDE.local.md", "AGENTS.override.md", ".claude/settings.local.json"];
  /** The block exactly as the pre-361 writer appended it to `.gitignore`. */
  const LEGACY_BLOCK = `# keryx:begin\n${renderMetaprojectGitignoreBlock().trim()}\n# keryx:end`;

  function git(cwd: string, args: string[]): { code: number | null; stdout: string } {
    const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    return { code: result.exitCode, stdout: result.stdout.toString() };
  }

  function mustGit(cwd: string, args: string[]): string {
    const result = git(cwd, args);
    if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed (${result.code})`);
    return result.stdout;
  }

  /**
   * A repository with one commit holding `files`. Its `core.excludesFile`
   * points at a file that does not exist: these tests ask git what is ignored,
   * and the developer's own global excludes (Claude Code adds
   * `.claude/settings.local.json` there) must not answer for the fixture.
   */
  async function repo(files: Record<string, string> = { "README.md": "readme\n" }): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), "keryx-ignore-rules-"));
    mustGit(root, ["init", "-q"]);
    mustGit(root, ["config", "user.email", "keryx@example.test"]);
    mustGit(root, ["config", "user.name", "Keryx Test"]);
    mustGit(root, ["config", "core.excludesFile", path.join(root, ".git", "no-global-excludes")]);
    for (const [relativePath, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(root, relativePath)), { recursive: true });
      await writeFile(path.join(root, relativePath), content, "utf8");
      // `-f`: a fixture may commit a file its own `.gitignore` ignores.
      mustGit(root, ["add", "-f", "--", relativePath]);
    }
    mustGit(root, ["commit", "-q", "-m", "fixture"]);
    return root;
  }

  async function sync(root: string, localTargets: readonly string[] = LOCAL_TARGETS) {
    const notices: string[] = [];
    const result = await syncMetaprojectIgnoreRules(root, { localTargets, onNotice: (line) => notices.push(line) });
    return { result, notices };
  }

  async function readExclude(root: string): Promise<string> {
    return readFile(path.join(root, ".git", "info", "exclude"), "utf8").catch(() => "");
  }

  function managedLines(exclude: string): string[] {
    const match = /^# keryx:begin\n([\s\S]*?)^# keryx:end$/m.exec(exclude);
    return match === null ? [] : (match[1] ?? "").split("\n").filter((line) => line.length > 0);
  }

  test("writes the entries to info/exclude, never creates .gitignore, and ignores all three local targets (AC6, AC7)", async () => {
    const root = await repo();
    try {
      const { result } = await sync(root);
      expect(result.status).toBe("written");

      expect(existsSync(path.join(root, ".gitignore"))).toBe(false);
      expect(mustGit(root, ["status", "--porcelain"])).not.toContain(".gitignore");
      const lines = managedLines(await readExclude(root));
      expect(lines).toContain(".metaproject/runtime/");
      expect(lines).toContain(".metaproject/data/learning/observations/");
      for (const target of LOCAL_TARGETS) {
        expect(lines).toContain(target);
        expect(git(root, ["check-ignore", "-q", "--", target]).code).toBe(0);
      }
      expect(git(root, ["check-ignore", "-q", "--", ".metaproject/data/learning/candidates/x.json"]).code).toBe(0);
      expect(git(root, ["check-ignore", "-q", "--no-index", "--", ".metaproject/memory/decisions/x.md"]).code).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a second run leaves info/exclude byte-identical and untouched", async () => {
    const root = await repo();
    try {
      await sync(root);
      const excludePath = path.join(root, ".git", "info", "exclude");
      const written = await readFile(excludePath, "utf8");
      const stamp = (await stat(excludePath)).mtimeMs;

      const second = await sync(root);
      expect(second.result.status).toBe("unchanged");
      expect(second.notices).toEqual([]);
      expect(await readFile(excludePath, "utf8")).toBe(written);
      expect((await stat(excludePath)).mtimeMs).toBe(stamp);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // AC6 (owner decision 2026-10-01, review round 2, F-014): the blanket line
  // is one branch's rule, and `info/exclude` is every worktree's, so the block
  // still carries the full set; a second run changes nothing.
  test("with .metaproject/ and the local targets ignored by .gitignore, the full block is still written and .gitignore is untouched (AC6)", async () => {
    const gitignore = `node_modules/\n.metaproject/\n${LOCAL_TARGETS.join("\n")}\n`;
    const root = await repo({ ".gitignore": gitignore });
    try {
      const { result } = await sync(root);
      expect(result.status).toBe("written");
      const written = await readExclude(root);
      expect(managedLines(written)).toEqual(renderMetaprojectGitignoreBlock().trim().split("\n").concat(
        "# Per-developer agent files keryx writes; they are never committed.",
        ...LOCAL_TARGETS,
      ));
      expect(await readFile(path.join(root, ".gitignore"), "utf8")).toBe(gitignore);
      expect(mustGit(root, ["status", "--porcelain"])).toBe("");

      const second = await sync(root);
      expect(second.result.status).toBe("unchanged");
      expect(second.notices).toEqual([]);
      expect(await readExclude(root)).toBe(written);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // The blanket line is the team's own rule in the team's own file: it is
  // honoured, not edited — also where `.metaproject` is tracked, which the
  // pre-361 writer answered by deleting the line from `.gitignore`.
  test("with .metaproject/ ignored as a whole and tracked, the .metaproject entries are written all the same and the blanket line stays", async () => {
    const gitignore = "node_modules/\n.metaproject/\n";
    const root = await repo({ ".gitignore": gitignore, ".metaproject/index.md": "# index\n" });
    try {
      await sync(root);

      const lines = managedLines(await readExclude(root));
      expect(lines).toContain(".metaproject/runtime/");
      expect(lines).toContain(".metaproject/data/security/raw/");
      expect(lines.filter((line) => LOCAL_TARGETS.includes(line))).toEqual(LOCAL_TARGETS);
      expect(await readFile(path.join(root, ".gitignore"), "utf8")).toBe(gitignore);
      expect(mustGit(root, ["status", "--porcelain"])).toBe("");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // Flow 361 review round 1, F-005: `info/exclude` is shared by every
  // worktree of the clone, while `.gitignore` belongs to one checkout. An
  // entry this checkout's `.gitignore` (or the global excludes file) already
  // covers is written all the same — a redundant line is harmless, a missing
  // one un-ignores files in the other worktrees.
  test("an entry the repository or the global excludes file already ignores is still written", async () => {
    const root = await repo({ ".gitignore": ".metaproject/runtime/\nCLAUDE.local.md\n" });
    const globalExcludes = `${root}-global-excludes`;
    try {
      await writeFile(globalExcludes, "AGENTS.override.md\n");
      mustGit(root, ["config", "core.excludesFile", globalExcludes]);
      await sync(root);

      const lines = managedLines(await readExclude(root));
      expect(lines).toEqual(renderMetaprojectGitignoreBlock().trim().split("\n").concat(
        "# Per-developer agent files keryx writes; they are never committed.",
        ...LOCAL_TARGETS,
      ));
      for (const target of LOCAL_TARGETS) {
        expect(git(root, ["check-ignore", "-q", "--", target]).code).toBe(0);
      }
    } finally {
      await rm(globalExcludes, { force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the shared info/exclude block is the same whichever worktree writes it, and keeps a worktree without keryx's .gitignore lines ignored (F-005)", async () => {
    const main = await repo();
    const feature = `${main}-feature`;
    try {
      mustGit(main, ["worktree", "add", "-q", feature, "-b", "feature"]);
      // main's team committed keryx's lines into .gitignore by hand; feature has none.
      await writeFile(path.join(main, ".gitignore"), renderMetaprojectGitignoreBlock());
      mustGit(main, ["add", "--", ".gitignore"]);
      mustGit(main, ["commit", "-q", "-m", "team ignores"]);

      await sync(feature);
      const fromFeature = await readExclude(main);
      expect(git(feature, ["check-ignore", "-q", "--no-index", "--", ".metaproject/runtime/x"]).code).toBe(0);

      const fromMain = await sync(main);
      expect(fromMain.result.status).toBe("unchanged");
      expect(await readExclude(main)).toBe(fromFeature);
      expect(git(feature, ["check-ignore", "-q", "--no-index", "--", ".metaproject/runtime/x"]).code).toBe(0);
      expect((await sync(feature)).result.status).toBe("unchanged");
    } finally {
      await rm(feature, { recursive: true, force: true });
      await rm(main, { recursive: true, force: true });
    }
  });

  // Flow 361 review round 2, F-014: a blanket `.metaproject/` line is one
  // branch's rule too. main commits it and feature does not; whichever of the
  // two runs last, the shared block is the full set, so feature keeps its
  // runtime state and the local HMAC key ignored (AC6).
  test("two worktrees whose .gitignore disagree about a blanket .metaproject/ line write the same block, and both keep .metaproject/runtime/ ignored (F-014)", async () => {
    const main = await repo();
    const feature = `${main}-feature`;
    const ignoredIn = (cwd: string, probe: string) => git(cwd, ["check-ignore", "-q", "--no-index", "--", probe]).code;
    try {
      mustGit(main, ["worktree", "add", "-q", feature, "-b", "feature"]);
      await writeFile(path.join(main, ".gitignore"), ".metaproject/\n");
      mustGit(main, ["add", "--", ".gitignore"]);
      mustGit(main, ["commit", "-q", "-m", "blanket"]);

      await sync(feature);
      const fromFeature = await readExclude(main);
      expect(managedLines(fromFeature)).toContain(".metaproject/runtime/");

      const fromMain = await sync(main);
      expect(fromMain.result.status).toBe("unchanged");
      expect(await readExclude(main)).toBe(fromFeature);
      for (const cwd of [main, feature]) {
        expect(ignoredIn(cwd, ".metaproject/runtime/x")).toBe(0);
        expect(ignoredIn(cwd, ".metaproject/data/security/raw/hmac.key")).toBe(0);
      }
      expect((await sync(feature)).result.status).toBe("unchanged");
      expect(await readFile(path.join(main, ".gitignore"), "utf8")).toBe(".metaproject/\n");
    } finally {
      await rm(feature, { recursive: true, force: true });
      await rm(main, { recursive: true, force: true });
    }
  });

  // Flow 361 review round 1, F-001: the paths come from a tracked,
  // hand-editable manifest. Whatever a caller passes, nothing reaches
  // info/exclude that re-includes a file or forges the block's end marker.
  test("local targets that would un-ignore a file or inject lines are refused, and nothing is written (F-001)", async () => {
    const root = await repo();
    const globalExcludes = `${root}-global-excludes`;
    try {
      await writeFile(globalExcludes, ".env\n");
      mustGit(root, ["config", "core.excludesFile", globalExcludes]);
      await writeFile(path.join(root, ".env"), "SECRET=1\n");
      const excludeBefore = await readExclude(root);

      const { result, notices } = await sync(root, ["!.env", "AGENTS.override.md\n!*.pem\n# keryx:end", ".claude/settings.local.json"]);

      expect(result.status).toBe("refused");
      expect(await readExclude(root)).toBe(excludeBefore);
      expect(mustGit(root, ["status", "--porcelain"])).not.toContain(".env");
      expect(notices.some((line) => line.startsWith("Ignore rules: not written"))).toBe(true);
    } finally {
      await rm(globalExcludes, { force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the block is replaced, not extended: retired entries are dropped, foreign lines stay", async () => {
    const root = await repo();
    try {
      const excludePath = path.join(root, ".git", "info", "exclude");
      await mkdir(path.dirname(excludePath), { recursive: true });
      const before = "# mine\n*.swp\n\n";
      const after = "\nscratch/\n";
      await writeFile(excludePath, `${before}# keryx:begin\n.metaproject/retired-by-keryx/\n# keryx:end\n${after}`);

      await sync(root);
      let exclude = await readExclude(root);
      expect(exclude.startsWith(`${before}# keryx:begin\n`)).toBe(true);
      expect(exclude.endsWith(`# keryx:end\n${after}`)).toBe(true);
      expect(managedLines(exclude)).not.toContain(".metaproject/retired-by-keryx/");
      expect(managedLines(exclude)).toContain(".metaproject/data/bundles/");

      // The team starts ignoring one entry itself: it stays in the shared
      // block, which other worktrees without that .gitignore line rely on (F-005).
      await writeFile(path.join(root, ".gitignore"), ".metaproject/data/bundles/\n");
      expect((await sync(root)).result.status).toBe("unchanged");
      exclude = await readExclude(root);
      expect(managedLines(exclude)).toContain(".metaproject/data/bundles/");
      expect(managedLines(exclude)).toContain(".metaproject/runtime/");
      expect(exclude.startsWith(before)).toBe(true);
      expect(exclude.endsWith(after)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("Codex mode skip leaves no override path to ignore", async () => {
    const root = await repo();
    try {
      const targets = defaultEntrypointTargets();
      const skipping = {
        ...targets,
        root: targets.root.map((entry) => (entry.runtime === "codex" && entry.scope === "local" ? { ...entry, mode: "skip" as const } : entry)),
      };
      await sync(root, localTargetPaths(skipping));

      const lines = managedLines(await readExclude(root));
      expect(lines).toContain("CLAUDE.local.md");
      expect(lines).toContain(".claude/settings.local.json");
      expect(lines).not.toContain("AGENTS.override.md");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // F-005: another worktree's branch may not carry the committed block, so
  // info/exclude still holds every entry.
  test("a managed block committed in HEAD is left alone; info/exclude still holds every entry", async () => {
    const gitignore = `node_modules/\n\n${LEGACY_BLOCK}\n`;
    const root = await repo({ ".gitignore": gitignore });
    try {
      const first = await sync(root, []);

      expect(await readFile(path.join(root, ".gitignore"), "utf8")).toBe(gitignore);
      expect(managedLines(await readExclude(root))).toEqual(renderMetaprojectGitignoreBlock().trim().split("\n"));
      expect(mustGit(root, ["status", "--porcelain"])).toBe("");
      expect(first.notices.some((line) => line.includes(".gitignore") && line.includes("HEAD"))).toBe(true);
      expect(first.notices.some((line) => line.includes("not repeated"))).toBe(false);

      await sync(root);
      expect(managedLines(await readExclude(root)).slice(-LOCAL_TARGETS.length)).toEqual(LOCAL_TARGETS);
      expect(await readFile(path.join(root, ".gitignore"), "utf8")).toBe(gitignore);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  for (const head of ["node_modules/\n", "node_modules/", "node_modules/\n\n\n"]) {
    test(`an uncommitted legacy block is moved to info/exclude and .gitignore goes back to HEAD (${JSON.stringify(head)}) (AC8)`, async () => {
      const root = await repo({ ".gitignore": head });
      try {
        // What the pre-361 writer left behind.
        await writeFile(path.join(root, ".gitignore"), `${head.trimEnd()}\n\n${LEGACY_BLOCK}\n`);
        expect(git(root, ["diff", "--quiet", "--", ".gitignore"]).code).toBe(1);

        const first = await sync(root);
        expect(git(root, ["diff", "--quiet", "--", ".gitignore"]).code).toBe(0);
        expect(await readFile(path.join(root, ".gitignore"), "utf8")).toBe(head);
        expect(mustGit(root, ["status", "--porcelain"])).not.toContain(".gitignore");
        expect(first.notices.some((line) => line.includes(".gitignore"))).toBe(true);
        const exclude = await readExclude(root);
        expect(managedLines(exclude)).toContain(".metaproject/runtime/");
        expect(git(root, ["check-ignore", "-q", "--", ".metaproject/runtime/x"]).code).toBe(0);

        const second = await sync(root);
        expect(second.result.status).toBe("unchanged");
        expect(second.notices).toEqual([]);
        expect(await readExclude(root)).toBe(exclude);
        expect(await readFile(path.join(root, ".gitignore"), "utf8")).toBe(head);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }

  // Flow 361 review round 1, F-004: the pre-361 writer also deleted team
  // lines OUTSIDE its block — every line duplicating one of its own, and a
  // blanket `.metaproject/` line where `.metaproject` was tracked. That
  // deletion was keryx's, not the developer's, so the file still goes back to HEAD.
  test("a .gitignore whose team lines the legacy writer deduplicated goes back to HEAD", async () => {
    const head = "node_modules/\n.metaproject/runtime/\n";
    const root = await repo({ ".gitignore": head });
    try {
      await writeFile(path.join(root, ".gitignore"), `node_modules/\n\n${LEGACY_BLOCK}\n`);
      const { notices } = await sync(root, ["CLAUDE.local.md"]);

      expect(await readFile(path.join(root, ".gitignore"), "utf8")).toBe(head);
      expect(git(root, ["diff", "--quiet", "--", ".gitignore"]).code).toBe(0);
      expect(notices.some((line) => line.startsWith(".gitignore: moved the managed keryx ignore block"))).toBe(true);
      expect(notices.some((line) => line.includes("your other uncommitted edits"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a blanket .metaproject/ line the legacy writer dropped where .metaproject was tracked goes back to HEAD", async () => {
    const head = "node_modules/\n.metaproject/\n";
    const root = await repo({ ".gitignore": head, ".metaproject/index.md": "# index\n" });
    try {
      await writeFile(path.join(root, ".gitignore"), `node_modules/\n\n${LEGACY_BLOCK}\n`);
      await sync(root);

      expect(await readFile(path.join(root, ".gitignore"), "utf8")).toBe(head);
      expect(git(root, ["diff", "--quiet", "--", ".gitignore"]).code).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a developer's own removal of a line the legacy writer never touched is still their edit", async () => {
    const root = await repo({ ".gitignore": "node_modules/\ndist/\n.metaproject/runtime/\n" });
    try {
      await writeFile(path.join(root, ".gitignore"), `node_modules/\n\n${LEGACY_BLOCK}\n`);
      const { notices } = await sync(root);

      expect(await readFile(path.join(root, ".gitignore"), "utf8")).toBe("node_modules/\n");
      expect(notices.some((line) => line.includes("your other uncommitted edits"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // Flow 361 review round 1, F-008: CRLF files keep CRLF on the strip path.
  test("a CRLF .gitignore loses the block and keeps its CRLF line endings", async () => {
    const root = await repo();
    try {
      const crlfBlock = LEGACY_BLOCK.split("\n").join("\r\n");
      await writeFile(path.join(root, ".gitignore"), `dist/\r\n\r\n${crlfBlock}\r\n\r\ncoverage/\r\n`);
      await sync(root);

      expect(await readFile(path.join(root, ".gitignore"), "utf8")).toBe("dist/\r\n\r\ncoverage/\r\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // Flow 361 T13 (T11 finding): the run that moves the block used to print
  // "moved … the file is back at HEAD" and then ".gitignore is not modified" —
  // two lines about the same file that read as a contradiction.
  test("the run that moves the block out of .gitignore does not also say .gitignore is not modified", async () => {
    const root = await repo({ ".gitignore": "node_modules/\n" });
    try {
      await writeFile(path.join(root, ".gitignore"), `node_modules/\n\n${LEGACY_BLOCK}\n`);
      const { notices } = await sync(root);

      expect(notices.some((line) => line.startsWith(".gitignore: moved the managed keryx ignore block"))).toBe(true);
      expect(notices.some((line) => line.includes(".gitignore is not modified"))).toBe(false);
      const summary = notices.find((line) => line.startsWith("Ignore rules: .git/info/exclude now holds"));
      expect(summary).toBeDefined();
      expect(summary).toContain("no keryx lines remain in .gitignore");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a run with no block in .gitignore still says .gitignore is not modified", async () => {
    const root = await repo({ ".gitignore": "node_modules/\n" });
    try {
      const { notices } = await sync(root);
      expect(notices).toEqual([
        expect.stringMatching(/^Ignore rules: \.git\/info\/exclude now holds keryx's managed block \(\d+ entries\); \.gitignore is not modified\.$/),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // R700-10 carried over: the markers, not the comment text inside, are what
  // identify the block — an OLD block with retired comments is moved out whole.
  test("an old managed block with retired comment text is moved out by its markers", async () => {
    const root = await repo({ ".gitignore": "node_modules/\n" });
    try {
      const oldBlock = [
        "# keryx:begin",
        "# Metaproject: keep agent-facing context versioned, ignore executable/generated internals.",
        ".metaproject/runtime/",
        "# Flow 313 (W4): the bundle ledger and staged/inspected bundle artifacts are",
        "# local runtime state (applied-state.json, temp audit copies), not something",
        "# a project commits.",
        ".metaproject/data/bundles/",
        "# keryx:end",
      ].join("\n");
      await writeFile(path.join(root, ".gitignore"), `node_modules/\n\n${oldBlock}\n`);

      await sync(root);

      expect(await readFile(path.join(root, ".gitignore"), "utf8")).toBe("node_modules/\n");
      const exclude = await readExclude(root);
      expect(exclude.split("# keryx:begin").length - 1).toBe(1);
      expect(exclude).not.toContain("Flow 313");
      expect(managedLines(exclude)).toContain(".metaproject/data/bundles/");
      expect(managedLines(exclude)).toContain(".metaproject/data/skills/stocktake/");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("unrelated uncommitted edits in .gitignore are kept byte-for-byte and the file is named (AC9)", async () => {
    const root = await repo({ ".gitignore": "node_modules/\n" });
    try {
      await writeFile(path.join(root, ".gitignore"), `node_modules/\ndist/\n\n${LEGACY_BLOCK}\n`);
      const before = await sync(root);
      expect(await readFile(path.join(root, ".gitignore"), "utf8")).toBe("node_modules/\ndist/\n");
      expect(before.notices.some((line) => line.includes(".gitignore") && line.includes("kept"))).toBe(true);
      expect(managedLines(await readExclude(root))).toContain(".metaproject/runtime/");

      // Edits on both sides of the block.
      await writeFile(path.join(root, ".gitignore"), `node_modules/\n\n${LEGACY_BLOCK}\n\n# mine\ncoverage/\n`);
      await sync(root);
      expect(await readFile(path.join(root, ".gitignore"), "utf8")).toBe("node_modules/\n\n# mine\ncoverage/\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // Decision (flow 361 T7): a `.gitignore` that is not in HEAD and holds
  // nothing but the keryx block is removed — every byte of it is keryx's, and
  // leaving an empty untracked file behind is the only other option.
  test("an untracked .gitignore that is nothing but the keryx block is removed, and reported", async () => {
    const root = await repo();
    try {
      await writeFile(path.join(root, ".gitignore"), `\n\n${LEGACY_BLOCK}\n`);
      const { notices } = await sync(root);

      expect(existsSync(path.join(root, ".gitignore"))).toBe(false);
      expect(mustGit(root, ["status", "--porcelain"])).toBe("");
      expect(notices.some((line) => line.includes(".gitignore") && line.includes("removed the file"))).toBe(true);
      expect(managedLines(await readExclude(root))).toContain(".metaproject/runtime/");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("an untracked .gitignore with other content loses only the block and stays", async () => {
    const root = await repo();
    try {
      await writeFile(path.join(root, ".gitignore"), `dist/\n\n${LEGACY_BLOCK}\n`);
      const { notices } = await sync(root);

      expect(await readFile(path.join(root, ".gitignore"), "utf8")).toBe("dist/\n");
      expect(notices.some((line) => line.includes(".gitignore") && line.includes("untracked"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a staged .gitignore that is nothing but the block is emptied, not deleted from under the index", async () => {
    const root = await repo();
    try {
      await writeFile(path.join(root, ".gitignore"), `\n\n${LEGACY_BLOCK}\n`);
      mustGit(root, ["add", "--", ".gitignore"]);
      await sync(root);

      expect(existsSync(path.join(root, ".gitignore"))).toBe(true);
      expect(await readFile(path.join(root, ".gitignore"), "utf8")).not.toContain("# keryx:begin");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("from a linked worktree the common dir's info/exclude is written and covers every worktree (AC6)", async () => {
    const main = await repo();
    const linked = `${main}-linked`;
    try {
      mustGit(main, ["worktree", "add", "-q", linked, "-b", "linked-branch"]);
      const { result } = await sync(linked);
      expect(result.status).toBe("written");

      expect(managedLines(await readExclude(main))).toContain(".metaproject/runtime/");
      expect(existsSync(path.join(main, ".git", "worktrees", path.basename(linked), "info", "exclude"))).toBe(false);
      for (const checkout of [main, linked]) {
        expect(existsSync(path.join(checkout, ".gitignore"))).toBe(false);
        for (const target of LOCAL_TARGETS) {
          expect(git(checkout, ["check-ignore", "-q", "--", target]).code).toBe(0);
        }
      }
      expect((await sync(main)).result.status).toBe("unchanged");
    } finally {
      await rm(linked, { recursive: true, force: true });
      await rm(main, { recursive: true, force: true });
    }
  });

  test("a project in a subdirectory of the repository is ignored through prefixed patterns", async () => {
    const root = await repo();
    try {
      const project = path.join(root, "packages", "app");
      await mkdir(project, { recursive: true });
      await sync(project);

      const exclude = await readExclude(root);
      expect(exclude).toContain("# keryx:begin packages/app/\n");
      expect(exclude).toContain("\npackages/app/.metaproject/runtime/\n");
      for (const target of LOCAL_TARGETS) {
        expect(git(project, ["check-ignore", "-q", "--", target]).code).toBe(0);
      }
      expect(git(project, ["check-ignore", "-q", "--", ".metaproject/runtime/x"]).code).toBe(0);
      expect(git(root, ["check-ignore", "-q", "--", ".metaproject/runtime/x"]).code).toBe(1);
      expect((await sync(project)).result.status).toBe("unchanged");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("outside a git repository nothing is written and one note says so", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "keryx-ignore-rules-nogit-"));
    try {
      const first = await sync(root);
      expect(first.result.status).toBe("not-a-git-repository");
      expect(first.notices).toHaveLength(1);
      expect(first.notices[0]).toContain("not a git repository");
      expect(existsSync(path.join(root, ".gitignore"))).toBe(false);

      // A block an older keryx wrote there has nowhere to move to: left as it is.
      const legacy = `node_modules/\n\n${LEGACY_BLOCK}\n`;
      await writeFile(path.join(root, ".gitignore"), legacy);
      await sync(root);
      expect(await readFile(path.join(root, ".gitignore"), "utf8")).toBe(legacy);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a `!` rule that re-includes a local target is reported", async () => {
    const root = await repo({ ".gitignore": "!CLAUDE.local.md\n" });
    try {
      const { notices } = await sync(root);
      expect(notices.some((line) => line.includes("CLAUDE.local.md") && line.includes(".gitignore:1"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // Flow 315 T5 (R5-F1 minor): a project's own `.gitignore` can be a symlink
  // pointing outside the project. Taking the legacy block out of it must not
  // write through the link — `writeContained` refuses (ContainedWriteError,
  // reason "escaping-symlink") and the outside file stays byte-for-byte.
  test("refuses to rewrite a .gitignore symlink that escapes the project", async () => {
    const root = await repo();
    const outsideRoot = await mkdtemp(path.join(tmpdir(), "keryx-gitignore-escape-outside-"));
    try {
      const sentinelPath = path.join(outsideRoot, "victim.gitignore");
      const original = `ORIGINAL\n\n${LEGACY_BLOCK}\n`;
      await writeFile(sentinelPath, original);
      await symlink(sentinelPath, path.join(root, ".gitignore"));

      let caught: unknown;
      try {
        await syncMetaprojectIgnoreRules(root);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(ContainedWriteError);
      expect((caught as ContainedWriteError).reason).toBe("escaping-symlink");
      expect(await readFile(sentinelPath, "utf8")).toBe(original);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });
});
