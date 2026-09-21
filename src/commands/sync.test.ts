import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { syncCommand } from "./sync";
import { provenancePath, readProvenance } from "../sync/provenance";
import { withCwd } from "../lib/test-cwd";

// AFC-08 (flow 236 T9): `resolveWikiSourceGate` (`wiki/staleness.ts`) is what
// `wikiCollect` (`wiki/service.ts`) consults before advancing gdwiki's OWN
// sync-provenance record — it deliberately skips that record when the code
// graph is not demonstrably fresh, so `keryx sync` never claims gdwiki
// reflects a source it did not actually read. `applyModule` in `sync.ts`
// (this file's subject) used to call `recordProvenance(cwd, module, at)`
// again, unconditionally, right after every module's apply step — including
// gdwiki's. That second, ungated write re-stamped gdwiki's provenance at the
// current commit regardless of what the gate had just decided, going around
// it entirely.
//
// The full `sync --apply` path mostly hides this: `SYNCED_MODULES` runs
// gdgraph before gdwiki, and an ordinary code change makes gdgraph's own
// diff fire first, rebuilding the graph (and therefore making it fresh)
// before gdwiki's turn. The reproduction below isolates the wiki-only path by
// making the graph fresh BY SYNC'S OWN COMMIT-DIFF CHECK (so gdgraph's branch
// in the loop never runs) while making it genuinely stale by the richer
// `checkGraphStaleness` signal `resolveWikiSourceGate` actually consults: an
// untracked file in the working tree, invisible to `git diff <base>` (what
// sync's own per-module diff uses) but not to `git status --porcelain`.

async function git(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if ((await proc.exited) !== 0) {
    throw new Error(`git ${args.join(" ")}: ${await new Response(proc.stderr).text()}`);
  }
}

async function headCommit(cwd: string): Promise<string> {
  const proc = Bun.spawn(["git", "rev-parse", "HEAD"], { cwd, stdout: "pipe" });
  return (await new Response(proc.stdout).text()).trim();
}

const jsonl = (rows: object[]): string => rows.map((row) => JSON.stringify(row)).join("\n");

let logged: string[] = [];
const realLog = console.log;

beforeEach(() => {
  logged = [];
  console.log = (...parts: unknown[]) => {
    logged.push(parts.map(String).join(" "));
  };
});

afterEach(() => {
  console.log = realLog;
});

/**
 * A git fixture where gdgraph and memory already look "up to date" to sync's
 * own commit-diff check (their provenance files already name HEAD), but the
 * actual graph is stale by `checkGraphStaleness`'s own git-status check: an
 * untracked file sits in the working tree. gdwiki has never been synced at
 * all (no provenance file), so it takes the "!provenance" baseline-apply
 * path — the only module `syncCommand --apply` will touch.
 */
async function wikiOnlyStaleGraphFixture(): Promise<{ root: string; commit: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-sync-wiki-gate-"));
  await git(root, ["init", "-q"]);
  await git(root, ["config", "user.email", "fixture@example.invalid"]);
  await git(root, ["config", "user.name", "fixture"]);
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "a.ts"), "export const a = 1;\n", "utf8");
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-q", "-m", "fixture"]);
  const commit = await headCommit(root);

  const graphDir = path.join(root, ".metaproject", "data", "gdgraph", "storage");
  await mkdir(graphDir, { recursive: true });
  await writeFile(
    path.join(graphDir, "nodes.jsonl"),
    jsonl([{ id: "src/a.ts", kind: "file", path: "src/a.ts" }]),
    "utf8",
  );
  await writeFile(path.join(graphDir, "edges.jsonl"), "", "utf8");

  for (const module of ["gdgraph", "memory"]) {
    const file = provenancePath(root, module);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      `${JSON.stringify({ commit, branch: "main", builtAt: new Date().toISOString() }, null, 2)}\n`,
      "utf8",
    );
  }

  // Untracked — invisible to `git diff <base>` (sync's own per-module check),
  // visible to `git status --porcelain` (checkGraphStaleness's check).
  await writeFile(path.join(root, "src", "b.ts"), "export const b = 2;\n", "utf8");

  return { root, commit };
}

/**
 * Flow 280 (the graph-provenance stall). Two commits: `commit1` establishes
 * gdgraph/memory provenance with a matching `nodes.jsonl` and a CLEAN working
 * tree (no untracked file, unlike `wikiOnlyStaleGraphFixture` above — this
 * fixture isolates the "HEAD moved, no code changed" trigger from the
 * separate untracked-file trigger). `commit2` then touches only bookkeeping
 * under `.metaproject/` (a notes file, plus the graph/provenance files this
 * fixture itself just wrote, none of which are source code) — no `src/` file
 * — so `codeOnly(diffSince(commit1))` for `commit2` is empty, but HEAD has
 * genuinely moved from `commit1` to `commit2`.
 */
async function metaprojectOnlyCommitFixture(): Promise<{ root: string; commit1: string; commit2: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-sync-metaproject-only-"));
  await git(root, ["init", "-q"]);
  await git(root, ["config", "user.email", "fixture@example.invalid"]);
  await git(root, ["config", "user.name", "fixture"]);
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "a.ts"), "export const a = 1;\n", "utf8");
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-q", "-m", "fixture"]);
  const commit1 = await headCommit(root);

  const graphDir = path.join(root, ".metaproject", "data", "gdgraph", "storage");
  await mkdir(graphDir, { recursive: true });
  await writeFile(
    path.join(graphDir, "nodes.jsonl"),
    jsonl([{ id: "src/a.ts", kind: "file", path: "src/a.ts" }]),
    "utf8",
  );
  await writeFile(path.join(graphDir, "edges.jsonl"), "", "utf8");

  for (const module of ["gdgraph", "memory"]) {
    const file = provenancePath(root, module);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      `${JSON.stringify({ commit: commit1, branch: "main", builtAt: new Date().toISOString() }, null, 2)}\n`,
      "utf8",
    );
  }

  // Bookkeeping-only second commit: a notes file under `.metaproject/`, plus
  // the graph/provenance files just written above — none of it a source file
  // `isCodeFile` recognizes.
  await mkdir(path.join(root, ".metaproject", "notes"), { recursive: true });
  await writeFile(path.join(root, ".metaproject", "notes", "log.md"), "# notes\n", "utf8");
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-q", "-m", "metaproject bookkeeping only"]);
  const commit2 = await headCommit(root);

  return { root, commit1, commit2 };
}

/**
 * Flow 280 finding 1 (review of ce309d58): all three modules already carry
 * provenance at `commit1` (as if `sync --apply` had already run once on a
 * clean tree). An untracked `src/new.ts` is then created — invisible to
 * `git diff <base>` (`codeOnly(diffSince(...))`, what the fast path's
 * `totalChanges(code) === 0` check reads) but visible to `git status
 * --porcelain` (`checkGraphStaleness`, what `resolveWikiSourceGate` reads).
 * `commit2` then touches only `.metaproject/` bookkeeping — no `src/` file —
 * so the fast path fires for every module.
 */
async function fastPathUntrackedFileFixture(): Promise<{ root: string; commit1: string; commit2: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-sync-fastpath-untracked-"));
  await git(root, ["init", "-q"]);
  await git(root, ["config", "user.email", "fixture@example.invalid"]);
  await git(root, ["config", "user.name", "fixture"]);
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "a.ts"), "export const a = 1;\n", "utf8");
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-q", "-m", "fixture"]);
  const commit1 = await headCommit(root);

  const graphDir = path.join(root, ".metaproject", "data", "gdgraph", "storage");
  await mkdir(graphDir, { recursive: true });
  await writeFile(
    path.join(graphDir, "nodes.jsonl"),
    jsonl([{ id: "src/a.ts", kind: "file", path: "src/a.ts" }]),
    "utf8",
  );
  await writeFile(path.join(graphDir, "edges.jsonl"), "", "utf8");

  // All three modules already synced at commit1 — the fast path, not the
  // "!provenance" baseline path, is what this fixture exercises.
  for (const module of ["gdgraph", "gdwiki", "memory"]) {
    const file = provenancePath(root, module);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      `${JSON.stringify({ commit: commit1, branch: "main", builtAt: new Date().toISOString() }, null, 2)}\n`,
      "utf8",
    );
  }

  // Untracked — invisible to `git diff <base>` (the fast path's own
  // `totalChanges(code)` check), visible to `git status --porcelain`
  // (`checkGraphStaleness`, consulted by `resolveWikiSourceGate`).
  await writeFile(path.join(root, "src", "new.ts"), "export const created = true;\n", "utf8");

  // `.metaproject/`-only second commit — deliberately `git add .metaproject`
  // rather than `-A`, so the untracked `src/new.ts` stays untracked.
  await mkdir(path.join(root, ".metaproject", "notes"), { recursive: true });
  await writeFile(path.join(root, ".metaproject", "notes", "log.md"), "# notes\n", "utf8");
  await git(root, ["add", ".metaproject"]);
  await git(root, ["commit", "-q", "-m", "metaproject bookkeeping only"]);
  const commit2 = await headCommit(root);

  return { root, commit1, commit2 };
}

function moduleSection(output: string, module: string): string {
  const marker = `## ${module}`;
  const start = output.indexOf(marker);
  if (start < 0) return "";
  const rest = output.slice(start + marker.length);
  const next = rest.search(/\n## /);
  return next < 0 ? rest : rest.slice(0, next);
}

describe("keryx sync --apply, fast path (no code diff) honors resolveWikiSourceGate for gdwiki (flow 280 finding 1)", () => {
  test("refuses to advance gdwiki provenance when an untracked file makes the graph stale, even though no code diff was seen", async () => {
    const { root, commit1, commit2 } = await fastPathUntrackedFileFixture();
    try {
      await withCwd(root, () => syncCommand(["--apply"]));
      const output = logged.join("\n");

      // gdgraph and memory have no equivalent staleness gate: their own apply
      // step (`gdgraph build` / `memory index`) always makes itself the fresh
      // ground truth, so the fast path's provenance advance is honest for
      // them. gdgraph additionally has an independent, provenance-independent
      // untracked-file signal (`checkGraphStaleness`'s git-status check) that
      // any OTHER consumer of graph staleness still sees regardless of what
      // this fast path stamps.
      expect((await readProvenance(root, "gdgraph"))?.commit).toBe(commit2);
      expect((await readProvenance(root, "memory"))?.commit).toBe(commit2);

      // gdwiki DOES publish a "reflects the code as of X" claim
      // (`resolveWikiSourceGate`) — the fast path must consult it, same as
      // `applyModule`, and must not stamp gdwiki's provenance past what the
      // gate says the collector actually saw.
      expect((await readProvenance(root, "gdwiki"))?.commit).toBe(commit1);

      const gdwikiSection = moduleSection(output, "gdwiki");
      expect(gdwikiSection).not.toContain(`provenance advanced to ${commit2.slice(0, 8)}`);
      expect(gdwikiSection).toContain("provenance NOT advanced");
      expect(gdwikiSection).toContain("the code graph is stale");
      expect(gdwikiSection).toContain("an untracked or newly added file exists in the working tree");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("control: advances gdwiki provenance through the fast path when the graph is genuinely fresh", async () => {
    const { root, commit2 } = await fastPathUntrackedFileFixture();
    try {
      await rm(path.join(root, "src", "new.ts"));

      await withCwd(root, () => syncCommand(["--apply"]));
      const output = logged.join("\n");

      expect((await readProvenance(root, "gdgraph"))?.commit).toBe(commit2);
      expect((await readProvenance(root, "memory"))?.commit).toBe(commit2);
      expect((await readProvenance(root, "gdwiki"))?.commit).toBe(commit2);

      const gdwikiSection = moduleSection(output, "gdwiki");
      expect(gdwikiSection).toContain(`provenance advanced to ${commit2.slice(0, 8)}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("keryx sync — a metaproject-only commit no longer stalls provenance (flow 280)", () => {
  test("AC1/AC2: report mode never mutates provenance; --apply advances it to HEAD and unblocks the gdwiki baseline", async () => {
    const { root, commit1, commit2 } = await metaprojectOnlyCommitFixture();
    try {
      // Report-only `keryx sync`: AC1's stall, still true for a plain report —
      // provenance must not move without `--apply`, and the message must say
      // why (HEAD moved, no code changed).
      logged = [];
      await withCwd(root, () => syncCommand([]));
      const reportOutput = logged.join("\n");
      expect(reportOutput).toContain(`up to date (built at ${commit1.slice(0, 8)})`);
      expect(reportOutput).toContain("HEAD moved");
      expect(reportOutput).toContain("run `keryx sync --apply` to advance provenance");
      const afterReport = await readProvenance(root, "gdgraph");
      expect(afterReport?.commit).toBe(commit1);

      // `keryx sync --apply`: AC2 — provenance advances to HEAD with no
      // rebuild, and the gdwiki baseline (never recorded before this run) is
      // now recordable in the SAME invocation, because gdgraph's provenance
      // (processed first in `SYNCED_MODULES`) is already fresh by the time
      // gdwiki's turn runs.
      logged = [];
      await withCwd(root, () => syncCommand(["--apply"]));
      const applyOutput = logged.join("\n");
      expect(applyOutput).toContain(`provenance advanced to ${commit2.slice(0, 8)}`);
      // Never claims a rebuilt artifact — no code changed, so nothing was
      // rebuilt, only the record moved.
      expect(applyOutput).not.toContain("updated + provenance advanced");

      const gdgraphProvenance = await readProvenance(root, "gdgraph");
      expect(gdgraphProvenance?.commit).toBe(commit2);

      expect(applyOutput).not.toContain("the code graph is stale");
      expect(applyOutput).toContain("provenance recorded (baseline)");
      const wikiProvenance = await readProvenance(root, "gdwiki");
      expect(wikiProvenance?.commit).toBe(commit2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("AC3 (regression): a commit that changes a tracked code file still rebuilds and advances provenance", async () => {
    const { root, commit1 } = await metaprojectOnlyCommitFixture();
    try {
      // A REAL code change this time: a new tracked source file.
      await writeFile(path.join(root, "src", "b.ts"), "export const b = 2;\n", "utf8");
      await git(root, ["add", "-A"]);
      await git(root, ["commit", "-q", "-m", "add src/b.ts"]);
      const commit3 = await headCommit(root);

      logged = [];
      await withCwd(root, () => syncCommand(["--apply"]));
      const output = logged.join("\n");

      // Unchanged from today: the ordinary rebuild path, not the new
      // no-rebuild advance this flow added.
      expect(output).toContain("updated + provenance advanced");
      expect(output).not.toContain("no code changed — provenance advanced");

      const gdgraphProvenance = await readProvenance(root, "gdgraph");
      expect(gdgraphProvenance?.commit).toBe(commit3);
      expect(gdgraphProvenance?.commit).not.toBe(commit1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("AC4 (flow 280 finding 2 regression): a commit that changes only a tracked .mts file still rebuilds and advances provenance", async () => {
    const { root, commit1 } = await metaprojectOnlyCommitFixture();
    try {
      // A real code change, but in an extension `CODE_EXT` (`../sync/diff.ts`)
      // did not recognize before finding 2's fix — before ce309d58 that only
      // left the artifact stale forever; since ce309d58 it would make the
      // fast path assert "no code changed" for a commit that changed code.
      await writeFile(path.join(root, "src", "b.mts"), "export const b = 2;\n", "utf8");
      await git(root, ["add", "-A"]);
      await git(root, ["commit", "-q", "-m", "add src/b.mts"]);
      const commit3 = await headCommit(root);

      logged = [];
      await withCwd(root, () => syncCommand(["--apply"]));
      const output = logged.join("\n");

      expect(output).toContain("updated + provenance advanced");
      expect(output).not.toContain("no code changed — provenance advanced");

      const gdgraphProvenance = await readProvenance(root, "gdgraph");
      expect(gdgraphProvenance?.commit).toBe(commit3);
      expect(gdgraphProvenance?.commit).not.toBe(commit1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("keryx sync --apply, wiki-only path honors resolveWikiSourceGate (flow 236 T9)", () => {
  test("does not stamp gdwiki provenance as current when only wiki applies over a stale graph", async () => {
    const { root } = await wikiOnlyStaleGraphFixture();
    try {
      expect(await readProvenance(root, "gdwiki")).toBeNull();

      await withCwd(root, () => syncCommand(["--apply"]));

      // The behavior under test: sync must not claim gdwiki reflects the
      // current commit when the graph the collector read from is
      // demonstrably stale — matching what `wikiCollect`'s own internal gate
      // already decided, instead of overriding it.
      expect(await readProvenance(root, "gdwiki")).toBeNull();

      const output = logged.join("\n");
      expect(output).not.toContain("provenance recorded (baseline)");
      expect(output).toContain("provenance NOT recorded");
      expect(output).toContain("the code graph is stale");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("control: does stamp gdwiki provenance when only wiki applies over a fresh graph", async () => {
    // Same fixture, minus the untracked file — proves the fix is a real gate,
    // not a blanket refusal to ever record gdwiki provenance from this path.
    const { root, commit } = await wikiOnlyStaleGraphFixture();
    try {
      await rm(path.join(root, "src", "b.ts"));

      await withCwd(root, () => syncCommand(["--apply"]));

      const wikiProvenance = await readProvenance(root, "gdwiki");
      expect(wikiProvenance).not.toBeNull();
      expect(wikiProvenance?.commit).toBe(commit);

      const output = logged.join("\n");
      expect(output).toContain("provenance recorded (baseline)");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
