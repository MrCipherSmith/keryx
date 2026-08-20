// Shared types for the stdio MCP client (flow 182, T6).
// Package: docs/requirements/keryx-mcp-client specification.md §1-§5.
//
// This file carries NO SDK import, static or dynamic — it is pure data shapes
// consumed by both the pure logic (`wire.ts`, `elicitation.ts`, unit-testable
// with no SDK at all) and the impure adapter (`client.ts`, the only file that
// lazily loads `@modelcontextprotocol/sdk`).
//
// `McpClientPort`/`McpClientConnection` is this module's analog of
// `src/harness/external/supervise.ts`'s `ExternalSpawnPort`/`SpawnedProcess`:
// the one injected seam a test substitutes wholesale, so the supervisor
// (`src/harness/external/supervise-mcp.ts`) never touches the real SDK in a
// unit test — only the flag-gated live smoke test in this directory does.

/** What the child process is spawned with. cwd/env only — argv is separate. */
export interface McpSpawnOptions {
  readonly cwd: string;
  readonly env: Record<string, string>;
}

/** One `tools/call` result, in the shape this module cares about. */
export interface McpToolCallResult {
  readonly content: unknown;
  readonly isError: boolean;
}

/**
 * The outcome of one `callTool`.
 *
 * `timeout` is its own variant, not a thrown error: per the T5 live probe
 * (context.md "T5 live probe findings"), the outer `tools/call` promise can
 * outlive a cleanly-declined elicitation and hit the SDK's own default 60s
 * client timeout (`McpError -32001`). A caller must be able to observe that
 * distinctly from a genuine protocol error, which is why {@link McpClientConnection.callTool}
 * always resolves rather than rejecting.
 */
export type McpToolCallOutcome =
  | { readonly kind: "result"; readonly result: McpToolCallResult }
  | { readonly kind: "timeout" }
  | { readonly kind: "error"; readonly message: string };

/**
 * One `elicitation/create` request, read off the RAW wire — i.e. NOT the
 * SDK's own `ElicitRequestSchema`-parsed value, which strips every field
 * codex populates outside the standard MCP shape via Zod's default
 * unknown-key stripping (T5 live probe finding, load-bearing for AC2).
 *
 * `vendor` carries every params key this module does not itself recognise as
 * standard MCP (`message`, `requestedSchema`) — `codex_call_id` lives in
 * here, read out by {@link import("./wire").extractCodexCallId}.
 */
export interface RawElicitationRequest {
  readonly requestId: string | number;
  readonly message: string | undefined;
  readonly requestedSchema: unknown;
  readonly vendor: Readonly<Record<string, unknown>>;
}

/**
 * One `codex/event` notification's `params.msg`, unpacked just enough to
 * correlate with a pending elicitation.
 *
 * `availableDecisions` is deliberately `readonly string[]`, not a fixed enum:
 * per the T5 live probe, the valid `decision` values for a given elicitation
 * are only known from THIS field on the sibling notification, and they are
 * not the same set across every request.
 */
export interface RawCodexEventNotification {
  readonly msgType: string;
  readonly callId: string | undefined;
  readonly availableDecisions: readonly string[] | undefined;
  readonly raw: Readonly<Record<string, unknown>>;
}

/**
 * The exact response shape codex's own `ExecApprovalResponse` deserializer
 * reads — a non-standard, TOP-LEVEL `decision` field, not the standard MCP
 * `ElicitResult.content` shape (T5 live probe finding).
 *
 * `decision` is omitted on a `"decline"` built from an UNCORRELATED
 * elicitation (no sibling `codex/event` found): there is no `available_decisions`
 * list to choose a safe value from, and guessing one is exactly what AC5
 * exists to forbid. `"cancel"` exists for completeness with the standard MCP
 * `action` vocabulary; this module never produces it.
 */
export type ElicitationResponsePayload =
  | { readonly action: "accept"; readonly decision: string }
  | { readonly action: "decline"; readonly decision?: string }
  | { readonly action: "cancel" };

/** Everything the escalation classifier seam (T9) needs about one elicitation. */
export interface PendingElicitation {
  readonly requestId: string | number;
  readonly callId: string | undefined;
  readonly message: string | undefined;
  readonly vendor: Readonly<Record<string, unknown>>;
}

/**
 * T9's seam: the elicitation-payload analog of `classifyPatchRisk`
 * (`src/lib/patch-risk.ts`). `T6-T8` supplied only a placeholder
 * implementation; `elicitation.ts`'s `classifyElicitationRisk` (T9) is the
 * real one, dropped in without touching any call site's shape.
 */
export interface ElicitationRiskClassification {
  readonly destructive: boolean;
  readonly credentials: boolean;
  /**
   * Human-readable reasons for the classification, mirroring
   * `PatchRiskClassification.reasons`'s same field. NOTE (T9): as of this
   * writing `PatchRiskClassification.reasons` itself is NOT threaded through
   * to the approval prompt — `agent.ts`'s `write` branch destructures only
   * `{ destructive, credentials }` from `classifyPatchRisk`'s result and
   * discards `reasons` (verified by reading that call site). This field
   * follows the same precedent: populated with real, non-empty content by
   * `classifyElicitationRisk` whenever it escalates, and available for a
   * future call site to surface, but `supervise-mcp.ts`'s `requestApproval`
   * call does not thread it through today either — see that file's own
   * comment at the call site for the same reasoning applied there.
   */
  readonly reasons: readonly string[];
}

/**
 * A live connection to one spawned `codex mcp-server` child.
 *
 * `onElicitation`'s handler RETURNS the response to send — this is the
 * seam's single most important shape decision (see `client.ts`'s header):
 * the real implementation registers exactly one MCP request handler for
 * `elicitation/create` and returns the handler's resolved value directly as
 * the JSON-RPC result, which is what lets the response be the non-standard
 * `{action, decision}` shape rather than the SDK's own `ElicitResult`
 * wrapping. Only one handler may be registered; a second call replaces it
 * (mirrors `SpawnedProcess`'s single-consumer shape).
 */
export interface McpClientConnection {
  callTool(
    name: string,
    args: Record<string, unknown>,
    opts?: { readonly timeoutMs?: number },
  ): Promise<McpToolCallOutcome>;
  onElicitation(handler: (request: RawElicitationRequest) => Promise<ElicitationResponsePayload>): void;
  onCodexEvent(handler: (event: RawCodexEventNotification) => void): void;
  close(): Promise<void>;
}

/**
 * The injected seam. `connect` is allowed to throw — a port that cannot spawn
 * or complete the MCP handshake at all is genuinely broken, mirroring
 * `ExternalSpawnPort.spawn`'s same allowance in `supervise.ts`.
 */
export interface McpClientPort {
  connect(argv: readonly string[], options: McpSpawnOptions): Promise<McpClientConnection>;
}
