// AC7: `model_tier` resolution in compiled output is delegated to
// `src/gdskills/model-tier.ts` (no re-implementation) — the compiler carries
// the declared tier through UNCHANGED — and no compiled output for any
// target contains a literal model name. `MODEL_RANK_HINTS` is the source of
// the size-word vocabulary a real model id would carry; scanning compiled
// text for it (plus a few vendor-family prefixes model-tier.ts deliberately
// holds no table of) is the same check the module comment recommends for
// anything worried about a smuggled model name.
import { expect, test } from "bun:test";
import { isModelTier, MODEL_RANK_HINTS, MODEL_TIERS } from "../gdskills/model-tier";
import { compileAgentDefinition } from "./compile";
import type { AgentDefinition, ModelTier } from "./types";

const MODEL_NAME_PATTERN = new RegExp(
  [...MODEL_RANK_HINTS.map((hint) => hint.pattern), "claude-", "gpt-", "gemini"].join("|"),
  "i",
);

function fixture(model_tier: ModelTier): AgentDefinition {
  return {
    name: "tdd-guide",
    description: "Drives a failing-test-first implementation loop.",
    role: "You write a failing test before any implementation change.",
    tools: ["read_file", "apply_patch"],
    model_tier,
    policy_profile: "workspace-write",
    skills: [],
    stacks: [],
    output_contract: "subagent-result",
    isolation: "none",
    body: "Write the failing test, run it, then make it pass with the smallest change.",
  };
}

test("every MODEL_TIERS value is a valid model_tier and passes through isModelTier", () => {
  for (const tier of MODEL_TIERS) {
    expect(isModelTier(tier)).toBe(true);
  }
});

test("compiled keryx-shell output carries the declared tier through unchanged, never a model name", () => {
  for (const tier of MODEL_TIERS) {
    const result = compileAgentDefinition(fixture(tier), "keryx-shell");
    expect(result.ok).toBe(true);
    if (!result.ok || result.result.target !== "keryx-shell") continue;
    expect(result.result.input.model_tier).toBe(tier);
    expect(MODEL_NAME_PATTERN.test(result.result.input.task)).toBe(false);
    expect(MODEL_NAME_PATTERN.test(result.result.input.model_tier)).toBe(false);
  }
});

test("compiled claude export contains no literal model name, and declares model: inherit", () => {
  for (const tier of MODEL_TIERS) {
    const result = compileAgentDefinition(fixture(tier), "claude");
    expect(result.ok).toBe(true);
    if (!result.ok || result.result.target === "keryx-shell") continue;
    expect(MODEL_NAME_PATTERN.test(result.result.content)).toBe(false);
    expect(result.result.content).toContain("model: inherit");
  }
});

test("a definition whose declared model_tier is actually a model name fails schema validation before compiling", () => {
  const poisoned = { ...fixture("light"), model_tier: "claude-opus-5" as unknown as ModelTier };
  const result = compileAgentDefinition(poisoned, "keryx-shell");
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected failure");
  expect(result.error.reason).toBe("invalid-definition");
});
