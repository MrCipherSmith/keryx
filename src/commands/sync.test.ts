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
