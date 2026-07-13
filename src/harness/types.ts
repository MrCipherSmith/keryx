// Release 0 harness run-input type (flow 009, W7 / S1, R0-01).
//
// `HarnessRunInput` mirrors the frozen `harness-run-input.schema.json` shape
// (required: schemaVersion/request/projectRoot/role/policy/budget; optional:
// flowId/sessionId/provider/model/scope/transport/nonInteractive) PLUS one
// local-only extension, `credentialRef`, that is NEVER part of the
// schema-validated document. ADR-0001 / README §Startup and Resume
// Preconditions treat "a reachable credential reference" as a startup
// precondition, but the frozen schema has `additionalProperties:false` and no
// `credentialRef` property — so callers strip `credentialRef` before running
// positive schema validation (see the tests' `toSchemaShape` helper).

/** Roles permitted by `harness-run-input.schema.json#/properties/role`. */
export type HarnessRole = "plan" | "build" | "review" | "verify" | "research" | "orchestrator";

/** Transports permitted by `harness-run-input.schema.json#/properties/transport`. */
export type HarnessTransport = "cli" | "rpc" | "json" | "test";

/** Per-run budget, mirroring `harness-run-input.schema.json#/properties/budget`. */
export interface HarnessBudget {
  maxSeconds: number;
  maxToolCalls: number;
  maxRetries: number;
  maxPromptTokens?: number;
  maxCompletionTokens?: number;
}

/** Optional scope selector, mirroring `harness-run-input.schema.json#/properties/scope`. */
export interface HarnessScope {
  paths?: string[];
  base?: string;
  head?: string;
  query?: string;
}

export interface HarnessRunInput {
  schemaVersion: number;
  request: string;
  projectRoot: string;
  role: HarnessRole;
  policy: string;
  budget: HarnessBudget;
  flowId?: string;
  sessionId?: string;
  provider?: string;
  model?: string;
  scope?: HarnessScope;
  transport?: HarnessTransport;
  nonInteractive?: boolean;
  /**
   * Local-only startup precondition. NEVER schema-validated: strip it before
   * calling `validateAgainstSchema` against `harness-run-input.schema.json`.
   */
  credentialRef?: string;
}
