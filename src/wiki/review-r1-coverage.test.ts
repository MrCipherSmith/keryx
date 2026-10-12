// Flow 367 review r1: coverage gaps found after the history/invariant work
// shipped. Each test names its finding id and would fail if the behaviour it
// pins regressed:
//
//   T-001  enrich with RLM on keeps the changelog and Version (finalizeEnrichedText)
//   T-004  collect --force leaves a page alone when a merge would break an invariant
//   T-005  `sync --apply` is one history run; collect records index.md's pre-run bytes
//   T-006  a run that fails part-way is undone whole by `restoreWikiRun`
//   T-008  a torn last line in runs.jsonl does not hide the intact entries

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { syncCommand } from "../commands/sync";
import { wikiCommand } from "../commands/wiki";
import type { NormalizedEvent, ProviderDescription, ProviderPort, StreamOptions } from "../harness/provider/types";
import { withCwd } from "../lib/test-cwd";
import { provenancePath } from "../sync/provenance";
import { type ProviderFactory, wikiEnrich } from "./enrich";
import {
  createWikiWriteContext,
  listWikiRuns,
  pageHistoryDir,
  readPageHistory,
  readWikiRuns,
  restoreWikiRun,
  wikiHistoryRoot,
  writeWikiPage,
} from "./history";
import { wrapReferenceSection } from "./managed-block";
import { compareVersions, newestChangelogVersion, pageVersion, parseChangelog } from "./page-invariants";
import { wikiCollect } from "./service";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "keryx-review-r1-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const jsonl = (rows: object[]): string => rows.map((row) => JSON.stringify(row)).join("\n");

function wikiFile(page: string): string {
  return path.join(root, ".metaproject", "wiki", ...page.split("/"));
}

/** Every markdown page under `.metaproject/wiki/`, index included, keyed by wiki-relative path. */
async function snapshotWiki(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), `${prefix}${entry.name}/`);
      else if (entry.name.endsWith(".md")) out.set(`${prefix}${entry.name}`, await readFile(path.join(dir, entry.name), "utf8"));
    }
  };
  await walk(path.join(root, ".metaproject", "wiki"), "");
  return out;
}

async function seedGraph(modules: string[], withSources = false): Promise<void> {
  const graphDir = path.join(root, ".metaproject", "data", "gdgraph", "storage");
  await mkdir(graphDir, { recursive: true });
  const nodes = modules.flatMap((m) =>
    ["a", "b"].map((f) => ({ id: `src/${m}/${f}.ts`, kind: "file", path: `src/${m}/${f}.ts`, language: "typescript" })),
  );
  await writeFile(path.join(graphDir, "nodes.jsonl"), jsonl(nodes), "utf8");
  await writeFile(path.join(graphDir, "edges.jsonl"), "", "utf8");
  if (withSources) {
    for (const m of modules) {
      await mkdir(path.join(root, "src", m), { recursive: true });
      for (const f of ["a", "b"]) await writeFile(path.join(root, "src", m, `${f}.ts`), `export const ${f} = "${m}";\n`, "utf8");
    }
  }
}

async function writeWikiConfig(config: unknown): Promise<void> {
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  await writeFile(path.join(root, ".metaproject", "wiki.config.json"), JSON.stringify(config), "utf8");
}

const DESCRIPTION: ProviderDescription = {
  capabilities: {
    streaming: true,
    toolCalls: false,
    parallelToolCalls: false,
    structuredOutput: false,
    reasoningMetadata: false,
    promptCaching: false,
    vision: false,
    tokenCounting: false,
    modelListing: false,
  },
  descriptor: { providerId: "stub" },
};

/**
 * A provider whose reply is chosen from the outgoing user prompt. `replyFor`
 * returns the reply text, or null to make the call throw (a network failure).
 */
function providerBy(replyFor: (userText: string) => string | null): ProviderFactory {
  const provider: ProviderPort = {
    describe: () => DESCRIPTION,
    stream(request, opts: StreamOptions): AsyncIterable<NormalizedEvent> {
      const userText = request.messages
        .filter((message) => message.role === "user")
        .map((message) => message.content)
        .join("\n");
      const reply = replyFor(userText);
      if (reply === null) throw new Error("simulated provider network failure");
      return (async function* (): AsyncGenerator<NormalizedEvent> {
        yield { kind: "text_delta", sequence: 0, attemptId: opts.attemptId, text: reply };
        yield { kind: "model_end", sequence: 1, attemptId: opts.attemptId };
      })();
    },
  };
  return () => provider;
}

const ATTESTATION =
  "- 0.3.0 - Deterministic repair by `.metaproject/core/gdwiki/verify-prose.mjs` (1 hedge-removed). Status unchanged -- the gate re-decides on this text.";
const GENERATED_ENTRY = "- 0.1.0 - Generated by `keryx wiki collect` at 2026-09-23T07:33:13.595Z.";

/** Every prior changelog entry survives in `after` byte for byte, and Version is not behind the changelog. */
function expectChangelogAndVersionKept(original: string, after: string): void {
  const before = parseChangelog(original);
  const kept = parseChangelog(after);
  expect(before).not.toBeNull();
  expect(kept).not.toBeNull();
  expect(before!.length).toBeGreaterThanOrEqual(2);
  for (const entry of before!) {
    expect(kept!.map((item) => item.text)).toContain(entry.text);
    expect(after).toContain(entry.text);
  }
  const newest = newestChangelogVersion(kept);
  const version = pageVersion(after);
  expect(newest).not.toBeNull();
  expect(version).not.toBeNull();
  expect(compareVersions(version, newest)).toBeGreaterThanOrEqual(0);
}

describe("T-001: enrich with RLM on keeps the changelog and Version", () => {
  test("T-001 light tier: a reply that drops ## Changelog or rewords an entry, and lowers Version, still lands with every entry and a current Version", async () => {
    await writeWikiConfig({ rlm: { enabled: true, classify: { skipMaxBytes: 0 }, batch: { enabled: false } } });
    const originals = new Map<string, string>();
    for (const slug of ["d1", "d2"]) {
      const content =
        `---\nTitle: Decision ${slug}\nVersion: 0.3.0\nType: decision\nStatus: draft\nSummary: stub\n---\n\n` +
        `# Decision ${slug}\n\nStub body for ${slug} with enough length to count as non-trivial content.\n\n` +
        `## Changelog\n\n${ATTESTATION}\n\n${GENERATED_ENTRY}\n`;
      await mkdir(path.dirname(wikiFile(`decisions/${slug}.md`)), { recursive: true });
      await writeFile(wikiFile(`decisions/${slug}.md`), content, "utf8");
      originals.set(slug, content);
    }
    const head = (slug: string): string =>
      `---\nTitle: Decision ${slug}\nVersion: 0.1.0\nType: decision\nStatus: draft\nSummary: stub\n---\n\n# Decision ${slug}\n\n` +
      `Rewritten prose for ${slug} with plenty of words so the structural validation passes cleanly.\n`;
    const factory = providerBy((prompt) => {
      // d1: the changelog is dropped altogether. d2: it is kept but an entry is reworded.
      if (prompt.includes("Title: Decision d1")) return head("d1");
      return `${head("d2")}\n## Changelog\n\n- 0.3.0 - A friendlier wording of the attestation.\n\n${GENERATED_ENTRY}\n`;
    });

    const result = await wikiEnrich({ cwd: root, providerFactory: factory, validate: false });

    expect(result.failed).toBe(0);
    expect(result.enriched).toBe(2);
    expect(result.pages.every((page) => page.tier === "light")).toBe(true);
    for (const slug of ["d1", "d2"]) {
      const after = await readFile(wikiFile(`decisions/${slug}.md`), "utf8");
      expect(after).toContain(`Rewritten prose for ${slug}`); // the model's prose did land
      expect(after).not.toContain("A friendlier wording");
      expectChangelogAndVersionKept(originals.get(slug)!, after);
    }
  });

  test("T-001 deep tier: the same holds for a page classified deep", async () => {
    await seedGraph(["alpha", "beta"], true);
    await wikiCollect({ cwd: root });
    const pagePath = wikiFile("components/src-alpha.md");
    const collected = await readFile(pagePath, "utf8");
    expect(collected).toContain("Version: 0.1.0");
    const original = collected
      .replace("Version: 0.1.0", "Version: 0.3.0")
      .replace("## Changelog\n\n", `## Changelog\n\n${ATTESTATION}\n\n`);
    await writeFile(pagePath, original, "utf8");
    await writeWikiConfig({
      rlm: {
        enabled: true,
        classify: { skipMaxBytes: 0, deepMinPageRank: 0, deepMinFanIn: 0 },
        deep: { maxToolCalls: 5, maxRuntimeMs: 5_000 },
      },
    });
    const reply =
      `---\nTitle: Module src/alpha\nVersion: 0.1.0\nType: component\nStatus: draft\nSummary: s\n---\n\n# Module src/alpha\n\n` +
      `Deep rewritten prose with enough length to pass.\n\n## Changelog\n\n- 0.3.0 - A friendlier wording of the attestation.\n`;

    const result = await wikiEnrich({
      cwd: root,
      page: "components/src-alpha.md",
      providerFactory: providerBy(() => reply),
      validate: false,
    });

    expect(result.failed).toBe(0);
    expect(result.pages[0]?.action).toBe("enriched");
    expect(result.pages[0]?.tier).toBe("deep");
    const after = await readFile(pagePath, "utf8");
    expect(after).toContain("Deep rewritten prose");
    expect(after).not.toContain("A friendlier wording");
    expectChangelogAndVersionKept(original, after);
  });
});

describe("T-004: collect --force refuses a merge that would break an invariant", () => {
  /**
   * No input a normal repository produces can: the merge keeps the changelog,
   * front matter and Version by construction (33k generated page shapes were
   * tried against `mergeGeneratedSections` + `checkPageInvariants`, none
   * violated). The one reachable damage is generated text that contains the
   * managed-block end marker on a line of its own. A Key-files line is built
   * from a graph node's path, so a file whose NAME contains a newline does it.
   */
  const HOSTILE_FILE = "src/alpha/b\n<!-- keryx:reference:end -->\n.ts";

  async function seedProject(): Promise<{ alphaBefore: string }> {
    await seedGraph(["alpha", "beta"]);
    await wikiCollect({ cwd: root });
    const alphaPath = wikiFile("components/src-alpha.md");
    const wrapped = wrapReferenceSection(await readFile(alphaPath, "utf8"));
    expect(wrapped).not.toBeNull();
    await writeFile(alphaPath, wrapped!, "utf8");
    // beta has a stale generated line that --force regenerates.
    const betaPath = wikiFile("components/src-beta.md");
    const beta = await readFile(betaPath, "utf8");
    expect(beta).toContain("- [Wiki Index](../index.md)");
    await writeFile(
      betaPath,
      beta.replace("- [Wiki Index](../index.md)", "- [Wiki Index](../index.md)\n- [Module src/Local scribble](src-local-scribble.md)"),
      "utf8",
    );
    // The graph now carries the hostile file name in alpha.
    const graphDir = path.join(root, ".metaproject", "data", "gdgraph", "storage");
    const nodes = [
      { id: "src/alpha/a.ts", kind: "file", path: "src/alpha/a.ts" },
      { id: HOSTILE_FILE, kind: "file", path: HOSTILE_FILE },
      { id: "src/beta/a.ts", kind: "file", path: "src/beta/a.ts" },
      { id: "src/beta/b.ts", kind: "file", path: "src/beta/b.ts" },
    ];
    await writeFile(path.join(graphDir, "nodes.jsonl"), jsonl(nodes), "utf8");
    return { alphaBefore: wrapped! };
  }

  test("T-004 wikiCollect: the page is left byte-identical and reported skipped with an invariantReason; other pages still update", async () => {
    const { alphaBefore } = await seedProject();

    const result = await wikiCollect({ cwd: root, force: true });

    const alpha = result.pages.find((page) => page.path.endsWith("src-alpha.md"));
    expect(alpha?.action).toBe("skipped");
    expect(alpha?.invariantReason).toContain("managed-block-dropped");
    expect(await readFile(wikiFile("components/src-alpha.md"), "utf8")).toBe(alphaBefore);

    const beta = result.pages.find((page) => page.path.endsWith("src-beta.md"));
    expect(beta?.action).toBe("updated");
    expect(beta?.invariantReason).toBeUndefined();
    expect(await readFile(wikiFile("components/src-beta.md"), "utf8")).not.toContain("Local scribble");
    // The refused page is not in the run's history either.
    const logged = (await readWikiRuns(root)).filter((entry) => entry.runId === result.historyRunId);
    expect(logged.map((entry) => entry.page)).not.toContain("components/src-alpha.md");
    expect(logged.map((entry) => entry.page)).toContain("components/src-beta.md");
  });

  test("T-004 runCollect: `wiki collect --force` exits 1 and says REFUSED when a page was left alone; a clean run does not", async () => {
    await seedProject();
    const realLog = console.log;
    const realExit = process.exitCode;
    const lines: string[] = [];
    try {
      console.log = (...parts: unknown[]) => {
        lines.push(parts.map(String).join(" "));
      };
      process.exitCode = 0;
      await withCwd(root, () => wikiCommand(["collect", "--force"]));
      expect(process.exitCode).toBe(1);
      expect(lines.join("\n")).toContain("REFUSED, would break: managed-block-dropped");

      // Control: the same project without the hostile name collects cleanly.
      await seedGraph(["alpha", "beta"]);
      lines.length = 0;
      process.exitCode = 0;
      await withCwd(root, () => wikiCommand(["collect", "--force"]));
      expect(process.exitCode).toBe(0);
      expect(lines.join("\n")).not.toContain("REFUSED");
    } finally {
      console.log = realLog;
      process.exitCode = realExit;
    }
  });
});

describe("T-005: sync --apply and collect record their pre-run bytes", () => {
  async function git(cwd: string, args: string[]): Promise<void> {
    const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")}: ${await new Response(proc.stderr).text()}`);
  }

  test("T-005a sync --apply is one history run labelled `sync --apply`, and `restore --run` returns the wiki to its pre-sync bytes", async () => {
    // A git project whose graph and memory already look synced; only gdwiki
    // has no provenance, so `--apply` collects + regenerates the index.
    await git(root, ["init", "-q"]);
    await git(root, ["config", "user.email", "fixture@example.invalid"]);
    await git(root, ["config", "user.name", "fixture"]);
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "a.ts"), "export const a = 1;\n", "utf8");
    await git(root, ["add", "-A"]);
    await git(root, ["commit", "-q", "-m", "fixture"]);
    const head = Bun.spawn(["git", "rev-parse", "HEAD"], { cwd: root, stdout: "pipe" });
    const commit = (await new Response(head.stdout).text()).trim();
    await seedGraph(["alpha", "beta"]);
    for (const module of ["gdgraph", "memory"]) {
      const file = provenancePath(root, module);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, `${JSON.stringify({ commit, branch: "main", builtAt: new Date().toISOString() })}\n`, "utf8");
    }
    // A wiki that already exists: an index a human edited, and a hand-written page.
    await mkdir(path.dirname(wikiFile("decisions/keep.md")), { recursive: true });
    await writeFile(wikiFile("index.md"), "# Wiki\n\nHand-written index text that sync will rewrite.\n", "utf8");
    await writeFile(wikiFile("decisions/keep.md"), "# Keep\n\nVersion: 1.0.0\nType: decision\nStatus: accepted\n", "utf8");
    const before = await snapshotWiki();

    const realLog = console.log;
    console.log = () => undefined;
    try {
      await withCwd(root, () => syncCommand(["--apply"]));
    } finally {
      console.log = realLog;
    }

    const after = await snapshotWiki();
    expect(after.size).toBeGreaterThan(before.size); // collect created pages
    expect(after.get("index.md")).not.toBe(before.get("index.md"));
    const runs = await readWikiRuns(root);
    expect(runs.length).toBeGreaterThanOrEqual(3); // component pages, project map, the index
    expect(new Set(runs.map((entry) => entry.runId)).size).toBe(1);
    expect(new Set(runs.map((entry) => entry.command))).toEqual(new Set(["sync --apply"]));
    expect(runs.map((entry) => entry.page)).toContain("index.md");

    const outcome = await restoreWikiRun(createWikiWriteContext(root, "test restore"), runs[0]!.runId);

    expect(outcome.conflicts).toEqual([]);
    expect(await snapshotWiki()).toEqual(before);
  });

  test("T-005b a collect run stores index.md's pre-run bytes in its history", async () => {
    await seedGraph(["alpha", "beta"]);
    const indexBefore = "# Wiki\n\nHand-written index text that collect regenerates.\n";
    await mkdir(path.dirname(wikiFile("index.md")), { recursive: true });
    await writeFile(wikiFile("index.md"), indexBefore, "utf8");

    const result = await wikiCollect({ cwd: root });

    const history = await readPageHistory(root, "index.md");
    expect(history).not.toBeNull();
    expect(history!.rows).toHaveLength(2);
    expect(history!.rows[0]!.run).toBe(result.historyRunId);
    const prior = history!.rows[1]!;
    expect(prior.by).toBe("baseline (before history)");
    expect(await readFile(path.join(pageHistoryDir(root, "index.md"), prior.file), "utf8")).toBe(indexBefore);
    expect(await readFile(wikiFile("index.md"), "utf8")).not.toBe(indexBefore);
  });
});

describe("T-006: a run that fails part-way is undone whole", () => {
  test("T-006 wikiEnrich whose provider fails on the 4th of 5 pages: restoreWikiRun puts every page back byte-identical", async () => {
    await seedGraph(["alpha", "beta", "gamma", "delta"], true);
    await wikiCollect({ cwd: root });
    const before = await snapshotWiki();
    const prose =
      "---\nTitle: Enriched\nStatus: draft\n---\n\n# Enriched\n\nFull prose body with enough text for validation checks to pass cleanly.\n";
    const factory = providerBy((prompt) => (prompt.includes("Title: Module src/delta") ? null : prose));

    const result = await wikiEnrich({ cwd: root, providerFactory: factory, validate: false, concurrency: 1 });

    const failedAt = result.pages.findIndex((page) => page.action === "failed");
    expect(result.failed).toBe(1);
    expect(result.pages[failedAt]?.path).toBe("components/src-delta.md");
    // Pages were enriched both before and after the failing one.
    expect(result.pages.slice(0, failedAt).some((page) => page.action === "enriched")).toBe(true);
    expect(result.pages.slice(failedAt + 1).some((page) => page.action === "enriched")).toBe(true);
    expect(result.historyRunId).toBeDefined();
    const mid = await snapshotWiki();
    expect([...mid].filter(([page, text]) => before.get(page) !== text).length).toBe(result.enriched);

    const restored = await restoreWikiRun(createWikiWriteContext(root, "test restore"), result.historyRunId!);

    expect(restored.conflicts).toEqual([]);
    expect(restored.restored).toHaveLength(result.enriched);
    expect(await snapshotWiki()).toEqual(before);
  });
});

describe("T-008: a torn last line in runs.jsonl", () => {
  test("T-008 readWikiRuns, listWikiRuns and restoreWikiRun still work for the intact entries", async () => {
    const page = (name: string): string => wikiFile(name);
    const tick = (() => {
      let n = 0;
      return () => new Date(Date.UTC(2026, 9, 1, 10, 0, n++));
    })();
    const first = createWikiWriteContext(root, "wiki first", { now: tick });
    const second = createWikiWriteContext(root, "wiki second", { now: tick });
    await writeWikiPage(first, page("components/a.md"), "one\n");
    await writeWikiPage(first, page("components/b.md"), "bee\n");
    await writeWikiPage(second, page("components/a.md"), "two\n");

    // An interrupted append: half a JSON object, no newline.
    const runsFile = path.join(wikiHistoryRoot(root), "runs.jsonl");
    await appendFile(runsFile, '{"runId":"run-torn","command":"wiki torn","page":"components/a.md","at":"2026-10-01T1', "utf8");

    const entries = await readWikiRuns(root);
    expect(entries).toHaveLength(3);
    expect(entries.map((entry) => entry.runId).sort()).toEqual([first.runId, first.runId, second.runId].sort());
    const runs = await listWikiRuns(root);
    expect(runs.map((run) => run.runId)).toEqual([second.runId, first.runId]);
    expect(runs.find((run) => run.runId === first.runId)?.pages).toBe(2);

    // Undo the second run (a.md back to "one"); the undo is itself a change to
    // a.md, so the first run is then restored with force (a.md and b.md removed).
    const undo = createWikiWriteContext(root, "test restore", { now: tick });
    const secondOutcome = await restoreWikiRun(undo, second.runId);
    expect(secondOutcome.conflicts).toEqual([]);
    expect(await readFile(page("components/a.md"), "utf8")).toBe("one\n");
    const firstOutcome = await restoreWikiRun(undo, first.runId, { force: true });
    expect(firstOutcome.conflicts).toEqual([]);
    await expect(readFile(page("components/a.md"), "utf8")).rejects.toThrow();
    await expect(readFile(page("components/b.md"), "utf8")).rejects.toThrow();
  });

  test("T-008 a run written after a torn line is still recorded (not glued onto the fragment)", async () => {
    const runsFile = path.join(wikiHistoryRoot(root), "runs.jsonl");
    await writeWikiPage(createWikiWriteContext(root, "wiki first"), wikiFile("components/a.md"), "one\n");
    await appendFile(runsFile, '{"runId":"run-torn","command":"wiki torn","page":"comp', "utf8");

    const later = createWikiWriteContext(root, "wiki later");
    await writeWikiPage(later, wikiFile("components/a.md"), "two\n");

    expect((await readWikiRuns(root)).some((entry) => entry.runId === later.runId)).toBe(true);
    const undone = await restoreWikiRun(createWikiWriteContext(root, "wiki restore"), later.runId);
    expect(undone.conflicts).toEqual([]);
    expect(await readFile(wikiFile("components/a.md"), "utf8")).toBe("one\n");
  });
});
