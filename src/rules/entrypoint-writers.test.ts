import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { uniqueTestRoot } from "../lib/test-tmp";
import { ensureMetaprojectReference, syncAgentRules } from "./agent-entrypoints";
import { defaultEntrypointTargets } from "./entrypoint-targets";
import {
  codexOverrideByteSize,
  codexOverrideState,
  declaredImportSources,
  isCodexOverrideStale,
  manifestAgentEntrypoints,
  parseCodexOverrideProvenance,
  renderCodexOverride,
  resolveProjectEntrypoints,
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
