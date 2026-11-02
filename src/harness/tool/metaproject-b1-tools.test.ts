// Block 1 review fixes for the agent's metaproject tools: graph freshness and the
// parsed graph are not kept for a whole session, search_code stops ripgrep at its
// output cap, a partial ripgrep result survives exit 2, wiki_freshness counts what
// it cuts.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createGdgraphService } from "../../gdgraph/service";
import type { StalenessCheck } from "../../gdgraph/staleness";
import { createMetaprojectAdapter, loadGraphCached, runBoundedProcess } from "./metaproject-adapter";
import { METAPROJECT_OPERATIONS } from "./metaproject-operations";

let root: string;
const storage = (): string => path.join(root, ".metaproject", "data", "gdgraph", "storage");
function writeNodes(n: number, mtimeSec: number): void {
  const file = path.join(storage(), "nodes.jsonl");
  writeFileSync(
    file,
    Array.from({ length: n }, (_, i) => JSON.stringify({ id: `f${i}.ts`, path: `f${i}.ts` })).join("\n") + "\n",
  );
  utimesSync(file, mtimeSec, mtimeSec);
}
beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "mp-b1-"));
  mkdirSync(storage(), { recursive: true });
  writeFileSync(path.join(storage(), "edges.jsonl"), "");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("graph freshness is not memoised for the adapter's lifetime", () => {
  function adapterWith(statuses: StalenessCheck[], clock: { now: number }) {
    let calls = 0;
    const port = createMetaprojectAdapter(root, {
      clockMs: () => clock.now,
      checkGraphStaleness: async () => statuses[Math.min(calls++, statuses.length - 1)]!,
    });
    return { port, calls: () => calls };
  }
  const fresh = { status: "fresh", reasons: [] } as unknown as StalenessCheck;
  const stale = { status: "stale", reasons: ["a file changed"] } as unknown as StalenessCheck;

  test("back-to-back calls share one check, an expired answer is recomputed", async () => {
    writeNodes(2, 1_000);
    const clock = { now: 0 };
    const { port, calls } = adapterWith([fresh, stale], clock);
    expect((await port.describeContext()).staleness?.status).toBe("fresh");
    expect((await port.describeContext()).staleness?.status).toBe("fresh");
    expect(calls()).toBe(1);
    clock.now = 60_000;
    expect((await port.describeContext()).staleness?.status).toBe("stale");
    expect(calls()).toBe(2);
  });

  test("a graph rebuild invalidates the answer at once", async () => {
    writeNodes(2, 2_000);
    const clock = { now: 0 };
    const { port, calls } = adapterWith([fresh, stale], clock);
    expect((await port.describeContext()).staleness?.status).toBe("fresh");
    writeNodes(3, 3_000);
    expect((await port.describeContext()).staleness?.status).toBe("stale");
    expect(calls()).toBe(2);
  });
});

describe("the parsed graph is cached by file signature", () => {
  test("repeated graph tools parse once; a rebuild is picked up", async () => {
    writeNodes(2, 4_000);
    let loads = 0;
    const real = createGdgraphService();
    const port = createMetaprojectAdapter(root, {
      createGdgraphService: () => ({
        ...real,
        loadGraph: async (cwd: string) => {
          loads++;
          return real.loadGraph(cwd);
        },
      }),
      checkGraphStaleness: async () => ({ status: "fresh", reasons: [] }) as unknown as StalenessCheck,
    });
    expect((await port.describeContext()).graphNodes).toBe(2);
    expect((await port.describeContext()).graphNodes).toBe(2);
    if (port.graphSymbol === undefined) throw new Error("adapter exposes graphSymbol");
    await port.graphSymbol({ name: "x" });
    expect(loads).toBe(1);
    writeNodes(5, 5_000);
    expect((await port.describeContext()).graphNodes).toBe(5);
    expect(loads).toBe(2);
  });

  test("with no graph files nothing is cached", async () => {
    const empty = mkdtempSync(path.join(tmpdir(), "mp-b1-empty-"));
    let loads = 0;
    const loader = async () => {
      loads++;
      return { nodes: [], edges: [] };
    };
    await loadGraphCached(empty, loader);
    await loadGraphCached(empty, loader);
    expect(loads).toBe(2);
    rmSync(empty, { recursive: true, force: true });
  });
});

describe("search_code stops ripgrep at the output cap", () => {
  test("an endless producer is killed and the read is bounded", async () => {
    const started = Date.now();
    const run = await runBoundedProcess(root, ["yes", "needle needle needle"], { maxStdoutChars: 5_000 });
    expect(run.stdoutCut).toBe(true);
    expect(run.stdout.length).toBeGreaterThanOrEqual(5_000);
    expect(run.stdout.length).toBeLessThan(2_000_000);
    expect(run.exitCode).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("a runaway process is killed at the time limit", async () => {
    const run = await runBoundedProcess(root, ["sleep", "30"], { timeoutMs: 100 });
    expect(run.timedOut).toBe(true);
  });

  test("a cut run is reported as truncated matches, not as an rg failure", async () => {
    const port = createMetaprojectAdapter(root, {
      runRipgrep: async () => ({
        stdout: `${"a.ts:1:1:needle\n".repeat(2_000)}b.ts:1:1:nee`,
        stderr: "",
        exitCode: 143,
        stdoutCut: true,
      }),
    });
    const result = await port.searchCode({ pattern: "needle" });
    expect(result.isError).toBe(false);
    expect(result.truncated).toBe(true);
    expect(result.output).toContain("more matches omitted");
  });

  test("a timeout with nothing read is a named error", async () => {
    const port = createMetaprojectAdapter(root, {
      runRipgrep: async () => ({ stdout: "", stderr: "", exitCode: 143, timedOut: true }),
    });
    const result = await port.searchCode({ pattern: "needle" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("timed out");
  });

  test("rg exit 2 with matches keeps the matches and names the unreadable path", async () => {
    const port = createMetaprojectAdapter(root, {
      runRipgrep: async () => ({
        stdout: "a.ts:1:1:needle\n",
        stderr: "locked.ts: Permission denied (os error 13)\n",
        exitCode: 2,
      }),
    });
    const result = await port.searchCode({ pattern: "needle" });
    expect(result.isError).toBe(false);
    expect(result.output).toContain("a.ts:1:1:needle");
    expect(result.output).toContain("Permission denied");
  });

  test("rg exit 2 with no matches is still a failure", async () => {
    const port = createMetaprojectAdapter(root, {
      runRipgrep: async () => ({ stdout: "", stderr: "regex parse error", exitCode: 2 }),
    });
    const result = await port.searchCode({ pattern: "(" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("regex parse error");
  });
});

describe("wiki_freshness says what it cuts", () => {
  const op = METAPROJECT_OPERATIONS.find((o) => o.name === "wiki_freshness")!;
  const pages = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      path: `p${i}.md`,
      category: "stale-prose",
      confidence: "fyi",
      commitsBehind: 1,
      verifiedAt: null,
    }));
  test("45 pages in doubt: 40 listed, the other 5 counted", async () => {
    const port = { wikiFreshness: async () => ({ status: "measured", pages: pages(45), limitations: [] }) } as never;
    const out = ((await op.invoke(port, {})) as { output: string }).output;
    expect(out).toContain("p39.md");
    expect(out).not.toContain("p40.md");
    expect(out).toContain("+5 more page(s) in doubt not shown (45 in all)");
  });
  test("exactly 40 pages: no marker", async () => {
    const port = { wikiFreshness: async () => ({ status: "measured", pages: pages(40), limitations: [] }) } as never;
    const out = ((await op.invoke(port, {})) as { output: string }).output;
    expect(out).toContain("p39.md");
    expect(out).not.toContain("more page(s)");
  });
});
