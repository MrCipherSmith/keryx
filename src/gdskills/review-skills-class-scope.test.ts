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
  "code-b091-review": "legacy opt-in profile; same free-prose shape as code-ai-review",
  "code-mobx-store-review":
    "legacy opt-in profile; does not use the blocker/major vocabulary at all",
  "code-style-review": "legacy opt-in profile; does not use the blocker/major vocabulary at all",
  "review-pr-feedback":
    "classifies INCOMING human PR comments by severity; it reports on other people's findings and produces none of its own, so there is no class for it to enumerate",
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
