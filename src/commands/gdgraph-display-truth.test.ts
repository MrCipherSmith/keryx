// THE COMMAND-LINE HALF OF THE FIFTH INSTANCE (flow 235, T18)
//
// The shape, restated: a DISPLAY decision — a slice, a limit, a token budget —
// used to make a statement about the CORPUS. Closed four times inside the
// `gdgraph find` payload; never once audited in the renderers that print prose
// beside it. `keryx gdgraph symbol` and `keryx gdgraph repomap` both had it,
// and `symbol` had it in the worst available form: the slice chose the OUTCOME
// CODE.
//
// MEASURED ON 2026-09-08, against real built graphs written to disk and read
// back through `gdgraphCommand`:
//
//   30 symbols named `handleAlpha`, then 10 named `handleBeta`:
//     $ keryx gdgraph symbol "handle"
//     code: ok
//     ## Definitions (25, matched by name-contains-query)
//
//   — forty symbols under two names, answered as one confident name, because
//   `resolveSymbolCandidates`'s default `limit = 25` had already deleted
//   `handleBeta` before the ambiguity guard could see it.
//
//   60 symbols with 60 distinct names containing `handle`:
//     reason: "handle" matches 25 symbols across 25 different names
//   — both numbers the page. And the `… +N more` notice below could never
//   fire: `matches` was the 25-row slice, so `matches.length > 25` was dead.
//
//   a `--seed` whose required set does not fit the budget:
//     gdgraph repomap complete: 0 entries, ~0 tokens
//   — `computeRepomap` had REFUSED (`overflow: context_overflow`), and the CLI
//   called it complete, at exit 0. The agent boundary got this fix in AFC-12;
//   this surface never did.
//
// Every test below drives the real `gdgraphCommand` over a real graph on disk.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gdgraphCommand } from "./gdgraph";

interface Sym {
  name: string;
  file: string;
}

async function writeGraph(root: string, symbols: Sym[]): Promise<void> {
  const storage = path.join(root, ".metaproject", "data", "gdgraph", "storage");
  await mkdir(storage, { recursive: true });
  const files = [...new Set(symbols.map((s) => s.file))];
  await writeFile(
    path.join(storage, "nodes.jsonl"),
    `${files
      .map((file) => JSON.stringify({ id: file, kind: "file", path: file, language: "typescript" }))
      .join("\n")}\n`,
    "utf8",
  );
  await writeFile(
    path.join(storage, "symbols.jsonl"),
    `${symbols
      .map((s) =>
        JSON.stringify({
          id: `${s.file}#${s.name}`,
          kind: "function",
          name: s.name,
          path: s.file,
          startLine: 1,
          endLine: 2,
        }),
      )
      .join("\n")}\n`,
    "utf8",
  );
}

describe("keryx gdgraph — a display limit may never speak for the corpus", () => {
  let root = "";
  let cwd = "";
  let loggedOut: string[] = [];
  let loggedErr: string[] = [];
  let originalLog: typeof console.log;
  let originalError: typeof console.error;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "keryx-gdgraph-display-truth-"));
    cwd = process.cwd();
    process.chdir(root);
    loggedOut = [];
    loggedErr = [];
    originalLog = console.log;
    originalError = console.error;
    console.log = (...parts: unknown[]) => {
      loggedOut.push(parts.map(String).join(" "));
    };
    console.error = (...parts: unknown[]) => {
      loggedErr.push(parts.map(String).join(" "));
    };
    process.exitCode = 0;
  });

  afterEach(async () => {
    console.log = originalLog;
    console.error = originalError;
    process.chdir(cwd);
    process.exitCode = 0;
    await rm(root, { recursive: true, force: true });
  });

  const out = (): string => loggedOut.join("\n");

  // --- symbol: the slice must not choose the code ----------------------------

  test("the 25-row slice cannot turn an ambiguous query into a confident one", async () => {
    // 30 `handleAlpha` first, then 10 `handleBeta`: the slice keeps only the
    // first name, and the ambiguity guard used to read the slice.
    await writeGraph(root, [
      ...Array.from({ length: 30 }, (_, i) => ({ name: "handleAlpha", file: `src/a${i}.ts` })),
      ...Array.from({ length: 10 }, (_, i) => ({ name: "handleBeta", file: `src/b${i}.ts` })),
    ]);

    await gdgraphCommand(["symbol", "handle"]);

    // The defect verbatim: `code: ok`, i.e. "here is your answer", for a query
    // that matches two different names forty times over.
    expect(out()).not.toContain("code: ok");
    expect(out()).toContain("code: insufficient-evidence");
    expect(out()).toContain("matches 40 symbols across 2 different names");
  });

  test("the ambiguity reason counts what matched, at every size across the display limit", async () => {
    // THE STRUCTURAL FORM: sweep the corpus size across the page size rather
    // than asserting one example. Below the limit the two counts coincide and
    // prove nothing; above it, any renderer that reads the page instead of the
    // scan reports 25 forever, and each of these fails.
    for (const total of [3, 24, 25, 26, 40, 60]) {
      loggedOut = [];
      await rm(path.join(root, ".metaproject"), { recursive: true, force: true });
      await writeGraph(
        root,
        Array.from({ length: total }, (_, i) => ({ name: `handleThing${i}`, file: `src/m${i}.ts` })),
      );

      await gdgraphCommand(["symbol", "handle"]);

      expect(`${total}: ${out()}`).toContain(
        `matches ${total} symbols across ${total} different names`,
      );
      // And the truncation notice is live rather than structurally unreachable:
      // it must appear exactly when the corpus really does exceed the page.
      const expectedNotice = total > 25 ? `… +${total - 25} more` : "";
      if (expectedNotice) {
        expect(`${total}: ${out()}`).toContain(expectedNotice);
      } else {
        expect(out()).not.toContain("more (a display limit");
      }
    }
  });

  test("a truncated same-name definition list says how many it is not showing", async () => {
    // 40 definitions of ONE name: unambiguous (`code: ok`), but `querySymbol`
    // still resolves through the 25-row default, so the header used to read
    // "## Definitions (25, matched by exact-name)" with nothing marking the cut.
    await writeGraph(
      root,
      Array.from({ length: 40 }, (_, i) => ({ name: "run", file: `src/n${i}.ts` })),
    );

    await gdgraphCommand(["symbol", "run"]);

    expect(out()).toContain("code: ok");
    expect(out()).not.toContain("## Definitions (25, matched by exact-name)");
    expect(out()).toContain("## Definitions (showing 25 of 40 matched, matched by exact-name)");
    expect(out()).toContain("15 further definition(s) of this name are not listed");
  });

  test("an untruncated definition list is unchanged", async () => {
    // The guard against fixing this by bolting a caveat onto every answer.
    await writeGraph(root, [
      { name: "run", file: "src/n0.ts" },
      { name: "run", file: "src/n1.ts" },
    ]);

    await gdgraphCommand(["symbol", "run"]);

    expect(out()).toContain("## Definitions (2, matched by exact-name)");
    expect(out()).not.toContain("further definition(s)");
    expect(out()).not.toContain("showing");
  });

  test("a real no-match is still a no-match, stated from the symbol layer's own size", async () => {
    await writeGraph(
      root,
      Array.from({ length: 30 }, (_, i) => ({ name: `handleThing${i}`, file: `src/m${i}.ts` })),
    );

    await gdgraphCommand(["symbol", "kubernetes"]);

    expect(out()).toContain("code: no-match");
    expect(out()).toContain("the symbol layer holds 30 symbols");
  });

  // --- find: the page counts are labelled as page counts ---------------------

  test("find's section headers count the page and say so", async () => {
    const storage = path.join(root, ".metaproject", "data", "gdgraph", "storage");
    await mkdir(storage, { recursive: true });
    // 40 files whose paths contain `refund`, plus 60 that do not: the default
    // file limit is 20, so the header and the reason disagree by construction.
    const nodes = [
      ...Array.from({ length: 40 }, (_, i) => `src/payments/refund-${i}.ts`),
      ...Array.from({ length: 60 }, (_, i) => `src/other/thing-${i}.ts`),
    ];
    await writeFile(
      path.join(storage, "nodes.jsonl"),
      `${nodes
        .map((p) => JSON.stringify({ id: p, kind: "file", path: p, language: "typescript" }))
        .join("\n")}\n`,
      "utf8",
    );

    await gdgraphCommand(["find", "refund"]);

    expect(out()).toContain("40 files and 0 symbols matched");
    // The page, named as one — never a bare `## Files (20)` under a reason
    // saying forty matched.
    expect(out()).toContain("## Files (20 shown)");
    expect(out()).not.toContain("## Files (20)\n");
  });

  // --- repomap: a refusal is not a completed map -----------------------------

  test("a budget that cannot hold the required seed is a refusal, not a complete map", async () => {
    const storage = path.join(root, ".metaproject", "data", "gdgraph", "storage");
    await mkdir(storage, { recursive: true });
    const nodes = Array.from({ length: 5 }, (_, i) => `src/f${i}.ts`);
    await writeFile(
      path.join(storage, "nodes.jsonl"),
      `${nodes
        .map((p) => JSON.stringify({ id: p, kind: "file", path: p, language: "typescript" }))
        .join("\n")}\n`,
      "utf8",
    );
    await writeFile(
      path.join(storage, "edges.jsonl"),
      `${JSON.stringify({ from: "src/f0.ts", to: "src/f1.ts", kind: "imports" })}\n`,
      "utf8",
    );

    await gdgraphCommand(["repomap", "--budget", "15", "--seed", "src/f2.ts"]);

    // The defect: "complete", at exit 0, for a map `computeRepomap` refused.
    expect(out()).not.toContain("gdgraph repomap complete");
    expect(loggedErr.join("\n")).toContain("context_overflow");
    // The seed the caller asked to protect is named, not dropped in silence.
    expect(loggedErr.join("\n")).toContain("src/f2.ts");
    expect(process.exitCode).toBe(1);
  });

  test("a map that fits is still reported as complete", async () => {
    const storage = path.join(root, ".metaproject", "data", "gdgraph", "storage");
    await mkdir(storage, { recursive: true });
    const nodes = Array.from({ length: 5 }, (_, i) => `src/f${i}.ts`);
    await writeFile(
      path.join(storage, "nodes.jsonl"),
      `${nodes
        .map((p) => JSON.stringify({ id: p, kind: "file", path: p, language: "typescript" }))
        .join("\n")}\n`,
      "utf8",
    );
    await writeFile(
      path.join(storage, "edges.jsonl"),
      `${JSON.stringify({ from: "src/f0.ts", to: "src/f1.ts", kind: "imports" })}\n`,
      "utf8",
    );

    await gdgraphCommand(["repomap"]);

    expect(out()).toContain("gdgraph repomap complete");
    expect(process.exitCode).toBe(0);
  });

  test("entries dropped for budget are named, and 0 entries is stated as a budget decision", async () => {
    const storage = path.join(root, ".metaproject", "data", "gdgraph", "storage");
    await mkdir(storage, { recursive: true });
    const nodes = Array.from({ length: 5 }, (_, i) => `src/f${i}.ts`);
    await writeFile(
      path.join(storage, "nodes.jsonl"),
      `${nodes
        .map((p) => JSON.stringify({ id: p, kind: "file", path: p, language: "typescript" }))
        .join("\n")}\n`,
      "utf8",
    );
    await writeFile(
      path.join(storage, "edges.jsonl"),
      `${JSON.stringify({ from: "src/f0.ts", to: "src/f1.ts", kind: "imports" })}\n`,
      "utf8",
    );

    // No seed: nothing is required, so every entry is optional and a tiny
    // budget omits them all — `entries: []` with `omitted > 0`.
    await gdgraphCommand(["repomap", "--budget", "15"]);

    expect(out()).toContain("omitted (over budget): 5");
    expect(out()).toContain("- src/f0.ts");
    expect(out()).toContain("not a claim that the graph holds no ranked files");
  });

  // --- affected: checked, and clean ------------------------------------------

  test("affected prints every dependent it computed — there is no limit to misreport", async () => {
    // The evidence for the audit's "clean" verdict on this renderer, pinned so
    // it stays true: `computeAffected` applies no slice at all, so the CLI's
    // counts and its "- none" branches are scan facts. Sixty dependents, sixty
    // lines, no truncation marker anywhere.
    const storage = path.join(root, ".metaproject", "data", "gdgraph", "storage");
    await mkdir(storage, { recursive: true });
    const nodes = ["src/target.ts", ...Array.from({ length: 60 }, (_, i) => `src/dep${i}.ts`)];
    await writeFile(
      path.join(storage, "nodes.jsonl"),
      `${nodes
        .map((p) => JSON.stringify({ id: p, kind: "file", path: p, language: "typescript" }))
        .join("\n")}\n`,
      "utf8",
    );
    await writeFile(
      path.join(storage, "edges.jsonl"),
      `${Array.from({ length: 60 }, (_, i) =>
        JSON.stringify({ from: `src/dep${i}.ts`, to: "src/target.ts", kind: "imports" }),
      ).join("\n")}\n`,
      "utf8",
    );

    await gdgraphCommand(["affected", "src/target.ts"]);

    const dependents = out()
      .split("\n")
      .filter((line) => line.startsWith("- src/dep"));
    expect(dependents.length).toBe(60);
    expect(out()).not.toContain("more");
  });
});
