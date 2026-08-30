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
  prHeadResolutionRemedy,
  readReviewGateConfig,
  readReviewRounds,
  shaMatches,
  type GateFinding,
  type PrHeadResolution,
} from "./review-gate";
import {
  FIXTURE_PR_HEAD,
  writeCleanReviewPackage,
  writePrCommentFixtureState,
  writeReviewPackage,
  type ReviewFixtureFinding,
} from "./review-fixtures";
import type { FlowService, FlowServiceDeps, FlowState, GateOutcome, TrackerAdapter } from "./types";

const PR_URL = "https://github.com/acme/app/pull/7";
// Shared with the fixtures so the comment record's `collected_sha` and the PR
// head the fake tracker reports cannot drift: condition 4 compares them.
const HEAD = FIXTURE_PR_HEAD;
const STALE = "0f1e2d3c4b5a69788796a5b4c3d2e1f098765432";

let ROOT = "";

/**
 * `detect: false` is the CI runner and the developer with no authenticated
 * `gh`: `githubAdapter.detect()` returns false when `gh` is off `PATH` or
 * `gh auth status` exits non-zero, and then the pull request is never asked
 * anything at all. A test below builds the OTHER shape by hand — the tracker ran and the
 * pull request is not visible (`flow implemented` refuses a PR it cannot see, so
 * that one needs a tracker whose answer changes). They are different facts, and
 * both differ again from a stale comment record. The gate must collapse none of
 * the three.
 */
function fakeTracker(over: { headSha?: string | null; detect?: boolean } = {}): TrackerAdapter {
  return {
    id: "fake",
    detect: async () => over.detect !== false,
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

/**
 * A flow standing at the point where `complete()` runs its gates.
 *
 * The external-comment record is written by default because condition 4 reads
 * the DURABLE record (`.metaproject/reviews/pr-comments/…`) rather than a
 * reviewer name in `manifest.coverage`, which any `--reviewers` value produced.
 * `collectComments: false` is the case where nobody ran the collector at all.
 */
async function driveToGates(
  service: FlowService,
  options: { collectComments?: boolean } = {},
): Promise<{ id: string; dir: string }> {
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
  if (options.collectComments !== false) {
    await writePrCommentFixtureState({ cwd: ROOT, prUrl: PR_URL });
  }
  return { id: flow.id, dir };
}

/**
 * One condition's slice of a failing gate detail.
 *
 * Needed because conditions 3 and 4 now describe the same tracker failure, so
 * `gate.detail.toContain(…)` can be satisfied by the wrong condition — which is
 * exactly the confusion these tests exist to pin.
 */
function conditionDetail(gate: GateOutcome, id: string): string {
  const part = gate.detail.split(" | ").find((entry) => entry.includes(`${id} (`));
  if (part === undefined) {
    throw new Error(`no \`${id}\` condition in: ${gate.detail}`);
  }
  return part;
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
  await writeCleanReviewPackage({ cwd: ROOT, flowDir: dir, head: HEAD, prUrl: PR_URL });

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

test("AC10 — `answered-disagree` is terminal once a reply exists, and never before", () => {
  // The state AC10 REQUIRES: our verifier refuted somebody else's comment, and
  // we still owe them an answer. `findingVerdict` did not know the word, so it
  // fell through to "not a state this build recognises" — permanently
  // non-terminal, failing conditions 2 AND 4 forever. The pipeline writes this
  // state on exactly the path AC10 describes, so the gate refused every flow
  // whose review worked as designed.
  const noReply: GateFinding = {
    id: "F-1",
    severity: "major",
    source: "external",
    disposition: { state: "answered-disagree", evidence: "the verifier could not reproduce it" },
    externalRef: { id: "1", url: `${PR_URL}#discussion_r1` },
    round: "round-1",
  };
  expect(findingVerdict(noReply).terminal).toBe(false);
  expect((findingVerdict(noReply) as { reason: string }).reason).toContain("no reply on the record");

  const replied: GateFinding = {
    ...noReply,
    externalRef: { id: "1", url: `${PR_URL}#discussion_r1`, reply_url: `${PR_URL}#issuecomment-9` },
  };
  expect(findingVerdict(replied)).toEqual({ terminal: true, kind: "answered" });

  // A hand-written record whose evidence names the reply, for packages older
  // than `reply_url`.
  const describedReply: GateFinding = {
    ...noReply,
    disposition: {
      state: "answered-disagree",
      evidence: `replied at ${PR_URL}#issuecomment-9; the verifier could not reproduce it`,
    },
  };
  expect(findingVerdict(describedReply)).toEqual({ terminal: true, kind: "answered" });
});

test("AC10 — an `answered-disagree` external finding with a reply completes the flow", async () => {
  await fresh();
  const service = createFlowService(makeDeps());
  const { id, dir } = await driveToGates(service);
  await writeReviewPackage({
    cwd: ROOT,
    flowDir: dir,
    reviewId: "round-1",
    head: HEAD,
    findings: [
      {
        id: "F-001",
        severity: "major",
        source: "external",
        disposition: {
          state: "answered-disagree",
          evidence: "our verifier could not reproduce it; said so on the thread",
        },
        verification: { verdict: "refuted", method: "execution", evidence: "the cited test passes" },
        external_ref: {
          id: "1",
          author: "someone",
          url: `${PR_URL}#discussion_r1`,
          reply_url: `${PR_URL}#issuecomment-9`,
        },
      },
    ],
  });

  expect(reviewOf((await service.complete({ cwd: ROOT, id })).gates).status).toBe("pass");
});

test("MINOR — an English word is not a commit SHA", () => {
  // `\b[0-9a-f]{7,40}\b` matches `effaced`, `defaced`, `facade`, `deadbeef`.
  // A disposition reading "the debug banner was effaced" and a verification
  // citing the same word therefore satisfied "a commit SHA AND a verifier
  // verdict citing that SHA".
  for (const word of ["effaced", "defaced", "deadbeef", "facade"]) {
    const wordAsSha: GateFinding = {
      id: "F-1",
      severity: "major",
      disposition: { state: "acted-on", evidence: `the debug banner was ${word}` },
      verification: { verdict: "refuted", method: "execution", evidence: `re-ran after it was ${word}` },
      round: "round-1",
    };
    expect(findingVerdict(wordAsSha).terminal).toBe(false);
    expect((findingVerdict(wordAsSha) as { reason: string }).reason).toContain("names no commit SHA");
  }

  // A real abbreviated SHA still works.
  const realSha: GateFinding = {
    id: "F-2",
    severity: "major",
    disposition: { state: "acted-on", evidence: `fixed in ${HEAD.slice(0, 8)}` },
    verification: { verdict: "refuted", method: "execution", evidence: `re-ran at ${HEAD}: gone` },
    round: "round-1",
  };
  expect(findingVerdict(realSha)).toEqual({ terminal: true, kind: "fixed" });
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

test("a round that stops being readable does not take its open findings with it", async () => {
  // MAJOR: this used to PASS, and the passing detail NAMED the round it had
  // lost — `1 of 2 round(s) ingested; latest is round-2 (not ingested: round-1)`.
  // `latestFindingStates` filtered to ingested rounds, so truncating round 1's
  // manifest deleted its blocker from the evaluation while `findings.json` sat
  // right there still saying it was open. Absence reading as clean, relocated
  // one level up from the rule this module was built to enforce.
  await fresh();
  const service = createFlowService(makeDeps());
  const { id, dir } = await driveToGates(service);
  await writeReviewPackage({
    cwd: ROOT,
    flowDir: dir,
    reviewId: "round-1",
    createdAt: "2026-08-29T10:00:00.000Z",
    head: HEAD,
    findings: [{ id: "F-001", severity: "blocker", problem: "off-by-one", dedupe_key: "off-by-one" }],
  });
  await writeReviewPackage({
    cwd: ROOT,
    flowDir: dir,
    reviewId: "round-2",
    createdAt: "2026-08-29T12:00:00.000Z",
    head: HEAD,
    findings: [],
  });

  const intact = reviewOf((await service.complete({ cwd: ROOT, id })).gates);
  expect(intact.status).toBe("fail");
  expect(intact.detail).toContain("F-001");

  await rm(path.join(ROOT, ".metaproject", "flows", dir, "reviews", "round-1", "manifest.json"));

  // A failed completion returns the flow to `in-progress`, so it has to be
  // walked back up to `implemented` before the gates run again.
  await service.implemented({ cwd: ROOT, id, prUrl: PR_URL });
  const truncated = reviewOf((await service.complete({ cwd: ROOT, id })).gates);
  expect(truncated.status).toBe("fail");
  // Both: the lost round is reported as lost, AND its finding still blocks.
  expect(truncated.detail).toContain("ingested-round (unobserved)");
  expect(truncated.detail).toContain("cannot be read");
  expect(truncated.detail).toContain("F-001");
});

test("an unreadable round fails condition 1 even when everything readable is clean", async () => {
  await fresh();
  const service = createFlowService(makeDeps());
  const { id, dir } = await driveToGates(service);
  await writeCleanReviewPackage({ cwd: ROOT, flowDir: dir, head: HEAD, prUrl: PR_URL });
  await writeReviewPackage({
    cwd: ROOT,
    flowDir: dir,
    reviewId: "round-0-abandoned",
    createdAt: "2026-08-29T08:00:00.000Z",
    head: HEAD,
    omitManifest: true,
  });

  const gate = reviewOf((await service.complete({ cwd: ROOT, id })).gates);

  expect(gate.status).toBe("fail");
  expect(gate.detail).toContain("ingested-round (unobserved)");
  expect(gate.detail).toContain("round-0-abandoned");
  expect(gate.detail).toContain("do not complete over it");
});

// --- AC5 condition 3 / AC-C2: the round ran against the PR head -------------

test("AC-C2 — a clean round against a stale SHA fails, and both SHAs are reported", async () => {
  await fresh();
  const service = createFlowService(makeDeps());
  const { id, dir } = await driveToGates(service);
  await writeCleanReviewPackage({ cwd: ROOT, flowDir: dir, head: STALE, prUrl: PR_URL });

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
  await writeCleanReviewPackage({ cwd: ROOT, flowDir: dir, head: HEAD, prUrl: PR_URL });

  const gate = reviewOf((await service.complete({ cwd: ROOT, id })).gates);

  expect(gate.status).toBe("fail");
  expect(gate.detail).toContain("head-commit (unobserved)");
  expect(gate.detail).toContain("did not report a head SHA");
});

test("AC-C2 — with no tracker, condition 3 offers a remedy IT can act on", async () => {
  // The two conditions share `prHeadResolutionRemedy` so they cannot tell
  // different stories about the same `null`, and that is right for five of the
  // six states. `no-tracker` is the exception: condition 3 asks a question the
  // LOCAL object database answers, so `--merged <sha>` is its way out and it
  // never reads `FlowServiceDeps.externalCommentsGate`. Sending its reader to
  // that seam is advice about a mechanism this condition does not consult.
  await fresh();
  const service = createFlowService(makeDeps());
  const { id, dir } = await driveToGates(service);
  await writeCleanReviewPackage({ cwd: ROOT, flowDir: dir, head: HEAD, prUrl: PR_URL });

  // Same flow on disk, same recorded PR — but nothing wired to ask about it.
  const untracked = createFlowService(makeDeps({ tracker: null }));
  const gate = reviewOf((await untracked.complete({ cwd: ROOT, id })).gates);

  const head = conditionDetail(gate, "head-commit");
  expect(head).toContain("head-commit (unobserved)");
  expect(head).toContain("no tracker is configured");
  expect(head).toContain("complete with `--merged <sha>`");
  expect(head).not.toContain("externalCommentsGate");
  // And condition 4 keeps the seam, because no local commit answers ITS question.
  expect(conditionDetail(gate, "external-comments")).toContain("externalCommentsGate");
});

// --- AC5 condition 4: external comments -------------------------------------

test("AC5/4 — a PR with nothing recorded about comments is unobserved, not clean", async () => {
  await fresh();
  const service = createFlowService(makeDeps());
  const { id, dir } = await driveToGates(service, { collectComments: false });
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
  expect(gate.detail).toContain("keryx review comments collect");
});

test("AC5/4 — naming a collector in `manifest.coverage` is NOT a collection", async () => {
  // MAJOR: this used to PASS. `manifest.coverage` is written by
  // `normalizeCoverage` straight from `keryx review ingest --reviewers …`, with
  // status `run` and the reason "selected for managed review package". So
  // `--reviewers pr-comments` completed a flow whose pull request could carry
  // thirty unanswered comments, and the gate said the collection "ran and found
  // nothing". Nothing had run.
  await fresh();
  const service = createFlowService(makeDeps());
  const { id, dir } = await driveToGates(service, { collectComments: false });
  await writeReviewPackage({
    cwd: ROOT,
    flowDir: dir,
    reviewId: "round-1",
    head: HEAD,
    findings: [],
    coverage: EXTERNAL_COMMENT_COVERAGE_REVIEWERS.map((reviewer) => ({
      reviewer,
      status: "run",
      reason: "selected for managed review package",
    })),
  });

  const gate = reviewOf((await service.complete({ cwd: ROOT, id })).gates);

  expect(gate.status).toBe("fail");
  expect(gate.detail).toContain("external-comments (unobserved)");
});

test("AC5/4 — the durable record is what answers the condition, and it can say `unanswered`", async () => {
  await fresh();
  const service = createFlowService(makeDeps());
  const { id, dir } = await driveToGates(service, { collectComments: false });
  await writePrCommentFixtureState({
    cwd: ROOT,
    prUrl: PR_URL,
    answered: [{ id: "1", author: "alice" }],
    unanswered: [{ id: "2", author: "coderabbitai" }],
  });
  await writeReviewPackage({ cwd: ROOT, flowDir: dir, reviewId: "round-1", head: HEAD, findings: [] });

  const gate = reviewOf((await service.complete({ cwd: ROOT, id })).gates);

  expect(gate.status).toBe("fail");
  expect(gate.detail).toContain("external-comments (violated)");
  expect(gate.detail).toContain("coderabbitai");
  // A bot's comment is a comment: the record does not distinguish, and neither
  // does this (AC8).
  expect(gate.detail).not.toContain("alice");
});

test("AC5/4 — a record that exists but collected nothing is unobserved, not clean", async () => {
  await fresh();
  const service = createFlowService(makeDeps());
  const { id, dir } = await driveToGates(service, { collectComments: false });
  await writePrCommentFixtureState({ cwd: ROOT, prUrl: PR_URL, roundsCollected: 0 });
  await writeReviewPackage({ cwd: ROOT, flowDir: dir, reviewId: "round-1", head: HEAD, findings: [] });

  const gate = reviewOf((await service.complete({ cwd: ROOT, id })).gates);

  expect(gate.status).toBe("fail");
  expect(gate.detail).toContain("external-comments (unobserved)");
  expect(gate.detail).toContain("no collection round has run yet");
});

test("AC5/4 — a collection that ran before the comments arrived is stale, not clean", async () => {
  // MAJOR: `rounds_collected > 0` was read as proof the collection was CURRENT,
  // and nothing in the record could date it — `SeenComment` has no timestamp and
  // `comments collect` defaults `--round` to 1, so the counter sat at 1 however
  // many times collection ran. Collect at the start of round 1 against a PR
  // nobody had commented on, let five people comment, never re-collect, and the
  // gate passed with "0 comment(s) collected over 1 round(s), 0 outstanding".
  await fresh();
  const service = createFlowService(makeDeps());
  const { id, dir } = await driveToGates(service, { collectComments: false });
  await writePrCommentFixtureState({ cwd: ROOT, prUrl: PR_URL, collectedSha: STALE });
  await writeReviewPackage({ cwd: ROOT, flowDir: dir, reviewId: "round-1", head: HEAD, findings: [] });

  const gate = reviewOf((await service.complete({ cwd: ROOT, id })).gates);

  expect(gate.status).toBe("fail");
  // `violated`, not `unobserved`: the head RESOLVED and the record is against a
  // different commit. That is a fact we went and got, and it is a different
  // state from "nobody could reach the tracker" — which reports `unobserved`
  // and gets different advice. See the tracker-unavailable tests below.
  expect(gate.detail).toContain("external-comments (violated)");
  expect(gate.detail).toContain("was last collected against");
  expect(gate.detail).toContain(STALE);
  expect(gate.detail).toContain(HEAD);
  expect(gate.detail).not.toContain("could not resolve");
});

test("AC5/4 — a record written before collections were dated is not read as fresh", async () => {
  // The compatibility decision, stated where it can be checked: a missing
  // `collected_sha` means "this cannot be shown to be current", which is exactly
  // what an absent file means. It cannot silently mean fresh.
  await fresh();
  const service = createFlowService(makeDeps());
  const { id, dir } = await driveToGates(service, { collectComments: false });
  await writePrCommentFixtureState({ cwd: ROOT, prUrl: PR_URL, collectedSha: null });
  await writeReviewPackage({ cwd: ROOT, flowDir: dir, reviewId: "round-1", head: HEAD, findings: [] });

  const gate = reviewOf((await service.complete({ cwd: ROOT, id })).gates);

  expect(gate.status).toBe("fail");
  // `violated` for the same reason as the stale case, and established WITHOUT
  // the tracker: an undatable file is undatable however healthy your `gh` is, so
  // the advice must be "re-collect", never "fix your tracker".
  expect(gate.detail).toContain("external-comments (violated)");
  expect(gate.detail).toContain("does not say which commit it was collected against");
  expect(gate.detail).not.toContain("gh auth login");
});

test("AC5/4 — a collection at the PR head passes, and the detail says which commit", async () => {
  await fresh();
  const service = createFlowService(makeDeps());
  const { id, dir } = await driveToGates(service, { collectComments: false });
  await writePrCommentFixtureState({ cwd: ROOT, prUrl: PR_URL, collectedSha: HEAD, roundsCollected: 2 });
  await writeReviewPackage({ cwd: ROOT, flowDir: dir, reviewId: "round-1", head: HEAD, findings: [] });

  const gate = reviewOf((await service.complete({ cwd: ROOT, id })).gates);

  expect(gate.status).toBe("pass");
  expect(gate.detail).toContain("all 5 conditions hold");
});

// --- The three states of condition 4 ----------------------------------------
//
// A fix round closed the freshness hole by refusing every unresolved head, and
// collapsed two facts doing it: "your comment record is stale" and "nobody could
// reach the tracker" came out as the same sentence and the same advice. The
// operator whose `gh` is logged out was told to re-run a collection that was
// already current, and could not tell from the message which of the two he was
// in. These tests pin all three apart.

test("AC5/4 — state 3: a tracker that cannot run is unobserved, and does NOT read as a stale record", async () => {
  await fresh();
  const service = createFlowService(makeDeps({ tracker: fakeTracker({ detect: false }) }));
  const { id, dir } = await driveToGates(service, { collectComments: false });
  // The record is CURRENT — collected at exactly the commit the round ran
  // against. Nothing about it is stale; the only thing missing is a tracker.
  await writePrCommentFixtureState({ cwd: ROOT, prUrl: PR_URL, collectedSha: HEAD });
  await writeReviewPackage({ cwd: ROOT, flowDir: dir, reviewId: "round-1", head: HEAD, findings: [] });

  const gate = reviewOf((await service.complete({ cwd: ROOT, id })).gates);

  expect(gate.status).toBe("fail");
  // Scoped to condition 4's OWN sentence. Condition 3 fails here too and now
  // says something similar, and an assertion the neighbour can satisfy proves
  // nothing about this one.
  const detail = conditionDetail(gate, "external-comments");
  expect(detail).toContain("external-comments (unobserved)");
  // It names the tracker as the thing that failed…
  expect(detail).toContain("could not be reached");
  expect(detail).toContain("gh auth status");
  // …the remedy for THAT, not for a stale collection…
  expect(detail).toContain("gh auth login");
  // …and the operator-level way past the gate, which is not "inject a dependency".
  expect(detail).toContain("require_clean_round");
  expect(detail).toContain("neither shown to be current nor shown to be stale");
  // …and it does not accuse the record of being stale, because it is not.
  expect(gate.detail).not.toContain("was last collected against");
  expect(gate.detail).not.toContain("no longer exists");
});

test("AC5/4 — state 3 vs state 2: the same record passes the moment the tracker answers", async () => {
  // The control for the test above. Identical fixture, identical record; the
  // ONLY difference is whether `detect()` succeeds. If the failure were about
  // the record, this would fail too.
  await fresh();
  const service = createFlowService(makeDeps());
  const { id, dir } = await driveToGates(service, { collectComments: false });
  await writePrCommentFixtureState({ cwd: ROOT, prUrl: PR_URL, collectedSha: HEAD });
  await writeReviewPackage({ cwd: ROOT, flowDir: dir, reviewId: "round-1", head: HEAD, findings: [] });

  const gate = reviewOf((await service.complete({ cwd: ROOT, id })).gates);

  expect(gate.status).toBe("pass");
});

test("AC-C2/AC5/4 — conditions 3 and 4 give the SAME reason for the missing head", async () => {
  // They read one resolution now. Before, condition 3 said "the tracker did not
  // report a head SHA — an older `gh`, or an inaccessible PR" about a tracker
  // `detect()` had refused to run, and condition 4 said the record was stale.
  // Two conditions, two wrong stories, one cause.
  await fresh();
  const service = createFlowService(makeDeps({ tracker: fakeTracker({ detect: false }) }));
  const { id, dir } = await driveToGates(service, { collectComments: false });
  await writePrCommentFixtureState({ cwd: ROOT, prUrl: PR_URL, collectedSha: STALE });
  await writeReviewPackage({ cwd: ROOT, flowDir: dir, reviewId: "round-1", head: HEAD, findings: [] });

  const gate = reviewOf((await service.complete({ cwd: ROOT, id })).gates);

  expect(gate.detail).toContain("head-commit (unobserved)");
  expect(gate.detail).toContain("external-comments (unobserved)");
  // One phrase, twice — once per condition.
  expect(gate.detail.match(/the tracker could not be reached/g)?.length).toBe(2);
  expect(gate.detail).not.toContain("did not report a head SHA");
  // And with the head unresolved, the record's staleness is NOT asserted, even
  // though this record happens to be stale: nobody looked.
  expect(gate.detail).not.toContain("but the PR head is");
});

test("AC5/4 — a pull request the tracker cannot see is its own state, not a dead tracker", async () => {
  await fresh();
  // Visible when the flow recorded it — `flow implemented` refuses a PR it
  // cannot see — and gone by completion time: the branch was deleted, or this
  // account lost access to the repository.
  let visible = true;
  const service = createFlowService(
    makeDeps({
      tracker: {
        ...fakeTracker(),
        prStatus: async () => ({ exists: visible, isDraft: true, checksGreen: true, headSha: HEAD }),
      },
    }),
  );
  const { id, dir } = await driveToGates(service, { collectComments: false });
  visible = false;
  await writePrCommentFixtureState({ cwd: ROOT, prUrl: PR_URL, collectedSha: HEAD });
  await writeReviewPackage({ cwd: ROOT, flowDir: dir, reviewId: "round-1", head: HEAD, findings: [] });

  const gate = reviewOf((await service.complete({ cwd: ROOT, id })).gates);

  expect(gate.status).toBe("fail");
  const detail = conditionDetail(gate, "external-comments");
  expect(detail).toContain("external-comments (unobserved)");
  expect(detail).toContain("the pull request is not there");
  // The advice points at the PR, not at `gh auth login`.
  expect(detail).toContain(PR_URL);
  expect(gate.detail).not.toContain("gh auth login");
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
  await writeCleanReviewPackage({ cwd: ROOT, flowDir: dir, head: HEAD, prUrl: PR_URL });

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
  await writeCleanReviewPackage({ cwd: ROOT, flowDir: dir, head: HEAD, prUrl: PR_URL });

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
    verificationMode: "off",
  });

  const gate = reviewOf((await service.complete({ cwd: ROOT, id })).gates);

  expect(gate.status).toBe("fail");
  expect(gate.detail).toContain("verifier-stats (violated)");
  expect(gate.detail).toContain("no finding in it was independently checked");
});

/** Terminal on the strength of a recorded human decision — no verifier claim needed. */
function dismissedByHuman(id: string): ReviewFixtureFinding {
  return {
    id,
    severity: "major",
    disposition: {
      state: "dismissed-wont-fix",
      evidence: "human: aleks — accepted as a known limitation, recorded in the flow package",
    },
  };
}

test("AC5/5 — a round that received no claim while retaining a blocking finding is a violation", async () => {
  // MINOR: the condition refused only `verification_mode: off`, on the ground
  // that no verdict was read — and the identical fact holds for `annotate` with
  // zero claims. `annotate` is the DEFAULT and `--verifications` is optional, so
  // a plain `keryx review ingest --report r.md` produced
  // `verification_mode: annotate, claims_received: 0`, and the gate printed
  // "0 claim(s) received" INSIDE the sentence saying the condition held.
  await fresh();
  const service = createFlowService(makeDeps());
  const { id, dir } = await driveToGates(service);
  await writeReviewPackage({
    cwd: ROOT,
    flowDir: dir,
    reviewId: "round-1",
    head: HEAD,
    // Terminal, so condition 2 passes and this assertion names one mechanism.
    findings: [dismissedByHuman("F-001")],
    verificationMode: "annotate",
    claimsReceived: 0,
  });

  const gate = reviewOf((await service.complete({ cwd: ROOT, id })).gates);

  expect(gate.status).toBe("fail");
  expect(gate.detail).toContain("verifier-stats (violated)");
  expect(gate.detail).toContain("received 0 claims");
  expect(gate.detail).toContain("F-001");
  expect(gate.detail).not.toContain("terminal-dispositions (violated)");
});

test("AC5/5 — a round with nothing at or above the floor to verify still passes on 0 claims", async () => {
  // The bound on the rule: a round that retained nothing blocking has verified
  // everything there was, and failing it would refuse the honest clean round.
  await fresh();
  const service = createFlowService(makeDeps());
  const { id, dir } = await driveToGates(service);
  await writeReviewPackage({
    cwd: ROOT,
    flowDir: dir,
    reviewId: "round-1",
    head: HEAD,
    findings: [{ id: "F-001", severity: "info", problem: "a naming nit" }],
    verificationMode: "annotate",
    claimsReceived: 0,
  });

  expect(reviewOf((await service.complete({ cwd: ROOT, id })).gates).status).toBe("pass");
});

test("AC5/5 — a mode line with no claim count is unobserved, not a pass", async () => {
  // The same rule the `verification === null` branch already uses one level up:
  // a record that does not say how much the verifier was given cannot say
  // whether anything was verified.
  await fresh();
  const service = createFlowService(makeDeps());
  const { id, dir } = await driveToGates(service);
  const packageDir = await writeReviewPackage({
    cwd: ROOT,
    flowDir: dir,
    reviewId: "round-1",
    head: HEAD,
    findings: [],
    verificationMode: "annotate",
  });
  const scopePath = path.join(packageDir, "scope.md");
  const scope = (await readFile(scopePath, "utf8")).replace(/^claims_received:.*$/m, "");
  await writeFile(scopePath, scope, "utf8");

  const gate = reviewOf((await service.complete({ cwd: ROOT, id })).gates);

  expect(gate.status).toBe("fail");
  expect(gate.detail).toContain("verifier-stats (unobserved)");
  expect(gate.detail).toContain("no `claims_received:` line");
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
  await writeCleanReviewPackage({ cwd: ROOT, flowDir: dir, head: HEAD, prUrl: PR_URL });

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

test("only `no-tracker` may differ between the two callers of the remedy helper", () => {
  // The helper is SHARED so conditions 3 and 4 cannot tell different stories
  // about one cause — that was round 2's finding. Round 4 then gave it a `caller`
  // parameter, because for `no-tracker` alone the shared advice named a seam
  // condition 3 never reads. A caller parameter is exactly how a shared guarantee
  // gets eroded later: a mutation branching a SECOND arm left 567 tests green.
  //
  // So the guarantee is asserted directly, over every state, rather than being
  // left to the one asymmetry the fix happened to introduce.
  const url = "https://github.com/o/r/pull/7";
  const states: PrHeadResolution[] = [
    { state: "resolved", sha: "a".repeat(40) },
    { state: "no-pr" },
    { state: "tracker-unavailable" },
    { state: "pr-unreachable" },
    { state: "head-unreported" },
  ];

  for (const state of states) {
    expect(prHeadResolutionRemedy(state, url, "head-commit")).toBe(
      prHeadResolutionRemedy(state, url, "external-comments"),
    );
  }

  // Non-vacuity: the one sanctioned asymmetry is still there, and is still
  // advice each condition can act on.
  const noTracker: PrHeadResolution = { state: "no-tracker" };
  const forHead = prHeadResolutionRemedy(noTracker, url, "head-commit");
  const forComments = prHeadResolutionRemedy(noTracker, url, "external-comments");
  expect(forHead).not.toBe(forComments);
  expect(forHead).toContain("--merged");
  expect(forComments).toContain("externalCommentsGate");
});
