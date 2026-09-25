// AC7: `model_tier` resolution in compiled output is delegated to
// `src/gdskills/model-tier.ts` (no re-implementation) — the compiler carries
// the declared tier through UNCHANGED for `target: "keryx-shell"` — and no
// compiled output for any target contains a literal model name.
// `MODEL_RANK_HINTS` is the source of the size-word vocabulary a real model
// id would carry; scanning compiled text for it (plus a few vendor-family
// prefixes model-tier.ts deliberately holds no table of) is the same check
// the module comment recommends for anything worried about a smuggled model
// name.
//
// Flow 339 deliberately NARROWS this guard for the claude target alone.
// Claude Code's own frontmatter accepts exactly `model:
// opus|sonnet|haiku|inherit` — a fixed, version-free vocabulary, never a
// concrete/versioned id — and `compile.ts#renderClaudeExport` now maps
// `model_tier` onto one of those four words by default. That word IS the
// alias this guard's original intent (T13's "the canonical tier is always
// readable straight off the exported file") anticipated, not the "literal
// model name" the guard exists to catch, so ONLY that one exact frontmatter
// line is exempted before scanning. Everything else about the guard is
// unchanged and still enforced, including on claude's own output: a bare
// tier-size word anywhere else in the content (task/header text, any OTHER
// frontmatter field, the sentinel) still fails, `keryx-shell` still forbids
// every one of these words everywhere (it carries no alias line at all), and
// a concrete/versioned id (`claude-…`, `gpt-…`, `gemini…`) still fails EVEN
// inside the model line itself — a line shaped like `model: claude-opus-5`
// does not match the four-word strip pattern below, so it is left in place
// for the scan to catch, proving the strip cannot be used to smuggle a real
// id past this guard.
import { expect, test } from "bun:test";
import { isModelTier, MODEL_RANK_HINTS, MODEL_TIERS } from "../gdskills/model-tier";
import { compileAgentDefinition } from "./compile";
import type { AgentDefinition, ModelTier } from "./types";

const MODEL_NAME_PATTERN = new RegExp(
  [...MODEL_RANK_HINTS.map((hint) => hint.pattern), "claude-", "gpt-", "gemini"].join("|"),
  "i",
);

/** The one claude frontmatter shape this flow allows past {@link MODEL_NAME_PATTERN} — see the file header. */
const CLAUDE_MODEL_ALIAS_LINE = /^model: (?:opus|sonnet|haiku|inherit)$/m;

/** `content` with the one allowed claude alias line removed, if present — what the narrowed scan below runs `MODEL_NAME_PATTERN` against. */
function withoutAllowedClaudeModelAliasLine(content: string): string {
  return content.replace(CLAUDE_MODEL_ALIAS_LINE, "");
}

/** `model_tier` -> Claude's frontmatter alias, mirrored independently of `compile.ts`'s own `CLAUDE_MODEL_ALIAS` so this test cannot pass by asserting a tautology against the implementation it is checking. */
const EXPECTED_CLAUDE_ALIAS: Readonly<Record<ModelTier, "opus" | "sonnet" | "haiku">> = {
  deep: "opus",
  standard: "sonnet",
  light: "haiku",
};

function fixture(model_tier: ModelTier): AgentDefinition {
  return {
    name: "test-first-driver",
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

test("compiled claude export declares its tier's own alias, with no OTHER literal model name anywhere", () => {
  for (const tier of MODEL_TIERS) {
    const result = compileAgentDefinition(fixture(tier), "claude");
    expect(result.ok).toBe(true);
    if (!result.ok || result.result.target === "keryx-shell") continue;
    expect(result.result.content).toContain(`model: ${EXPECTED_CLAUDE_ALIAS[tier]}`);
    // Exactly one model line, and it is the alias line the strip pattern
    // recognizes — never two competing `model:` declarations.
    expect(result.result.content.match(/^model:.*$/gm)).toEqual([`model: ${EXPECTED_CLAUDE_ALIAS[tier]}`]);
    expect(MODEL_NAME_PATTERN.test(withoutAllowedClaudeModelAliasLine(result.result.content))).toBe(false);
  }
});

test("modelGuidance.claudeSubagentAliases: false restores model: inherit for every tier, with no literal model name", () => {
  for (const tier of MODEL_TIERS) {
    const result = compileAgentDefinition(fixture(tier), "claude", { claudeSubagentAliases: false });
    expect(result.ok).toBe(true);
    if (!result.ok || result.result.target === "keryx-shell") continue;
    expect(result.result.content).toContain("model: inherit");
    expect(MODEL_NAME_PATTERN.test(withoutAllowedClaudeModelAliasLine(result.result.content))).toBe(false);
  }
});

test("the strip pattern exempts only the four canonical aliases, never a concrete/versioned id shaped like them", () => {
  // Proves the narrowing cannot be used to smuggle a real model id: a line
  // that merely LOOKS like the frontmatter shape but names something other
  // than the four canonical words is not stripped, and still fails the scan.
  for (const smuggled of ["model: claude-opus-5", "model: gpt-5.2-codex", "model: gemini-3-pro", "model: opus-5"]) {
    expect(CLAUDE_MODEL_ALIAS_LINE.test(smuggled)).toBe(false);
    expect(MODEL_NAME_PATTERN.test(withoutAllowedClaudeModelAliasLine(smuggled))).toBe(true);
  }
  // The four the strip DOES exempt — sanity, so the positive case is pinned too.
  for (const allowed of ["model: opus", "model: sonnet", "model: haiku", "model: inherit"]) {
    expect(CLAUDE_MODEL_ALIAS_LINE.test(allowed)).toBe(true);
  }
});

test("a definition whose declared model_tier is actually a model name fails schema validation before compiling", () => {
  const poisoned = { ...fixture("light"), model_tier: "claude-opus-5" as unknown as ModelTier };
  const result = compileAgentDefinition(poisoned, "keryx-shell");
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected failure");
  expect(result.error.reason).toBe("invalid-definition");
});
