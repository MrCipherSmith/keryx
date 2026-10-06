// Flow 405: a review finds every defect of a change in the fewest rounds.
//
// Two orchestrated rounds approved vantage-frontend PR #7357 with two cosmetic
// minors; the next human round filed six real findings, every one reachable from
// the diff and the backend at a pinned SHA. The rounds lost them step by step: one
// subagent with no dispatch tool reviewed alone, the fan-out was cut by diff size,
// the dispatch paraphrased the backend contract, whole surfaces were marked "do
// not re-raise", and a verified-clean line rested on nothing. Each rule below
// closes one of those steps, and each test pins the rule where an agent reads it —
// the shipped bundled files, not a copy.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { validateJson } from "./contracts";

type Schema = Parameters<typeof validateJson>[1];

const BUNDLED = path.join(import.meta.dir, "bundled");
const ENGINE = path.join(BUNDLED, "skills", "review", "review-orchestrator");

function read(...parts: string[]): string {
  return readFileSync(path.join(...parts), "utf8");
}

const SKILL = read(ENGINE, "SKILL.md");
const DETAIL = read(ENGINE, "SKILL.detail.md");
const FLOW = read(BUNDLED, "skills", "orchestration", "flow-orchestrator", "SKILL.md");
const MODELS = read(BUNDLED, "rules", "core", "model-selection.mdc");
const CONTEXT = JSON.parse(read(ENGINE, "review-context.schema.json")) as Schema;

/** From `heading` up to the next heading of the same or a higher level. */
function section(text: string, heading: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line === heading);
  expect(start).toBeGreaterThanOrEqual(0);
  const level = /^#+/.exec(heading)?.[0].length ?? 0;
  const end = lines.findIndex((line, i) => i > start && new RegExp(`^#{1,${level}} `).test(line));
  return lines.slice(start, end === -1 ? undefined : end).join("\n");
}

const START_MAIN = section(SKILL, "### Start questions (Step 5)");
const START_DETAIL = section(DETAIL, "## Start questions (Step 5) — once per round, after the context pack");
const DEPTH = section(DETAIL, "## Depth floor — a gating round does not degrade");
const COUNTERPART = section(DETAIL, "## Counterpart verification — the contract is enumerated, not summarised");
const OBLIGATIONS = section(DETAIL, "## Round obligations — always on, never asked");

describe("AC1: start questions, once, after the context pack and the scope", () => {
  test("Step 5 of the workflow is the start questions, with their three defaults", () => {
    const step5 = SKILL.split("\n").find((line) => line.startsWith("- [ ] Step 5:")) ?? "";
    expect(step5).toContain("Start questions, once, after Steps 1 and 3");
    expect(step5).toContain("reviewers (default `--all`)");
    expect(step5).toContain("counterpart verification (default on)");
    expect(step5).toContain("model plan");
  });

  test("the main file asks after Steps 1 and 3, in one interaction, with the defaults", () => {
    expect(START_MAIN).toContain("Ask once, after the context pack (Step 1) and the scope (Step 3), in one interaction");
    expect(START_MAIN).toContain("`AskUserQuestion` call on Claude Code");
    expect(START_MAIN).toContain("**Reviewers** — default `--all`");
    expect(START_MAIN).toContain("ON by default even with no link");
    expect(START_MAIN).toContain("accept (default), all `deep`, or custom. Once per round.");
    expect(START_MAIN).toContain("Unattended rounds ask nothing: `--all`, counterpart verified, computed models");
  });

  test("the lettered prompt for other hosts defaults to the same answers", () => {
    expect(START_DETAIL).toContain("one `AskUserQuestion` call carrying the\nthree questions");
    expect(START_DETAIL).toContain("> answers (default: 1A 2A 3A)");
  });

  test("the report records how the questions were answered", () => {
    expect(SKILL).toContain(
      "start questions: reviewers <…>, counterpart <verified at <sha> | skipped: reason>, models <accepted | all deep | custom | defaults (unattended)>",
    );
    expect(read(ENGINE, "templates", "review-report.md")).toContain(
      "- **Selection:** <explicit flags | start questions: reviewers <`--all` | narrowed to …>, counterpart <verified at <sha> | skipped: reason>",
    );
  });

  test("model_strategy defaults to ask when interactive and adaptive when unattended", () => {
    expect(SKILL).toContain("Default: `ask` in an interactive round (shown once as Start question 3), `adaptive` unattended");
    expect(SKILL).toContain("| `ask` (default, interactive) |");
    expect(SKILL).toContain("| `adaptive` (default, unattended) |");
    expect(MODELS).toContain("**An interactive review round shows the computed plan once.**");
    expect(MODELS).toContain("**Do not ask the operator which model to use per dispatch.**");
  });
});

describe("AC2: the counterpart is re-read every round, and asked for when it cannot be found", () => {
  test("verification does not depend on a paired PR", () => {
    expect(START_MAIN).toContain("Verification is not limited to a paired PR: contracts and logic are re-read every round.");
    expect(START_DETAIL).toContain("Verification is not limited to a\n   paired PR");
  });

  test("an unlocated counterpart is a question, not `state: unavailable`", () => {
    expect(SKILL).toContain("If you cannot locate the producer, ask the operator where it is (Start question 2)");
    expect(START_DETAIL).toContain("it asks the operator where it is; it never records\n   `state: unavailable` on its own");
  });
});

describe("AC3: a gating round never reviews alone", () => {
  test("a host without a dispatch tool returns BLOCKED with nested_dispatch_unavailable", () => {
    const dispatching = section(SKILL, "## Dispatching Reviewers");
    expect(dispatching).toContain("returns `STATUS: BLOCKED` (`nested_dispatch_unavailable`) and never reviews alone");
    expect(START_MAIN).toContain("returns `STATUS: BLOCKED` (`nested_dispatch_unavailable`) instead of reviewing alone");
    expect(DEPTH).toContain("**No dispatch tool, no review.**");
    expect(DEPTH).toContain("A gating round runs the composition the start questions\nselected.");
  });
});

describe("AC4: depth follows risk, not size", () => {
  test("a client-side mirror of a server rule is a high-risk trigger", () => {
    expect(SKILL).toContain(
      "API contracts, a client-side mirror of a server rule (validation, limit, permission, uniqueness, reserved names)",
    );
    expect(DEPTH).toContain("**High-risk includes a client-side mirror of a server rule**");
  });

  test("size never lowers depth below the risk class", () => {
    expect(SKILL).toContain("Size never lowers depth below the risk class");
    expect(DEPTH).toContain("**Size never lowers depth below the risk class.**");
  });
});

/** The minimum a `review_context` needs, so each test varies only `cross_repo`. */
function contextWith(crossRepo: unknown[]): Record<string, unknown> {
  return {
    request: { raw: "review this PR" },
    scope: { mode: "diff", files: ["src/reference-data/reference-data-name.ts"] },
    routing: { selected_reviewers: ["review-logic"] },
    token_policy: { context_mode: "light", omissions: [] },
    cross_repo: crossRepo,
  };
}

const INPUT_RULE = {
  repo: "vantage-backend",
  reason: "what the backend accepts for a reference data name",
  facts: ["validateName refuses anything outside [A-Za-z0-9_-]+"],
  state: "merged",
  sha: "9b0a2dcdba",
  checks: [
    {
      check: "name matches [A-Za-z0-9_-]+ in full",
      source: "RefDataValidator.java:27",
      case_sensitive: true,
      paths: ["create", "rename", "publish", "move", "copy"],
    },
    {
      check: "name fits ref_data.name varchar(255)",
      source: "V1_184__reference_data.sql:6",
      case_sensitive: null,
      paths: ["create", "rename", "publish", "move", "copy"],
    },
  ],
  enumeration_method: "read RefDataService.validateCreate, update, resolveRehomeName, resolveFreeName and checkNameIsFree",
};

async function errorsFor(value: unknown): Promise<string[]> {
  return (await validateJson(value, CONTEXT)).map((e) => `${e.path}: ${e.message}`);
}

describe("AC5: an input rule carries the producer's complete check set", () => {
  test("a complete check set with its enumeration method validates", async () => {
    expect(await errorsFor(contextWith([INPUT_RULE]))).toEqual([]);
  });

  test("a check set without an enumeration method is refused", async () => {
    const { enumeration_method: _omitted, ...withoutMethod } = INPUT_RULE;
    expect((await errorsFor(contextWith([withoutMethod]))).join("\n")).toContain("enumeration_method");
  });

  test("a check that names no producer path is refused", async () => {
    const pathless = { ...INPUT_RULE, checks: [{ check: "name is not reserved", source: "Utils.java:60" }] };
    expect((await errorsFor(contextWith([pathless]))).join("\n")).toContain("paths");
  });

  test("an entry without a check set still validates, as before", async () => {
    const { checks: _c, enumeration_method: _m, ...plain } = INPUT_RULE;
    expect(await errorsFor(contextWith([plain]))).toEqual([]);
  });

  test("reviewers are told the facts are a starting point and a missing limit is a question", () => {
    expect(COUNTERPART).toContain("**The facts are a starting point, not a boundary.**");
    expect(COUNTERPART).toContain("**\"The producer has no limit\" is a question, not a fact.**");
    expect(COUNTERPART).toContain("**Build the surfaces × checks matrix**");
  });
});

describe("AC6: round obligations apply to every round without a question", () => {
  test.each([
    "**Enumerate before concluding.**",
    "**Quantified claims are checked.**",
    "**A verified-clean line names its sites.**",
    "**A pre-existing defect gets a disposition.**",
    "**Red on the parent, per test.**",
    "**A threaded value is pinned per site.**",
    "**One rule, one implementation.**",
    "**\"Do not re-raise\" needs a record.**",
  ])("%s", (obligation) => {
    expect(OBLIGATIONS).toContain(obligation);
  });

  test("the main file points every round at the obligations", () => {
    expect(START_MAIN).toContain("Every\nround also carries the always-on obligations");
    expect(START_MAIN).toContain("§ \"Round obligations\"");
  });
});

describe("AC7: flow-orchestrator runs the review in its own session", () => {
  const phase3 = section(FLOW, "## Phase 3: Verification And Review");

  test("the engine is never handed whole to one subagent", () => {
    expect(phase3).toContain("in this session,\n   never handed whole to one subagent");
  });

  test("a budget stop asks the operator and never shrinks the fan-out", () => {
    expect(phase3).toContain("**stop and ask the user** rather than dispatching another fan-out — never shrink the fan-out to fit.");
  });

  test("dispatch prompts point at sources and never paraphrase a contract", () => {
    expect(phase3).toContain("Dispatch prompts point at sources (files, SHAs, the PR) and never paraphrase a contract.");
  });
});

describe("AC8: the new rules name tiers, never model ids", () => {
  test.each([
    ["Start questions (main)", START_MAIN],
    ["Start questions (detail)", START_DETAIL],
    ["Depth floor", DEPTH],
    ["Counterpart verification", COUNTERPART],
    ["Round obligations", OBLIGATIONS],
  ])("%s", (_name, text) => {
    expect(text).not.toMatch(/\b(opus|sonnet|haiku|gpt|gemini|claude|codex)[-\w.]*\d/i);
  });
});
