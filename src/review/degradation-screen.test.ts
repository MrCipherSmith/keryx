import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { READY_DISPATCH } from "./dispatch.test-helpers";
import {
  DEGRADATION_NO_EVIDENCE_RULE,
  degradationScreenRecord,
  renderDegradationScreenLines,
  renderDegradationScreenMarkdown,
  screenDegradationFindings,
} from "./degradation";
import { createManagedReviewPackage, type ManagedReviewIngestInput } from "./managed";
import type { StructuredReviewFinding } from "./types";

function finding(over: Partial<StructuredReviewFinding> = {}): StructuredReviewFinding {
  return {
    id: "D-001",
    reviewer: "review-degradation",
    severity: "major",
    problem: "an Escape key press handled by a nested popup now also closes the parent",
    impact: "the parent dialog disappears while the user is editing in the popup",
    suggested_fix: "stop the event at the popup",
    evidence: "pressed Escape in the popup on head and on base",
    confidence: "high",
    file: "src/popup.ts",
    class_scope: { sites: ["src/popup.ts:10"], enumeration_method: "every handler registered on the popup" },
    degradation_class: "behaviour-delta",
    ...over,
  };
}

test("AC4: a major without evidence_kind is downgraded to info and marked, not dropped", () => {
  const result = screenDegradationFindings([finding()]);

  expect(result.retained).toHaveLength(1);
  expect(result.retained[0]?.severity).toBe("info");
  expect(result.retained[0]?.evidence_screen).toEqual({ rule: DEGRADATION_NO_EVIDENCE_RULE, original_severity: "major" });
  expect(result.downgraded).toHaveLength(1);
  expect(result.downgraded[0]).toMatchObject({ rule: "degradation-no-evidence", from: "major", to: "info" });
  expect(result.screened).toBe(1);
});

test("AC4: a blocker without evidence_kind is downgraded too, and stops blocking the merge", () => {
  const result = screenDegradationFindings([finding({ severity: "blocker", blocking_merge: true })]);

  expect(result.retained[0]?.severity).toBe("info");
  expect(result.retained[0]?.blocking_merge).toBe(false);
  expect(result.retained[0]?.evidence_screen?.original_severity).toBe("blocker");
});

test("AC4: a finding with an evidence kind keeps its severity", () => {
  const input = [finding({ evidence_kind: "probe" }), finding({ id: "D-002", severity: "blocker", evidence_kind: "red-test" })];
  const result = screenDegradationFindings(input);

  expect(result.retained.map((entry) => entry.severity)).toEqual(["major", "blocker"]);
  expect(result.retained.every((entry) => entry.evidence_screen === undefined)).toBe(true);
  expect(result.downgraded).toHaveLength(0);
  expect(result.screened).toBe(2);
});

test("AC4: an evidence kind outside the closed list counts as no evidence", () => {
  const result = screenDegradationFindings([finding({ evidence_kind: "vibes" as never })]);

  expect(result.retained[0]?.severity).toBe("info");
});

test("AC4: minor and info findings are not the screen's business and are returned as given", () => {
  const minor = finding({ id: "D-003", severity: "minor" });
  const info = finding({ id: "D-004", severity: "info" });
  const result = screenDegradationFindings([minor, info]);

  expect(result.retained[0]).toBe(minor);
  expect(result.retained[1]).toBe(info);
  expect(result.downgraded).toHaveLength(0);
});

test("AC4: findings of other reviewers are not touched, whatever fields they carry", () => {
  const regression = finding({ id: "R-001", reviewer: "review-regression" });
  const logic = finding({ id: "L-001", reviewer: "review-logic", degradation_class: "debt" });
  const result = screenDegradationFindings([regression, logic]);

  expect(result.retained[0]).toBe(regression);
  expect(result.retained[1]).toBe(logic);
  expect(result.screened).toBe(0);
  expect(result.downgraded).toHaveLength(0);
});

test("AC4: the reviewer is matched by containment on a normalised name", () => {
  const result = screenDegradationFindings([finding({ reviewer: "Review_Degradation (deep)" })]);

  expect(result.downgraded).toHaveLength(1);
});

test("AC4: the record names the rule on its own heading, and the terminal gets the same lines", () => {
  const record = degradationScreenRecord(screenDegradationFindings([finding(), finding({ id: "D-002", evidence_kind: "probe" })]));
  const markdown = renderDegradationScreenMarkdown(record);
  const lines = renderDegradationScreenLines(record);

  expect(markdown).toContain("## Degradation evidence screen");
  expect(markdown).toContain("rule: degradation-no-evidence");
  expect(markdown).toContain("screened: 2");
  expect(markdown).toContain("downgraded: 1");
  expect(markdown).toContain("| D-001 | review-degradation | degradation-no-evidence | major | info |");
  expect(markdown).not.toContain("| D-002 |");
  expect(lines[0]).toBe("degradation screen: screened=2 downgraded=1");
  expect(lines[1]).toContain("downgraded D-001 major -> info [degradation-no-evidence]");
});

test("AC4: a round with no degradation finding still writes the block, and says the screen found nothing to judge", () => {
  const record = degradationScreenRecord(screenDegradationFindings([]));

  expect(renderDegradationScreenMarkdown(record)).toContain("screened: 0");
  expect(renderDegradationScreenMarkdown(record)).toContain("no `review-degradation` finding in this round");
  expect(renderDegradationScreenLines(record)).toEqual([]);
});

// ---------------------------------------------------------------------------
// Through `keryx review ingest`
// ---------------------------------------------------------------------------

let ROOT = "";

afterEach(async () => {
  if (ROOT) {
    await rm(ROOT, { recursive: true, force: true });
    ROOT = "";
  }
});

async function ingest(reviewId: string, findings: StructuredReviewFinding[]) {
  ROOT = await realpath(await mkdtemp(path.join(tmpdir(), "gd-degradation-")));
  await mkdir(path.join(ROOT, ".metaproject"), { recursive: true });
  await mkdir(path.join(ROOT, "docs", "requirements", "managed-review-feedback-loop", "schemas"), { recursive: true });
  await writeFile(
    path.join(ROOT, "docs", "requirements", "managed-review-feedback-loop", "schemas", "managed-review-package.schema.json"),
    `{"type":"object"}`,
    "utf8",
  );
  const input: ManagedReviewIngestInput = {
    cwd: ROOT,
    mode: "ingest",
    reviewId,
    target: { kind: "report", ref: "review.md" },
    reportText: "# Round\n\nno machine-readable block here\nEvidence level: static only — did not run: tests\n",
    findings,
    research: { version: 1, scopeReviewed: true, rawReconciled: true, obligations: [], dispatch: READY_DISPATCH },
    now: new Date("2026-10-28T11:00:00Z"),
  };
  const result = await createManagedReviewPackage(input);
  return {
    result,
    scope: await readFile(path.join(ROOT, result.path, "scope.md"), "utf8"),
    findings: JSON.parse(await readFile(path.join(ROOT, result.path, "findings.json"), "utf8")) as StructuredReviewFinding[],
  };
}

test("AC4: ingest lowers the unproven major, keeps the proven one, and lists the lowered one in scope.md", async () => {
  const { result, scope, findings } = await ingest("2026-10-28-degradation", [
    finding({ id: "D-001" }),
    finding({ id: "D-002", evidence_kind: "consumer-trace", problem: "an empty value now falls to a different placeholder in every consumer" }),
    finding({ id: "R-001", reviewer: "review-logic", class_scope: undefined, severity: "minor" }),
  ]);

  const byId = new Map(findings.map((entry) => [entry.id, entry]));
  expect(byId.get("D-001")?.severity).toBe("info");
  expect(byId.get("D-001")?.evidence_screen).toEqual({ rule: "degradation-no-evidence", original_severity: "major" });
  expect(byId.get("D-001")?.degradation_class).toBe("behaviour-delta");
  expect(byId.get("D-002")?.severity).toBe("major");
  expect(byId.get("D-002")?.evidence_kind).toBe("consumer-trace");
  expect(byId.get("R-001")?.severity).toBe("minor");

  expect(scope).toContain("## Degradation evidence screen");
  expect(scope).toContain("| D-001 | review-degradation | degradation-no-evidence | major | info |");
  expect(result.degradationScreen.downgraded.map((entry) => entry.id)).toEqual(["D-001"]);
});

test("AC4: ingest writes the heading even when no degradation finding was raised", async () => {
  const { scope } = await ingest("2026-10-28-degradation-none", [finding({ id: "L-001", reviewer: "review-logic", severity: "minor" })]);

  expect(scope).toContain("## Degradation evidence screen");
  expect(scope).toContain("screened: 0");
});
