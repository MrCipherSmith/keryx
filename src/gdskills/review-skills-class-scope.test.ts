// Every reviewer that reports a severity must ask for the CLASS, not one site.
//
// This is a SOURCE-level guard, and the reason is that this flow's own main task
// is a sweep across ~15 skills — the exact per-site shape the flow exists to
// remove. A behavioural check would cover the skills whoever wrote it thought
// of; flow 128 proved that twice (one writer of five, one instruction of four).
// So the denominator comes from the filesystem and the complement must be empty.
//
// Same construction as `config-dir.writers.test.ts` and the command-registry
// coverage guard: derive the set from the code, exempt by name with a stated
// reason, assert nothing is left over.

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const REVIEW_ROOT = path.join(import.meta.dir, "bundled", "skills", "review");

/**
 * Reviewers that use the severity vocabulary but must NOT carry the contract,
 * each with the reason. A name here is a decision, not an oversight — which is
 * the point of listing them rather than filtering them out silently.
 */
const EXEMPT: Record<string, string> = {
  "code-ai-review":
    "legacy opt-in profile (--legacy-profiles); emits a free-prose Russian report with no per-finding severity field, and carries four per-editor SKILL variants that would all have to be kept in step",
  "code-learned-review": "legacy opt-in profile; same free-prose shape as code-ai-review",
  "code-mobx-store-review":
    "legacy opt-in profile; does not use the blocker/major vocabulary at all",
  "code-style-review": "legacy opt-in profile; does not use the blocker/major vocabulary at all",
  "review-pr-feedback":
    "classifies INCOMING human PR comments by severity; it reports on other people's findings and produces none of its own, so there is no class for it to enumerate",
  "review-verifier":
    "checks findings raised by other reviewers and can only DELETE — it cannot add a finding, raise a severity, or change a finding's text, enforced in src/review/verification.ts — so it produces no finding whose class it could enumerate; it READS class_scope to check that the named sites exist",
};

/** Markers the contract section must carry. Both, so a passing mention does not count. */
const REQUIRED_MARKERS = ["class_scope", "required for `blocker` and `major`"];

function reviewerSkills(): string[] {
  return readdirSync(REVIEW_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => existsSync(path.join(REVIEW_ROOT, name, "SKILL.md")))
    .sort();
}

/** A reviewer reports findings if its skill uses the severity vocabulary. */
function reportsFindings(name: string): boolean {
  return readFileSync(path.join(REVIEW_ROOT, name, "SKILL.md"), "utf8").includes("blocker");
}

describe("the orchestrator collects context and records rounds", () => {
  // Prose guards are weaker than the schema ones above, and that is stated
  // rather than glossed: a skill is markdown, so what can be pinned is that the
  // instruction is present and names a command that exists. The enforcement
  // that actually bites lives in reviewer-input.schema.json.
  const skill = readFileSync(path.join(REVIEW_ROOT, "review-orchestrator", "SKILL.md"), "utf8");

  test("the Context Pack requires an accepted-only memory search", () => {
    expect(skill).toContain("keryx memory search");
    expect(skill).toContain("--status accepted");
    // The filter is the whole point: without it a draft hypothesis reaches a
    // reviewer as project truth.
    expect(skill).toMatch(/draft entry is a hypothesis/i);
  });

  test("memory is required, not best-effort", () => {
    expect(skill).toContain("### Memory (required)");
  });

  test("a fix round is scoped to the branch, not to the fix commit", () => {
    expect(skill).toContain("is_fix_round");
    expect(skill).toMatch(/merge-base\.\.HEAD`?, never the fix commit alone/);
    // The second half — enumerating what NAMES the changed thing — is the part
    // that would have caught one instruction of four.
    expect(skill).toMatch(/Enumerate what NAMES the thing the fix changed/);
  });

  test("a fix round must be recorded through the managed-review CLI", () => {
    expect(skill).toContain("keryx review start");
    expect(skill).toContain("keryx review ingest");
    expect(skill).toMatch(/fix round is managed, not optional/i);
  });
});

describe("Wave C verifies by executing; it does not re-score by re-reading (AC6)", () => {
  // `review-strict` re-read the consolidated findings and adjusted their severity
  // with no new evidence, under an elevation table biased 3:1 toward escalation.
  // That operation is MEASURED to degrade accuracy, so it was removed rather than
  // improved — and the numbers are pinned here so nobody restores it as an
  // obvious-looking idea. It looked obvious the first time too.
  const orchestrator = readFileSync(path.join(REVIEW_ROOT, "review-orchestrator", "SKILL.md"), "utf8");

  test("review-strict is gone from the bundle and from the catalog", () => {
    expect(existsSync(path.join(REVIEW_ROOT, "review-strict"))).toBe(false);
    expect(reviewerSkills()).not.toContain("review-strict");
    const catalog = readFileSync(path.join(import.meta.dir, "catalog.ts"), "utf8");
    expect(catalog).not.toContain('skill("review-strict"');
    // Removed from the bundle is not enough: a bundled directory with no catalog
    // entry is never installed, and a catalog entry with no directory installs a
    // generated stub. Both halves have to move together.
    expect(catalog).toContain('skill("review-verifier"');
  });

  test("review-verifier replaced it", () => {
    expect(reviewerSkills()).toContain("review-verifier");
    expect(orchestrator).toContain("review-verifier");
  });

  test("the removal is justified IN THE SKILL, with the measurements", () => {
    // Prose, and weaker than a schema guard — but the alternative is a deletion
    // whose reason lives only in a flow journal nobody reads before re-adding it.
    expect(orchestrator).toMatch(/95\.5\s*→\s*91\.5\s*→\s*89\.0/);
    expect(orchestrator).toMatch(/75\.8\s*→\s*38\.1/);
    expect(orchestrator).toContain("arXiv:2310.01798");
    // Wrapped across a line in the skill, so the whitespace is not pinned.
    expect(orchestrator).toMatch(/\+49\.2 on dialogue[\s\S]{0,60}\+0\.2\s+on maths/);
    expect(orchestrator).toMatch(/no new evidence/i);
    expect(orchestrator).toMatch(/removed, not improved|removed rather than improved/i);
  });

  test("the verifier skill states what it cannot do, and why reasoning is capped", () => {
    const verifier = readFileSync(path.join(REVIEW_ROOT, "review-verifier", "SKILL.md"), "utf8");
    expect(verifier).toMatch(/can only delete/i);
    expect(verifier).toMatch(/never verify your own finding/i);
    expect(verifier).toMatch(/capped at `unverifiable`/i);
    // The counter-example that kills anything vote-shaped.
    expect(verifier).toContain("padding-oracle");
    expect(verifier).toMatch(/never votes|never poll, never vote/i);
    // And the evidence that execution is the method that works.
    expect(verifier).toContain("arXiv:2604.11950");
    expect(verifier).toContain("arXiv:2402.09171");
  });

  test("the orchestrator records the stage counts and forbids a precision claim (AC11/AC15)", () => {
    expect(orchestrator).toContain("## Stage counts");
    expect(orchestrator).toContain("verification_mode");
    expect(orchestrator).toMatch(/no precision baseline exists to improve on/i);
  });
});

describe("every reviewer that reports a severity requires class_scope", () => {
  const all = reviewerSkills();

  test("the denominator is derived from the filesystem and is not empty", () => {
    // If this ever reads 0, every assertion below passes vacuously.
    expect(all.length).toBeGreaterThan(15);
  });

  test("every exemption names a real skill", () => {
    // An exemption for a skill that no longer exists is how a stale exemption
    // silently starts covering nothing — or, after a rename, the wrong thing.
    for (const name of Object.keys(EXEMPT)) {
      expect(all).toContain(name);
    }
  });

  test("no skill that reports findings is missing the contract", () => {
    const missing = all
      .filter((name) => EXEMPT[name] === undefined)
      .filter(reportsFindings)
      .filter((name) => {
        const text = readFileSync(path.join(REVIEW_ROOT, name, "SKILL.md"), "utf8");
        return !REQUIRED_MARKERS.every((marker) => text.includes(marker));
      });
    expect(missing).toEqual([]);
  });

  test("an exempt skill is exempt because of its shape, not because it was skipped", () => {
    // Each exemption claims something checkable: either the skill does not use
    // the vocabulary at all, or it is a legacy opt-in profile. Pin the first
    // half so the reason cannot quietly become false.
    for (const [name, reason] of Object.entries(EXEMPT)) {
      const text = readFileSync(path.join(REVIEW_ROOT, name, "SKILL.md"), "utf8");
      if (reason.includes("does not use the blocker/major vocabulary")) {
        expect(text.includes("blocker")).toBe(false);
      } else {
        expect(reason.length).toBeGreaterThan(40);
      }
    }
  });
});
