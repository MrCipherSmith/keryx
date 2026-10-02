// Flow 367: every keryx command that overwrites or deletes a wiki page goes through
// `writeWikiPage` / `deleteWikiPage`. `history.test.ts` covers that module itself;
// this file proves the call sites in `enrich.ts` (W1, W2) and `service.ts` (W3-W5)
// actually use it, by running the real command function over a page that already
// existed and checking the stored bytes. W6-W8 live in `refresh.test.ts` and W9 in
// `../sac/wiki-owner-writer.test.ts`, next to the fixtures they reuse.
//
// Each test would fail if its call site went back to a direct `writeFile` / `rm`:
// the history folder would be missing, or would not hold the pre-run bytes.

import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { NormalizedEvent, ProviderPort, StreamOptions } from "../harness/provider/types";
import { pathExists } from "../lib/fs";
import { type ProviderFactory, wikiEnrich } from "./enrich";
import { pageHistoryDir, readPageHistory, readWikiRuns, type WikiVersionRow } from "./history";
import { wikiCollect, wikiCreatePage, wikiPruneOrphans } from "./service";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "keryx-wiki-writers-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const jsonl = (rows: object[]): string => rows.map((r) => JSON.stringify(r)).join("\n");

const sha256 = (content: Buffer): string => createHash("sha256").update(content).digest("hex");

function wikiFile(page: string): string {
  return path.join(root, ".metaproject", "wiki", ...page.split("/"));
}

/** The bytes of every markdown page under `.metaproject/wiki/` (index excluded), keyed by wiki-relative path. */
async function snapshotPages(): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), `${prefix}${entry.name}/`);
      else if (entry.name.endsWith(".md") && `${prefix}${entry.name}` !== "index.md") {
        out.set(`${prefix}${entry.name}`, await readFile(path.join(dir, entry.name)));
      }
    }
  };
  await walk(path.join(root, ".metaproject", "wiki"), "");
  return out;
}

/** The stored copy of `row`, read from the page's history folder. */
async function storedCopy(page: string, row: WikiVersionRow): Promise<Buffer> {
  expect(row.file.endsWith(".md")).toBe(true);
  return readFile(path.join(pageHistoryDir(root, page), row.file));
}

/**
 * After a command ran over `page`, which held `prior` beforehand: the history
 * holds a non-current version byte-identical to `prior`, and the newest row is
 * the page's live content. Returns the history for further assertions.
 */
async function expectPriorStored(page: string, prior: Buffer): Promise<NonNullable<Awaited<ReturnType<typeof readPageHistory>>>> {
  const history = await readPageHistory(root, page);
  expect(history).not.toBeNull();
  const rows = history!.rows;
  expect(rows.length).toBeGreaterThanOrEqual(2);

  const older = rows.slice(1);
  let found = false;
  for (const row of older) {
    if (!row.file.endsWith(".md")) continue;
    if ((await storedCopy(page, row)).equals(prior)) found = true;
  }
  expect(found).toBe(true);

  const live = await readFile(wikiFile(page));
  expect(live.equals(prior)).toBe(false);
  expect(rows[0]!.sha).toBe(sha256(live));
  expect((await storedCopy(page, rows[0]!)).equals(live)).toBe(true);
  return history!;
}

async function seedGraph(modules: string[]): Promise<void> {
  const graphDir = path.join(root, ".metaproject", "data", "gdgraph", "storage");
  await mkdir(graphDir, { recursive: true });
  const nodes = modules.flatMap((m) => ["a", "b"].map((f) => ({ id: `src/${m}/${f}.ts`, kind: "file", path: `src/${m}/${f}.ts` })));
  await writeFile(path.join(graphDir, "nodes.jsonl"), jsonl(nodes), "utf8");
  await writeFile(path.join(graphDir, "edges.jsonl"), "", "utf8");
}

async function writeWikiConfig(config: unknown): Promise<void> {
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  await writeFile(path.join(root, ".metaproject", "wiki.config.json"), JSON.stringify(config), "utf8");
}

function stubProvider(reply: string): ProviderPort {
  return {
    describe() {
      return {
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
    },
    async *stream(_request, opts: StreamOptions): AsyncIterable<NormalizedEvent> {
      yield { kind: "text_delta", sequence: 0, attemptId: opts.attemptId, text: reply };
      yield { kind: "model_end", sequence: 1, attemptId: opts.attemptId };
    },
  };
}

const ENRICHED_PAGE = `---
Title: Enriched
Version: 1.0.0
Type: component
Status: draft
Summary: Test page
---

# Enriched

Full prose body with enough text for validation checks to pass cleanly.
`;

describe("wiki page history: command call sites", () => {
  test("W1 flow 367: wiki enrich (RLM off) stores the pre-run bytes of every page it rewrites, under one run id", async () => {
    await seedGraph(["alpha", "beta"]);
    await wikiCollect({ cwd: root });
    const before = await snapshotPages();

    const factory: ProviderFactory = () => stubProvider(ENRICHED_PAGE);
    const result = await wikiEnrich({ cwd: root, providerFactory: factory, validate: false });

    const enriched = result.pages.filter((page) => page.action === "enriched");
    expect(result.failed).toBe(0);
    expect(enriched.length).toBeGreaterThanOrEqual(2);

    const runIds = new Set<string>();
    for (const page of enriched) {
      const prior = before.get(page.path);
      expect(prior).toBeDefined();
      const history = await expectPriorStored(page.path, prior!);
      expect(history.rows[0]!.by).toBe("wiki enrich");
      expect((await readFile(wikiFile(page.path), "utf8"))).toContain("Full prose body");
      runIds.add(history.rows[0]!.run);
    }
    // One command invocation, one run id, shared by every page it wrote.
    expect(runIds.size).toBe(1);
    const runId = [...runIds][0]!;
    expect(runId).toMatch(/^run-/);
    const logged = (await readWikiRuns(root)).filter((entry) => entry.command === "wiki enrich");
    expect(logged.map((entry) => entry.runId)).toEqual(enriched.map(() => runId));
    expect(logged.map((entry) => entry.page).sort()).toEqual(enriched.map((page) => page.path).sort());
  });

  test("W2 flow 367: wiki enrich with RLM on stores the pre-run bytes of the pages it rewrites", async () => {
    // Hand-written decision pages: the RLM path classifies each as `light`
    // (skipMaxBytes: 0 turns the `skip` tier off), and batching is off so each
    // page is its own provider call and its own `writeWikiPage`.
    await writeWikiConfig({ rlm: { enabled: true, classify: { skipMaxBytes: 0 }, batch: { enabled: false } } });
    for (const slug of ["d1", "d2"]) {
      await mkdir(path.dirname(wikiFile(`decisions/${slug}.md`)), { recursive: true });
      await writeFile(
        wikiFile(`decisions/${slug}.md`),
        `---\nTitle: Decision ${slug}\nVersion: 0.1.0\nType: decision\nStatus: draft\nSummary: stub\n---\n\n` +
          `# Decision ${slug}\n\nStub body for ${slug} with enough length to count as non-trivial content.\n`,
        "utf8",
      );
    }
    const before = await snapshotPages();

    const result = await wikiEnrich({ cwd: root, providerFactory: () => stubProvider(ENRICHED_PAGE), validate: false });

    expect(result.failed).toBe(0);
    expect(result.enriched).toBe(2);
    expect(result.pages.every((page) => page.tier === "light")).toBe(true);
    const runIds = new Set<string>();
    for (const page of result.pages) {
      const history = await expectPriorStored(page.path, before.get(page.path)!);
      expect(history.rows[0]!.by).toBe("wiki enrich");
      expect(await readFile(wikiFile(page.path), "utf8")).toContain("Full prose body");
      runIds.add(history.rows[0]!.run);
    }
    expect(runIds.size).toBe(1);
  });

  test("W3 flow 367: wiki collect --force stores the pre-run bytes, and every page of the run carries one run id", async () => {
    await seedGraph(["alpha", "beta"]);
    await wikiCollect({ cwd: root });
    // Still generated drafts (marker + `Status: draft` intact), with a stale
    // module link inside a generator-owned section (Related Wiki), which
    // `--force` regenerates. Since flow 367 T6 it regenerates ONLY such
    // sections, and keeps an enricher's own lines there, so the edit has to be
    // a generated-looking module link for the page to change at all.
    const generated = await snapshotPages();
    expect(generated.size).toBeGreaterThanOrEqual(2);
    const prior = new Map<string, Buffer>();
    for (const [page, content] of generated) {
      const text = content.toString("utf8");
      expect(text).toContain("- [Wiki Index](../index.md)");
      const edited = Buffer.from(
        text.replace("- [Wiki Index](../index.md)", "- [Wiki Index](../index.md)\n- [Module src/Local scribble](src-local-scribble.md)"),
        "utf8",
      );
      await writeFile(wikiFile(page), edited);
      prior.set(page, edited);
    }

    const result = await wikiCollect({ cwd: root, force: true });

    const updated = result.pages.filter((page) => page.action === "updated");
    expect(updated.length).toBe(prior.size);
    const runIds = new Set<string>();
    for (const page of updated) {
      const wikiRelative = path.relative(path.join(root, ".metaproject", "wiki"), path.join(root, page.path)).split(path.sep).join("/");
      const history = await expectPriorStored(wikiRelative, prior.get(wikiRelative)!);
      expect(history.rows[0]!.by).toBe("wiki collect --force");
      expect((await readFile(wikiFile(wikiRelative), "utf8"))).not.toContain("Local scribble");
      runIds.add(history.rows[0]!.run);
    }
    expect(runIds.size).toBe(1);
    expect([...runIds][0]).toBe(result.historyRunId);
    const logged = (await readWikiRuns(root)).filter((entry) => entry.runId === result.historyRunId);
    // The regenerated index.md is recorded in the same run, so `restore --run`
    // puts it back with the pages.
    const loggedPages = logged.filter((entry) => entry.page !== "index.md");
    expect(loggedPages.length).toBe(updated.length);
    expect(loggedPages.every((entry) => entry.action === "updated")).toBe(true);
    expect(logged.some((entry) => entry.page === "index.md")).toBe(true);
  });

  test("W4 flow 367: wiki prune keeps a deleted orphan's last content and records a (deleted) row", async () => {
    await seedGraph(["keep", "gone"]);
    await wikiCollect({ cwd: root });
    const prior = await readFile(wikiFile("components/src-gone.md"));
    // The module disappears from the graph: its generated draft is now an orphan.
    await seedGraph(["keep"]);

    const result = await wikiPruneOrphans(root);

    expect(result.pruned).toEqual([".metaproject/wiki/components/src-gone.md"]);
    expect(await pathExists(wikiFile("components/src-gone.md"))).toBe(false);
    const history = await readPageHistory(root, "components/src-gone.md");
    expect(history).not.toBeNull();
    expect(history!.rows[0]!.sha).toBe("(deleted)");
    expect(history!.rows[0]!.by).toBe("wiki prune");
    // The page was created by `wiki collect`, so its last content is that run's version.
    const last = history!.rows[1]!;
    expect(last.by).toBe("wiki collect");
    expect((await storedCopy("components/src-gone.md", last)).equals(prior)).toBe(true);
    // The kept module's page was not touched.
    expect(await pathExists(wikiFile("components/src-keep.md"))).toBe(true);
    expect((await readPageHistory(root, "components/src-keep.md"))!.rows).toHaveLength(1);
  });

  test("W5 flow 367: wiki new --force stores the page it overwrites", async () => {
    const page = "decisions/w5-page.md";
    const handWritten = Buffer.from("# Hand-written decision\n\nVersion: 3.0.0\nType: decision\nStatus: accepted\n\nProse a human wrote.\n", "utf8");
    await mkdir(path.dirname(wikiFile(page)), { recursive: true });
    await writeFile(wikiFile(page), handWritten);

    // Without --force the page is refused and nothing is recorded.
    await expect(wikiCreatePage({ cwd: root, type: "decision", slug: "w5-page" })).rejects.toThrow(/already exists/);
    expect(await readPageHistory(root, page)).toBeNull();

    const result = await wikiCreatePage({ cwd: root, type: "decision", slug: "w5-page", force: true });

    expect(result.created).toBe(true);
    const history = await expectPriorStored(page, handWritten);
    expect(history.rows[0]!.by).toBe("wiki new --force");
    expect(history.rows[1]!.by).toBe("baseline (before history)");
    expect(await readFile(wikiFile(page), "utf8")).toContain("# W5 Page");
  });
});
