import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { syncMetaprojectIgnoreRules } from "../lib/metaproject-gitignore";
import { uniqueTestRoot } from "../lib/test-tmp";
import { ensureMetaprojectReference, syncAgentRules } from "./agent-entrypoints";
import {
  defaultEntrypointTargets,
  localClaudeSettingsTarget,
  localRootEntry,
  normalizeEntrypointTargets,
  sharedEntrypointTargets,
  type CodexLocalRootEntry,
} from "./entrypoint-targets";
import {
  codexOverrideByteSize,
  codexOverrideState,
  declaredImportSources,
  ignoredLocalTargetPaths,
  isCodexOverrideStale,
  manifestAgentEntrypoints,
  parseCodexOverrideProvenance,
  planLocalLeftovers,
  renderCodexOverride,
  resolveProjectEntrypoints,
  writeCodexLocalTargets,
  writeEntrypointBlocks,
} from "./entrypoint-writers";

const BLOCK = "<!-- keryx:index -->\n## Metaproject\n<!-- /keryx:index -->\n";
const CODEX_ENTRY = { path: "AGENTS.override.md", source: "AGENTS.md" };

async function git(cwd: string, args: string[]): Promise<number> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "ignore", stderr: "ignore" });
  return proc.exited;
}

async function initRepo(root: string, files: Record<string, string>): Promise<void> {
  await mkdir(root, { recursive: true });
  await git(root, ["init", "-q"]);
  await git(root, ["config", "user.email", "keryx@example.test"]);
  await git(root, ["config", "user.name", "Keryx Test"]);
  for (const [rel, content] of Object.entries(files)) {
    await writeFile(path.join(root, rel), content);
    await git(root, ["add", "--", rel]);
  }
  expect(await git(root, ["commit", "-q", "-m", "fixture"])).toBe(0);
}

test("renderCodexOverride: provenance line, then the block, then the source without its own block", () => {
  const source = `# Team\n\n${BLOCK}\nRules for everyone.\n`;
  const rendered = renderCodexOverride({ source: "AGENTS.md", sourceContent: source, block: BLOCK });

  const [firstLine] = rendered.split("\n");
  expect(firstLine).toMatch(/^<!-- keryx:override source="AGENTS\.md" sha256=[0-9a-f]{64} /);
  expect(parseCodexOverrideProvenance(rendered)?.source).toBe("AGENTS.md");
  // Exactly one block: the one keryx put first, not a second copy from the source.
  expect(rendered.split("<!-- keryx:index -->").length - 1).toBe(1);
  expect(rendered.indexOf("<!-- /keryx:index -->")).toBeLessThan(rendered.indexOf("# Team"));
  expect(rendered).toContain("Rules for everyone.\n");
});

test("parseCodexOverrideProvenance returns nothing for a file keryx did not generate", () => {
  expect(parseCodexOverrideProvenance("# My own override\n")).toBeUndefined();
  expect(parseCodexOverrideProvenance(`intro\n<!-- keryx:override source="AGENTS.md" sha256=${"a".repeat(64)} -->\n`)).toBeUndefined();
});

test("manifestAgentEntrypoints writes the entry form and keeps pointer fields and key order", async () => {
  const entrypoints = { targets: defaultEntrypointTargets(), importSources: [] };
  const fromLegacy = manifestAgentEntrypoints({ root: ["AGENTS.md"], custom: 1 }, entrypoints, { metaproject: ".metaproject/index.md" });
  expect(fromLegacy.root).toEqual([
    { runtime: "claude", path: "CLAUDE.local.md", scope: "local" },
    { runtime: "codex", path: "AGENTS.override.md", scope: "local", mode: "override", source: "AGENTS.md" },
  ]);
  expect(fromLegacy.claudeSettings).toEqual({ path: ".claude/settings.local.json", scope: "local" });
  expect(fromLegacy.metaproject).toBe(".metaproject/index.md");
  expect((fromLegacy as Record<string, unknown>).custom).toBe(1);
  expect("importSources" in fromLegacy).toBe(false);

  // Feeding the result back in serialises to the same bytes.
  const again = manifestAgentEntrypoints(fromLegacy, entrypoints, { metaproject: ".metaproject/index.md" });
  expect(JSON.stringify(again)).toBe(JSON.stringify(fromLegacy));
});

test("a legacy root string naming another root file is kept as an import source, never as a target", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-entry-writers-custom");
  try {
    await mkdir(root, { recursive: true });
    const legacy = { root: ["AGENTS.md", "TEAM.md", "../escape.md", "CLAUDE.local.md"] };
    const resolved = await resolveProjectEntrypoints(root, legacy);
    expect(resolved.importSources).toEqual(["TEAM.md"]);
    expect(resolved.targets.root.map((entry) => entry.path)).toEqual(["AGENTS.override.md", "CLAUDE.local.md"]);
    expect(declaredImportSources(legacy)).toEqual(["AGENTS.md", "CLAUDE.md", "TEAM.md"]);

    // Once written in entry form, the source survives the round trip.
    const written = manifestAgentEntrypoints(legacy, resolved);
    expect(written.importSources).toEqual(["TEAM.md"]);
    expect((await resolveProjectEntrypoints(root, written)).importSources).toEqual(["TEAM.md"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an entry switched to local by hand never targets the team file itself", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-entry-writers-hand-edit");
  try {
    await mkdir(root, { recursive: true });
    const resolved = await resolveProjectEntrypoints(root, {
      root: [
        { runtime: "codex", path: "AGENTS.md", scope: "local", mode: "skip" },
        { runtime: "claude", path: "CLAUDE.md", scope: "local" },
      ],
      claudeSettings: { path: ".claude/settings.json", scope: "shared" },
    });
    expect(resolved.targets.root).toEqual([
      { runtime: "codex", path: "AGENTS.override.md", scope: "local", mode: "skip", source: "AGENTS.md" },
      { runtime: "claude", path: "CLAUDE.local.md", scope: "local" },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("codexOverrideState: missing, fresh, stale after the source changes, source-missing, unmanaged", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-entry-writers-stale");
  try {
    await mkdir(path.join(root, ".metaproject"), { recursive: true });
    await writeFile(path.join(root, "AGENTS.md"), "# Team\n\nRules.\n");
    expect(await codexOverrideState(root, CODEX_ENTRY)).toBe("missing");
    expect(await codexOverrideByteSize(root, CODEX_ENTRY)).toBeUndefined();

    await syncAgentRules(root, path.join(root, ".metaproject"), { targets: defaultEntrypointTargets() });
    expect(await codexOverrideState(root, CODEX_ENTRY)).toBe("fresh");
    expect(await isCodexOverrideStale(root, CODEX_ENTRY)).toBe(false);
    const override = await readFile(path.join(root, "AGENTS.override.md"));
    expect(await codexOverrideByteSize(root, CODEX_ENTRY)).toBe(override.byteLength);

    await writeFile(path.join(root, "AGENTS.md"), "# Team\n\nRules, revised.\n");
    expect(await codexOverrideState(root, CODEX_ENTRY)).toBe("stale");
    expect(await isCodexOverrideStale(root, CODEX_ENTRY)).toBe(true);

    await rm(path.join(root, "AGENTS.md"));
    expect(await codexOverrideState(root, CODEX_ENTRY)).toBe("source-missing");

    await writeFile(path.join(root, "AGENTS.override.md"), "# Mine\n");
    expect(await codexOverrideState(root, CODEX_ENTRY)).toBe("unmanaged");
    expect(await isCodexOverrideStale(root, CODEX_ENTRY)).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an AGENTS.override.md keryx did not generate is left untouched and reported", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-entry-writers-unmanaged");
  try {
    await mkdir(path.join(root, ".metaproject"), { recursive: true });
    await writeFile(path.join(root, "AGENTS.md"), "# Team\n");
    await writeFile(path.join(root, "AGENTS.override.md"), "# My own override\n");
    const notices: string[] = [];
    await syncAgentRules(root, path.join(root, ".metaproject"), {
      targets: defaultEntrypointTargets(),
      onNotice: (line) => notices.push(line),
    });
    expect(await readFile(path.join(root, "AGENTS.override.md"), "utf8")).toBe("# My own override\n");
    expect(notices.some((line) => line.includes("AGENTS.override.md") && line.includes("not generated by keryx"))).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLAUDE.local.md imports AGENTS.md only when keryx creates it in a repository with no CLAUDE.md", async () => {
  const agentsOnly = uniqueTestRoot(tmpdir(), "keryx-entry-writers-import");
  const both = uniqueTestRoot(tmpdir(), "keryx-entry-writers-noimport");
  const existing = uniqueTestRoot(tmpdir(), "keryx-entry-writers-existing");
  try {
    for (const root of [agentsOnly, both, existing]) {
      await mkdir(path.join(root, ".metaproject"), { recursive: true });
      await writeFile(path.join(root, "AGENTS.md"), "# Team\n");
    }
    await writeFile(path.join(both, "CLAUDE.md"), "# Claude\n");
    await writeFile(path.join(existing, "CLAUDE.local.md"), "# Mine\n\nMy sandbox URL.\n");
    for (const root of [agentsOnly, both, existing]) {
      await syncAgentRules(root, path.join(root, ".metaproject"), { targets: defaultEntrypointTargets() });
    }

    const created = await readFile(path.join(agentsOnly, "CLAUDE.local.md"), "utf8");
    expect(created).toContain("<!-- keryx:index -->");
    expect(created.split("\n")).toContain("@AGENTS.md");
    expect((await readFile(path.join(both, "CLAUDE.local.md"), "utf8")).split("\n")).not.toContain("@AGENTS.md");
    const kept = await readFile(path.join(existing, "CLAUDE.local.md"), "utf8");
    expect(kept).toContain("My sandbox URL.");
    expect(kept).toContain("<!-- keryx:index -->");
    expect(kept.split("\n")).not.toContain("@AGENTS.md");
  } finally {
    for (const root of [agentsOnly, both, existing]) await rm(root, { recursive: true, force: true });
  }
});

test("a block committed in HEAD is stripped, not restored, once the manifest says local — and a custom source is left alone", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-entry-writers-switch");
  try {
    const committed = `# Team\n\n${BLOCK}\nRules.\n`;
    await initRepo(root, { "AGENTS.md": committed, "TEAM.md": committed });
    await mkdir(path.join(root, ".metaproject"), { recursive: true });
    const notices: string[] = [];
    await syncAgentRules(root, path.join(root, ".metaproject"), {
      targets: defaultEntrypointTargets(),
      manifestSources: ["TEAM.md"],
      onNotice: (line) => notices.push(line),
    });
    expect(await readFile(path.join(root, "AGENTS.md"), "utf8")).toBe("# Team\n\nRules.\n");
    expect(notices.some((line) => line.startsWith("AGENTS.md:") && line.includes("commit this removal"))).toBe(true);
    expect(await readFile(path.join(root, "TEAM.md"), "utf8")).toBe(committed);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Flow 361 T13 (T11 finding): creating a per-developer file used to be
// silent. One line each, on creation only — a refresh prints nothing.
test("creating CLAUDE.local.md and generating AGENTS.override.md each print one line, and only the first time", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-entry-writers-created");
  try {
    await initRepo(root, { "AGENTS.md": "# Team\n", "CLAUDE.md": "# Claude\n" });
    await mkdir(path.join(root, ".metaproject"), { recursive: true });
    // What `init`/`update` do before the block writers run.
    await syncMetaprojectIgnoreRules(root, { localTargets: ["CLAUDE.local.md", "AGENTS.override.md"] });
    const run = async (): Promise<string[]> => {
      const notices: string[] = [];
      await syncAgentRules(root, path.join(root, ".metaproject"), {
        targets: defaultEntrypointTargets(),
        onNotice: (line) => notices.push(line),
      });
      return notices;
    };

    const first = await run();
    expect(first).toEqual([
      "CLAUDE.local.md: created with the keryx block (gitignored, per checkout).",
      "AGENTS.override.md: generated from AGENTS.md with the keryx block (gitignored, per checkout); Codex reads it instead of AGENTS.md.",
    ]);
    const claudeLocal = await readFile(path.join(root, "CLAUDE.local.md"), "utf8");
    const override = await readFile(path.join(root, "AGENTS.override.md"), "utf8");

    expect(await run()).toEqual([]);
    expect(await readFile(path.join(root, "CLAUDE.local.md"), "utf8")).toBe(claudeLocal);
    expect(await readFile(path.join(root, "AGENTS.override.md"), "utf8")).toBe(override);

    // Regenerating an override whose source changed is a refresh, not a creation.
    await writeFile(path.join(root, "AGENTS.md"), "# Team\n\nRevised.\n");
    expect(await run()).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the creation lines claim gitignored only when git ignores the file: no repository, and a repository with no ignore rules yet", async () => {
  const noGit = uniqueTestRoot(tmpdir(), "keryx-entry-writers-created-nogit");
  const unignored = uniqueTestRoot(tmpdir(), "keryx-entry-writers-created-unignored");
  try {
    await mkdir(noGit, { recursive: true });
    await writeFile(path.join(noGit, "AGENTS.md"), "# Team\n");
    // `rules sync` writes no ignore rules; a fresh repository has none.
    await initRepo(unignored, { "AGENTS.md": "# Team\n" });
    await git(unignored, ["config", "core.excludesFile", path.join(unignored, ".git", "no-global-excludes")]);
    const expected = {
      [noGit]: "(a per-developer file",
      [unignored]: "(per checkout, but git does not ignore it yet — `keryx update` adds it to info/exclude",
    };
    for (const [root, note] of Object.entries(expected)) {
      await mkdir(path.join(root, ".metaproject"), { recursive: true });
      const notices: string[] = [];
      await syncAgentRules(root, path.join(root, ".metaproject"), {
        targets: defaultEntrypointTargets(),
        onNotice: (line) => notices.push(line),
      });
      const created = notices.filter((line) => line.includes("created with") || line.includes("generated from"));
      expect(created).toHaveLength(2);
      for (const line of created) {
        expect(line).toContain(note);
        expect(line).not.toContain("gitignored");
      }
    }
  } finally {
    for (const root of [noGit, unignored]) await rm(root, { recursive: true, force: true });
  }
});

test("an untracked team file loses only the block and is never deleted", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-entry-writers-untracked");
  try {
    await initRepo(root, { "README.md": "readme\n" });
    await mkdir(path.join(root, ".metaproject"), { recursive: true });
    await writeFile(path.join(root, "AGENTS.md"), "# AGENTS Instructions\n");
    await ensureMetaprojectReference(path.join(root, "AGENTS.md"), { root });
    const notices: string[] = [];
    await syncAgentRules(root, path.join(root, ".metaproject"), {
      targets: defaultEntrypointTargets(),
      onNotice: (line) => notices.push(line),
    });
    expect(existsSync(path.join(root, "AGENTS.md"))).toBe(true);
    expect(await readFile(path.join(root, "AGENTS.md"), "utf8")).toBe("# AGENTS Instructions\n");
    expect(notices.some((line) => line.startsWith("AGENTS.md:") && line.includes("untracked"))).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Flow 361 review round 1, F-001: the paths keryx ignores and writes come
// from a tracked manifest a cloned repository controls.
test("a cloned manifest's local paths never reach info/exclude or a write: the standard local files are used", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-entry-writers-manifest-paths");
  try {
    await initRepo(root, { "AGENTS.md": "# Team\n" });
    const resolved = await resolveProjectEntrypoints(root, {
      root: [
        { runtime: "claude", scope: "local", path: "!.env" },
        { runtime: "codex", scope: "local", path: "AGENTS.override.md\n!*.pem\n# keryx:end", mode: "override", source: "AGENTS.md" },
      ],
      claudeSettings: { scope: "local", path: "!secrets.json" },
    });
    expect(ignoredLocalTargetPaths(resolved.targets)).toEqual([
      "CLAUDE.local.md",
      "AGENTS.override.md",
      ".claude/settings.local.json",
    ]);
    await mkdir(path.join(root, ".metaproject"), { recursive: true });
    await syncAgentRules(root, path.join(root, ".metaproject"), { targets: resolved.targets });
    expect(existsSync(path.join(root, "CLAUDE.local.md"))).toBe(true);
    expect(existsSync(path.join(root, "!.env"))).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Flow 361 review round 2, F-014: `info/exclude` is shared by every worktree,
// so the leftover `CLAUDE.local.md` of a Claude entry switched back to shared
// is listed whether or not this checkout has the file.
test("the leftover CLAUDE.local.md is ignored whether or not the checkout has it", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-entry-writers-leftover-ignore");
  try {
    await initRepo(root, { "AGENTS.md": "# Team\n", "CLAUDE.md": "# Claude\n" });
    const resolved = await resolveProjectEntrypoints(root, {
      root: [
        { runtime: "claude", scope: "shared", path: "CLAUDE.md" },
        { runtime: "codex", scope: "shared", path: "AGENTS.md" },
      ],
    });
    const withoutFile = ignoredLocalTargetPaths(resolved.targets);
    expect(withoutFile).toContain("CLAUDE.local.md");
    await writeFile(path.join(root, "CLAUDE.local.md"), "# Mine\n");
    expect(ignoredLocalTargetPaths(resolved.targets)).toEqual(withoutFile);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Flow 361 review round 1, F-002: `readFile` follows symlinks, so a source
// under a committed `home -> $HOME` link would be copied into the override
// Codex sends to its model provider.
test("a Codex override source reached through a symlink leaving the project is never read", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-entry-writers-symlink-source");
  const outside = uniqueTestRoot(tmpdir(), "keryx-entry-writers-symlink-outside");
  try {
    await mkdir(path.join(outside, ".aws"), { recursive: true });
    await writeFile(path.join(outside, ".aws", "credentials"), "aws_secret_access_key = OUTSIDE-SECRET\n");
    await mkdir(path.join(root, ".metaproject"), { recursive: true });
    await writeFile(path.join(root, "AGENTS.md"), "# Team\n");
    await symlink(outside, path.join(root, "home"));

    const statedRoot = [
      { runtime: "claude", scope: "shared", path: "CLAUDE.md" },
      { runtime: "codex", scope: "local", mode: "override", source: "home/.aws/credentials" },
    ];
    // Flow 363 review round 1, F-001: a manifest can no longer name such a
    // source at all — it is junk. The writers still refuse the symlink for
    // targets built by hand, which is what the rest of this test drives.
    expect(normalizeEntrypointTargets({ root: statedRoot, claudeSettings: { scope: "local" } }).ignored).toEqual([statedRoot[1]]);
    const codex: CodexLocalRootEntry = { runtime: "codex", path: "AGENTS.override.md", scope: "local", mode: "override", source: "home/.aws/credentials" };
    const targets = { root: [{ runtime: "claude" as const, path: "CLAUDE.md", scope: "shared" as const }, codex], claudeSettings: { path: ".claude/settings.local.json", scope: "local" as const } };

    const notices: string[] = [];
    await writeCodexLocalTargets(root, targets, { onNotice: (line) => notices.push(line) });
    expect(existsSync(path.join(root, "AGENTS.override.md"))).toBe(false);
    expect(notices.some((line) => line.includes("home/.aws/credentials") && line.includes("symlink"))).toBe(true);

    // An override already on disk that names the source: its state is
    // refused, not computed from the secret, and a rerun leaves it as it is.
    const planted = renderCodexOverride({ source: "home/.aws/credentials", sourceContent: "old\n", block: BLOCK });
    await writeFile(path.join(root, "AGENTS.override.md"), planted);
    expect(await codexOverrideState(root, codex)).toBe("source-refused");
    expect(await isCodexOverrideStale(root, codex)).toBe(false);
    await writeCodexLocalTargets(root, targets, {});
    expect(await readFile(path.join(root, "AGENTS.override.md"), "utf8")).toBe(planted);

    // Through `rules sync` as well.
    await syncAgentRules(root, path.join(root, ".metaproject"), { targets });
    expect(await readFile(path.join(root, "AGENTS.override.md"), "utf8")).not.toContain("OUTSIDE-SECRET");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

// Flow 361 review round 1, F-008: every strip path keeps a CRLF file CRLF.
const CRLF_TEAM = "# Team\r\n\r\nIntro line\r\n\r\n<!-- keryx:index -->\r\nblock body\r\n<!-- /keryx:index -->\r\n\r\nAfter line\r\n";
const CLAUDE_ONLY_LOCAL = { root: [localRootEntry("claude")], claudeSettings: localClaudeSettingsTarget() };

test("stripping the block from a CRLF team file outside git keeps CRLF line endings", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-entry-writers-crlf-nogit");
  try {
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, "AGENTS.md"), CRLF_TEAM);
    await writeEntrypointBlocks(root, CLAUDE_ONLY_LOCAL, { sources: ["AGENTS.md"] });
    expect(await readFile(path.join(root, "AGENTS.md"), "utf8")).toBe("# Team\r\n\r\nIntro line\r\n\r\nAfter line\r\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stripping the block from a CRLF team file with other edits reuses HEAD's spacing and keeps CRLF", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-entry-writers-crlf-edits");
  try {
    await initRepo(root, { "AGENTS.md": "# Team\r\n\r\nIntro line\r\nAfter line\r\n" });
    await writeFile(path.join(root, "AGENTS.md"), `${CRLF_TEAM}Mine.\r\n`);
    await writeEntrypointBlocks(root, CLAUDE_ONLY_LOCAL, { sources: ["AGENTS.md"] });
    expect(await readFile(path.join(root, "AGENTS.md"), "utf8")).toBe("# Team\r\n\r\nIntro line\r\nAfter line\r\nMine.\r\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a CRLF CLAUDE.local.md left over after the switch to shared loses keryx's part and keeps CRLF", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-entry-writers-crlf-leftover");
  try {
    await mkdir(root, { recursive: true });
    await writeFile(
      path.join(root, "CLAUDE.local.md"),
      "# Local Claude Instructions\r\n\r\nMy sandbox URL.\r\n\r\n<!-- keryx:index -->\r\nblock\r\n<!-- /keryx:index -->\r\n",
    );
    const [leftover] = await planLocalLeftovers(root, sharedEntrypointTargets());
    expect(leftover).toMatchObject({ action: "strip", next: "# Local Claude Instructions\r\n\r\nMy sandbox URL.\r\n" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Flow 361 review round 1, F-009: a strip leaves the index alone, so a staged
// copy can still carry the block into the next plain `git commit`.
test("a staged, never-committed team file is not called untracked, and the staged block is pointed out", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-entry-writers-staged-new");
  try {
    await initRepo(root, { "README.md": "readme\n" });
    await mkdir(path.join(root, ".metaproject"), { recursive: true });
    await writeFile(path.join(root, "AGENTS.md"), `# Team\n\n${BLOCK}\nRules.\n`);
    expect(await git(root, ["add", "--", "AGENTS.md"])).toBe(0);
    const notices: string[] = [];
    await syncAgentRules(root, path.join(root, ".metaproject"), { targets: defaultEntrypointTargets(), onNotice: (line) => notices.push(line) });

    expect(await readFile(path.join(root, "AGENTS.md"), "utf8")).toBe("# Team\n\nRules.\n");
    const line = notices.find((notice) => notice.startsWith("AGENTS.md:"));
    expect(line).toBeDefined();
    expect(line).not.toContain("untracked");
    expect(line).toContain("staged");
    expect(line).toContain("git add AGENTS.md");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a committed team file with other edits and a staged block gets the git restore --staged hint", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-entry-writers-staged-block");
  try {
    await initRepo(root, { "AGENTS.md": "# Team\n" });
    await mkdir(path.join(root, ".metaproject"), { recursive: true });
    await writeFile(path.join(root, "AGENTS.md"), `# Team\n\n${BLOCK}\nMine.\n`);
    expect(await git(root, ["add", "--", "AGENTS.md"])).toBe(0);
    const notices: string[] = [];
    await syncAgentRules(root, path.join(root, ".metaproject"), { targets: defaultEntrypointTargets(), onNotice: (line) => notices.push(line) });

    expect(await readFile(path.join(root, "AGENTS.md"), "utf8")).toBe("# Team\n\nMine.\n");
    const line = notices.find((notice) => notice.startsWith("AGENTS.md:"));
    expect(line).toContain("your other uncommitted edits");
    expect(line).toContain("git restore --staged AGENTS.md");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Flow 361 review round 1, F-010: Codex reads AGENTS.override.md instead of
// AGENTS.md; with AGENTS.md gone, a leftover override is the only thing it reads.
test("a keryx-generated AGENTS.override.md is removed once AGENTS.md is gone, and the output says so", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-entry-writers-source-gone");
  try {
    await initRepo(root, { "README.md": "readme\n" });
    await mkdir(path.join(root, ".metaproject"), { recursive: true });
    await writeFile(path.join(root, "AGENTS.md"), "# Team\n");
    await syncAgentRules(root, path.join(root, ".metaproject"), { targets: defaultEntrypointTargets() });
    expect(existsSync(path.join(root, "AGENTS.override.md"))).toBe(true);

    await rm(path.join(root, "AGENTS.md"));
    const notices: string[] = [];
    await syncAgentRules(root, path.join(root, ".metaproject"), { targets: defaultEntrypointTargets(), onNotice: (line) => notices.push(line) });
    expect(existsSync(path.join(root, "AGENTS.override.md"))).toBe(false);
    expect(notices.some((line) => line.startsWith("AGENTS.override.md: removed") && line.includes("AGENTS.md"))).toBe(true);

    // One the developer wrote stays.
    await writeFile(path.join(root, "AGENTS.override.md"), "# Mine\n");
    await syncAgentRules(root, path.join(root, ".metaproject"), { targets: defaultEntrypointTargets() });
    expect(await readFile(path.join(root, "AGENTS.override.md"), "utf8")).toBe("# Mine\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Flow 361 review round 1, F-011: a tracked CLAUDE.local.md is the team's
// file, and writing the block there would show it dirty after every update.
test("the block is never written into a tracked CLAUDE.local.md; the output says how to fix it", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-entry-writers-tracked-local");
  try {
    await initRepo(root, { "AGENTS.md": "# Team\n", "CLAUDE.md": "# Claude\n", "CLAUDE.local.md": "# Committed local\n" });
    await mkdir(path.join(root, ".metaproject"), { recursive: true });
    const notices: string[] = [];
    await syncAgentRules(root, path.join(root, ".metaproject"), { targets: defaultEntrypointTargets(), onNotice: (line) => notices.push(line) });

    expect(await readFile(path.join(root, "CLAUDE.local.md"), "utf8")).toBe("# Committed local\n");
    expect(await git(root, ["diff", "--quiet", "--", "CLAUDE.local.md"])).toBe(0);
    const line = notices.find((notice) => notice.startsWith("CLAUDE.local.md:"));
    expect(line).toContain("tracked");
    expect(line).toContain("git rm --cached CLAUDE.local.md");
    expect(line).toContain('"shared"');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
