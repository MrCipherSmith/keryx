// `compileAgentDefinition` — the ONLY producer of dispatch/export inputs from
// an `AgentDefinition` (D-2, W2 §Design "Compiler"). No second reader may
// re-derive the keryx-shell input shape or a host file's content; every
// caller (the CLI's `export`/`verify`, a future orchestrator skill) goes
// through this function.
//
// Steps, in the fixed order W2 specifies:
//   1. validate the definition (schema.ts) and refuse a body that repeats
//      the prompt-defense baseline (AC3 — the compiler is the only injector).
//   2. render the compiled header: baseline + role + body, that fixed order.
//   3. project into the target's shape — `keryx-shell` returns the literal
//      `spawn_subagent` input subset (AC2) plus a policy sidecar; a host
//      target returns a `HostAgentExport`.
//
// `model_tier` is passed through UNCHANGED — never resolved to a model name
// here (AC7). `src/gdskills/model-tier.ts` (`isModelTier`) is the only tier
// authority this module defers to; the actual model resolution happens later,
// inside `spawn_subagent` itself, against the session's own provider.

import { createHash } from "node:crypto";
import { PROMPT_DEFENSE_BASELINE } from "./baseline";
import { validateAgentDefinition, type AgentSchemaError } from "./schema";
import { mapToolsForTarget, type HostToolTarget } from "./tools";
import { isAgentPolicyProfile, resolveKeryxShellPolicy, type AgentPolicyProfile, type KeryxShellMode } from "./policy";
import type { AgentDefinition, AgentExportRuntime, ExportSupportLevel, IsolationMode, ModelTier } from "./types";

export type CompileErrorReason =
  | "invalid-definition"
  | "baseline-in-body"
  | "unknown-policy-profile"
  | "target-not-implemented";

export interface CompileError {
  readonly reason: CompileErrorReason;
  readonly message: string;
  readonly details?: readonly string[];
}

/**
 * The `target="keryx-shell"` compiled result: `input`'s keys are always a
 * SUBSET of `spawn_subagent`'s `inputSchema.properties`
 * (`task`/`mode`/`label`/`max_tool_calls`/`max_rounds`/`model_tier`/
 * `runtime`) — this workstream adds no new keys to that tool (AC2). Fields
 * with no direct `spawn_subagent` input slot (`tools`, `policy_profile`,
 * `isolation`) are threaded through the `policy` sidecar instead of being
 * silently dropped.
 */
export interface KeryxShellCompileResult {
  readonly target: "keryx-shell";
  readonly input: {
    readonly task: string;
    readonly mode: KeryxShellMode;
    readonly label: string;
    readonly model_tier: ModelTier;
  };
  readonly policy: {
    readonly profile: string;
    readonly toolAllowlist: readonly string[];
    readonly isolation: IsolationMode;
  };
}

/** A host-target compiled result. `renderHostExport` (below) is the one hook point every host renderer plugs into. */
export interface HostAgentExport {
  readonly target: Exclude<AgentExportRuntime, "keryx-shell">;
  readonly supportLevel: ExportSupportLevel;
  readonly relativePath: string;
  readonly content: string;
  readonly droppedTools: readonly string[];
}

export type CompiledAgent = KeryxShellCompileResult | HostAgentExport;

export type CompileResult = { readonly ok: true; readonly result: CompiledAgent } | { readonly ok: false; readonly error: CompileError };

/** Baseline + role + body, in that fixed order (W2 §Design "Compiler", step 2). */
function renderHeader(definition: AgentDefinition): string {
  return `${PROMPT_DEFENSE_BASELINE}\n\n${definition.role}\n\n${definition.body}`;
}

function formatValidationErrors(errors: readonly AgentSchemaError[]): readonly string[] {
  return errors.map((error) => `${error.field}: ${error.message}`);
}

/**
 * A deterministic, field-by-field serialization of an {@link AgentDefinition}
 * (T7): every field in a fixed order, never `JSON.stringify(definition)`
 * directly (object key order is not a contract this module wants to depend
 * on). This is the "canonical source" every host export's managed sentinel
 * hashes — see {@link definitionSourceHash} — so the SAME hash appears in
 * every target's export of one definition version, letting a caller notice
 * "this source changed since it was exported" without diffing rendered,
 * per-target content against itself.
 */
function canonicalDefinitionSource(definition: AgentDefinition): string {
  return JSON.stringify({
    schema_version: definition.schema_version ?? null,
    name: definition.name,
    description: definition.description,
    role: definition.role,
    tools: [...definition.tools],
    model_tier: definition.model_tier,
    policy_profile: definition.policy_profile,
    skills: [...definition.skills],
    stacks: [...definition.stacks],
    output_contract: definition.output_contract,
    isolation: definition.isolation,
    origin: definition.origin ?? null,
    body: definition.body,
  });
}

/** sha256 hex of {@link canonicalDefinitionSource} — the hash every managed-export sentinel carries. */
export function definitionSourceHash(definition: AgentDefinition): string {
  return createHash("sha256").update(canonicalDefinitionSource(definition), "utf8").digest("hex");
}

/**
 * The ONE managed-sentinel wording every host renderer below embeds (task
 * text, T7): `<!-- keryx-managed: keryx agents export (<name>,
 * sha256:<hash-of-canonical-source>) -->` for markdown, `# keryx-managed: ...`
 * for TOML (codex), and — for kiro's JSON, whose unknown-key tolerance is
 * undocumented — the SAME text as the first line of the `prompt` field
 * instead of a new top-level key. Sharing this one string (with only the
 * comment delimiter varying) is what lets `export.ts`'s refuse-unmanaged /
 * unchanged detection substring-match ONE pattern across every target.
 */
export function agentManagedSentinelText(definition: AgentDefinition): string {
  return `keryx-managed: keryx agents export (${definition.name}, sha256:${definitionSourceHash(definition)})`;
}

/**
 * The fixed, name/hash-independent PREFIX of every managed sentinel this
 * module writes — `export.ts`'s "does this existing file carry a
 * keryx-managed sentinel at all" check (refuse-unmanaged vs
 * create/update/unchanged) substring-matches this, not the full
 * per-definition text (which also carries the current name/hash and would
 * never match a STALE export from an earlier source version).
 */
export const AGENT_SENTINEL_PREFIX = "keryx-managed: keryx agents export (";

/** `target="keryx-shell"` projection (W2 §Design "Keryx shell child agents"). */
function compileKeryxShell(definition: AgentDefinition, header: string): CompileResult {
  const policyResolution = resolveKeryxShellPolicy(definition.policy_profile);
  if (!policyResolution.ok) {
    return { ok: false, error: { reason: "unknown-policy-profile", message: policyResolution.error.message } };
  }
  return {
    ok: true,
    result: {
      target: "keryx-shell",
      input: {
        task: header,
        mode: policyResolution.resolution.mode,
        label: definition.name,
        model_tier: definition.model_tier,
      },
      policy: {
        profile: policyResolution.resolution.profileName,
        toolAllowlist: [...definition.tools],
        isolation: definition.isolation,
      },
    },
  };
}

/**
 * Claude Code renderer (`.claude/agents/<name>.md`) — the one host renderer
 * this task implements end-to-end, so the compile path is testable without
 * waiting on T7. codex/kiro/opencode are the hook point T7 fills in; they
 * throw a clear, named refusal here rather than emitting a guessed shape.
 *
 * `supportLevel` is hardcoded `"native"` for claude here because T5 has no
 * W5 registry lookup wired in yet (that lookup — `agentExportSupport` — is
 * `export.ts`'s job, owned by T7); this renderer is the content-shape half
 * of the exporter, not the honesty-gated dispatcher in front of it.
 */
/** A markdown HTML-comment sentinel line, the shape claude/opencode both use. */
function mdSentinelLine(definition: AgentDefinition): string {
  return `<!-- ${agentManagedSentinelText(definition)} -->`;
}

function renderClaudeExport(definition: AgentDefinition, header: string): HostAgentExport {
  const { mappedTools, droppedTools } = mapToolsForTarget(definition.tools, "claude");
  const frontmatter = [
    "---",
    `name: ${definition.name}`,
    `description: ${definition.description}`,
    `tools: ${mappedTools.join(", ")}`,
    // Tier is never mapped to a model alias (AC7) — `inherit` never
    // downgrades and names no concrete model.
    "model: inherit",
    "---",
  ].join("\n");
  const content = `${frontmatter}\n${mdSentinelLine(definition)}\n\n${header}\n`;
  return {
    target: "claude",
    supportLevel: "native",
    relativePath: `.claude/agents/${definition.name}.md`,
    content,
    droppedTools,
  };
}

/**
 * TOML basic-string escaping (single-line fields: name/description/
 * sandbox_mode — none of these carry embedded newlines by schema, but the
 * escape still guards backslash/quote/control-char content defensively).
 */
function tomlString(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  return `"${escaped}"`;
}

/**
 * TOML multi-line basic string for `developer_instructions` (the compiled
 * header, which is always multi-line). Backslashes are escaped first, then
 * any run of 3+ quotes is broken up so it can never be mistaken for the
 * closing `"""` delimiter — the header is agent-authored prose, not
 * TOML-aware input, so this guards against pathological content rather than
 * an expected shape.
 */
function tomlMultilineString(value: string): string {
  const escapedBackslashes = value.replace(/\\/g, "\\\\");
  const escapedQuoteRuns = escapedBackslashes.replace(/"{3,}/g, (run) => run.replace(/"/g, '\\"'));
  return `"""\n${escapedQuoteRuns}\n"""`;
}

/**
 * Codex renderer (`.codex/agents/<name>.toml`, context.md's first-party docs
 * check): codex has NO per-tool allowlist — access is governed entirely by
 * `sandbox_mode` (`read-only` | `workspace-write`, the SAME two values
 * `policy_profile` already uses — `policy.ts`'s canonical vocabulary maps
 * onto codex's directly, no separate table needed). Every declared tool is
 * therefore reported governed-by-sandbox rather than dropped: `droppedTools`
 * is always `[]` here, a deliberate choice (not an oversight — see
 * `tools.ts`'s empty codex map comment), documented in this renderer rather
 * than silently inherited from `mapToolsForTarget`. `model`/
 * `model_reasoning_effort` are both omitted (omit = inherit the parent,
 * confirmed by docs) — never a literal model name (AC7).
 */
function renderCodexExport(definition: AgentDefinition, header: string): CompileResult {
  const policy = resolveKeryxShellPolicy(definition.policy_profile);
  if (!policy.ok) {
    return { ok: false, error: { reason: "unknown-policy-profile", message: policy.error.message } };
  }
  // codex's sandbox_mode vocabulary IS `policy_profile`'s vocabulary
  // (`AgentPolicyProfile`) verbatim — asserted here rather than re-derived,
  // so a future third profile value fails loudly instead of silently mapping
  // to the wrong sandbox mode.
  const sandboxMode: AgentPolicyProfile = isAgentPolicyProfile(definition.policy_profile)
    ? definition.policy_profile
    : "read-only";
  const lines = [
    `# ${agentManagedSentinelText(definition)}`,
    `name = ${tomlString(definition.name)}`,
    `description = ${tomlString(definition.description)}`,
    `developer_instructions = ${tomlMultilineString(header)}`,
    `sandbox_mode = ${tomlString(sandboxMode)}`,
  ];
  return {
    ok: true,
    result: {
      target: "codex",
      supportLevel: "adapter",
      relativePath: `.codex/agents/${definition.name}.toml`,
      content: `${lines.join("\n")}\n`,
      droppedTools: [],
    },
  };
}

/**
 * Kiro renderer (`.kiro/agents/<name>.json`, context.md's first-party docs
 * check): unknown-key tolerance is undocumented, so NO extra top-level key
 * carries the managed sentinel — it is the first line of `prompt` instead.
 * `tools` uses kiro's documented coarse tags (`read`/`write`/`shell`/`web`,
 * `tools.ts`'s kiro map) — every vocabulary entry maps onto one of the four,
 * so nothing is ever dropped here. `model` is omitted (omit = inherit).
 * `allowedTools` is deliberately NOT emitted: its interaction with `tools`
 * is not confirmed by first-party docs, and inventing a value would be a
 * guess this renderer refuses to make.
 */
function renderKiroExport(definition: AgentDefinition, header: string): CompileResult {
  const { mappedTools, droppedTools } = mapToolsForTarget(definition.tools, "kiro");
  const prompt = `${agentManagedSentinelText(definition)}\n\n${header}`;
  const doc = {
    name: definition.name,
    description: definition.description,
    prompt,
    tools: mappedTools,
  };
  return {
    ok: true,
    result: {
      target: "kiro",
      supportLevel: "adapter",
      relativePath: `.kiro/agents/${definition.name}.json`,
      content: `${JSON.stringify(doc, null, 2)}\n`,
      droppedTools,
    },
  };
}

/**
 * OpenCode renderer (`.opencode/agents/<name>.md`, context.md's first-party
 * docs check): the documented `tools` boolean map is deprecated — this
 * renderer emits a `permission` map instead (`edit`/`bash`/`webfetch`/
 * `websearch`, each `allow`/`deny`), derived from BOTH the definition's
 * `tools[]` (does the mapped OpenCode tool actually appear) and its
 * `policy_profile` (a `read-only` definition denies `edit`/`bash`
 * regardless of what `tools[]` names — the enforced policy always wins over
 * a merely-declared intent; `webfetch`/`websearch` are non-mutating and
 * follow tool presence alone, unaffected by the write/no-write distinction
 * `policy_profile` encodes). `mode: subagent` and an omitted `model` (=
 * inherit) are both fixed per docs.
 */
function renderOpencodeExport(definition: AgentDefinition, header: string): CompileResult {
  const { mappedTools, droppedTools } = mapToolsForTarget(definition.tools, "opencode");
  const has = (toolName: string) => mappedTools.includes(toolName);
  const canWrite = definition.policy_profile === "workspace-write";
  const permission = {
    edit: canWrite && has("edit") ? "allow" : "deny",
    bash: canWrite && has("bash") ? "allow" : "deny",
    webfetch: has("webfetch") ? "allow" : "deny",
    websearch: has("websearch") ? "allow" : "deny",
  };
  const frontmatter = [
    "---",
    `description: ${definition.description}`,
    "mode: subagent",
    "permission:",
    `  edit: ${permission.edit}`,
    `  bash: ${permission.bash}`,
    `  webfetch: ${permission.webfetch}`,
    `  websearch: ${permission.websearch}`,
    "---",
  ].join("\n");
  const content = `${frontmatter}\n${mdSentinelLine(definition)}\n\n${header}\n`;
  return {
    ok: true,
    result: {
      target: "opencode",
      supportLevel: "adapter",
      relativePath: `.opencode/agents/${definition.name}.md`,
      content,
      droppedTools,
    },
  };
}

/**
 * The hook point every host renderer plugs into. `supportLevel` on each
 * result is the renderer's OWN mechanical-shape fact (claude verified/native
 * per T5, codex/kiro/opencode experimental/adapter per context.md's docs
 * check) — never the final honesty gate a caller relies on; `export.ts`'s
 * `agentExportSupport` (reading the W5 registry) is the one place that
 * decides whether this render is actually used for a given project, per
 * AC4.
 */
export function renderHostExport(
  definition: AgentDefinition,
  target: HostToolTarget,
  header: string,
): CompileResult {
  if (target === "claude") {
    return { ok: true, result: renderClaudeExport(definition, header) };
  }
  if (target === "codex") {
    return renderCodexExport(definition, header);
  }
  if (target === "kiro") {
    return renderKiroExport(definition, header);
  }
  if (target === "opencode") {
    return renderOpencodeExport(definition, header);
  }
  return {
    ok: false,
    error: {
      reason: "target-not-implemented",
      message: `host export target "${String(target)}" has no renderer`,
    },
  };
}

export type CompileHeaderResult = { readonly ok: true; readonly header: string } | { readonly ok: false; readonly error: CompileError };

/**
 * Validate + render the header alone (baseline + role + body), with none of
 * a target's own shape applied — the same first two steps
 * `compileAgentDefinition` always runs before dispatching on `target`.
 * `export.ts`'s instruction-only prose fallback (AC4: a runtime with no
 * W5 registry `agents` record) is the one caller that needs the header
 * WITHOUT committing to any one host's frontmatter/TOML/JSON shape — reusing
 * this avoids a second, independent copy of the validate-then-render steps.
 */
export function compileAgentHeader(definition: AgentDefinition): CompileHeaderResult {
  const validation = validateAgentDefinition(definition);
  if (!validation.ok) {
    return {
      ok: false,
      error: {
        reason: "invalid-definition",
        message: `agent "${definition.name}" failed schema validation`,
        details: formatValidationErrors(validation.errors),
      },
    };
  }
  if (definition.body.includes(PROMPT_DEFENSE_BASELINE)) {
    return {
      ok: false,
      error: {
        reason: "baseline-in-body",
        message: `agent "${definition.name}"'s body repeats the prompt-defense baseline text — the compiler injects it once; remove it from the body`,
      },
    };
  }
  return { ok: true, header: renderHeader(definition) };
}

/** The only producer of dispatch/export inputs from an {@link AgentDefinition} (D-2). Never throws. */
export function compileAgentDefinition(definition: AgentDefinition, target: AgentExportRuntime): CompileResult {
  const headerResult = compileAgentHeader(definition);
  if (!headerResult.ok) {
    return { ok: false, error: headerResult.error };
  }
  const header = headerResult.header;
  if (target === "keryx-shell") {
    return compileKeryxShell(definition, header);
  }
  return renderHostExport(definition, target, header);
}
