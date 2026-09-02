// The Context Pack's two hardest-won rules had no carrier.
//
// `review-orchestrator`'s SKILL.md told reviewers to read `review_context.pr.body`
// and to record cross-repo contracts in `review_context.cross_repo`. The schema
// declared `pr` as a bare `{"type": ["object","null"], "additionalProperties": true}`
// with no properties at all, and declared no `cross_repo` whatsoever — it survived
// only on `additionalProperties: true`. So neither rule could be violated, which
// is a different thing from neither rule being broken: a body that was never
// fetched and a body that was empty were the same value, and a cross-repo fact
// pinned to a branch that had since been squashed still validated clean.
//
// These tests drive real instances through the SHIPPED schemas, because the
// schema files are what a dispatched reviewer is handed. A test that asserted
// against an inline copy would pass while the shipped file drifted.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { validateJson } from "./contracts";

/** `Schema` is module-local in contracts.ts; take it from the function it feeds. */
type Schema = Parameters<typeof validateJson>[1];

const ORCHESTRATOR = path.join(
  import.meta.dir,
  "bundled",
  "skills",
  "review",
  "review-orchestrator",
);

function schema(name: string): Schema {
  return JSON.parse(readFileSync(path.join(ORCHESTRATOR, name), "utf8")) as Schema;
}

const CONTEXT = schema("review-context.schema.json");
const FINDING = schema("reviewer-finding.schema.json");
const SKILL = readFileSync(path.join(ORCHESTRATOR, "SKILL.md"), "utf8");

/** The minimum a `review_context` needs to be valid, so each test varies one thing. */
function baseContext(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    request: { raw: "review this PR" },
    scope: { mode: "diff", files: ["src/api/client.ts"] },
    routing: { selected_reviewers: ["review-backend"] },
    token_policy: { context_mode: "light", omissions: [] },
    ...extra,
  };
}

async function errorsFor(value: unknown, s: Schema = CONTEXT): Promise<string[]> {
  return (await validateJson(value, s)).map((e) => `${e.path}: ${e.message}`);
}

describe("the PR description is a typed field, not a naming convention", () => {
  test("a fetched body validates", async () => {
    expect(
      await errorsFor(
        baseContext({
          pr: {
            number: 431,
            url: "https://github.com/o/r/pull/431",
            title: "narrow the retry window",
            body: "Switches the client to the producer's new timeout.",
            state: "open",
          },
        }),
      ),
    ).toEqual([]);
  });

  test("a null body validates and is distinguishable from an empty one", async () => {
    // Null means the fetch did not happen; "" means the author wrote nothing.
    // Both are legal values and they are NOT the same fact — the second is
    // reportable and the first is a gap in the pack.
    expect(await errorsFor(baseContext({ pr: { number: 1, body: null } }))).toEqual([]);
    expect(await errorsFor(baseContext({ pr: { number: 1, body: "" } }))).toEqual([]);
  });

  test("a non-string body is rejected — before this it was accepted", async () => {
    const errors = await errorsFor(baseContext({ pr: { number: 1, body: { text: "oops" } } }));
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(" ")).toContain("pr.body");
  });

  test("an unknown pr state is rejected", async () => {
    const errors = await errorsFor(baseContext({ pr: { number: 1, state: "landed" } }));
    expect(errors.join(" ")).toContain("pr.state");
  });

  test("pr stays optional — path-mode review has no pull request", async () => {
    expect(await errorsFor(baseContext())).toEqual([]);
    expect(await errorsFor(baseContext({ pr: null }))).toEqual([]);
  });
});

describe("cross_repo can describe a producer that has not merged", () => {
  const merged = {
    repo: "vantage-backend",
    state: "merged",
    sha: "f5219d5d4",
    reason: "DQ report payload: which halves are null vs 0",
    facts: ["sqlScore stays null when the half is absent"],
    merge_order: "independent",
  };

  const open = {
    repo: "vantage-backend",
    state: "open",
    pr: "https://github.com/o/backend/pull/98",
    branch: "feat/new-timeout",
    reason: "the timeout this client now assumes",
    facts: ["requestTimeoutMs default moves 30_000 -> 5_000"],
    merge_order: "producer_first",
    facts_pinned_round: 1,
    revalidated_round: 3,
  };

  test("both a merged and an open producer validate", async () => {
    expect(await errorsFor(baseContext({ cross_repo: [merged, open] }))).toEqual([]);
  });

  test("an unavailable producer is a recordable result, not an omission", async () => {
    expect(
      await errorsFor(
        baseContext({
          cross_repo: [
            {
              repo: "vantage-backend",
              state: "unavailable",
              reason: "the DQ payload shape",
              facts: ["not readable from this checkout; dependent findings held at info"],
            },
          ],
        }),
      ),
    ).toEqual([]);
  });

  test("a merged producer without a sha is rejected", async () => {
    const { sha, ...noSha } = merged;
    const errors = await errorsFor(baseContext({ cross_repo: [noSha] }));
    expect(errors.join(" ")).toContain("sha");
  });

  test("an open producer without a pull request is rejected", async () => {
    // This is the whole point of the `state` split: an open branch is rebased
    // and squashed, so a sha read from it names a commit that will not survive
    // the merge. The pull request is the address that does.
    const { pr, ...noPr } = open;
    const errors = await errorsFor(baseContext({ cross_repo: [noPr] }));
    expect(errors.join(" ")).toContain("pr");
  });

  test("an entry without repo, reason, facts or state is rejected", async () => {
    for (const missing of ["repo", "reason", "facts", "state"] as const) {
      const entry: Record<string, unknown> = { ...merged };
      delete entry[missing];
      const errors = await errorsFor(baseContext({ cross_repo: [entry] }));
      expect(errors.join(" ")).toContain(missing);
    }
  });

  test("an empty facts array is rejected — an entry that read nothing recorded nothing", async () => {
    const errors = await errorsFor(baseContext({ cross_repo: [{ ...merged, facts: [] }] }));
    expect(errors.length).toBeGreaterThan(0);
  });

  test("an unknown state or merge_order is rejected", async () => {
    expect((await errorsFor(baseContext({ cross_repo: [{ ...merged, state: "draft" }] }))).join(" "))
      .toContain("state");
    expect((await errorsFor(baseContext({ cross_repo: [{ ...merged, merge_order: "later" }] }))).join(" "))
      .toContain("merge_order");
  });
});

describe("a finding can name the repository its evidence lives in", () => {
  function report(finding: Record<string, unknown>): Record<string, unknown> {
    return {
      status: "DONE",
      reviewer: "review-backend",
      summary: "one cross-repo claim",
      findings: [
        {
          id: "F-001",
          reviewer: "review-backend",
          severity: "info",
          problem: "the client assumes a 5s producer timeout",
          impact: "a slow producer response is retried instead of awaited",
          suggested_fix: "read the timeout from the producer's config contract",
          evidence: "backend config.ts:42 at PR o/backend#98, head 9a1c2f0",
          confidence: "medium",
          ...finding,
        },
      ],
      stats: { blocker: 0, major: 0, minor: 0, info: 1 },
    };
  }

  test("repo validates on the reviewer-side schema", async () => {
    expect(
      await errorsFor(
        report({ repo: "vantage-backend", file: "src/config.ts", line: 42 }),
        FINDING,
      ),
    ).toEqual([]);
  });

  test("repo stays optional — a local finding names no repository", async () => {
    expect(await errorsFor(report({ file: "src/api/client.ts", line: 9 }), FINDING)).toEqual([]);
    expect(await errorsFor(report({ repo: null, file: "src/api/client.ts" }), FINDING)).toEqual([]);
  });

  test("the registered review-finding contract accepts repo too", async () => {
    // It is `additionalProperties: false`, so a finding carrying `repo` would be
    // REJECTED by the registered contract if the property were declared only on
    // the reviewer-side schema. The two schemas are a pair and drift silently.
    const registered = JSON.parse(
      readFileSync(path.join(import.meta.dir, "contracts", "review-finding.schema.json"), "utf8"),
    ) as Schema;
    const errors = await validateJson(
      {
        id: "F-001",
        reviewer: "review-backend",
        severity: "info",
        repo: "vantage-backend",
        file: "src/config.ts",
        line: 42,
        problem: "the client assumes a 5s producer timeout",
        impact: "a slow producer response is retried instead of awaited",
        suggested_fix: "read the timeout from the producer's config contract",
        evidence: "backend config.ts:42 at PR o/backend#98, head 9a1c2f0",
        confidence: "medium",
      },
      registered,
    );
    expect(errors.map((e) => `${e.path}: ${e.message}`)).toEqual([]);
  });
});

describe("the skill states the rules the schemas now carry", () => {
  test("the Step 1 checklist names the description, memory and cross-repo", () => {
    const step1 = SKILL.split("\n").find((l) => l.startsWith("- [ ] Step 1:"));
    expect(step1).toBeDefined();
    expect(step1!.toLowerCase()).toContain("description");
    expect(step1!.toLowerCase()).toContain("memory");
    expect(step1!.toLowerCase()).toContain("cross-repo");
  });

  test("an open producer that must ship first is a blocker, kept distinct from the deploy-note minor", () => {
    const section = SKILL.slice(SKILL.indexOf("### A producer that has not merged yet"));
    expect(section).toContain("merge_order: producer_first");
    expect(section).toContain("`blocker`");
    // The pre-existing `minor` is about the DESCRIPTION and must survive: the two
    // findings have different subjects and collapsing them loses the operational one.
    expect(section).toContain("`minor`");
  });

  test("the blocker enumeration stays closed at four shapes", () => {
    // The first draft of this change added a FIFTH shape, which would have
    // falsified "not one of the four shapes" in five other reviewer skills that
    // cite this list — the exact unwired-claim defect this flow exists to remove.
    // An unshipped dependency is a crash or a corruption at runtime, so it is
    // already shape 1 or 2 and the enumeration does not have to grow.
    const rubric = SKILL.slice(SKILL.indexOf("### `blocker` — merge-blocking"));
    expect(rubric).toContain("Exactly four shapes");
    expect(SKILL).not.toContain("Exactly five shapes");
    const closed = rubric.slice(0, rubric.indexOf("### `major`"));
    expect(closed).toContain("shape 1 or shape 2");
    expect(closed).toContain("merge_order: producer_first");
  });

  test("no reviewer skill's reference to the four shapes was falsified", () => {
    // The cross-references are prose in other files; the guard is that the
    // number they name still matches the list they name it about.
    const citing = readdirSync(path.join(import.meta.dir, "bundled", "skills", "review"))
      .map((dir) => path.join(import.meta.dir, "bundled", "skills", "review", dir, "SKILL.md"))
      .filter((file) => existsSync(file))
      .filter((file) => /the four shapes/.test(readFileSync(file, "utf8")));
    expect(citing.length).toBeGreaterThan(0); // non-vacuity: these citations exist
    expect(SKILL).toContain("Exactly four shapes");
  });

  test("an open producer is re-read every round rather than pinned once", () => {
    const section = SKILL.slice(SKILL.indexOf("### A producer that has not merged yet"));
    expect(section).toContain("revalidated_round");
    expect(section.toLowerCase()).toContain("every round");
  });

  test("the Stage 1 gate falls back to the PR body and owns the description-vs-diff check", () => {
    const gate = SKILL.slice(SKILL.indexOf("## Stage 1 Gate — Spec Compliance"));
    expect(gate).toContain("### With no issue and no task doc, the PR body is the spec");
    expect(gate).toContain("### This gate owns the description-vs-diff comparison");
    expect(gate).toContain("pr.body");
  });
});

test("every keyword these schemas declare is one the validator implements", () => {
  // The registry guard in contract-keywords.test.ts covers CONTRACTS only, and
  // none of review-orchestrator's schemas are registered — so the keywords added
  // here (`enum`, `if`/`then`, `const`, `minItems`) were outside every existing
  // check. Scraped from the validator source rather than hand-listed, for the
  // reason that test records: a hand-listed set is one more thing that drifts.
  const source = readFileSync(path.join(import.meta.dir, "contracts.ts"), "utf8");
  const implemented = new Set<string>();
  for (const match of source.matchAll(/\bschema\.([$a-zA-Z][a-zA-Z0-9_]*)/g)) implemented.add(match[1]!);
  expect(implemented.has("if")).toBe(true);
  expect(implemented.has("enum")).toBe(true);
  expect(implemented.has("minItems")).toBe(true);

  const annotations = new Set([
    "$schema", "$id", "$comment", "title", "description", "examples", "default",
    "deprecated", "readOnly", "writeOnly", "$defs", "definitions", "format",
  ]);

  function declared(node: unknown, into: Set<string>): void {
    if (Array.isArray(node)) {
      for (const entry of node) declared(entry, into);
      return;
    }
    if (typeof node !== "object" || node === null) return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === "properties" || key === "definitions" || key === "$defs") {
        for (const child of Object.values((value ?? {}) as Record<string, unknown>)) declared(child, into);
        continue;
      }
      into.add(key);
      declared(value, into);
    }
  }

  const offenders: string[] = [];
  for (const name of ["review-context.schema.json", "reviewer-finding.schema.json"]) {
    const keywords = new Set<string>();
    declared(schema(name), keywords);
    expect(keywords.size).toBeGreaterThan(5); // non-vacuity: the walk read something
    for (const keyword of [...keywords].sort()) {
      if (annotations.has(keyword) || implemented.has(keyword)) continue;
      offenders.push(`${name} declares \`${keyword}\`, which validateValue never reads`);
    }
  }
  expect(offenders).toEqual([]);
});
