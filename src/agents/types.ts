// Flow 310 (W2 agent-definitions catalog) — the shapes the rest of `src/agents/`
// is built from. Frontmatter fields mirror
// `docs/requirements/keryx-agent-platform-expansion/schemas/agent-definition.schema.json`
// exactly (`schema.ts`'s AC1 test asserts the two agree); `body` is the
// Markdown that follows the frontmatter block, not part of the JSON Schema
// itself.
//
// This file is data shapes only — no IO, no validation logic, no compiler.
// `compile.ts` is the only producer of dispatch/export inputs FROM these
// types (D-2); nothing here duplicates that.

import type { ModelTier } from "../gdskills/model-tier";

export type { ModelTier };

/** The one result contract this workstream ships against (W2 §Design). */
export type OutputContract = "subagent-result";

/** Whether the compiled dispatch requests worktree isolation. Default `"none"`. */
export type IsolationMode = "none" | "worktree";

/** Definition schema versions accepted by the catalogue. V1 remains readable; V2 adds delegation metadata. */
export type AgentSchemaVersion = 1 | 2;

/** Whether an agent is a leaf worker or may coordinate bounded child work. */
export type AgentExecutionKind = "worker" | "orchestrator";

/** Static definitions use their declared tools; parent scope requests the parent's effective tool surface. */
export type AgentToolScope = "static" | "parent";

/** Declarative delegation ceiling. Runtime admission may only narrow these values. */
export interface AgentDelegation {
  readonly allowed_entities: readonly string[];
  readonly max_depth: number;
  readonly max_children: number;
}

/** Provenance kind for a definition (`origin.kind`). */
export type OriginKind = "authored" | "generated" | "imported" | "learned";

/** `origin` — provenance for a definition. Absent only for a hand-authored file predating this field. */
export interface AgentOrigin {
  readonly kind: OriginKind;
  /** Required in practice for every non-`authored` kind (schema description). */
  readonly sourceRef?: string;
  readonly generatedAt?: string;
}

/**
 * A parsed, schema-valid agent definition: every frontmatter field from
 * `agent-definition.schema.json`, plus the Markdown `body` that follows it.
 *
 * `tools`/`skills`/`stacks` are always arrays here (schema defaults `[]`
 * applied by `schema.ts#buildAgentDefinition`), and `isolation` is always
 * present (defaulted to `"none"`) — a caller never has to re-apply the
 * schema's defaults itself.
 */
export interface AgentDefinition {
  /** Omitted definitions are legacy V1. V2 carries the orchestration fields below. */
  readonly schema_version?: AgentSchemaVersion;
  readonly name: string;
  readonly description: string;
  readonly role: string;
  readonly tools: readonly string[];
  readonly model_tier: ModelTier;
  readonly policy_profile: string;
  readonly skills: readonly string[];
  readonly stacks: readonly string[];
  readonly output_contract: OutputContract;
  readonly isolation: IsolationMode;
  /** Defaults to `worker` when a V1 definition is built or directly compiled. */
  readonly execution_kind?: AgentExecutionKind;
  /** Defaults to `static`; `parent` is valid only for an orchestrator. */
  readonly tool_scope?: AgentToolScope;
  /** Defaults to a leaf ceiling (`[]`, depth 0, children 0). */
  readonly delegation?: AgentDelegation;
  readonly origin?: AgentOrigin;
  /** Markdown body: the persona's operating instructions (no baseline text — compiler-injected). */
  readonly body: string;
}

/** Where a loaded definition came from. A project definition overrides a bundled one of the same name. */
export type AgentSourceKind = "bundled" | "project";

export interface AgentSource {
  readonly kind: AgentSourceKind;
  /** Absolute path to the `<name>.md` file this definition was read from. */
  readonly path: string;
}

/** A catalog entry: the parsed definition, where it came from, and the raw file text. */
export interface LoadedAgent {
  readonly definition: AgentDefinition;
  readonly source: AgentSource;
  readonly raw: string;
}

/** The five compile targets W2 ships against (spec §"Per-harness exporters"). */
export type AgentExportRuntime = "claude" | "codex" | "kiro" | "opencode" | "keryx-shell";

/**
 * Per-runtime export honesty (W2 §"Per-harness exporters"): looked up from the
 * W5 capability matrix, never asserted independently by this module.
 */
export type ExportSupportLevel = "native" | "adapter" | "instruction-only";
