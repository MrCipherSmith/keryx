import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  detectReviewLoop,
  findingIdentities,
  normalizeReviewOutput,
  readFlowReviewRounds,
  readTaskAttemptCount,
  renderLoopDetectionMarkdown,
  type ReviewRound,
} from "./loop";
import { createManagedReviewPackage } from "./managed";
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
// AC8/AC11 — an external comment is not a reviewer in a loop (flow 204)
//
// Comments are collected EVERY round and answered ONCE, after the final one, so
// an unanswered comment is re-collected and re-persisted every round by design.
// `dedupe_key: external:<comment id>` is stable across rounds on purpose, and it
// is the detector's first identity key — so before this was fixed, one
// outstanding comment made `keryx review loop` exit non-zero from round 2 of
// every flow and name the COMMENTER as the reviewer stuck in a loop.
// ---------------------------------------------------------------------------

/** One collected comment, in the shape `externalFindingsFromComments` produces. */
function externalFinding(overrides: Partial<StructuredReviewFinding> = {}): Partial<StructuredReviewFinding> {
  return {
    id: "EXT-001",
    reviewer: "coderabbitai[bot]",
    severity: "major",
    problem: "this helper is called before the guard runs",
    file: "src/loop.ts",
    source: "external",
    external_ref: {
      id: "prc-991",
      author: "coderabbitai[bot]",
      url: "https://github.com/x/y/pull/1#r991",
      submitted_at: "2026-08-30T09:00:00.000Z",
    },
    // Stable across rounds BY DESIGN — this is the key that used to escalate.
    dedupe_key: "external:prc-991",
    ...overrides,
  };
}

test("an unanswered PR comment collected in two rounds does NOT escalate", () => {
  const detection = detectReviewLoop({
    rounds: [round("r1", [externalFinding()]), round("r2", [externalFinding({ id: "EXT-004" })])],
  });

  expect(detection.escalate).toBe(false);
  expect(detection.signals).toHaveLength(0);
  expect(detection.externalFindingsExcluded).toBe(2);
  expect(detection.externalFindingsRecurring).toBe(1);
});

test("a reviewer repeating itself still escalates, alongside a recurring comment", () => {
  // Both directions in one round pair: the external one is held out, the
  // internal one is not, and the signal names the internal finding.
  const detection = detectReviewLoop({
    rounds: [
      round("r1", [externalFinding(), finding()]),
      round("r2", [externalFinding(), finding({ id: "F-007" })]),
    ],
  });

  expect(detection.escalate).toBe(true);
  expect(detection.signals).toHaveLength(1);
  expect(detection.signals[0]?.kind).toBe("repeated-finding");
  expect(detection.signals[0]?.key).not.toContain("external:");
  expect(detection.signals[0]?.detail).toContain("review-logic");
});

test("an external finding does not link a reviewer finding's identity to itself", () => {
  // Same file and line as the reviewer's finding, and a `global_id` shared with
  // nothing. Excluding it must happen BEFORE the identity union, or its keys
  // would merge into the reviewer group and take the reviewer's finding with it.
  const shared = { file: "src/loop.ts", problem: "unbounded loop in the fix round", reviewer: "review-logic" };
  const detection = detectReviewLoop({
    rounds: [
      round("r1", [externalFinding(shared), finding()]),
      round("r2", [externalFinding({ ...shared, id: "EXT-004" }), finding({ id: "F-007" })]),
    ],
  });

  expect(detection.signals).toHaveLength(1);
  expect(detection.signals[0]?.rounds).toEqual(["r1", "r2"]);
});

test("the record says the comments were held out rather than staying silent", () => {
  const markdown = renderLoopDetectionMarkdown(
    detectReviewLoop({ rounds: [round("r1", [externalFinding()]), round("r2", [externalFinding()])] }),
  );

  expect(markdown).toContain("external_findings_excluded: 2 (recurring across rounds: 1)");
  expect(markdown).toContain("collection");
  expect(markdown).toContain("escalate: no");
});

// ---------------------------------------------------------------------------
// Finding identity
// ---------------------------------------------------------------------------

/**
 * Identity is a SET, not a ranking.
 *
 * The ranking is what broke it: `global_id` outranked the content key, and
 * `assignGlobalIds` mints a fresh `<reviewId>#<id>` on every finding before it
 * is persisted — so the highest-ranked key was guaranteed to differ between any
 * two rounds, and the content key that would have matched was never consulted.
 */
test("every key a finding carries is an identity, not just the highest-ranked one", () => {
  const keys = findingIdentities(finding({ dedupe_key: "K1", global_id: "r1#F-001" }));

  expect(keys).toContain("dedupe:K1");
  expect(keys).toContain("global:r1#F-001");
  expect(keys.some((key) => key.startsWith("derived:"))).toBe(true);
});

test("a finding with nothing to compare contributes no derived key", () => {
  // `derived:?|?|?|?|` would make every contentless finding identical to every
  // other one, which is a detector that fires on nothing meaningful.
  expect(findingIdentities({ id: "F-001" })).toEqual([]);
  expect(findingIdentities({ id: "F-001", global_id: "r1#F-001" })).toEqual(["global:r1#F-001"]);
});

test("a finding whose global_id was minted fresh each round still matches on content", () => {
  const round1 = finding({ global_id: "2026-08-30-ingest-demo#F-001" });
  const round2 = finding({ global_id: "round-2#F-001" });

  expect(detectReviewLoop({ rounds: [round("r1", [round1]), round("r2", [round2])] }).escalate).toBe(true);
});

test("a global_id deliberately carried forward matches even when the wording changed", () => {
  // The other direction, and the reason `global_id` stays an identity at all: a
  // producer that carries round N's key is stating the finding is the same one,
  // and a reworded problem statement must not defeat that.
  const round1 = finding({ global_id: "r1#F-001", problem: "the variable `x` does not say what it holds" });
  const round2 = finding({ global_id: "r1#F-001", problem: "rename `x`", file: "src/other.ts" });

  expect(detectReviewLoop({ rounds: [round("r1", [round1]), round("r2", [round2])] }).escalate).toBe(true);
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

  expect(findingIdentities(a).some((key) => findingIdentities(b).includes(key))).toBe(false);
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

  expect(markdown).toContain("no repeated reviewer finding, and no identical consecutive output");
  expect(markdown).toContain("output_pairs_compared: 1 of 1");
});

/**
 * AC10 again, on the half that was still stating a negative it could not know:
 * `identical-output` needs BOTH rounds' `report.md`, and a package whose report
 * is missing or unreadable silently contributes nothing — while the record went
 * on saying "no identical consecutive output".
 */
test("AC10: a negative is not claimed for a comparison that never ran", () => {
  const markdown = renderLoopDetectionMarkdown(
    detectReviewLoop({
      rounds: [round("r1", [finding({ problem: "one" })]), round("r2", [finding({ problem: "two" })])],
    }),
  );

  expect(markdown).toContain("output_pairs_compared: 0 of 1");
  expect(markdown).not.toContain("no identical consecutive output");
  expect(markdown).toContain("no round pair could be compared");
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

// ---------------------------------------------------------------------------
// AC9 END TO END — through the writer, on the state the pipeline actually
// persists.
//
// Every test above this line builds its rounds by hand, and that is exactly how
// the defect shipped: `assignGlobalIds` mints `<reviewId>#<id>` on every finding
// before it reaches disk, and `defaultReviewId` is date-keyed, so two rounds of
// one branch on one day produced (a) two findings with different `global_id`s
// and (b) one directory. Neither is expressible in a hand-built fixture.
//
// These tests go through `createManagedReviewPackage` twice. Nothing below
// constructs a round object.
// ---------------------------------------------------------------------------

const PERSISTED_FINDING: StructuredReviewFinding = {
  id: "F-001",
  reviewer: "review-style",
  severity: "minor",
  problem: "the variable `x` does not say what it holds",
  impact: "the next reader has to re-derive the meaning",
  suggested_fix: "rename it to `pendingRounds`",
  evidence: "src/thing.ts:12",
  confidence: "high",
};

async function ingestRound(cwd: string, at: string, summary: string): Promise<string> {
  const result = await createManagedReviewPackage({
    cwd,
    mode: "ingest",
    // NO reviewId. The documented invocation never passes `--review-id`, and the
    // round-collapsing half of the defect lived entirely in that default.
    flowId: "203",
    target: { kind: "branch", ref: "flow/203-unify-and-bound" },
    reportText: `# Review round\n\nSummary: ${summary}\n\n- [F-001] minor: the variable \`x\` does not say what it holds\n`,
    findings: [PERSISTED_FINDING],
    now: new Date(at),
  });
  return result.reviewId;
}

test("AC9 end-to-end: two ingested rounds of one branch on one day escalate", async () => {
  const { cwd } = await fixtureFlow();

  // Same day, same branch, and one changed word in the Summary — the shape that
  // defeated `identical-output` while `repeated-finding` could not fire either.
  const first = await ingestRound(cwd, "2026-08-30T09:00:00.000Z", "the fix did not land");
  const second = await ingestRound(cwd, "2026-08-30T10:00:00.000Z", "the fix still did not land");

  // (b): two rounds, two packages. The second must not have overwritten the first.
  expect(second).not.toBe(first);
  const rounds = await readFlowReviewRounds(cwd, "203");
  expect(rounds).toHaveLength(2);
  expect(rounds.map((item) => item.label)).toEqual([first, second]);

  // (a): the same finding, minted under two different reviewIds, is still the
  // same finding.
  const detection = detectReviewLoop({ rounds });
  expect(detection.escalate).toBe(true);
  expect(detection.signals.map((signal) => signal.kind)).toContain("repeated-finding");
  expect(detection.roundsSeen).toBe(2);
});

test("AC9 end-to-end: an explicit --review-id still owns its directory", async () => {
  // The discriminator is for the DEFAULT id only. A caller that names the id is
  // stating the identity of the round, and re-ingesting under that name is a
  // deliberate replacement — the retry path.
  const { cwd } = await fixtureFlow();

  const first = await createManagedReviewPackage({
    cwd,
    mode: "ingest",
    reviewId: "named-round",
    flowId: "203",
    target: { kind: "branch", ref: "flow/203-unify-and-bound" },
    reportText: "# Review round\n\nfirst\n",
    findings: [PERSISTED_FINDING],
    now: new Date("2026-08-30T09:00:00.000Z"),
  });
  const second = await createManagedReviewPackage({
    cwd,
    mode: "ingest",
    reviewId: "named-round",
    flowId: "203",
    target: { kind: "branch", ref: "flow/203-unify-and-bound" },
    reportText: "# Review round\n\nsecond\n",
    findings: [PERSISTED_FINDING],
    now: new Date("2026-08-30T10:00:00.000Z"),
  });

  expect(second.reviewId).toBe(first.reviewId);
  expect(await readFlowReviewRounds(cwd, "203")).toHaveLength(1);
});
