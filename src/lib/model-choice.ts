// Flow 336 — model guidance for Claude Code and Codex, from keryx's own
// routing table (`src/harness/routing/*`) and model tiers
// (`src/gdskills/model-tier.ts`).
//
// WHY THIS FILE EXISTS SEPARATELY
//
// The managed `<!-- keryx:index -->` block in root AGENTS.md/CLAUDE.md
// (`src/lib/agent-entrypoint-blocks.ts`) is read on EVERY turn by every host
// that reads it — including every subagent dispatch — so its content is
// hand-picked and small (see the "index gate stays small" test in
// `templates.test.ts`, and the known-mistake this mirrors: a mandatory
// context-injection rule's per-read cost multiplies by every subsequent turn
// and subagent dispatch). This module renders the Model choice text once,
// pure and synchronous, so the caller can measure and bound its size the same
// way every other managed-block line already is.
//
// WHAT IT DOES NOT DO
//
// It never writes a literal model id into a rule or a skill — that is
// `src/gdskills/bundled/rules/core/model-selection.mdc`'s own guarded
// territory (`concreteModelDeclarations` in `model-tier.ts`), untouched here.
// A concrete id appears in the RENDERED block only when the PROJECT's own
// `routing.config.json` resolves one for a category this policy addresses,
// and only once the operator has approved that file's current content
// (`keryx routing trust`) — the same trust gate `keryx routing list` already
// enforces (`src/harness/routing/trust.ts`). It never reads the operator's
// personal (`user`) routing layer: that layer is the operator's own global
// config, not a project fact, and this module's output gets committed to the
// repository and read by everyone who clones it.
//
// It never touches anything outside the project. Codex CLI reads `AGENTS.md`
// the same way Claude Code reads `CLAUDE.md`/`AGENTS.md` — the SAME managed
// block reaches both hosts, so there is no separate write to
// `~/.codex/config.toml` or any other path outside `projectRoot`.
import path from "node:path";
import { pathExists } from "./fs";
import { readJsonObjectFile } from "./json";
import { loadRoutingConfig } from "../harness/routing/config";
import type { CategoryAssignment, RoutingCategory, RoutingTable } from "../harness/routing/table";
import { MODEL_TIERS, type ModelTier } from "../gdskills/model-tier";

/**
 * The routing categories this operator policy assigns a tier to, and which
 * tier. Categories `table.ts` defines but this policy is silent on
 * (`default`, `coding`) are left to the session's own model, exactly as an
 * unrouted category already resolves — this module adds no opinion there.
 */
export const MODEL_CHOICE_CATEGORY_TIERS: Readonly<Partial<Record<RoutingCategory, ModelTier>>> = {
  planning: "deep",
  review: "deep",
  subagents: "standard",
  docs: "standard",
  unattended: "standard",
  quick: "light",
};

/** Ordered so the rendered line's category list reads planning/review first, trivial last. */
const MODEL_CHOICE_CATEGORY_ORDER: readonly RoutingCategory[] = ["planning", "review", "subagents", "docs", "unattended", "quick"];

/** Tier word an operator-facing sentence uses, matching `model-selection.mdc`'s own vocabulary. */
const TIER_WORD: Readonly<Record<ModelTier, string>> = {
  deep: "the flagship tier",
  standard: "one tier down",
  light: "the smallest tier",
};

/** Every `ModelTier` in `TIER_WORD` — a compile-time check that the table above stays total. */
const _TIER_WORD_IS_TOTAL: readonly ModelTier[] = MODEL_TIERS.map((tier) => {
  void TIER_WORD[tier];
  return tier;
});
void _TIER_WORD_IS_TOTAL;

/** Where a project opts out. Mirrors `REVIEW_GATE_CONFIG_PATH`'s own "absence is normal" contract. */
export const MODEL_GUIDANCE_CONFIG_PATH = ".metaproject/tasks.config.json";

export interface ModelGuidanceConfig {
  readonly enabled: boolean;
  /** Set when the config file exists but could not be honestly read as configuring this key. */
  readonly note?: string;
}

/**
 * Read `.metaproject/tasks.config.json`'s `modelGuidance.enabled`. Absent
 * file, absent key, or a non-boolean value all mean "enabled" (the shipped
 * default) — only an explicit `false` turns the Model choice policy off. A
 * file that exists but cannot be parsed as an object also keeps the default,
 * with a note a caller can surface (mirrors `readReviewGateConfig`'s "a
 * malformed file yields the default plus a note, never a silent guess").
 */
export async function readModelGuidanceConfig(projectRoot: string): Promise<ModelGuidanceConfig> {
  const file = path.join(projectRoot, MODEL_GUIDANCE_CONFIG_PATH);
  if (!(await pathExists(file))) {
    return { enabled: true };
  }
  const read = await readJsonObjectFile(file);
  if (read.state !== "object") {
    return { enabled: true, note: `${MODEL_GUIDANCE_CONFIG_PATH} could not be read as a JSON object; model guidance stayed enabled` };
  }
  const modelGuidance = read.value["modelGuidance"];
  if (typeof modelGuidance !== "object" || modelGuidance === null || Array.isArray(modelGuidance)) {
    return { enabled: true };
  }
  const enabled = (modelGuidance as Record<string, unknown>)["enabled"];
  if (enabled === false) {
    return { enabled: false };
  }
  if (enabled !== undefined && enabled !== true) {
    return { enabled: true, note: `${MODEL_GUIDANCE_CONFIG_PATH}: modelGuidance.enabled is not a boolean; model guidance stayed enabled` };
  }
  return { enabled: true };
}

export interface ModelChoiceResolution {
  /** Only the categories `MODEL_CHOICE_CATEGORY_TIERS` addresses AND the project routing table actually (and approvedly) resolves. */
  readonly assignments: Readonly<Partial<Record<RoutingCategory, CategoryAssignment>>>;
  /** True when the project's `routing.config.json` exists but is not yet approved (`keryx routing trust`) — surfaced for the status line, never for the committed doc. */
  readonly untrusted: boolean;
  /** A read/parse/validation problem, when there was one — surfaced the same way. */
  readonly error?: string;
}

/**
 * The project routing table, narrowed to the categories this policy
 * addresses. Reads ONLY the `project` layer (`routing.config.json`, trust-
 * gated) — never the operator's personal `user` layer, which has no business
 * in a file this module's caller commits to the repository.
 */
export async function resolveModelChoice(projectRoot: string, userConfigDir?: string): Promise<ModelChoiceResolution> {
  const result = await loadRoutingConfig("project", { cwd: projectRoot, ...(userConfigDir === undefined ? {} : { userConfigDir }) });
  const assignments = pickAddressedAssignments(result.table);
  return {
    assignments,
    untrusted: result.untrusted === true,
    ...(result.error === undefined ? {} : { error: result.error }),
  };
}

function pickAddressedAssignments(table: RoutingTable): Partial<Record<RoutingCategory, CategoryAssignment>> {
  const picked: Partial<Record<RoutingCategory, CategoryAssignment>> = {};
  for (const category of MODEL_CHOICE_CATEGORY_ORDER) {
    const assignment = table[category];
    if (assignment !== undefined) picked[category] = assignment;
  }
  return picked;
}

/** One assignment, described for the managed block — never a raw model-id guess, only what was actually resolved. */
function describeAssignment(assignment: CategoryAssignment): string {
  switch (assignment.kind) {
    case "session-default":
      return "session default";
    case "model":
      return `${assignment.providerId}/${assignment.modelId}`;
    case "provider-default":
      return `${assignment.providerId} (provider default)`;
    default: {
      const exhaustive: never = assignment;
      return exhaustive;
    }
  }
}

/**
 * The Model choice policy sentence rendered into the managed block. Pure —
 * takes exactly what {@link resolveModelChoice} resolved, adds nothing of its
 * own. Deliberately ONE sentence-shaped bullet, matching every other line in
 * `renderProjectMetaprojectReferenceBlock`'s policy list, so this addition
 * costs about as much per-turn context as any one of the existing bullets —
 * not a new heading, not a table.
 */
export function renderModelChoicePolicy(assignments: Readonly<Partial<Record<RoutingCategory, CategoryAssignment>>>): string {
  const resolvedParts = MODEL_CHOICE_CATEGORY_ORDER.filter((category) => assignments[category] !== undefined).map(
    (category) => `${category}=${describeAssignment(assignments[category]!)}`,
  );
  const resolvedNote =
    resolvedParts.length > 0
      ? ` This project's \`routing.config.json\` currently resolves: ${resolvedParts.join(", ")}; every other addressed category runs on the session's own model.`
      : " Declare a tier, never a model id, in a rule/skill/subagent file — this project has not pinned any of these categories in `routing.config.json`, so every one of them runs on the session's own model.";
  return (
    "For choosing which model to run this session, a subagent dispatch, or a scheduled/unattended run on, use the model tiers: " +
    `${TIER_WORD.deep} for planning and review, ${TIER_WORD.standard} for subagents, docs, and unattended work, and ${TIER_WORD.light} only for trivial, mechanical work.` +
    resolvedNote
  );
}

export interface ModelChoiceBlockInput {
  readonly enabled: boolean;
  readonly assignments: Readonly<Partial<Record<RoutingCategory, CategoryAssignment>>>;
}

/** The tier-word-only, nothing-resolved default — what a fresh scaffold (no project I/O done yet) renders. */
export const DEFAULT_MODEL_CHOICE_BLOCK_INPUT: ModelChoiceBlockInput = { enabled: true, assignments: {} };

/**
 * Resolve everything `renderProjectMetaprojectReferenceBlock` needs for the
 * Model choice policy, in one call — the seam `ensureMetaprojectReference`
 * uses. `projectRoot` is required (the caller already gates this on
 * `options.root !== undefined` — see `agent-entrypoints.ts`); a caller with no
 * notion of a project root should use {@link DEFAULT_MODEL_CHOICE_BLOCK_INPUT}
 * instead of calling this with a guess.
 */
export async function buildModelChoiceBlockInput(projectRoot: string, userConfigDir?: string): Promise<ModelChoiceBlockInput> {
  const config = await readModelGuidanceConfig(projectRoot);
  if (!config.enabled) {
    return { enabled: false, assignments: {} };
  }
  const resolved = await resolveModelChoice(projectRoot, userConfigDir);
  return { enabled: true, assignments: resolved.assignments };
}

/**
 * One human-readable status line — what `keryx rules sync` / `keryx update`
 * print after regenerating the managed block, so the operator can see what
 * was generated without opening the file.
 */
export async function describeModelChoiceStatus(projectRoot: string, userConfigDir?: string): Promise<string> {
  const config = await readModelGuidanceConfig(projectRoot);
  if (!config.enabled) {
    return `model_choice: disabled (${MODEL_GUIDANCE_CONFIG_PATH}: modelGuidance.enabled=false)`;
  }
  const resolved = await resolveModelChoice(projectRoot, userConfigDir);
  const total = MODEL_CHOICE_CATEGORY_ORDER.length;
  const resolvedCount = Object.keys(resolved.assignments).length;
  const parts = [`model_choice: enabled (${resolvedCount}/${total} categories resolved from routing.config.json)`];
  if (resolved.untrusted) {
    parts.push("routing.config.json has unapproved entries — run `keryx routing trust` to apply them");
  } else if (resolved.error !== undefined) {
    parts.push(resolved.error);
  } else if (config.note !== undefined) {
    parts.push(config.note);
  }
  return parts.join("; ");
}
