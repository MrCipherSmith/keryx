// The dismissal taxonomy's far end (flow 207, AC4-AC6).
//
// The roadmap's finding was not that the taxonomy was wrong — it was that
// `.metaproject/memory/review-notes/` did not exist, so the `review-note` type
// had never been written and the learning loop had produced nothing at all.
// These tests drive the real pipeline into that folder and then assert the two
// things that keep the signal worth having: that only `dismissed-incorrect`
// reaches it (AC4), and that an unattested dismissal does not (AC6).

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { reviewCommand } from "../commands/review";
import { findingVerdict } from "../flow/review-gate";
import { collectEntries } from "../memory/store";
import { completeManagedReview, createManagedReviewPackage, type ManagedReviewIngestInput } from "./managed";
import {
  attestDismissal,
  isModelErrorState,
  modelErrorSignal,
  reviewNotesDir,
  MODEL_ERROR_STATES,
} from "./review-notes";
import { FINDING_DISMISSAL_STATES } from "./types";
import type { StructuredReviewFinding } from "./types";

const ORIGINAL_CWD = process.cwd();
let ROOT = "";
let logs: string[] = [];
const realLog = console.log;

beforeEach(async () => {
  ROOT = await mkdtemp(path.join(tmpdir(), "gd-review-notes-"));
  await mkdir(path.join(ROOT, ".metaproject"), { recursive: true });
  await mkdir(path.join(ROOT, "docs", "requirements", "managed-review-feedback-loop", "schemas"), { recursive: true });
  await writeFile(
    path.join(ROOT, "docs", "requirements", "managed-review-feedback-loop", "schemas", "managed-review-package.schema.json"),
    await readFile(
      path.join(
        ORIGINAL_CWD,
        "docs",
        "requirements",
        "managed-review-feedback-loop",
        "schemas",
        "managed-review-package.schema.json",
      ),
      "utf8",
    ),
    "utf8",
  );
  logs = [];
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  process.exitCode = 0;
});

afterEach(async () => {
  console.log = realLog;
  process.chdir(ORIGINAL_CWD);
  process.exitCode = 0;
  if (ROOT) {
    await rm(ROOT, { recursive: true, force: true });
    ROOT = "";
  }
});

const FINDING: StructuredReviewFinding = {
  id: "F-001",
  reviewer: "review-security-code",
  severity: "minor",
  problem: "the guard asserts on a synthetic context",
  impact: "the guard passes when the production path is unwired",
  suggested_fix: "drive the writer the CLI drives",
  evidence: "deleted the guarded line; the test stayed green",
  confidence: "high",
};

async function ingest(reviewId: string, over: Partial<ManagedReviewIngestInput> = {}): Promise<string> {
  const result = await createManagedReviewPackage({
    cwd: ROOT,
    mode: "ingest",
    reviewId,
    target: { kind: "report", ref: "review.md" },
    reportText: "# Round\n\nno machine-readable block here\n",
    findings: [FINDING],
    now: new Date("2026-08-30T11:00:00Z"),
    ...over,
  });
  return result.path;
}

async function notes(): Promise<string[]> {
  const dir = reviewNotesDir(ROOT);
  try {
    return (await readdir(dir)).sort();
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// AC4: only `dismissed-incorrect` is model error
// ---------------------------------------------------------------------------

test("AC4: only `dismissed-incorrect` is a model-error state, and the list says why", () => {
  expect([...MODEL_ERROR_STATES]).toEqual(["dismissed-incorrect"]);
  // The other three dismissals are correct findings the team chose not to act
  // on. Enumerated from the shared constant so a fifth dismissal state added
  // later cannot quietly default into the signal.
  for (const state of FINDING_DISMISSAL_STATES) {
    expect(isModelErrorState(state)).toBe(state === "dismissed-incorrect");
  }
  expect(isModelErrorState("answered-disagree")).toBe(false);
  expect(isModelErrorState(undefined)).toBe(false);
});

test("AC4: a `dismissed-wont-fix` finding contributes nothing to the model-error signal", () => {
  const signal = modelErrorSignal([
    { ...FINDING, id: "F-001", disposition: { state: "dismissed-wont-fix", evidence: "human: alice deferred it" } },
    { ...FINDING, id: "F-002", disposition: { state: "dismissed-out-of-scope", evidence: "human: alice" } },
    { ...FINDING, id: "F-003", disposition: { state: "dismissed-deprioritised", evidence: "human: alice" } },
    { ...FINDING, id: "F-004", disposition: { state: "acted-on", evidence: "closed by 380bf3b09" } },
  ]);

  expect(signal.model_error).toBe(0);
  expect(signal.dismissed_not_model_error).toBe(3);
  // And the four states stay distinguishable rather than collapsing into one
  // `dismissed` bucket, which is what makes a dismissal rate unreadable.
  expect(signal.by_state).toEqual({
    "dismissed-wont-fix": 1,
    "dismissed-out-of-scope": 1,
    "dismissed-deprioritised": 1,
  });

  const withError = modelErrorSignal([
    { ...FINDING, id: "F-005", disposition: { state: "dismissed-incorrect", evidence: "human: alice; it never reproduced" } },
  ]);
  expect(withError.model_error).toBe(1);
});

test("AC4: a `dismissed-wont-fix` finding writes no review-note, through the real close", async () => {
  // The signal-level assertion above is not enough on its own: the leak that
  // would matter is a WRITER that treats all four states alike, and only the
  // pipeline can show that.
  const pkg = await ingest("2026-08-30-notes-wont-fix");
  await completeManagedReview(ROOT, pkg, {
    dispositions: [
      { finding: "F-001", state: "dismissed-wont-fix", evidence: "human: alice — correct, and not this quarter" },
    ],
    now: new Date("2026-08-30T12:00:00Z"),
  });

  expect(await notes()).toEqual([]);
});

// ---------------------------------------------------------------------------
// AC5: the pipeline writes the folder the roadmap records as empty
// ---------------------------------------------------------------------------

test("AC5: closing a round as `dismissed-incorrect` writes a review-note naming the finding, the reason and the round", async () => {
  const pkg = await ingest("2026-08-30-notes-incorrect");
  const result = await completeManagedReview(ROOT, pkg, {
    dispositions: [
      {
        finding: "F-001",
        state: "dismissed-incorrect",
        evidence: "human: alice ran the guard under the production path; the claim does not reproduce",
      },
    ],
    now: new Date("2026-08-30T12:00:00Z"),
  });

  expect(await notes()).toEqual(["2026-08-30-notes-incorrect__F-001.md"]);
  expect(result.reviewNotes.written).toEqual([
    {
      finding: "2026-08-30-notes-incorrect#F-001",
      path: path.join(".metaproject", "memory", "review-notes", "2026-08-30-notes-incorrect__F-001.md"),
      attestation: "human",
    },
  ]);

  const note = await readFile(path.join(reviewNotesDir(ROOT), "2026-08-30-notes-incorrect__F-001.md"), "utf8");
  // The three things AC5 requires by name.
  expect(note).toContain("2026-08-30-notes-incorrect#F-001");
  expect(note).toContain("alice ran the guard under the production path");
  expect(note).toContain("2026-08-30-notes-incorrect");
  expect(note).toContain("review-security-code");
});

test("AC5: the note is a memory entry the memory module actually reads", async () => {
  // A file in the right folder that `collectEntries` cannot parse would satisfy
  // "the folder is written" and nothing else — which is the shape of every
  // defect this programme exists to end.
  const pkg = await ingest("2026-08-30-notes-parseable");
  await completeManagedReview(ROOT, pkg, {
    dispositions: [
      { finding: "F-001", state: "dismissed-incorrect", evidence: "human: alice; it never reproduced" },
    ],
    now: new Date("2026-08-30T12:00:00Z"),
  });

  const entries = await collectEntries(ROOT);
  expect(entries).toHaveLength(1);
  const entry = entries[0];
  expect(entry?.type).toBe("review-note");
  expect(entry?.relativePath).toBe("review-notes/2026-08-30-notes-parseable__F-001.md");
  expect(entry?.version).toBe("0.1.0");
  // `keryx memory check` fails an entry with an empty summary or no version.
  expect(entry?.summary).not.toBe("");
  // Draft, not accepted: only `accepted` entries influence skills, and an
  // automatically written record is the thing a person should promote.
  expect(entry?.status).toBe("draft");
});

test("AC5: an applied `refuted` verdict writes the note at ingest, attested by the verifier", async () => {
  // The other producer. In `filter` mode `managed.ts` writes
  // `dismissed-incorrect` from the verifier's verdict, and a writer wired only
  // to `review complete` would leave that half producing model errors nothing
  // learns from.
  const result = await createManagedReviewPackage({
    cwd: ROOT,
    mode: "ingest",
    reviewId: "2026-08-30-notes-filtered",
    target: { kind: "report", ref: "review.md" },
    reportText: "# Round\n\nno machine-readable block here\n",
    findings: [FINDING],
    verificationMode: "filter",
    verifications: [
      {
        finding: "F-001",
        verdict: "refuted",
        method: "execution",
        evidence: "ran the guard under the production path; it does not assert on a synthetic context",
        verifier: "review-verifier",
      },
    ],
    now: new Date("2026-08-30T11:00:00Z"),
  });

  expect(result.reviewNotes.written.map((note) => note.attestation)).toEqual(["verifier"]);
  expect(await notes()).toEqual(["2026-08-30-notes-filtered__F-001.md"]);
  const note = await readFile(path.join(reviewNotesDir(ROOT), "2026-08-30-notes-filtered__F-001.md"), "utf8");
  expect(note).toContain("Attested by: verifier — review-verifier (execution)");
});

test("AC5: `keryx review complete` says on the terminal where the note went", async () => {
  process.chdir(ROOT);
  const pkg = await ingest("2026-08-30-notes-cli");
  logs = [];

  await reviewCommand([
    "complete",
    pkg,
    "--finding",
    "F-001",
    "--disposition",
    "dismissed-incorrect",
    "--evidence",
    "human: alice; the claim does not reproduce",
  ]);

  expect(process.exitCode).toBe(0);
  expect(logs.join("\n")).toContain("review-note: 2026-08-30-notes-cli#F-001 ->");
  expect(logs.join("\n")).toContain("attested by human");
});

test("AC5: `keryx review complete` says out loud when a dismissal reached no note", async () => {
  // The documented line. A refusal an operator has to read source to discover is
  // a refusal that reads, on the terminal they were looking at, as success.
  process.chdir(ROOT);
  const pkg = await ingest("2026-08-30-notes-cli-skip");
  logs = [];

  await reviewCommand([
    "complete",
    pkg,
    "--finding",
    "F-001",
    "--disposition",
    "dismissed-incorrect",
    "--evidence",
    "on reflection this looked wrong to me",
  ]);

  expect(process.exitCode).toBe(0);
  expect(logs.join("\n")).toContain("review-note NOT written for 2026-08-30-notes-cli-skip#F-001:");
  expect(await notes()).toEqual([]);
});

test("AC5: re-closing the same round overwrites its own note rather than accumulating one per run", async () => {
  const pkg = await ingest("2026-08-30-notes-idempotent");
  const disposition = {
    finding: "F-001",
    state: "dismissed-incorrect" as const,
    evidence: "human: alice; the claim does not reproduce",
  };
  await completeManagedReview(ROOT, pkg, { dispositions: [disposition], now: new Date("2026-08-30T12:00:00Z") });
  await completeManagedReview(ROOT, pkg, { dispositions: [disposition], now: new Date("2026-08-30T13:00:00Z") });

  expect(await notes()).toEqual(["2026-08-30-notes-idempotent__F-001.md"]);
});

// ---------------------------------------------------------------------------
// AC6: a dismissal still requires a recorded human decision
// ---------------------------------------------------------------------------

test("AC6: an unattested `dismissed-incorrect` writes NO note, and the refusal is named", async () => {
  // The `--refuted` channel with prose evidence and nobody behind it: the round
  // filing its own finding as its own error. It is still RECORDED — the record
  // of a dismissal is what flow 202 built — but it does not become a learning
  // signal, because nothing checked it and nobody signed it.
  const result = await createManagedReviewPackage({
    cwd: ROOT,
    mode: "ingest",
    reviewId: "2026-08-30-notes-unattested",
    target: { kind: "report", ref: "review.md" },
    reportText: "# Round\n\nno machine-readable block here\n",
    findings: [FINDING],
    refuted: [
      {
        ...FINDING,
        id: "F-009",
        problem: "claimed the writer is group-writable",
        disposition: { state: "dismissed-incorrect", evidence: "on reflection this looked wrong to me" },
      },
    ],
    now: new Date("2026-08-30T11:00:00Z"),
  });

  // Recorded in findings.json...
  const findings = JSON.parse(
    await readFile(path.join(ROOT, result.path, "findings.json"), "utf8"),
  ) as StructuredReviewFinding[];
  expect(findings.find((finding) => finding.id === "F-009")?.disposition?.state).toBe("dismissed-incorrect");
  // ...and NOT in the learning loop.
  expect(await notes()).toEqual([]);
  expect(result.reviewNotes.written).toEqual([]);
  expect(result.reviewNotes.skipped).toHaveLength(1);
  expect(result.reviewNotes.skipped[0]?.reason).toContain("may not file a finding as its own error on its own authority");
});

test("AC6: naming the human turns the same dismissal into a note", async () => {
  // The complement. Without it the test above is satisfied by a writer that
  // never writes anything.
  const result = await createManagedReviewPackage({
    cwd: ROOT,
    mode: "ingest",
    reviewId: "2026-08-30-notes-attested",
    target: { kind: "report", ref: "review.md" },
    reportText: "# Round\n\nno machine-readable block here\n",
    findings: [FINDING],
    refuted: [
      {
        ...FINDING,
        id: "F-009",
        problem: "claimed the writer is group-writable",
        disposition: {
          state: "dismissed-incorrect",
          evidence: "decided-by: alice — ran the writer under umask 002; the mode is 0700",
        },
      },
    ],
    now: new Date("2026-08-30T11:00:00Z"),
  });

  expect(result.reviewNotes.skipped).toEqual([]);
  expect(result.reviewNotes.written.map((note) => note.attestation)).toEqual(["human"]);
});

test("AC6: the attestation rule agrees with the review gate's, driven rather than asserted", () => {
  // The gate holds `dismissed-wont-fix` to "the evidence must name who decided".
  // This module holds `dismissed-incorrect` to the same rule, and the two
  // patterns are declared in different files — so this drives `findingVerdict`
  // and compares, rather than restating the regex and hoping.
  const cases = [
    "human: alice decided this",
    "decided-by: bob",
    "approved-by: carol",
    "operator: dave",
    "owner = erin",
    "on reflection this looked wrong to me",
    "we discussed it and moved on",
    "human",
    "human:",
  ];

  for (const evidence of cases) {
    const gateAccepts = findingVerdict({
      id: "F-001",
      severity: "minor",
      round: "r1",
      disposition: { state: "dismissed-wont-fix", evidence },
    }).terminal;
    const attested = attestDismissal({ ...FINDING, disposition: { state: "dismissed-incorrect", evidence } }).kind;
    expect([evidence, attested === "human"]).toEqual([evidence, gateAccepts]);
  }
});

test("AC6: a verifier `refuted` verdict with no evidence is not an attestation", () => {
  // The verifier branch has to be as strict as the gate's, which requires a
  // method AND evidence. A bare `refuted` would let a claim with nothing behind
  // it manufacture a learning note.
  expect(
    attestDismissal({
      ...FINDING,
      disposition: { state: "dismissed-incorrect", evidence: "refuted" },
      verification: { verdict: "refuted", method: "execution", evidence: "   " },
    }).kind,
  ).toBe("none");
  expect(
    attestDismissal({
      ...FINDING,
      disposition: { state: "dismissed-incorrect", evidence: "refuted" },
      verification: { verdict: "confirmed", method: "execution", evidence: "it reproduces" },
    }).kind,
  ).toBe("none");
});
