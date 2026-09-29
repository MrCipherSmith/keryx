import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createManagedReviewPackage } from "../managed";
import { createFixturePort } from "../pr-comments";
import { computeBotMetrics, formatRatio, refreshPullStates, renderBotMetrics } from "./metrics";
import { emptyBotState, readBotState, writeBotState } from "./run";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const HEAD = "a".repeat(40);
const TREE = "const a = 1;\n";

function finding(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    reviewer: "review-bot",
    severity: "minor",
    problem: `problem ${id}`,
    impact: "impact",
    suggested_fix: "fix",
    evidence: "evidence",
    confidence: "medium",
    file: "src/a.ts",
    quote: "const a = 1;",
    ...overrides,
  };
}

async function newRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-bot-metrics-"));
  roots.push(root);
  return root;
}

async function seed(
  root: string,
  input: { pr: number; findings: unknown[]; head?: string; at?: string; repo?: string },
): Promise<{ reviewId: string; dir: string }> {
  const repo = input.repo ?? "acme/app";
  const packaged = await createManagedReviewPackage({
    cwd: root,
    mode: "ingest",
    target: { kind: "pr", ref: `https://github.com/${repo}/pull/${input.pr}`, repository: repo, base: "b".repeat(40), head: input.head ?? HEAD },
    reportText: "# Report",
    findings: input.findings as never,
    reviewers: ["review-bot"],
    readTreeFile: async () => TREE,
    resolveHead: async () => input.head ?? HEAD,
    now: new Date(input.at ?? "2026-09-29T10:00:00Z"),
  });
  return { reviewId: packaged.reviewId, dir: path.join(root, packaged.path) };
}

async function disposition(dir: string, id: string, state: string): Promise<void> {
  const file = path.join(dir, "findings.json");
  const findings = JSON.parse(await readFile(file, "utf8")) as Array<Record<string, unknown>>;
  for (const entry of findings) {
    if (entry.id === id) entry.disposition = { state, evidence: "recorded in the test" };
  }
  await writeFile(file, JSON.stringify(findings, null, 2));
}

async function touch(dir: string, updatedAt: string): Promise<void> {
  const file = path.join(dir, "manifest.json");
  const manifest = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  manifest.updatedAt = updatedAt;
  await writeFile(file, JSON.stringify(manifest, null, 2));
}

async function markMerged(root: string, pr: number, mergedAt: string | null): Promise<void> {
  const state = emptyBotState("acme/app", pr);
  state.pull = { state: mergedAt === null ? "open" : "closed", merged: mergedAt !== null, mergedAt, headSha: HEAD, checkedAt: mergedAt ?? "2026-09-29T10:00:00Z" };
  await writeBotState(root, state);
}

describe("formatRatio", () => {
  test("a ratio with no data prints n/a and never 0", () => {
    expect(formatRatio(null)).toBe("n/a");
    expect(formatRatio(0)).toBe("0%");
    expect(formatRatio(0.5)).toBe("50%");
  });
});

describe("computeBotMetrics", () => {
  test("no reviews at all: counts are zero and both ratios are null", async () => {
    const root = await newRoot();
    const metrics = await computeBotMetrics(root);
    expect(metrics.raised).toBe(0);
    expect(metrics.precision).toBeNull();
    expect(metrics.resolvedBeforeMerge.ratio).toBeNull();
    expect(renderBotMetrics(metrics)).toContain("n/a");
  });

  test("counts every disposition kind; a finding nobody dispositioned is still open", async () => {
    const root = await newRoot();
    const { dir } = await seed(root, {
      pr: 7,
      findings: [finding("F-001"), finding("F-002"), finding("F-003"), finding("F-004"), finding("F-005"), finding("F-006"), finding("F-007"), finding("F-008")],
    });
    await disposition(dir, "F-001", "acted-on");
    await disposition(dir, "F-002", "acted-on");
    await disposition(dir, "F-003", "dismissed-incorrect");
    await disposition(dir, "F-004", "dismissed-wont-fix");
    await disposition(dir, "F-005", "dismissed-out-of-scope");
    await disposition(dir, "F-006", "dismissed-deprioritised");
    await disposition(dir, "F-007", "answered-disagree");
    const metrics = await computeBotMetrics(root);
    expect(metrics.raised).toBe(8);
    expect(metrics.actedOn).toBe(2);
    expect(metrics.dismissed).toEqual({ incorrect: 1, wontFix: 1, outOfScope: 1, deprioritised: 1 });
    expect(metrics.answeredDisagree).toBe(1);
    expect(metrics.unknown).toBe(1);
    expect(metrics.open).toBe(1);
  });

  test("precision is acted-on over acted-on plus dismissed-incorrect; other dismissals do not count against it", async () => {
    const root = await newRoot();
    const { dir } = await seed(root, { pr: 7, findings: [finding("F-001"), finding("F-002"), finding("F-003"), finding("F-004"), finding("F-005")] });
    await disposition(dir, "F-001", "acted-on");
    await disposition(dir, "F-002", "acted-on");
    await disposition(dir, "F-003", "acted-on");
    await disposition(dir, "F-004", "dismissed-incorrect");
    await disposition(dir, "F-005", "dismissed-wont-fix");
    const metrics = await computeBotMetrics(root);
    expect(metrics.precision).toBeCloseTo(0.75, 5);
  });

  test("precision is null, not 0, when nothing was acted on or found incorrect", async () => {
    const root = await newRoot();
    const { dir } = await seed(root, { pr: 7, findings: [finding("F-001")] });
    await disposition(dir, "F-001", "dismissed-wont-fix");
    expect((await computeBotMetrics(root)).precision).toBeNull();
  });

  test("findings that came from somebody else's comment are not the bot's and are not counted", async () => {
    const root = await newRoot();
    await seed(root, {
      pr: 7,
      findings: [
        finding("F-001"),
        finding("F-002", {
          source: "external",
          external_ref: { id: "review-comment:1", author: "alice", url: "https://github.com/acme/app/pull/7#discussion_r1", submitted_at: "2026-09-29T09:00:00Z" },
        }),
      ],
    });
    expect((await computeBotMetrics(root)).raised).toBe(1);
  });

  test("resolved-before-merge: only merged pull requests count, and only outcomes recorded by the merge time", async () => {
    const root = await newRoot();
    const merged = await seed(root, { pr: 7, findings: [finding("F-001"), finding("F-002")], at: "2026-09-29T10:00:00Z" });
    await disposition(merged.dir, "F-001", "acted-on");
    await touch(merged.dir, "2026-09-29T12:00:00Z");
    await markMerged(root, 7, "2026-09-29T13:00:00Z");

    const late = await seed(root, { pr: 8, findings: [finding("F-001")], at: "2026-09-29T10:00:00Z" });
    await disposition(late.dir, "F-001", "acted-on");
    await touch(late.dir, "2026-09-30T09:00:00Z");
    await markMerged(root, 8, "2026-09-29T13:00:00Z");

    await seed(root, { pr: 9, findings: [finding("F-001")] });
    await markMerged(root, 9, null);

    const metrics = await computeBotMetrics(root);
    expect(metrics.resolvedBeforeMerge.total).toBe(3);
    expect(metrics.resolvedBeforeMerge.resolved).toBe(1);
    expect(metrics.resolvedBeforeMerge.ratio).toBeCloseTo(1 / 3, 5);
  });

  test("resolved-before-merge is null when no pull request is known to have merged", async () => {
    const root = await newRoot();
    await seed(root, { pr: 7, findings: [finding("F-001")] });
    const metrics = await computeBotMetrics(root);
    expect(metrics.resolvedBeforeMerge.total).toBe(0);
    expect(metrics.resolvedBeforeMerge.ratio).toBeNull();
    expect(renderBotMetrics(metrics)).toMatch(/Resolved before merge: n\/a/);
  });

  test("one row per review with its round number, head and dispositions", async () => {
    const root = await newRoot();
    const first = await seed(root, { pr: 7, findings: [finding("F-001")], at: "2026-09-29T10:00:00Z" });
    await disposition(first.dir, "F-001", "acted-on");
    await seed(root, { pr: 7, findings: [finding("F-001"), finding("F-002")], head: "c".repeat(40), at: "2026-09-29T11:00:00Z" });
    const metrics = await computeBotMetrics(root);
    expect(metrics.rows).toHaveLength(2);
    const rounds = metrics.rows.map((row) => [row.round, row.findings, row.actedOn, row.unknown]);
    expect(rounds).toContainEqual([1, 1, 1, 0]);
    expect(rounds).toContainEqual([2, 2, 0, 2]);
    expect(metrics.rows.find((row) => row.round === 2)?.head).toBe("c".repeat(40));
    expect(metrics.rows[0]?.pull).toBe("acme/app#7");
  });

  test("a package that is not for a pull request is ignored", async () => {
    const root = await newRoot();
    await createManagedReviewPackage({
      cwd: root,
      mode: "ingest",
      target: { kind: "branch", ref: "feature/x" },
      reportText: "# Report",
      findings: [finding("F-001")] as never,
      reviewers: ["review-bot"],
      readTreeFile: async () => TREE,
      resolveHead: async () => HEAD,
      now: new Date("2026-09-29T10:00:00Z"),
    });
    expect((await computeBotMetrics(root)).raised).toBe(0);
  });
});

describe("refreshPullStates", () => {
  test("records merge state read through the allowed pull request read", async () => {
    const root = await newRoot();
    await seed(root, { pr: 7, findings: [finding("F-001")] });
    const port = createFixturePort({
      pull: { state: "closed", merged_at: "2026-09-29T13:00:00Z", head: { sha: HEAD, repo: { full_name: "acme/app", id: 1 } }, base: { sha: "b".repeat(40), repo: { full_name: "acme/app", id: 1 } } },
    });
    const refreshed = await refreshPullStates(root, port, new Date("2026-09-29T14:00:00Z"));
    expect(refreshed).toEqual({ refreshed: 1, failed: [] });
    expect(port.posts).toEqual([]);
    expect((await readBotState(root, "acme/app", 7)).pull?.mergedAt).toBe("2026-09-29T13:00:00Z");
  });

  test("a read that fails is reported and leaves the stored state alone", async () => {
    const root = await newRoot();
    await seed(root, { pr: 7, findings: [finding("F-001")] });
    await markMerged(root, 7, "2026-09-29T13:00:00Z");
    const port = { request: async () => { throw new Error("offline"); } };
    const refreshed = await refreshPullStates(root, port as never, new Date("2026-09-29T14:00:00Z"));
    expect(refreshed.refreshed).toBe(0);
    expect(refreshed.failed[0]).toContain("acme/app#7");
    expect((await readBotState(root, "acme/app", 7)).pull?.mergedAt).toBe("2026-09-29T13:00:00Z");
  });
});
