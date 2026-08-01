// A fix round must be dispatched WITH the findings it is answering.
//
// Eleven review rounds across flows 127 and 128 were dispatched without them.
// Twice in a row the round produced a fix that repaired the site a finding named
// and left its siblings, and the NEXT round found those siblings — which reads
// as "reviewers keep finding problems in fixes" and is actually "no reviewer was
// ever told what the previous one found".
//
// The requirement is conditional: a first-pass review has no prior findings and
// must not be forced to invent an empty array's worth of ceremony.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { validateJson } from "./contracts";

const SCHEMA = JSON.parse(
  readFileSync(
    path.join(
      import.meta.dir,
      "bundled",
      "skills",
      "review",
      "review-orchestrator",
      "reviewer-input.schema.json",
    ),
    "utf8",
  ),
) as Record<string, unknown>;

function baseInput(): Record<string, unknown> {
  return {
    review_context: {
      request: { raw: "review the fix" },
      scope: { mode: "diff", files: ["src/lib/config-dir.ts"] },
      routing: { selected_reviewers: ["review-security-code"] },
      token_policy: { context_mode: "light", omissions: [] },
    },
    reviewer: "review-security-code",
    scope_mode: "diff",
    model_class: "normal",
    budget: { max_findings: 20 },
  };
}

const PRIOR = [
  {
    round: 1,
    finding: {
      id: "F-001",
      reviewer: "review-security-code",
      severity: "major",
      problem: "the shared config directory is created group-writable",
      impact: "any member of the operator's group can replace auth.json",
      suggested_fix: "route every writer through ensureKeryxConfigDir",
      evidence: "measured 0775 under umask 002",
      confidence: "high",
      class_scope: {
        sites: ["src/lib/shell-config.ts", "src/session/store.ts"],
        enumeration_method: "grep for the config-path resolvers; 7 writers, 2 unguarded",
      },
    },
    claimed_disposition: "fixed",
    claimed_evidence: "config-dir.permissions.test.ts drives every writer under umask 002",
  },
];

const METAPROJECT = {
  memory: [
    {
      path: ".metaproject/memory/lessons/a-fix-round-needs-its-own-review.md",
      type: "lesson",
      status: "accepted",
      title: "A fix round needs its own review",
    },
  ],
};

describe("reviewer-input requires prior findings on a fix round", () => {
  test("a first-pass review needs neither prior_findings nor metaproject", async () => {
    expect(await validateJson(baseInput(), SCHEMA)).toEqual([]);
  });

  test("is_fix_round: false is still a first pass", async () => {
    expect(await validateJson({ ...baseInput(), is_fix_round: false }, SCHEMA)).toEqual([]);
  });

  test("a fix round WITHOUT prior_findings is rejected", async () => {
    const errors = await validateJson({ ...baseInput(), is_fix_round: true, metaproject: METAPROJECT }, SCHEMA);
    expect(errors.some((e) => e.path.includes("prior_findings"))).toBe(true);
  });

  test("a fix round WITHOUT metaproject is rejected", async () => {
    const errors = await validateJson({ ...baseInput(), is_fix_round: true, prior_findings: PRIOR }, SCHEMA);
    expect(errors.some((e) => e.path.includes("metaproject"))).toBe(true);
  });

  test("a fix round with both is accepted", async () => {
    const errors = await validateJson(
      { ...baseInput(), round: 2, is_fix_round: true, prior_findings: PRIOR, metaproject: METAPROJECT },
      SCHEMA,
    );
    expect(errors).toEqual([]);
  });

  test("a prior finding is validated as a real finding, not an opaque blob", async () => {
    // The `$ref` must actually resolve. If it silently did not, a prior finding
    // could carry anything and the reviewer would be handed junk — the same
    // decorative-guard shape this flow exists to remove.
    const broken = structuredClone(PRIOR) as Array<{ finding: Record<string, unknown> }>;
    delete broken[0]!.finding.class_scope;
    const errors = await validateJson(
      { ...baseInput(), is_fix_round: true, prior_findings: broken, metaproject: METAPROJECT },
      SCHEMA,
    );
    // A `major` without class_scope is invalid under the finding contract, so
    // the ref resolved and the conditional inside it fired.
    expect(errors.some((e) => e.path.includes("class_scope"))).toBe(true);
  });

  test("memory entries that are not accepted are rejected", async () => {
    const errors = await validateJson(
      {
        ...baseInput(),
        is_fix_round: true,
        prior_findings: PRIOR,
        metaproject: {
          memory: [{ ...METAPROJECT.memory[0], status: "draft" }],
        },
      },
      SCHEMA,
    );
    expect(errors.some((e) => e.path.includes("status"))).toBe(true);
  });
});
