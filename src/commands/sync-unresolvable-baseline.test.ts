import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { syncCommand } from "./sync";
import { provenancePath } from "../sync/provenance";
import { withCwd } from "../lib/test-cwd";

// `diffSince` returns null when git CANNOT ANSWER, and its own comment says so —
// "not a repo, unknown base". The caller then treated that null the same as a
// diff with zero changes, so both printed `up to date`.
//
// That is not hypothetical. This repository's committed graph provenance named
// `b99290b6` on `fix/tui-foreground-operation-cancellation`, a branch that was
// squash-merged and deleted. `git cat-file` cannot resolve the sha at all. Sync
// reported the graph up to date; a rebuild then added ~30 files including the
// whole `src/wiki/freshness/` tree — the Living Wiki implementation itself.
//
// Same shape as two defects fixed the day before: an impossible comparison
// reported as a passing one.

async function git(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if ((await proc.exited) !== 0) {
    throw new Error(`git ${args.join(" ")}: ${await new Response(proc.stderr).text()}`);
  }
}

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

async function repoWithProvenance(commit: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-sync-baseline-"));
  await git(root, ["init", "-q"]);
  await git(root, ["config", "user.email", "fixture@example.invalid"]);
  await git(root, ["config", "user.name", "fixture"]);
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "a.ts"), "export const a = 1;\n", "utf8");
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-q", "-m", "fixture"]);

  const file = provenancePath(root, "gdgraph");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    JSON.stringify({ commit, branch: "deleted-branch", builtAt: "2026-09-02T22:45:41.347Z" }, null, 2) + "\n",
    "utf8",
  );
  return root;
}

describe("keryx sync with an unresolvable provenance commit", () => {
  test("says it cannot compare, and does not claim the layer is up to date", async () => {
    // A well-formed sha that is not an object in this repository — exactly what
    // a squash-merged, deleted branch leaves behind.
    const root = await repoWithProvenance("b99290b6451fb4d45b6bd68ebe3bf22f68f5751c");
    try {
      await withCwd(root, () => syncCommand([]));
      const output = logged.join("\n");

      expect(output).toContain("cannot compare");
      expect(output).toContain("b99290b6");
      expect(output).not.toContain("up to date (built at b99290b6)");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a resolvable baseline with no code changes still reports up to date", async () => {
    // The control. Without it, a version that printed "cannot compare"
    // unconditionally would satisfy the assertion above while destroying the
    // distinction the fix exists to draw.
    const root = await mkdtemp(path.join(tmpdir(), "keryx-sync-clean-"));
    try {
      await git(root, ["init", "-q"]);
      await git(root, ["config", "user.email", "fixture@example.invalid"]);
      await git(root, ["config", "user.name", "fixture"]);
      await mkdir(path.join(root, "src"), { recursive: true });
      await writeFile(path.join(root, "src", "a.ts"), "export const a = 1;\n", "utf8");
      await git(root, ["add", "-A"]);
      await git(root, ["commit", "-q", "-m", "fixture"]);

      const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root });
      const commit = head.stdout.toString().trim();

      const file = provenancePath(root, "gdgraph");
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(
        file,
        JSON.stringify({ commit, branch: "main", builtAt: "2026-09-05T00:00:00.000Z" }, null, 2) + "\n",
        "utf8",
      );

      await withCwd(root, () => syncCommand([]));
      const output = logged.join("\n");

      expect(output).toContain("up to date");
      expect(output).not.toContain("cannot compare");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
