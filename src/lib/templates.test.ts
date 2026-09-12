import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  renderGdgraphCoreCli,
  renderGdgraphManifest,
  renderGdgraphSkillReadme,
  renderHooksReadme,
  renderIndexGateMarkdown,
  renderIndexMarkdown,
  ROUTING_FILENAME,
  renderMetaprojectGitignoreBlock,
  renderMetaprojectDashboardHtml,
  renderAgentEntrypoint,
  renderImportedAgentRules,
  renderProjectRulesReadme,
} from "./templates";
import { renderProjectMetaprojectReferenceBlock } from "./agent-entrypoint-blocks";
import { GDGRAPH_CORE_SOURCES } from "../gdgraph/core-sources";

const ALL_MODULES = {
  enableGdgraph: true,
  enableGdctx: true,
  enableGdwiki: true,
  enableGdskills: true,
  enableHealth: true,
  enableTesting: true,
  enableMemory: true,
  enableTasks: true,
  enableSecurity: true,
  ruleSources: [] as string[],
};

test("generated index uses supported refresh commands only", () => {
  const index = renderIndexMarkdown({
    enableGdgraph: true,
    enableGdctx: true,
    enableGdwiki: true,
    enableGdskills: true,
    enableHealth: true,
    enableTesting: true,
    enableMemory: true,
    enableTasks: true,
    enableSecurity: true,
    ruleSources: [],
  });
  expect(index).not.toContain("keryx index refresh");
  expect(index).toContain("keryx gdgraph build");
  expect(index).toContain("keryx wiki index");
  expect(index).toContain("keryx test analyze");
  expect(index).not.toContain("data/memory/artifacts/latest.md");
});

test("generated index gives one-per-session, non-blocking version advisory guidance", () => {
  const index = renderIndexMarkdown({
    enableGdgraph: true,
    enableGdctx: true,
    enableGdwiki: true,
    enableGdskills: true,
    enableHealth: true,
    enableTesting: true,
    enableMemory: true,
    enableTasks: true,
    enableSecurity: true,
    ruleSources: [],
  });

  expect(index).toContain("keryx version check --json");
  expect(index).toMatch(/once per session/i);
  expect(index).toContain("update-available");
  expect(index).toMatch(/notify|advisory/i);
  expect(index).toMatch(/never block|non-blocking/i);
  for (const outcome of ["timeout", "offline", "unavailable", "unknown-command"]) {
    expect(index).toContain(outcome);
  }
});

// The graph answers from the last build, and a stale answer is indistinguishable
// from a fresh one. Every agent-facing surface must therefore carry the refresh
// rule: the manifest holds the contract, the index and the root entrypoint block
// route to it.

test("gdgraph manifest states the freshness contract: what invalidates, how it shows, how to repair", () => {
  const manifest = renderGdgraphManifest();

  expect(manifest).toContain("## Freshness & Refresh");
  // What invalidates the graph.
  expect(manifest).toMatch(/added, deleted, renamed or moved/i);
  expect(manifest).toMatch(/import added or removed/i);
  // The symbol layer is the part an in-file edit does invalidate.
  expect(manifest).toMatch(/symbol layer/i);
  // How staleness is observed, and how it is repaired.
  expect(manifest).toContain("keryx gdgraph context");
  expect(manifest).toContain("freshness: working tree clean");
  expect(manifest).toContain("keryx gdgraph build");
  // The hook half, including its opt-out and its cost.
  expect(manifest).toContain("KERYX_GDGRAPH_HOOK_REBUILD=0");
});

test("generated index routes graph staleness in both the workflow and the intent router", () => {
  const index = renderIndexMarkdown({ ...ALL_MODULES });

  // Workflow item: rebuild before trusting an answer, not once per question.
  expect(index).toMatch(/last `keryx gdgraph build`, not from the working tree/);
  expect(index).toMatch(/added, renamed, deleted or moved files in this session/);
  expect(index).toContain("keryx gdgraph context");
  expect(index).toContain("modules/gdgraph.md");
  // Intent router row for the same intent.
  expect(index).toMatch(/\|[^\n]*graph answers look stale[^\n]*\|[^\n]*keryx gdgraph build[^\n]*\|/i);
});

test("index drops the graph freshness routing when gdgraph is disabled", () => {
  const index = renderIndexMarkdown({ ...ALL_MODULES, enableGdgraph: false });

  expect(index).not.toContain("keryx gdgraph build");
  expect(index).not.toMatch(/graph answers look stale/i);
});

test("root entrypoint block carries the same rebuild rule as the index", () => {
  const block = renderProjectMetaprojectReferenceBlock({ enableTasks: true });

  expect(block).toContain("<!-- keryx:index -->");
  expect(block).toMatch(/last `keryx gdgraph build`, not from the working tree/);
  expect(block).toContain(".metaproject/modules/gdgraph.md");
});

test("the managed gitignore block covers forgetting and retention runtime state", () => {
  // These two lines were added to this repository's .gitignore by hand, INSIDE
  // the `# keryx:begin`/`# keryx:end` markers. `keryx update` regenerates that
  // region from this template, so the next update silently deleted them and the
  // auto-sweep stamp — runtime state the gdctx write path rewrites on every
  // call — became eligible for tracking again.
  //
  // Anything that must survive an update belongs in the template, not in a
  // hand-edit of the block the template owns.
  const block = renderMetaprojectGitignoreBlock();

  expect(block).toContain(".metaproject/data/forgetting/");
  expect(block).toContain(".metaproject/data/retention/");
});

test("the index gate stays small, because its size is multiplied by task length", () => {
  // Measured 2026-09-05: the full router is ~3,226 tokens and an agent re-sends
  // its whole transcript every turn, so reading it once costs ~3,226 x turns —
  // ~80,000 on a 25-turn task, about half the context gap the retrieval
  // benchmark measured against keryx.
  //
  // This bound is the point of the split. If the gate creeps back toward the
  // router's size, the split has quietly undone itself and nothing else would
  // say so.
  const gate = renderIndexGateMarkdown({ ...ALL_MODULES });

  expect(gate.length).toBeLessThan(2000); // ~500 tokens, against ~3,226 before
  expect(gate).toContain(ROUTING_FILENAME);
});

test("the gate carries pointers and the rules that bind, not prose", () => {
  const gate = renderIndexGateMarkdown({ ...ALL_MODULES });

  // Pointers an agent needs to act at all.
  expect(gate).toContain("keryx gdgraph affected");
  expect(gate).toContain("keryx ctx rg");
  // The two rules that change behaviour rather than describing it.
  expect(gate).toMatch(/never bare `rg`\/`grep`/);
  expect(gate).toMatch(/last `keryx gdgraph build`/);

  // Deliberately left to routing.md: these are re-read every turn of every
  // task, including the many where none of it applies.
  expect(gate).not.toContain("## Intent Router");
  expect(gate).not.toContain("## Agent Workflow");
  expect(gate).not.toContain("## Enabled Modules");
});

test("the gate names only the modules that are enabled", () => {
  const gate = renderIndexGateMarkdown({
    ...ALL_MODULES,
    enableGdwiki: false,
    enableMemory: false,
  });

  expect(gate).toContain("keryx ctx rg");
  expect(gate).not.toContain("wiki/index.md");
  expect(gate).not.toContain("keryx memory search");
});

test("subagents are not all made to read the full routing index", () => {
  // Measured 2026-09-05: `.metaproject/index.md` is ~3,226 tokens, and an agent
  // re-sends its whole transcript on every turn — so one read costs ~3,226 x
  // turns. The old rule required EVERY subagent to read it, which at three
  // subagents of ten turns each is ~177,000 tokens of routing index alone, and
  // defeats the reason subagents exist: a narrow slice of context.
  //
  // The rule is prose, so nothing but this test stops it drifting back.
  const block = renderProjectMetaprojectReferenceBlock({ enableTasks: true });

  expect(block).not.toMatch(/Every subagent prompt must .*require reading/);
  expect(block).toMatch(/inline the few routing pointers/i);
  expect(block).toMatch(/only when it will navigate the codebase itself/i);
});

test("gdgraph skill refresh policy describes the hook the template actually renders", () => {
  const skill = renderGdgraphSkillReadme();

  // The previous text claimed the hook "refreshes graph"; the body only printed
  // a reminder. Whatever it claims now must match the rendered hook.
  expect(skill).toContain("KERYX_GDGRAPH_HOOK_REBUILD=0");
  expect(skill).toMatch(/never blocks the commit/i);
  expect(skill).toContain("$HOME/.local/bin/keryx");
  expect(skill).toContain("modules/gdgraph.md");
});

test("hooks README documents the gdgraph hook as rebuilding, with its cost and opt-out", () => {
  const readme = renderHooksReadme();

  expect(readme).toMatch(/rebuilds the graph|rebuilding/i);
  expect(readme).toContain("KERYX_GDGRAPH_HOOK_REBUILD=0");
  expect(readme).toMatch(/exits 0|never blocks/i);
  expect(readme).toContain("data/gdgraph/artifacts/");
});

test("generated ignore block isolates memory views without hiding canonical entries", () => {
  const block = renderMetaprojectGitignoreBlock();
  expect(block).toContain(".metaproject/data/memory/index/");
  expect(block).toContain(".metaproject/data/memory/embeddings/");
  expect(block).toContain(".metaproject/data/memory/artifacts/");
  expect(block).toContain(".metaproject/runtime/memory/");
  expect(block).not.toContain(".metaproject/memory/");
});

// ---------------------------------------------------------------------------
// T19 finding 5 (flow 234 review, MINOR) — `renderGdgraphCoreCli()` emits the
// standalone `.metaproject/core/gdgraph/cli.ts` runner every scaffolded
// project gets, so a project can run the graph builder without the full
// `keryx` package installed. Its `affected` handler called the raw
// `getAffected(graph, target)` with no membership check — the exact same
// defect as finding 1 (`src/mcp/tools.ts`) — so it printed the same empty
// `{target, dependencies: [], dependents: []}` shape and exited 0 for a
// target the graph never indexed, indistinguishable from a real, indexed,
// edge-less node. This test executes the ACTUAL emitted output (not just its
// source text) with `bun`, against real copies of `GDGRAPH_CORE_SOURCES`
// (`build.ts`/`query.ts`/`target.ts`/`types.ts`) — the same files `init`/
// `update` copy — so it proves the fix in the emitted runner itself, not
// merely in `getAffected`/`query.ts` (which this task deliberately leaves
// unchanged; see the task report).
// ---------------------------------------------------------------------------

async function scaffoldGdgraphCoreRunner(root: string): Promise<string> {
  const gdgraphCoreRoot = path.join(root, ".metaproject", "core", "gdgraph");
  await mkdir(gdgraphCoreRoot, { recursive: true });
  for (const file of GDGRAPH_CORE_SOURCES) {
    await copyFile(
      path.join(process.cwd(), "src", "gdgraph", file),
      path.join(gdgraphCoreRoot, file),
    );
  }
  await writeFile(path.join(gdgraphCoreRoot, "cli.ts"), renderGdgraphCoreCli(), "utf8");

  const storageDir = path.join(root, ".metaproject", "data", "gdgraph", "storage");
  await mkdir(storageDir, { recursive: true });
  await writeFile(
    path.join(storageDir, "nodes.jsonl"),
    '{"id":"src/a.ts","kind":"file","path":"src/a.ts","language":"typescript"}\n',
    "utf8",
  );
  return gdgraphCoreRoot;
}

test("T19 finding 5 — an indexed target with no edges still exits 0 (control, byte-identical to before)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-templates-core-cli-known-"));
  try {
    const gdgraphCoreRoot = await scaffoldGdgraphCoreRunner(root);
    const result = spawnSync(
      "bun",
      [path.join(gdgraphCoreRoot, "cli.ts"), "affected", "src/a.ts", "--json"],
      { cwd: root, encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as { target: string; dependencies: string[]; dependents: string[] };
    expect(parsed).toEqual({ target: "src/a.ts", dependencies: [], dependents: [] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 20000);

test("T19 finding 5 — the emitted runner's `affected` command rejects a target the graph never indexed, non-zero exit", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-templates-core-cli-unknown-"));
  try {
    const gdgraphCoreRoot = await scaffoldGdgraphCoreRunner(root);
    const result = spawnSync(
      "bun",
      [path.join(gdgraphCoreRoot, "cli.ts"), "affected", "src/does-not-exist.ts", "--json"],
      { cwd: root, encoding: "utf8" },
    );

    // Before the fix: this printed
    // `{"target":"src/does-not-exist.ts","dependencies":[],"dependents":[]}`
    // on stdout and exited 0 — byte-identical to the known-empty control case
    // above except for the target string.
    expect(result.status).not.toBe(0);
    expect(result.stdout.trim()).toBe("");
    expect(result.stderr).toContain("does-not-exist.ts");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 20000);

// docs/verification/page-count-is-not-coverage.md rows 15/16: the dashboard's
// hero KPI strip prints `wikiPages.length` / `memoryEntries.length` as a bare
// number — the same "count presented with nothing naming what is absent" shape
// documented for rows 1 and 5, in the very file where rows 6/7 were fixed. The
// fix here is a `title` caveat on each tile (verified below); this is a
// regression tripwire, not a UI redesign — losing the caveat should make this
// test fail, not silently regress to a bare, unqualified count.
test("dashboard hero KPI tiles for wiki pages and memory entries carry a 'not coverage' caveat", () => {
  const html = renderMetaprojectDashboardHtml({
    ...ALL_MODULES,
    data: {
      wiki: { pages: [{ title: "Auth flow", href: "wiki/auth.md", group: "domain" }] },
      memory: { entries: [{ title: "Lesson one", href: "memory/lesson.md", group: "lessons" }] },
    },
  });

  const wikiKpi = /<div class="kpi" title="([^"]*)">\s*<b>1<\/b><span>wiki pages<\/span>/.exec(html);
  const memoryKpi = /<div class="kpi" title="([^"]*)">\s*<b>1<\/b><span>memory entries<\/span>/.exec(html);

  expect(wikiKpi).not.toBeNull();
  expect(memoryKpi).not.toBeNull();
  expect(wikiKpi?.[1]).toMatch(/not a coverage measure/i);
  expect(memoryKpi?.[1]).toMatch(/not a coverage measure/i);
});

// D8 (flow 252 defect map): `extractAgentRuleBody` strips the managed
// `<!-- keryx:index -->` block, but a fresh `renderAgentEntrypoint` source
// (or any entrypoint reduced to just its heading) leaves only the leading H1
// behind. That text is non-empty, so the old `body.length > 0` check treated
// it as real content and skipped the fallback — the mirror in
// `.metaproject/rules/` shipped as a bare heading pointing nowhere.

test("imported agent rules fall back when only the heading survives block removal", () => {
  const source = "AGENTS.md";
  const content = renderAgentEntrypoint({ source });

  const rendered = renderImportedAgentRules({ source, content });

  expect(rendered).not.toContain("# AGENTS.md Instructions");
  expect(rendered).toMatch(/delegates agent routing to `\.metaproject\/index\.md`/);
  expect(rendered).toMatch(/Read `\.metaproject\/index\.md` first/);
});

test("imported agent rules preserve real content past the heading", () => {
  const source = "AGENTS.md";
  const block = renderProjectMetaprojectReferenceBlock({ enableTasks: true });
  const content = `# AGENTS.md Instructions

Always run the linter before committing. Never touch \`main\` directly.

${block}
`;

  const rendered = renderImportedAgentRules({ source, content });

  expect(rendered).toContain("# AGENTS.md Instructions");
  expect(rendered).toContain("Always run the linter before committing. Never touch `main` directly.");
  expect(rendered).not.toMatch(/delegates agent routing to `\.metaproject\/index\.md`/);
});

// Round-1 finding T-004(a): the rules README's core claims — core rules are
// read on demand only when cited (never loaded automatically), and keryx
// itself does not act on Cursor's `alwaysApply`/`globs` fields — were
// asserted nowhere. Pinning the whole rendered string would be brittle (any
// unrelated wording tweak breaks the test) and wouldn't catch a REVERSAL of
// the claim (e.g. "loaded automatically" instead of "on-demand"), so this
// pins short, specific phrases lifted from the current text instead.
test("project rules README states core rules are on-demand and that keryx ignores alwaysApply/globs", () => {
  const readme = renderProjectRulesReadme();

  // "loaded on demand when cited" claim.
  expect(readme).toContain("on-demand rule library");
  expect(readme).toContain("read only when a skill or `routing.md` cites it");

  // "keryx does not read alwaysApply/globs" claim.
  expect(readme).toContain("`alwaysApply` and `globs`");
  expect(readme).toContain("keryx itself does not read or act on either field");
});

// Round-1 finding T-003: `isHeadingOnlyBody`'s `#` anchor
// (`/^#[^\n]*\n?/`) was not pinned by any test — a body whose FIRST line is
// a plain instruction with no leading `#` must keep that line and must not
// take the heading-only fallback. Without the `#` anchor, the regex would
// strip any first line (heading or not), leaving nothing behind and
// wrongly triggering the fallback for ordinary AGENTS.md/CLAUDE.md content
// that simply doesn't open with a heading.
test("imported agent rules keep a first line with no leading '#' — not a heading to strip", () => {
  const source = "AGENTS.md";
  const block = renderProjectMetaprojectReferenceBlock({ enableTasks: true });
  const content = `Always run the linter.\n\n${block}\n`;

  const rendered = renderImportedAgentRules({ source, content });

  expect(rendered).toContain("Always run the linter.");
  expect(rendered).not.toMatch(/delegates agent routing to `\.metaproject\/index\.md`/);
});

test("imported agent rules always drop the managed keryx:index block, heading-only or not", () => {
  const source = "AGENTS.md";
  const headingOnly = renderImportedAgentRules({ source, content: renderAgentEntrypoint({ source }) });

  const block = renderProjectMetaprojectReferenceBlock({ enableTasks: true });
  const withRealContent = renderImportedAgentRules({
    source,
    content: `# AGENTS.md Instructions\n\nSome real instructions here.\n\n${block}\n`,
  });

  for (const rendered of [headingOnly, withRealContent]) {
    expect(rendered).not.toContain("<!-- keryx:index -->");
    expect(rendered).not.toContain("<!-- /keryx:index -->");
  }
});
