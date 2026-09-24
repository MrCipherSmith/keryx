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

import { PROMPT_DEFENSE_BASELINE } from "./baseline";
import { validateAgentDefinition, type AgentSchemaError } from "./schema";
import { mapToolsForTarget, type HostToolTarget } from "./tools";
import { resolveKeryxShellPolicy, type KeryxShellMode } from "./policy";
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
function renderClaudeExport(definition: AgentDefinition, header: string): HostAgentExport {
  const { mappedTools, droppedTools } = mapToolsForTarget(definition.tools, "claude");
  const frontmatter = [
    "---",
    `name: ${definition.name}`,
    `description: ${definition.description}`,
    `tools: ${mappedTools.join(", ")}`,
    "model: inherit",
    "---",
  ].join("\n");
  const sentinel = `<!-- keryx-managed: agents export target=claude name=${definition.name} -->`;
  const content = `${frontmatter}\n${sentinel}\n\n${header}\n`;
  return {
    target: "claude",
    supportLevel: "native",
    relativePath: `.claude/agents/${definition.name}.md`,
    content,
    droppedTools,
  };
}

/**
 * The hook point T7 implements the remaining host renderers through
 * (codex/kiro/opencode). Exported so a future renderer can be added without
 * touching `compileAgentDefinition`'s dispatch below.
 */
export function renderHostExport(
  definition: AgentDefinition,
  target: HostToolTarget,
  header: string,
): CompileResult {
  if (target === "claude") {
    return { ok: true, result: renderClaudeExport(definition, header) };
  }
  return {
    ok: false,
    error: {
      reason: "target-not-implemented",
      message: `host export target "${target}" is not implemented in T5 (T7 adds it once its first-party docs are confirmed)`,
    },
  };
}

/** The only producer of dispatch/export inputs from an {@link AgentDefinition} (D-2). Never throws. */
export function compileAgentDefinition(definition: AgentDefinition, target: AgentExportRuntime): CompileResult {
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

  const header = renderHeader(definition);
  if (target === "keryx-shell") {
    return compileKeryxShell(definition, header);
  }
  return renderHostExport(definition, target, header);
}
