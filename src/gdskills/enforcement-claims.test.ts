// Flow 209, AC9 and AC10 — two documents that asserted something untrue, and
// the guards that notice if either sentence comes back.
//
// Both are string checks over shipped Markdown, and a string check is a weak
// instrument. It is the RIGHT instrument here for one reason: the defect in both
// cases IS a sentence. A skill that claims an enforcement nobody wrote and a
// status block that claims a phase nobody shipped are both false statements
// about the code, and the only thing that can catch a false statement returning
// is something that reads the statement.
//
// AC9's guard is more than a string check, and deliberately: it pins the REASON
// the sentence was removed. If `reviewer-input` is ever registered as a contract
// and the dispatch really can be refused, this fails and asks for the claim to
// be restored — so the prose cannot drift in either direction.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { CONTRACTS } from "./contracts";

const REPO_ROOT = path.join(import.meta.dir, "..", "..");

/** Both trees. A skill edit that lands in one of them has diverged. */
const REVIEW_ORCHESTRATOR_SKILLS = [
  path.join(REPO_ROOT, "src", "gdskills", "bundled", "skills", "review", "review-orchestrator", "SKILL.md"),
  path.join(REPO_ROOT, ".metaproject", "skills", "gdskills", "review", "review-orchestrator", "SKILL.md"),
];

const HARDENING_README = path.join(
  REPO_ROOT,
  "docs",
  "requirements",
  "keryx-orchestrator-hardening",
  "README.md",
);

describe("AC9: review-orchestrator does not claim an enforcement that does not exist", () => {
  test("the sweep reads both copies of the skill", () => {
    for (const file of REVIEW_ORCHESTRATOR_SKILLS) {
      expect(readFileSync(file, "utf8").length).toBeGreaterThan(1000);
    }
  });

  test("`prior_findings` is not described as rejected by a schema", () => {
    // The exact sentence that survived the Phase 7 audit which removed its
    // siblings: "the schema rejects the dispatch otherwise". No production
    // TypeScript loads `reviewer-input.schema.json`, and reviewer dispatch is a
    // host-agent action rather than a `keryx` invocation, so there is no point
    // at which a malformed dispatch could be refused.
    for (const file of REVIEW_ORCHESTRATOR_SKILLS) {
      const text = readFileSync(file, "utf8");
      expect(text).not.toContain("the schema rejects the dispatch");
      // Softening the verb is not a resolution, so the weakened forms are
      // refused too: the file must state that NOTHING refuses it.
      expect(text).not.toMatch(/schema\s+(?:may\s+|can\s+|will\s+|should\s+)?rejects?\s+the\s+dispatch/i);
      expect(text).toContain("Nothing refuses a dispatch that omits them");
    }
  });

  test("the reason the claim is false still holds — `reviewer-input` is not a registered contract", () => {
    // The bidirectional half. If somebody registers `reviewer-input` and wires a
    // real refusal, this goes red and the skill's prose has to be revisited,
    // rather than staying pessimistic about an enforcement that now exists.
    expect(CONTRACTS.map((contract) => contract.name)).not.toContain("reviewer-input");
  });
});

describe("AC10: the orchestrator-hardening status block states what shipped", () => {
  test("it no longer says phases 2 through 7 are unstarted", () => {
    const text = readFileSync(HARDENING_README, "utf8");
    const status = text.slice(text.indexOf("## Status"), text.indexOf("## The measured baseline"));

    expect(status.length).toBeGreaterThan(200);
    expect(status).not.toContain("Phases 0 and 1 delivered");
    expect(status).not.toContain("are specified and not started");
    expect(status).toContain("All seven phases delivered");
    expect(status).toContain("0.2.72");
  });

  test("it does not describe a delivered dependency as still missing", () => {
    // "It does not today — `src/review/managed.ts` re-parses findings from
    // Markdown" described the state before `df1e6234`, and stayed in the file
    // for the whole release in which the durable record shipped.
    const text = readFileSync(HARDENING_README, "utf8");
    expect(text).not.toContain("It does not today");
  });

  test("the status block does not claim the eleven measured regressions are closed", () => {
    // The failure mode a status block has: over-correcting from "nothing
    // shipped" to "everything is fine". The 2026-08-31 measurement found eleven
    // defects in the delivered result, and the block says so.
    const text = readFileSync(HARDENING_README, "utf8");
    expect(text).toContain("Delivered is not defect-free");
    expect(text).toContain("eleven");
  });
});
