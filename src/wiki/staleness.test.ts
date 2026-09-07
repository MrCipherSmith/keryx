import { execFileSync } from "node:child_process";
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { GraphData } from "../gdgraph/types";
import { recordProvenance } from "../sync/provenance";
import {
  computePageNodeHash,
  isPageUnchangedSinceLastEnrich,
  resolveWikiSourceGate,
} from "./staleness";

async function tempRepo(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "gd-wiki-staleness-"));
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

// AFC-10 (flow 234, phase 2) / AFC-08 (flow 236 T8): the wiki-side gate runs
// real `git` commands through `checkGraphStaleness` (`gdgraph/staleness.ts`)
// and — per the frozen AC3 criterion — treats ANY git failure as `"unknown"`,
// never as `"fresh"`. A bare temp directory with a hand-written `.git/HEAD`
// file (the old fixture below `tempRepo()`) is not a real repository: `git
// rev-parse HEAD` genuinely fails against it. `makeBuiltFixture()` instead
// builds a REAL repo with a real commit and matching build provenance,
// mirroring `gdgraph/staleness.test.ts`, so the "graph built at HEAD" /
// "HEAD moved past the build" conditions these tests name are genuinely true.
//
// These two tests previously exercised `checkPageStalenessGate`, which flow
// 236's inventory measured as having zero non-test callers — a capability whose
// only remaining proof of life was this file. It has been replaced by
// `resolveWikiSourceGate`, which `refreshPages`, `verifyPages` and `wikiCollect`
// actually call; the fixtures are unchanged so the same two conditions are
// still demonstrated, now against something the product uses.
async function makeBuiltFixture(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "gd-wiki-staleness-built-"));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@test.com"]);
  git(dir, ["config", "user.name", "test"]);
  await mkdir(path.join(dir, "src"), { recursive: true });
  await mkdir(path.join(dir, ".metaproject", "data", "gdgraph", "storage"), { recursive: true });
  await writeFile(path.join(dir, "src", "a.ts"), "export const a = 1;\n");
  await writeFile(
    path.join(dir, ".metaproject", "data", "gdgraph", "storage", "nodes.jsonl"),
    '{"id":"src/a.ts","kind":"file","path":"src/a.ts","language":"typescript"}\n',
  );
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "initial build fixture"]);
  // Record provenance AFTER the commit exists — `recordProvenance` reads
  // `git rev-parse HEAD`, which fails (and silently no-ops) with zero commits.
  await recordProvenance(dir, "gdgraph", new Date().toISOString());
  return dir;
}

function fixtureGraph(): GraphData {
  return {
    nodes: [
      { id: "src/a.ts", kind: "file", path: "src/a.ts", language: "typescript" },
      { id: "src/b.ts", kind: "file", path: "src/b.ts", language: "typescript" },
    ],
    edges: [],
  };
}

test("T5/computePageNodeHash — deterministic: same inputs produce the same hash", async () => {
  const cwd = await tempRepo();
  try {
    await mkdir(path.join(cwd, "src"), { recursive: true });
    await writeFile(path.join(cwd, "src/a.ts"), "export const a = 1;\n", "utf8");
    await writeFile(path.join(cwd, "src/b.ts"), "export const b = 2;\n", "utf8");

    const graph = fixtureGraph();
    const first = await computePageNodeHash(cwd, ["src/a.ts", "src/b.ts"], graph);
    const second = await computePageNodeHash(cwd, ["src/a.ts", "src/b.ts"], graph);
    expect(first).toBe(second);

    // Order of `keyFiles` must not matter — only content/membership.
    const reordered = await computePageNodeHash(cwd, ["src/b.ts", "src/a.ts"], graph);
    expect(reordered).toBe(first);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("T5/computePageNodeHash — changes when a key file's content changes", async () => {
  const cwd = await tempRepo();
  try {
    await mkdir(path.join(cwd, "src"), { recursive: true });
    await writeFile(path.join(cwd, "src/a.ts"), "export const a = 1;\n", "utf8");
    await writeFile(path.join(cwd, "src/b.ts"), "export const b = 2;\n", "utf8");

    const graph = fixtureGraph();
    const before = await computePageNodeHash(cwd, ["src/a.ts", "src/b.ts"], graph);

    await writeFile(path.join(cwd, "src/a.ts"), "export const a = 999;\n", "utf8");
    const after = await computePageNodeHash(cwd, ["src/a.ts", "src/b.ts"], graph);

    expect(after).not.toBe(before);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("T5/computePageNodeHash — a key file that is not a graph node hashes as a stable sentinel, not a crash", async () => {
  const cwd = await tempRepo();
  try {
    await mkdir(path.join(cwd, "src"), { recursive: true });
    await writeFile(path.join(cwd, "src/a.ts"), "export const a = 1;\n", "utf8");

    const graph = fixtureGraph(); // knows src/a.ts and src/b.ts, not src/missing.ts
    const withUnknown = await computePageNodeHash(cwd, ["src/a.ts", "src/missing.ts"], graph);
    const withoutUnknown = await computePageNodeHash(cwd, ["src/a.ts"], graph);
    expect(withUnknown).not.toBe(withoutUnknown);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("T5/isPageUnchangedSinceLastEnrich — true only when a hash is recorded and equal", () => {
  const recorded = { "components/alpha.md": "abc123" };
  expect(isPageUnchangedSinceLastEnrich("components/alpha.md", "abc123", recorded)).toBe(true);
  expect(isPageUnchangedSinceLastEnrich("components/alpha.md", "different", recorded)).toBe(false);
  expect(isPageUnchangedSinceLastEnrich("components/beta.md", "abc123", recorded)).toBe(false);
  expect(isPageUnchangedSinceLastEnrich("components/alpha.md", "abc123", undefined)).toBe(false);
});

test("T8/resolveWikiSourceGate — a graph built at HEAD may stamp that head", async () => {
  const cwd = await makeBuiltFixture();
  try {
    // Nothing has moved since `makeBuiltFixture()` committed and recorded
    // provenance for that same commit ⇒ the source saw this revision ⇒ a
    // generator may stamp it.
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
    const gate = await resolveWikiSourceGate(cwd, head);
    expect(gate.status).toBe("fresh");
    expect(gate.stampableHead).toBe(head);
    expect(gate.preserveGenerated).toBe(false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("T8/resolveWikiSourceGate — a head the graph never saw is not stampable", async () => {
  const cwd = await makeBuiltFixture();
  try {
    // A new commit lands after the graph was built ⇒ HEAD has moved past the
    // commit recorded in build provenance ⇒ the source is stale, and the new
    // head must not be stamped as if the source had read it.
    await writeFile(path.join(cwd, "src", "b.ts"), "export const b = 1;\n");
    git(cwd, ["add", "-A"]);
    git(cwd, ["commit", "-q", "-m", "a new commit after the graph was built"]);

    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
    const gate = await resolveWikiSourceGate(cwd, head);
    expect(gate.status).toBe("stale");
    expect(gate.stampableHead).toBeNull();
    // Stale is not an error: the block may still be regenerated.
    expect(gate.preserveGenerated).toBe(false);
    expect(gate.reasons.join(" ")).toContain("HEAD moved");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("T8/resolveWikiSourceGate — a git failure is unknown, and preserves only when a head exists", async () => {
  const broken = async () => ({ status: "unknown" as const, reasons: ["git status failed"] });

  // A project with no git at all: `unknown` is the expected steady state and
  // there is no revision to over-claim, so generation proceeds as before.
  const noGit = await resolveWikiSourceGate("/nonexistent", undefined, broken);
  expect(noGit.status).toBe("unknown");
  expect(noGit.stampableHead).toBeNull();
  expect(noGit.preserveGenerated).toBe(false);

  // A head that resolves while the staleness check's git calls fail is a
  // genuinely broken repository — preserve the existing block.
  const partial = await resolveWikiSourceGate("/nonexistent", "f".repeat(40), broken);
  expect(partial.preserveGenerated).toBe(true);
  expect(partial.stampableHead).toBeNull();
});
