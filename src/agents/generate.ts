// `generateStackAgentPair` — the ONE producer of the per-stack
// `<id>-code-auditor` / `<id>-build-fixer` generated agent-definition pair
// (W2 §Design "Initial catalogue", flow 314 T10). Pure and deterministic: the
// same `pack.json`-shaped input always produces byte-identical output, with
// no `Date.now()`/`generatedAt` anywhere in it (W2's `origin.generatedAt` is
// optional and this generator never sets it) — the drift guard in
// `verify.ts` (`generated-drift`) depends on this determinism to detect a
// hand edit by simple string comparison against a freshly-regenerated copy.
//
// No IO here — a caller (the `keryx agents generate` CLI in
// `src/commands/agents-catalog.ts`, or `verify.ts`'s drift check) reads
// `pack.json` from disk and passes the parsed object in.

export interface StackPackAgentProfile {
  readonly displayName: string;
  readonly auditFocus: readonly string[];
  readonly buildCommands: readonly string[];
  readonly fixGuardrails: readonly string[];
}

/** The subset of a W1 `pack.json` this generator reads. Everything else on the real file is ignored. */
export interface StackPackForAgentGeneration {
  readonly id: string;
  readonly skills: {
    readonly review?: readonly string[];
    readonly "build-fix"?: readonly string[];
  };
  readonly agentProfile: StackPackAgentProfile;
}

export interface GeneratedAgentFile {
  readonly name: string;
  readonly fileName: string;
  readonly content: string;
}

export interface GeneratedAgentPair {
  readonly auditor: GeneratedAgentFile;
  readonly fixer: GeneratedAgentFile;
}

/** Read-only tool allowlist every generated `<id>-code-auditor` carries — never `apply_patch`/`shell_exec`. */
const AUDITOR_TOOLS = ["read_file", "list_dir", "get_cwd", "search_code", "graph_affected", "memory_search"] as const;

/** Workspace-write tool allowlist every generated `<id>-build-fixer` carries. */
const FIXER_TOOLS = ["read_file", "list_dir", "get_cwd", "search_code", "graph_affected", "apply_patch", "shell_exec"] as const;

/**
 * A YAML double-quoted scalar for a frontmatter value (mirrors
 * `compile.ts`'s `yamlDoubleQuoted`, duplicated locally rather than imported
 * — this module stays a leaf with no dependency on `compile.ts`'s export
 * surface, and `JSON.stringify` produces a valid YAML double-quoted scalar
 * for any string, the same closed injection argument `compile.ts` documents).
 */
function yamlQuoted(value: string): string {
  return JSON.stringify(value);
}

/** `key: []` for an empty list, else a block list (`key:\n  - a\n  - b`) — matches `frontmatter.ts`'s grammar either way. */
function yamlList(key: string, items: readonly string[]): string {
  if (items.length === 0) return `${key}: []`;
  return [`${key}:`, ...items.map((item) => `  - ${item}`)].join("\n");
}

function frontmatter(fields: {
  readonly name: string;
  readonly description: string;
  readonly role: string;
  readonly tools: readonly string[];
  readonly model_tier: string;
  readonly policy_profile: string;
  readonly skills: readonly string[];
  readonly stacks: readonly string[];
  readonly output_contract: string;
  readonly isolation: string;
  readonly origin: { readonly kind: string; readonly sourceRef: string };
}): string {
  return [
    "---",
    "schema_version: 1",
    `name: ${fields.name}`,
    `description: ${yamlQuoted(fields.description)}`,
    `role: ${yamlQuoted(fields.role)}`,
    yamlList("tools", fields.tools),
    `model_tier: ${fields.model_tier}`,
    `policy_profile: ${fields.policy_profile}`,
    yamlList("skills", fields.skills),
    yamlList("stacks", fields.stacks),
    `output_contract: ${fields.output_contract}`,
    `isolation: ${fields.isolation}`,
    "origin:",
    `  kind: ${fields.origin.kind}`,
    `  sourceRef: ${fields.origin.sourceRef}`,
    "---",
  ].join("\n");
}

const STATUS_LINE =
  "The reply's first line is `STATUS: DONE|DONE_WITH_CONCERNS|NEEDS_CONTEXT|BLOCKED` per the subagent-result contract.";

function auditorDescription(pack: StackPackForAgentGeneration): string {
  return (
    `Reviews ${pack.agentProfile.displayName} code, read-only, for the ${pack.agentProfile.auditFocus.length} ` +
    `stack-specific risk patterns this pack's governance gate has confirmed for ${pack.id} (correctness, resource, ` +
    `and security patterns particular to ${pack.agentProfile.displayName}). Dispatched for a stack-specific code-` +
    `quality pass distinct from generic review, gated the same stack_requires-style way review-orchestrator already ` +
    `uses for per-stack reviewers.`
  );
}

function fixerDescription(pack: StackPackForAgentGeneration): string {
  return (
    `Reproduces and fixes a ${pack.agentProfile.displayName} build, lint, type-check, or test failure with the ` +
    `smallest root-cause change, isolated in a worktree. Dispatched after a ${pack.id} build/CI command fails and ` +
    `needs a targeted fix rather than a full implementation pass, always re-running the same commands to prove the ` +
    `fix actually holds.`
  );
}

function auditorBody(pack: StackPackForAgentGeneration): string {
  const displayName = pack.agentProfile.displayName;
  const reviewSkills = pack.skills.review ?? [];
  const focusList = pack.agentProfile.auditFocus.map((item) => `   - ${item}`).join("\n");
  const skillsLine =
    reviewSkills.length > 0
      ? `the \`${reviewSkills.join("`, `")}\` skill(s)`
      : "this stack's review skill";
  return [
    `# ${displayName} Code Auditor`,
    "",
    "## Scope",
    "",
    `Read-only review of ${displayName} code within the given diff or area, gated on the \`${pack.id}\` stack. Never edits files — findings and remediation guidance only.`,
    "",
    "## Procedure",
    "",
    "1. Identify the scope: which files are in the diff or named area, and which of them are actually written in this stack.",
    `2. Use \`search_code\` and \`read_file\` to check each of the following ${pack.id}-specific risk patterns:`,
    focusList,
    "3. Trace anything ambiguous with `graph_affected` before ruling on it, and check `memory_search` for a prior accepted finding in this area before re-raising something already reviewed.",
    `4. For any pattern not covered above, consult ${skillsLine} and this pack's rules under \`stacks/${pack.id}/rules\` (module \`${pack.id}-rules\`).`,
    "",
    "## Report",
    "",
    "Findings section, ordered by severity: file path and line, which audit-focus pattern it matches, and a specific remediation. Note anything checked and found clean.",
    "",
    `${STATUS_LINE} Use \`DONE_WITH_CONCERNS\` when findings exist; \`BLOCKED\` only when the scope could not be read.`,
    "",
  ].join("\n");
}

function fixerBody(pack: StackPackForAgentGeneration): string {
  const displayName = pack.agentProfile.displayName;
  const commands = pack.agentProfile.buildCommands;
  const commandSteps = commands.map((command, index) => `   ${index + 1}. \`${command}\``).join("\n");
  const guardrails = pack.agentProfile.fixGuardrails.map((item) => `   - ${item}`).join("\n");
  return [
    `# ${displayName} Build Fixer`,
    "",
    "## Scope",
    "",
    `Workspace-write build/lint/type/test-failure fixing for ${displayName} projects, isolated in a worktree so a bad fix never lands in the parent checkout. Only the smallest fix needed to turn the given failure green.`,
    "",
    "## Procedure",
    "",
    "1. Reproduce the reported failure by running, in this order:",
    commandSteps,
    "2. Read the failing output and the smallest set of files it implicates, using `read_file`, `search_code`, and `graph_affected` to trace the failure to its root cause before changing anything.",
    "3. Make the smallest root-cause fix with `apply_patch`. Never do any of the following:",
    guardrails,
    "4. Re-run the exact same commands from step 1, in the same order, and confirm every one is green before reporting.",
    "",
    "## Report",
    "",
    "Findings section: which command(s) were failing, the root cause, the fix applied, and the final re-run result for each command from step 1.",
    "",
    `${STATUS_LINE} Use \`DONE_WITH_CONCERNS\` when a fix landed but a related risk remains; \`BLOCKED\` when the failure could not be reproduced at all.`,
    "",
  ].join("\n");
}

/**
 * Generate the `<id>-code-auditor` / `<id>-build-fixer` pair for one stack
 * pack. Pure: given the same `pack`, always returns byte-identical
 * `content` for each file — no timestamp, no random id, no environment
 * read. Callers write these to
 * `src/gdskills/bundled/agents/<fileName>` and list both `name`s in that
 * pack's `agent-refs.json`.
 */
export function generateStackAgentPair(pack: StackPackForAgentGeneration): GeneratedAgentPair {
  const auditorName = `${pack.id}-code-auditor`;
  const fixerName = `${pack.id}-build-fixer`;

  const auditorFrontmatter = frontmatter({
    name: auditorName,
    description: auditorDescription(pack),
    role:
      `A ${pack.agentProfile.displayName}-focused code auditor who reads for this stack's known risk patterns ` +
      "without editing anything, and ranks findings by real-world impact rather than listing every theoretical concern equally.",
    tools: AUDITOR_TOOLS,
    model_tier: "deep",
    policy_profile: "read-only",
    skills: pack.skills.review ?? [],
    stacks: [pack.id],
    output_contract: "subagent-result",
    isolation: "none",
    origin: { kind: "generated", sourceRef: pack.id },
  });

  const fixerFrontmatter = frontmatter({
    name: fixerName,
    description: fixerDescription(pack),
    role:
      `A ${pack.agentProfile.displayName} build-and-test fixer who reproduces the reported failure, finds the ` +
      "smallest root-cause fix, and proves the original commands pass again before reporting done.",
    tools: FIXER_TOOLS,
    model_tier: "standard",
    policy_profile: "workspace-write",
    skills: pack.skills["build-fix"] ?? [],
    stacks: [pack.id],
    output_contract: "subagent-result",
    isolation: "worktree",
    origin: { kind: "generated", sourceRef: pack.id },
  });

  return {
    auditor: {
      name: auditorName,
      fileName: `${auditorName}.md`,
      content: `${auditorFrontmatter}\n\n${auditorBody(pack)}`,
    },
    fixer: {
      name: fixerName,
      fileName: `${fixerName}.md`,
      content: `${fixerFrontmatter}\n\n${fixerBody(pack)}`,
    },
  };
}
