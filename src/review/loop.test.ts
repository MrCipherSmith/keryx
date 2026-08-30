import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  detectReviewLoop,
  findingIdentity,
  normalizeReviewOutput,
  readFlowReviewRounds,
  readTaskAttemptCount,
  renderLoopDetectionMarkdown,
  type ReviewRound,
} from "./loop";
import type { StructuredReviewFinding } from "./types";

function finding(overrides: Partial<StructuredReviewFinding> = {}): Partial<StructuredReviewFinding> {
  return {
    id: "F-001",
    reviewer: "review-logic",
    severity: "major",
    problem: "unbounded loop in the fix round",
    file: "src/loop.ts",
    ...overrides,
  };
}

function round(label: string, findings: Array<Partial<StructuredReviewFinding>>, output?: string): ReviewRound {
  return { label, findings, ...(output === undefined ? {} : { output }) };
}

// ---------------------------------------------------------------------------
// AC9 — detection, not counting
// ---------------------------------------------------------------------------

/**
 * The criterion literally: the same finding twice escalates.
 *
 * Fails without detection — a counter over two rounds against a bound of three
 * reports "budget remaining" and keeps going.
 */
test("AC9: the same finding recurring in two rounds escalates", () => {
  const detection = detectReviewLoop({
    rounds: [round("r1", [finding()]), round("r2", [finding({ id: "F-007" })])],
  });

  expect(detection.escalate).toBe(true);
  expect(detection.signals).toHaveLength(1);
  expect(detection.signals[0]?.kind).toBe("repeated-finding");
  expect(detection.signals[0]?.rounds).toEqual(["r1", "r2"]);
});

test("AC9: escalation does not consult the remaining budget", () => {
  // Two rounds against a bound of three: a counter has a round left. The
  // detector has no budget parameter at all, which is the point.
  const detection = detectReviewLoop({
    rounds: [round("r1", [finding()]), round("r2", [finding()])],
    attempts: 2,
  });

  expect(detection.escalate).toBe(true);
  expect(detection.attempts).toBe(2);
});

test("AC9: two consecutive rounds with identical output escalate", () => {
  const report = "# Review\n\n- F-001 unbounded loop\n";
  const detection = detectReviewLoop({
    rounds: [round("r1", [], report), round("r2", [], `${report}   \n\n\n`)],
  });

  expect(detection.escalate).toBe(true);
  expect(detection.signals[0]?.kind).toBe("identical-output");
});

test("AC9: identical output must be CONSECUTIVE", () => {
  const same = "# Review\n\n- F-001\n";
  const detection = detectReviewLoop({
    rounds: [round("r1", [], same), round("r2", [], "# Review\n\n- F-002\n"), round("r3", [], same)],
  });

  expect(detection.signals.filter((signal) => signal.kind === "identical-output")).toHaveLength(0);
});

test("AC9: a differing timestamp is not a change", () => {
  const detection = detectReviewLoop({
    rounds: [
      round("r1", [], "created_at: 2026-08-30T04:00:00.000Z\n- F-001\n"),
      round("r2", [], "created_at: 2026-08-30T05:11:22.000Z\n- F-001\n"),
    ],
  });

  expect(detection.signals.some((signal) => signal.kind === "identical-output")).toBe(true);
});

test("AC9: two empty outputs are not an identical-output signal", () => {
  const detection = detectReviewLoop({ rounds: [round("r1", [], "   \n"), round("r2", [], "\n\n")] });

  expect(detection.escalate).toBe(false);
});

test("AC9: distinct findings across rounds do not escalate", () => {
  const detection = detectReviewLoop({
    rounds: [
      round("r1", [finding({ problem: "one", file: "a.ts" })], "a"),
      round("r2", [finding({ problem: "two", file: "b.ts" })], "b"),
    ],
  });

  expect(detection.escalate).toBe(false);
  expect(detection.signals).toHaveLength(0);
});

test("AC9: a finding repeated WITHIN one round is a deduplication problem, not a loop", () => {
  const detection = detectReviewLoop({ rounds: [round("r1", [finding(), finding()])] });

  expect(detection.escalate).toBe(false);
});

// ---------------------------------------------------------------------------
// Finding identity
// ---------------------------------------------------------------------------

test("dedupe_key wins, then global_id, then the derived content key", () => {
  expect(findingIdentity(finding({ dedupe_key: "K1", global_id: "r1#F-001" }))).toBe("dedupe:K1");
  expect(findingIdentity(finding({ global_id: "r1#F-001" }))).toBe("global:r1#F-001");
  expect(findingIdentity(finding())).toStartWith("derived:");
});

/**
 * The reason `id` is not an identity: `F-001` denotes a different finding in
 * every round of every review in the corpus, so keying on it would escalate on
 * the second round of every flow whatever happened. A detector that always fires
 * gets turned off.
 */
test("the display id alone never makes two findings the same", () => {
  const a = finding({ id: "F-001", problem: "one", file: "a.ts" });
  const b = finding({ id: "F-001", problem: "two", file: "b.ts" });

  expect(findingIdentity(a)).not.toBe(findingIdentity(b));
  expect(detectReviewLoop({ rounds: [round("r1", [a]), round("r2", [b])] }).escalate).toBe(false);
});

test("normalizeReviewOutput strips trailing whitespace, blank runs and timestamps", () => {
  expect(normalizeReviewOutput("a   \n\n\n\nb\n")).toBe("a\n\nb");
  expect(normalizeReviewOutput("at 2026-08-30T04:00:00.000Z")).toBe("at <timestamp>");
});

// ---------------------------------------------------------------------------
// AC10 — the detector records what it saw
// ---------------------------------------------------------------------------

test("AC10: the record names the signal, the rounds and why", () => {
  const detection = detectReviewLoop({
    rounds: [round("r1", [finding()]), round("r2", [finding()])],
    attempts: 2,
  });
  const markdown = renderLoopDetectionMarkdown(detection);

  expect(markdown).toContain("## Loop detection");
  expect(markdown).toContain("escalate: yes");
  expect(markdown).toContain("attempts_recorded: 2");
  expect(markdown).toContain("repeated-finding");
  expect(markdown).toContain("r1 -> r2");
  expect(markdown).toContain("The remaining round budget was not consulted");
});

test("AC10: an unlooked-up attempt count renders `not recorded`, not 0", () => {
  const markdown = renderLoopDetectionMarkdown(detectReviewLoop({ rounds: [] }));

  expect(markdown).toContain("attempts_recorded: not recorded");
  expect(markdown).not.toContain("attempts_recorded: 0");
});

test("AC10: fewer than two rounds says so rather than claiming `no loop`", () => {
  const markdown = renderLoopDetectionMarkdown(detectReviewLoop({ rounds: [round("r1", [finding()])] }));

  expect(markdown).toContain("repetition cannot be observed yet. This is not `no loop`");
});

test("AC10: two clean rounds are reported as observed, not as unobserved", () => {
  const markdown = renderLoopDetectionMarkdown(
    detectReviewLoop({
      rounds: [round("r1", [finding({ problem: "one" })], "a"), round("r2", [finding({ problem: "two" })], "b")],
    }),
  );

  expect(markdown).toContain("no repeated finding and no identical consecutive output");
});

// ---------------------------------------------------------------------------
// Reading REAL persisted state (flow 201's attempt counter, packages on disk)
// ---------------------------------------------------------------------------

async function fixtureFlow(): Promise<{ cwd: string; flowDir: string }> {
  const cwd = await mkdtemp(path.join(tmpdir(), "keryx-loop-"));
  const flowDir = "203-2026-08-30-loop-fixture";
  const root = path.join(cwd, ".metaproject", "flows", flowDir);
  await mkdir(root, { recursive: true });
  await writeFile(
    path.join(root, "flow.json"),
    JSON.stringify({
      schemaVersion: 2,
      id: "203",
      slug: "loop-fixture",
      title: "loop fixture",
      status: "in-progress",
      createdAt: "2026-08-30T00:00:00.000Z",
      updatedAt: "2026-08-30T00:00:00.000Z",
      source: { type: "description", ref: null },
      acChecksum: null,
      acConfirmed: {},
      pr: { url: null },
      tasks: [{ id: "T1", title: "fix", kind: "implement", status: "todo", attempts: { count: 5, log: [] } }],
      history: [],
    }),
  );
  return { cwd, flowDir };
}

async function writeRound(
  cwd: string,
  flowDir: string,
  reviewId: string,
  createdAt: string,
  findings: Array<Partial<StructuredReviewFinding>>,
  report: string,
): Promise<void> {
  const dir = path.join(cwd, ".metaproject", "flows", flowDir, "reviews", reviewId);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "manifest.json"), JSON.stringify({ reviewId, createdAt }));
  await writeFile(path.join(dir, "findings.json"), JSON.stringify(findings));
  await writeFile(path.join(dir, "report.md"), report);
}

test("AC9: rounds are read from the packages on disk, oldest first", async () => {
  const { cwd, flowDir } = await fixtureFlow();
  await writeRound(cwd, flowDir, "round-b", "2026-08-30T02:00:00.000Z", [finding()], "second");
  await writeRound(cwd, flowDir, "round-a", "2026-08-30T01:00:00.000Z", [finding()], "first");

  const rounds = await readFlowReviewRounds(cwd, "203");

  expect(rounds.map((item) => item.label)).toEqual(["round-a", "round-b"]);
  expect(detectReviewLoop({ rounds }).escalate).toBe(true);
});

/**
 * The state that survives a session restart. A resumed orchestrator's own
 * context starts at zero while `attempts.count` does not, which is why flow 201
 * put it in `flow.json`.
 */
test("AC9: the attempt count is read from flow.json, not from a session", async () => {
  const { cwd } = await fixtureFlow();

  expect(await readTaskAttemptCount(cwd, "203", "T1")).toBe(5);
  expect(await readTaskAttemptCount(cwd, "203", "T9")).toBeUndefined();
});

test("a flow with no reviews directory yields no rounds rather than throwing", async () => {
  const { cwd } = await fixtureFlow();

  expect(await readFlowReviewRounds(cwd, "203")).toEqual([]);
});
