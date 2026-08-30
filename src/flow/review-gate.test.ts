// Flow 204 — the review gate (AC5, AC6, AC7 / specification §2, AC-C1..AC-C6).
//
// Every one of the five conditions has a test that FAILS WITHOUT IT: each one is
// exercised from a package that satisfies the other four, so a passing assertion
// names exactly one mechanism. That matters more here than usual, because the
// property under test is "the gate does not pass on absence" — and a suite whose
// fixtures are absent in several ways at once cannot tell which absence was
// caught.
//
// The stale-SHA case is exercised twice: once as a mismatch (the round ran, at
// the wrong commit) and once as an unknown head (nothing said which commit the
// PR is at). They are different failures with different fixes and the gate must
// not collapse them.
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFlowService } from "./service";
import {
  EXTERNAL_COMMENT_COVERAGE_REVIEWERS,
  REVIEW_GATE_CONFIG_PATH,
  REVIEW_ROUND_CAP,
  blocksAtFloor,
  findingVerdict,
  latestFindingStates,
  parseVerificationStats,
  readReviewGateConfig,
  readReviewRounds,
  shaMatches,
  type GateFinding,
} from "./review-gate";
import { writeCleanReviewPackage, writeReviewPackage, type ReviewFixtureFinding } from "./review-fixtures";
import type { FlowService, FlowServiceDeps, FlowState, GateOutcome, TrackerAdapter } from "./types";

const PR_URL = "https://github.com/acme/app/pull/7";
const HEAD = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const STALE = "0f1e2d3c4b5a69788796a5b4c3d2e1f098765432";

let ROOT = "";

function fakeTracker(over: { headSha?: string | null } = {}): TrackerAdapter {
  return {
    id: "fake",
    detect: async () => true,
    parseRef: () => null,
    fetchIssue: async () => ({ title: "Issue title", body: "body" }),
    prStatus: async () => ({
      exists: true,
      isDraft: true,
      checksGreen: true,
      headSha: over.headSha === undefined ? HEAD : over.headSha,
    }),
    comment: async () => true,
  };
}

function makeDeps(over: Partial<FlowServiceDeps> = {}): FlowServiceDeps {
  return {
    tracker: fakeTracker(),
    healthGate: async () => ({ status: "pass", reasons: [] }),
    now: () => new Date("2026-08-30T10:00:00Z"),
    ...over,
  };
}

async function fresh(): Promise<void> {
  if (ROOT) {
    await rm(ROOT, { recursive: true, force: true });
  }
  ROOT = await mkdtemp(path.join(tmpdir(), "keryx-review-gate-"));
  await mkdir(path.join(ROOT, ".metaproject"), { recursive: true });
}

afterEach(async () => {
  if (ROOT) {
    await rm(ROOT, { recursive: true, force: true });
    ROOT = "";
  }
});

async function writeAc(dir: string, criteria: string[]): Promise<void> {
  await writeFile(
    path.join(ROOT, ".metaproject", "flows", dir, "acceptance-criteria.md"),
    `# Acceptance Criteria\n\n## Criteria\n\n${criteria.map((c, i) => `- AC${i + 1}: ${c}`).join("\n")}\n`,
    "utf8",
  );
}

/** A flow standing at the point where `complete()` runs its gates. */
async function driveToGates(service: FlowService): Promise<{ id: string; dir: string }> {
  const { flow, dir: created } = await service.init({ cwd: ROOT, title: "Review gate subject" });
  const dir = path.basename(created);
  await writeAc(dir, ["Only criterion"]);
  await service.freeze({ cwd: ROOT, id: flow.id });
  await service.start({ cwd: ROOT, id: flow.id });
  await service.implemented({ cwd: ROOT, id: flow.id, prUrl: PR_URL });
  await service.acConfirm({ cwd: ROOT, id: flow.id, criterion: "AC1" });
  for (const taskId of ["T1", "T2", "T3", "T4"]) {
    await service.taskDone({ cwd: ROOT, id: flow.id, taskId });
  }
  return { id: flow.id, dir };
}

function reviewOf(gates: GateOutcome[]): GateOutcome {
  const gate = gates.find((entry) => entry.name === "review");
  if (gate === undefined) {
    throw new Error(`no review gate in: ${gates.map((entry) => entry.name).join(", ")}`);
  }
  return gate;
}

/** A finding that is terminal in the `fixed` sense — SHA plus a matching refutation. */
function fixedFinding(id: string, sha = HEAD): ReviewFixtureFinding {
  return {
    id,
    severity: "major",
    disposition: { state: "acted-on", evidence: `fixed in ${sha}` },
    verification: {
      verdict: "refuted",
      method: "execution",
      evidence: `bun test src/x.test.ts at ${sha}: the assertion no longer fails`,
      verifier: "review-verifier",
    },
  };
}

// --- AC5 condition 1: an ingested round must exist --------------------------

test("AC5/1 — a flow with no review package at all fails the gate", async () => {
  await fresh();
  const service = createFlowService(makeDeps());
  const { id } = await driveToGates(service);

  const result = await service.complete({ cwd: ROOT, id });

  expect(result.passed).toBe(false);
  expect(result.flow.status).toBe("in-progress");
  const gate = reviewOf(result.gates);
  expect(gate.status).toBe("fail");
  expect(gate.detail).toContain("ingested-round (unobserved)");
  expect(gate.detail).toContain("no managed review package exists");
});

test("AC5/1 — a package missing findings.json is not ingested and cannot be cited", async () => {
  await fresh();
  const service = createFlowService(makeDeps());
  const { id, dir } = await driveToGates(service);
  await writeReviewPackage({ cwd: ROOT, flowDir: dir, reviewId: "round-1", head: HEAD, omitFindings: true });

  const gate = reviewOf((await service.complete({ cwd: ROOT, id })).gates);

  expect(gate.status).toBe("fail");
  expect(gate.detail).toContain("ingested-round (unobserved)");
  expect(gate.detail).toContain("findings.json is missing");
  expect(gate.detail).toContain("cannot be cited");
});

test("AC5/1 — the same flow passes once a clean round is ingested", async () => {
  await fresh();
  const service = createFlowService(makeDeps());
  const { id, dir } = await driveToGates(service);
  await writeCleanReviewPackage({ cwd: ROOT, flowDir: dir, head: HEAD });

  const result = await service.complete({ cwd: ROOT, id });

  expect(reviewOf(result.gates).status).toBe("pass");
  expect(result.passed).toBe(true);
  expect(result.flow.status).toBe("done");
});

// --- AC5 condition 2 / AC-C1: non-terminal findings at or above the floor ----

test("AC-C1 — a major finding with no disposition fails, and is named", async () => {
  await fresh();
  const service = createFlowService(makeDeps());
  const { id, dir } = await driveToGates(service);
  await writeReviewPackage({
    cwd: ROOT,
    flowDir: dir,
    reviewId: "round-1",
    head: HEAD,
    coverage: [{ reviewer: "external-comments", status: "run", reason: "collected" }],
    findings: [{ id: "F-001", severity: "major", problem: "unchecked index" }],
  });

  const gate = reviewOf((await service.complete({ cwd: ROOT, id })).gates);

  expect(gate.status).toBe("fail");
  expect(gate.detail).toContain("terminal-dispositions (violated)");
  expect(gate.detail).toContain("F-001");
  expect(gate.detail).toContain("no disposition recorded");
  // Never a bare "review gate: fail".
  expect(gate.detail).toContain("of 5 conditions failed");
});

test("AC5/2 — an `info` finding never blocks, whatever its disposition", async () => {
  await fresh();
  const service = createFlowService(makeDeps());
  const { id, dir } = await driveToGates(service);
  await writeReviewPackage({
    cwd: ROOT,
    flowDir: dir,
    reviewId: "round-1",
    head: HEAD,
    coverage: [{ reviewer: "external-comments", status: "run", reason: "collected" }],
    findings: [{ id: "F-001", severity: "info", problem: "a naming nit" }],
  });

  expect(reviewOf((await service.complete({ cwd: ROOT, id })).gates).status).toBe("pass");
});

test("AC5/2 — the floor is configurable: `major` lets an undispositioned minor through", async () => {
  await fresh();
  const service = createFlowService(makeDeps());
  const { id, dir } = await driveToGates(service);
  await writeFile(
    path.join(ROOT, REVIEW_GATE_CONFIG_PATH),
    `${JSON.stringify({ completion: { severity_floor: "major" } }, null, 2)}\n`,
    "utf8",
  );
  await writeReviewPackage({
    cwd: ROOT,
    flowDir: dir,
    reviewId: "round-1",
    head: HEAD,
    coverage: [{ reviewer: "external-comments", status: "run", reason: "collected" }],
    findings: [{ id: "F-001", severity: "minor", problem: "a minor thing" }],
  });

  expect(reviewOf((await service.complete({ cwd: ROOT, id })).gates).status).toBe("pass");
});

// --- AC6: "clean" is positive, per finding ----------------------------------

test("AC6 — a finding vanishing from round 2 is NOT evidence it was fixed", async () => {
  await fresh();
  const service = createFlowService(makeDeps());
  const { id, dir } = await driveToGates(service);
  // Round 1 raises a blocker. Round 2 is silent about it and is otherwise clean.
  await writeReviewPackage({
    cwd: ROOT,
    flowDir: dir,
    reviewId: "round-1",
    createdAt: "2026-08-29T10:00:00.000Z",
    head: HEAD,
    coverage: [{ reviewer: "external-comments", status: "run", reason: "collected" }],
    findings: [
      { id: "F-001", severity: "blocker", problem: "off-by-one in the cap", file: "src/a.ts", dedupe_key: "cap-off-by-one" },
    ],
  });
  await writeReviewPackage({
    cwd: ROOT,
    flowDir: dir,
    reviewId: "round-2",
    createdAt: "2026-08-29T12:00:00.000Z",
    head: HEAD,
    coverage: [{ reviewer: "external-comments", status: "run", reason: "collected" }],
    findings: [],
  });

  const gate = reviewOf((await service.complete({ cwd: ROOT, id })).gates);

  expect(gate.status).toBe("fail");
  expect(gate.detail).toContain("terminal-dispositions (violated)");
  expect(gate.detail).toContain("F-001");
});

test("AC6 — the same finding clears once round 2 records a disposition with its evidence", async () => {
  await fresh();
  const service = createFlowService(makeDeps());
  const { id, dir } = await driveToGates(service);
  await writeReviewPackage({
    cwd: ROOT,
    flowDir: dir,
    reviewId: "round-1",
    createdAt: "2026-08-29T10:00:00.000Z",
    head: HEAD,
    coverage: [{ reviewer: "external-comments", status: "run", reason: "collected" }],
    findings: [
      { id: "F-001", severity: "blocker", problem: "off-by-one in the cap", file: "src/a.ts", dedupe_key: "cap-off-by-one" },
    ],
  });
  await writeReviewPackage({
    cwd: ROOT,
    flowDir: dir,
    reviewId: "round-2",
    createdAt: "2026-08-29T12:00:00.000Z",
    head: HEAD,
    coverage: [{ reviewer: "external-comments", status: "run", reason: "collected" }],
    findings: [
      {
        ...fixedFinding("F-001"),
        severity: "blocker",
        problem: "off-by-one in the cap",
        file: "src/a.ts",
        dedupe_key: "cap-off-by-one",
      },
    ],
  });

  expect(reviewOf((await service.complete({ cwd: ROOT, id })).gates).status).toBe("pass");
});

test("AC-C3 — `fixed` without a verifier verdict against the fixing commit is rejected", () => {
  const noVerification: GateFinding = {
    id: "F-1",
    severity: "major",
    disposition: { state: "acted-on", evidence: `fixed in ${HEAD}` },
    round: "round-1",
  };
  expect(findingVerdict(noVerification)).toEqual({
    terminal: false,
    reason: expect.stringContaining("no verifier verdict of `refuted`") as unknown as string,
  });

  const noSha: GateFinding = {
    id: "F-2",
    severity: "major",
    disposition: { state: "acted-on", evidence: "fixed it" },
    verification: { verdict: "refuted", method: "execution", evidence: "test passes" },
    round: "round-1",
  };
  expect(findingVerdict(noSha).terminal).toBe(false);
  expect((findingVerdict(noSha) as { reason: string }).reason).toContain("names no commit SHA");

  // Verified — but against a DIFFERENT tree. The one the specification calls out.
  const wrongSha: GateFinding = {
    id: "F-3",
    severity: "major",
    disposition: { state: "acted-on", evidence: `fixed in ${HEAD}` },
    verification: { verdict: "refuted", method: "execution", evidence: `re-ran at ${STALE}` },
    round: "round-1",
  };
  expect(findingVerdict(wrongSha).terminal).toBe(false);
  expect((findingVerdict(wrongSha) as { reason: string }).reason).toContain("does not cite that commit");

  // The abbreviated form of the same commit is the same commit.
  const abbreviated: GateFinding = {
    id: "F-4",
    severity: "major",
    disposition: { state: "acted-on", evidence: `fixed in ${HEAD.slice(0, 8)}` },
    verification: { verdict: "refuted", method: "execution", evidence: `re-ran at ${HEAD}: gone` },
    round: "round-1",
  };
  expect(findingVerdict(abbreviated)).toEqual({ terminal: true, kind: "fixed" });
});

test("AC6 — `refuted` requires a verifier verdict with a method and evidence", () => {
  const asserted: GateFinding = {
    id: "F-1",
    severity: "major",
    disposition: { state: "dismissed-incorrect", evidence: "it was never real" },
    round: "round-1",
  };
  expect(findingVerdict(asserted).terminal).toBe(false);
  expect((findingVerdict(asserted) as { reason: string }).reason).toContain("no verifier `refuted` verdict");

  const verified: GateFinding = {
    ...asserted,
    verification: { verdict: "refuted", method: "site-check", evidence: "src/a.ts:41 does not exist" },
  };
  expect(findingVerdict(verified)).toEqual({ terminal: true, kind: "refuted" });
});

test("AC-C4 — the orchestrator cannot dismiss on its own authority", () => {
  const orchestratorDismissal: GateFinding = {
    id: "F-1",
    severity: "major",
    disposition: {
      state: "dismissed-out-of-scope",
      evidence: "this belongs to a later flow and was recorded there",
    },
    round: "round-1",
  };
  expect(findingVerdict(orchestratorDismissal).terminal).toBe(false);
  expect((findingVerdict(orchestratorDismissal) as { reason: string }).reason).toContain(
    "no recorded human decision",
  );

  const humanDismissal: GateFinding = {
    ...orchestratorDismissal,
    disposition: {
      state: "dismissed-out-of-scope",
      evidence: "human: aleks — deferred to flow 205, recorded in that package's description",
    },
  };
  expect(findingVerdict(humanDismissal)).toEqual({ terminal: true, kind: "dismissed" });
});

test("AC6 — an unrecognised disposition never passes, and neither does an unevidenced one", () => {
  expect(
    findingVerdict({ id: "F", severity: "major", disposition: { state: "resolved", evidence: "x" }, round: "r" })
      .terminal,
  ).toBe(false);
  expect(
    findingVerdict({ id: "F", severity: "major", disposition: { state: "acted-on" }, round: "r" }).terminal,
  ).toBe(false);
  expect(findingVerdict({ id: "F", severity: "major", disposition: { state: "unknown" }, round: "r" }).terminal).toBe(
    false,
  );
});

// --- AC5 condition 3 / AC-C2: the round ran against the PR head -------------

test("AC-C2 — a clean round against a stale SHA fails, and both SHAs are reported", async () => {
  await fresh();
  const service = createFlowService(makeDeps());
  const { id, dir } = await driveToGates(service);
  await writeCleanReviewPackage({ cwd: ROOT, flowDir: dir, head: STALE });

  const gate = reviewOf((await service.complete({ cwd: ROOT, id })).gates);

  expect(gate.status).toBe("fail");
  expect(gate.detail).toContain("head-commit (violated)");
  expect(gate.detail).toContain(STALE);
  expect(gate.detail).toContain(HEAD);
  expect(gate.detail).toContain("stale SHA");
});

test("AC-C2 — a round that records NO head is unobserved, not a match", async () => {
  await fresh();
  const service = createFlowService(makeDeps());
  const { id, dir } = await driveToGates(service);
  await writeReviewPackage({
    cwd: ROOT,
    flowDir: dir,
    reviewId: "round-1",
    head: null,
    findings: [],
    coverage: [{ reviewer: "external-comments", status: "run", reason: "collected" }],
  });

  const gate = reviewOf((await service.complete({ cwd: ROOT, id })).gates);

  expect(gate.status).toBe("fail");
  expect(gate.detail).toContain("head-commit (unobserved)");
  expect(gate.detail).toContain("records no target head commit");
});

test("AC-C2 — a tracker that reports no head SHA is unobserved, not a pass", async () => {
  await fresh();
  const service = createFlowService(makeDeps({ tracker: fakeTracker({ headSha: null }) }));
  const { id, dir } = await driveToGates(service);
  await writeCleanReviewPackage({ cwd: ROOT, flowDir: dir, head: HEAD });

  const gate = reviewOf((await service.complete({ cwd: ROOT, id })).gates);

  expect(gate.status).toBe("fail");
  expect(gate.detail).toContain("head-commit (unobserved)");
  expect(gate.detail).toContain("did not report a head SHA");
});

// --- AC5 condition 4: external comments -------------------------------------

test("AC5/4 — a PR with nothing recorded about comments is unobserved, not clean", async () => {
  await fresh();
  const service = createFlowService(makeDeps());
  const { id, dir } = await driveToGates(service);
  await writeReviewPackage({
    cwd: ROOT,
    flowDir: dir,
    reviewId: "round-1",
    head: HEAD,
    findings: [],
    coverage: [{ reviewer: "review-logic", status: "run", reason: "dispatched" }],
  });

  const gate = reviewOf((await service.complete({ cwd: ROOT, id })).gates);

  expect(gate.status).toBe("fail");
  expect(gate.detail).toContain("external-comments (unobserved)");
  expect(gate.detail).toContain("different facts");
  // The failure names both ways out, so the operator is not left guessing.
  expect(gate.detail).toContain("externalCommentsGate");
  for (const reviewer of EXTERNAL_COMMENT_COVERAGE_REVIEWERS) {
    expect(gate.detail).toContain(reviewer);
  }
});

test("AC5/4 — an injected collector reporting an unanswered comment fails the gate", async () => {
  await fresh();
  const service = createFlowService(
    makeDeps({
      externalCommentsGate: async () => ({
        collected: true,
        unanswered: ["https://github.com/acme/app/pull/7#discussion_r1"],
        detail: "3 collected, 1 unanswered",
      }),
    }),
  );
  const { id, dir } = await driveToGates(service);
  await writeCleanReviewPackage({ cwd: ROOT, flowDir: dir, head: HEAD });

  const gate = reviewOf((await service.complete({ cwd: ROOT, id })).gates);

  expect(gate.status).toBe("fail");
  expect(gate.detail).toContain("external-comments (violated)");
  expect(gate.detail).toContain("discussion_r1");
});

test("AC5/4 — a collector that did not run is unobserved even when it reports nothing", async () => {
  await fresh();
  const service = createFlowService(
    makeDeps({
      externalCommentsGate: async () => ({ collected: false, unanswered: [], detail: "the PR was unreachable" }),
    }),
  );
  const { id, dir } = await driveToGates(service);
  await writeCleanReviewPackage({ cwd: ROOT, flowDir: dir, head: HEAD });

  const gate = reviewOf((await service.complete({ cwd: ROOT, id })).gates);

  expect(gate.status).toBe("fail");
  expect(gate.detail).toContain("external-comments (unobserved)");
  expect(gate.detail).toContain("the PR was unreachable");
});

test("AC5/4 — an external finding that was dispositioned but never replied to fails", async () => {
  await fresh();
  const service = createFlowService(makeDeps());
  const { id, dir } = await driveToGates(service);
  await writeReviewPackage({
    cwd: ROOT,
    flowDir: dir,
    reviewId: "round-1",
    head: HEAD,
    coverage: [{ reviewer: "external-comments", status: "run", reason: "collected" }],
    findings: [
      {
        ...fixedFinding("F-001"),
        source: "external",
        external_ref: { id: "1", author: "someone", url: `${PR_URL}#discussion_r1` },
      },
    ],
  });

  const gate = reviewOf((await service.complete({ cwd: ROOT, id })).gates);

  expect(gate.status).toBe("fail");
  expect(gate.detail).toContain("external-comments (violated)");
  expect(gate.detail).toContain("no reply was posted");
});

test("AC5/4 — the same external finding passes once a reply url is recorded", async () => {
  await fresh();
  const service = createFlowService(makeDeps());
  const { id, dir } = await driveToGates(service);
  await writeReviewPackage({
    cwd: ROOT,
    flowDir: dir,
    reviewId: "round-1",
    head: HEAD,
    coverage: [{ reviewer: "external-comments", status: "run", reason: "collected" }],
    findings: [
      {
        ...fixedFinding("F-001"),
        source: "external",
        external_ref: { id: "1", author: "someone", url: `${PR_URL}#discussion_r1`, reply_url: `${PR_URL}#r2` },
      },
    ],
  });

  expect(reviewOf((await service.complete({ cwd: ROOT, id })).gates).status).toBe("pass");
});

// --- AC5 condition 5: the verifier ran, and its stats are recorded ----------

test("AC5/5 — a round with no verification stats is unobserved", async () => {
  await fresh();
  const service = createFlowService(makeDeps());
  const { id, dir } = await driveToGates(service);
  await writeReviewPackage({
    cwd: ROOT,
    flowDir: dir,
    reviewId: "round-1",
    head: HEAD,
    findings: [],
    coverage: [{ reviewer: "external-comments", status: "run", reason: "collected" }],
    verificationMode: null,
  });

  const gate = reviewOf((await service.complete({ cwd: ROOT, id })).gates);

  expect(gate.status).toBe("fail");
  expect(gate.detail).toContain("verifier-stats (unobserved)");
  expect(gate.detail).toContain("Nothing says whether a verifier ran");
});

test("AC5/5 — `verification_mode: off` is a violation, not an absence", async () => {
  await fresh();
  const service = createFlowService(makeDeps());
  const { id, dir } = await driveToGates(service);
  await writeReviewPackage({
    cwd: ROOT,
    flowDir: dir,
    reviewId: "round-1",
    head: HEAD,
    findings: [],
    coverage: [{ reviewer: "external-comments", status: "run", reason: "collected" }],
    verificationMode: "off",
  });

  const gate = reviewOf((await service.complete({ cwd: ROOT, id })).gates);

  expect(gate.status).toBe("fail");
  expect(gate.detail).toContain("verifier-stats (violated)");
  expect(gate.detail).toContain("no finding in it was independently checked");
});

test("AC5/5 — `annotate` satisfies the condition; the verifier ran and said so", async () => {
  await fresh();
  const service = createFlowService(makeDeps());
  const { id, dir } = await driveToGates(service);
  await writeReviewPackage({
    cwd: ROOT,
    flowDir: dir,
    reviewId: "round-1",
    head: HEAD,
    findings: [],
    coverage: [{ reviewer: "external-comments", status: "run", reason: "collected" }],
    verificationMode: "annotate",
  });

  expect(reviewOf((await service.complete({ cwd: ROOT, id })).gates).status).toBe("pass");
});

// --- AC7: the round cap and the gate --------------------------------------

test("AC7 — reaching the round cap with the gate unsatisfied never completes", async () => {
  await fresh();
  const service = createFlowService(makeDeps());
  const { id, dir } = await driveToGates(service);
  for (const round of [1, 2, 3]) {
    await writeReviewPackage({
      cwd: ROOT,
      flowDir: dir,
      reviewId: `round-${round}`,
      createdAt: `2026-08-29T1${round}:00:00.000Z`,
      head: HEAD,
      coverage: [{ reviewer: "external-comments", status: "run", reason: "collected" }],
      findings: [{ id: "F-001", severity: "blocker", problem: "still open", dedupe_key: "still-open" }],
    });
  }

  const result = await service.complete({ cwd: ROOT, id });

  expect(result.passed).toBe(false);
  expect(result.flow.status).toBe("in-progress");
  const gate = reviewOf(result.gates);
  expect(gate.status).toBe("fail");
  expect(gate.detail).toContain(`round cap (${REVIEW_ROUND_CAP}) is reached with the gate unsatisfied`);
  expect(gate.detail).toContain("the decision is the operator's");
});

test("AC7 — below the cap the failure is reported without the cap note", async () => {
  await fresh();
  const service = createFlowService(makeDeps());
  const { id, dir } = await driveToGates(service);
  await writeReviewPackage({
    cwd: ROOT,
    flowDir: dir,
    reviewId: "round-1",
    head: HEAD,
    coverage: [{ reviewer: "external-comments", status: "run", reason: "collected" }],
    findings: [{ id: "F-001", severity: "blocker", problem: "still open" }],
  });

  const gate = reviewOf((await service.complete({ cwd: ROOT, id })).gates);

  expect(gate.status).toBe("fail");
  expect(gate.detail).not.toContain("round cap");
});

// --- AC-C6 / opt-in --------------------------------------------------------

test("the gate is opt-in: a package without `gates.review` reports skipped", async () => {
  await fresh();
  const service = createFlowService(makeDeps());
  const { id, dir } = await driveToGates(service);

  const flowPath = path.join(ROOT, ".metaproject", "flows", dir, "flow.json");
  const flow = JSON.parse(await readFile(flowPath, "utf8")) as FlowState;
  delete flow.gates?.review;
  await writeFile(flowPath, `${JSON.stringify(flow, null, 2)}\n`, "utf8");

  const result = await service.complete({ cwd: ROOT, id });

  const gate = reviewOf(result.gates);
  expect(gate.status).toBe("skipped");
  expect(gate.detail).toContain("created before the gate");
  expect(result.passed).toBe(true);
});

test("`flow init` opts every new package into both the task and the review gate", async () => {
  await fresh();
  const service = createFlowService(makeDeps());
  const { flow } = await service.init({ cwd: ROOT, title: "Opt-in check" });
  expect(flow.gates).toEqual({ tasks: true, review: true });
});

test("the gate runs where the specification puts it: sixth, after tasks", async () => {
  await fresh();
  const service = createFlowService(makeDeps());
  const { id, dir } = await driveToGates(service);
  await writeCleanReviewPackage({ cwd: ROOT, flowDir: dir, head: HEAD });

  const result = await service.complete({ cwd: ROOT, id });

  expect(result.gates.map((gate) => gate.name)).toEqual([
    "acceptance-criteria",
    "pull-request",
    "tasks",
    "review",
    "health",
  ]);
});

// --- configuration ---------------------------------------------------------

test("`require_clean_round: false` disables the gate VISIBLY, and says what stopped being checked", async () => {
  await fresh();
  const service = createFlowService(makeDeps());
  const { id } = await driveToGates(service);
  await writeFile(
    path.join(ROOT, REVIEW_GATE_CONFIG_PATH),
    `${JSON.stringify({ completion: { require_clean_round: false } }, null, 2)}\n`,
    "utf8",
  );

  const result = await service.complete({ cwd: ROOT, id });

  const gate = reviewOf(result.gates);
  expect(gate.status).toBe("skipped");
  expect(gate.detail).toContain("Nothing checked that the last review round came back clean");
});

test("a severity floor of `info` is clamped to `minor` and the clamp is reported", async () => {
  await fresh();
  await writeFile(
    path.join(ROOT, REVIEW_GATE_CONFIG_PATH),
    `${JSON.stringify({ completion: { severity_floor: "info" } }, null, 2)}\n`,
    "utf8",
  );

  const config = await readReviewGateConfig(ROOT);

  expect(config.severityFloor).toBe("minor");
  expect(config.notes.join(" ")).toContain("never blocks");
});

test("a malformed config file falls back to the defaults WITH a note, never silently", async () => {
  await fresh();
  await writeFile(path.join(ROOT, REVIEW_GATE_CONFIG_PATH), "{ not json", "utf8");

  const config = await readReviewGateConfig(ROOT);

  expect(config.severityFloor).toBe("minor");
  expect(config.requireCleanRound).toBe(true);
  expect(config.notes).toHaveLength(1);
  expect(config.notes[0]).toContain("could not be parsed");
});

// --- units -----------------------------------------------------------------

test("an unrecognised severity ranks as a blocker, so a typo cannot bypass the floor", () => {
  expect(blocksAtFloor("critical", "minor")).toBe(true);
  expect(blocksAtFloor("critical", "blocker")).toBe(true);
  expect(blocksAtFloor("info", "minor")).toBe(false);
  expect(blocksAtFloor("minor", "major")).toBe(false);
  expect(blocksAtFloor("major", "major")).toBe(true);
});

test("shaMatches accepts abbreviations and refuses anything shorter than git prints", () => {
  expect(shaMatches(HEAD, HEAD.slice(0, 7))).toBe(true);
  expect(shaMatches(HEAD.slice(0, 12), HEAD)).toBe(true);
  expect(shaMatches(HEAD, STALE)).toBe(false);
  expect(shaMatches(HEAD, "a1b2c3")).toBe(false);
});

test("parseVerificationStats returns null when no verifier line is present", () => {
  expect(parseVerificationStats("# Review Scope\n\nnothing here\n")).toBeNull();
  expect(parseVerificationStats("verification_mode: filter\nrefuted: 2\n")).toEqual({
    mode: "filter",
    claimsReceived: null,
    claimsApplied: null,
    refuted: 2,
    findingsIn: null,
    findingsRetained: null,
    findingsRemoved: null,
  });
});

test("latestFindingStates takes the newest record of each identity and drops nothing", async () => {
  await fresh();
  const service = createFlowService(makeDeps());
  const { dir } = await driveToGates(service);
  await writeReviewPackage({
    cwd: ROOT,
    flowDir: dir,
    reviewId: "round-1",
    createdAt: "2026-08-29T10:00:00.000Z",
    head: HEAD,
    findings: [
      { id: "F-001", dedupe_key: "shared", problem: "one" },
      { id: "F-002", dedupe_key: "only-in-round-1", problem: "two" },
    ],
  });
  await writeReviewPackage({
    cwd: ROOT,
    flowDir: dir,
    reviewId: "round-2",
    createdAt: "2026-08-29T12:00:00.000Z",
    head: HEAD,
    findings: [{ id: "F-009", dedupe_key: "shared", problem: "one, restated" }],
  });

  const rounds = await readReviewRounds(ROOT, dir);
  const states = latestFindingStates(rounds);

  expect(rounds.map((round) => round.reviewId)).toEqual(["round-1", "round-2"]);
  // Two identities: the shared one (latest record wins) and the round-1-only one
  // (carried forward, because vanishing is not a disposition).
  expect(states.map((finding) => finding.id).sort()).toEqual(["F-002", "F-009"]);
  expect(states.find((finding) => finding.id === "F-002")?.round).toBe("round-1");
});
