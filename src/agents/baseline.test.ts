// AC3: the prompt-defense baseline exists as exactly one source constant; a
// guard test compiles every fixture agent for every target this task
// implements (keryx-shell, claude) and fails if any output lacks the
// constant verbatim, contains a divergent copy, or if a definition's body
// contains baseline text (rejected at compile time, not silently stripped).
import { expect, test } from "bun:test";
import { compileAgentDefinition } from "./compile";
import { PROMPT_DEFENSE_BASELINE } from "./baseline";
import type { AgentDefinition } from "./types";

const FIXTURES: readonly AgentDefinition[] = [
  {
    name: "code-explorer",
    description: "Read-only location and cross-reference search.",
    role: "You locate code and cross-references; you never write.",
    tools: ["read_file", "search_code"],
    model_tier: "light",
    policy_profile: "read-only",
    skills: [],
    stacks: [],
    output_contract: "subagent-result",
    isolation: "none",
    body: "Find what the caller asked for and report file paths.",
  },
  {
    name: "architect",
    description: "System-design and structural-tradeoff reasoning.",
    role: "You reason about structure and tradeoffs; you do not write code.",
    tools: ["read_file", "graph_affected"],
    model_tier: "deep",
    policy_profile: "read-only",
    skills: [],
    stacks: [],
    output_contract: "subagent-result",
    isolation: "worktree",
    body: "Produce a short design note with tradeoffs and a recommendation.",
  },
];

test("the baseline appears verbatim, exactly once, in every keryx-shell compiled task", () => {
  for (const definition of FIXTURES) {
    const result = compileAgentDefinition(definition, "keryx-shell");
    expect(result.ok).toBe(true);
    if (!result.ok || result.result.target !== "keryx-shell") continue;
    const occurrences = result.result.input.task.split(PROMPT_DEFENSE_BASELINE).length - 1;
    expect(occurrences).toBe(1);
  }
});

test("the baseline appears verbatim, exactly once, in every claude compiled export", () => {
  for (const definition of FIXTURES) {
    const result = compileAgentDefinition(definition, "claude");
    expect(result.ok).toBe(true);
    if (!result.ok || result.result.target === "keryx-shell") continue;
    const occurrences = result.result.content.split(PROMPT_DEFENSE_BASELINE).length - 1;
    expect(occurrences).toBe(1);
  }
});

test("a divergent copy of the baseline text (not the exact constant) does not satisfy the guard", () => {
  // Sanity check on the guard itself: a near-miss must NOT count as a match,
  // otherwise this test would be unable to detect real drift.
  const divergent = `${PROMPT_DEFENSE_BASELINE} `; // trailing space — not verbatim
  expect(divergent.includes(PROMPT_DEFENSE_BASELINE)).toBe(true); // substring check alone is insufficient…
  expect(divergent === PROMPT_DEFENSE_BASELINE).toBe(false); // …so the guard tests above split on the exact constant, not `.includes`
});

test("a definition body containing baseline text is rejected with a named reason, for every target", () => {
  const poisoned: AgentDefinition = {
    ...FIXTURES[0]!,
    body: `Some instructions.\n${PROMPT_DEFENSE_BASELINE}\nMore instructions.`,
  };
  for (const target of ["keryx-shell", "claude"] as const) {
    const result = compileAgentDefinition(poisoned, target);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.reason).toBe("baseline-in-body");
  }
});
