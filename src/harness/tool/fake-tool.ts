// FakeTool — one registered, read-only, deterministic tool over the W5 tool
// port for the Keryx harness (flow 008, W6 / F-02).
//
// Pins the single read-only tool permitted in Release 0 by
// `docs/requirements/keryx-project-agent-harness/specification.md`
// ("Tool Definition" — read-only classification, provenance, replay flag; "the
// model must not receive direct filesystem or shell access outside registered
// tools") and the frozen AC3: a registered read-only fake tool whose `invoke`
// returns a `ToolResult` with a hash-bound `outputHash` stable across runs
// (same input -> same hash), executable only after `validateToolCall`
// (unregistered / envelope-invalid / input-invalid calls are rejected), with no
// network / filesystem / mutation side effects.
//
// Deterministic + offline by construction: hashing is a canonical sha256 of the
// recorded output (`node:crypto`), and every id / timestamp on the returned
// `ToolResult` is derived from the call. No `Date.now`, no `Math.random`, no
// network, no filesystem, and no provider SDK — this reuses only the W5 neutral
// port types, the registry, and the W4-backed `validateToolCall` gate.

import { createHash } from "node:crypto";
import type { ToolRegistry } from "./registry";
import { validateToolCall } from "./tool-port";
import type { ToolDefinition, ToolExecutorPort, ToolInvocation, ToolResult } from "./types";

/**
 * Deterministic canonical JSON: object keys are emitted in sorted order at every
 * level so structurally-equal values serialize identically regardless of
 * insertion order. Arrays keep their order (semantically significant). Mirrors
 * the sibling canonicalizers in `registry.ts` / `fake-provider.ts`.
 */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const entries = keys.map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`);
  return `{${entries.join(",")}}`;
}

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * The single registered read-only fake tool (Release 0). The wire-shaped fields
 * (`schemaVersion`..`replay`) validate against `tool-definition.schema.json`;
 * `classification` is an in-memory-only policy hint (see {@link ToolDefinition})
 * that the schema — being `additionalProperties: false` — does not carry, so
 * callers strip it before schema validation.
 */
export const FAKE_READONLY_TOOL: ToolDefinition = {
  schemaVersion: 1,
  toolId: "fake.read",
  version: "0.1.0",
  description: "Deterministic read-only fake tool for the Keryx harness (Release 0).",
  inputSchema: {
    type: "object",
    required: ["key"],
    properties: { key: { type: "string" } },
  },
  outputSchema: { type: "object" },
  risk: "read",
  capabilities: ["read"],
  limits: {
    timeoutMs: 1_000,
    maxOutputBytes: 65_536,
    concurrencyKey: "fake.read",
  },
  replay: { deterministic: true, recordedResultSupported: true },
  classification: {
    read: true,
    write: false,
    network: false,
    subprocess: false,
    credential: false,
  },
};

/**
 * The canonical recorded output for a given `input`. Pure and deterministic:
 * it embeds the tool id and the (canonicalized) input, so different inputs
 * produce structurally different recorded outputs and therefore different
 * hashes, while a fresh object with the same contents reproduces the same one.
 */
function recordedOutputFor(input: Record<string, unknown>): Record<string, unknown> {
  return {
    kind: "recorded-read",
    tool: FAKE_READONLY_TOOL.toolId,
    input,
  };
}

/**
 * Deterministic sha256 hex digest over the canonical recorded output for
 * `input` (`node:crypto`, sorted-key JSON). Same input -> same hash, different
 * input -> different hash, independent of any executor / registry instance and
 * of any clock or randomness.
 */
export function recordedOutputHash(input: Record<string, unknown>): string {
  return sha256(canonicalize(recordedOutputFor(input)));
}

/** Fixed deterministic timestamp for every recorded result (no clock read). */
const RECORDED_CREATED_AT = "1970-01-01T00:00:00.000Z";

/** Options for {@link FakeToolExecutor}. */
export interface FakeToolExecutorOptions {
  schemaDir: string;
}

/**
 * The read-only fake tool executor (AC3). `invoke` first gates the call through
 * `validateToolCall` — an unregistered tool, an envelope-invalid call, or an
 * input violating the tool's inline `inputSchema` REJECTS the returned promise
 * and never reaches a `ToolResult`. A valid call resolves to a schema-valid
 * `ToolResult` (`status: "succeeded"`) whose `outputHash` is bound to
 * {@link recordedOutputHash} of the call input. It performs no filesystem,
 * network, or mutation side effects.
 */
export class FakeToolExecutor implements ToolExecutorPort {
  private readonly registry: ToolRegistry;
  private readonly schemaDir: string;

  constructor(registry: ToolRegistry, opts: FakeToolExecutorOptions) {
    this.registry = registry;
    this.schemaDir = opts.schemaDir;
  }

  async invoke(invocation: ToolInvocation): Promise<ToolResult> {
    const { call } = invocation;

    // Gate: registered + envelope-valid + input-valid. Any failure rejects;
    // a gate-rejected call never produces a `ToolResult`.
    const gate = validateToolCall(call, this.registry, this.schemaDir);
    if (!gate.valid) {
      const detail = gate.errors.map((error) => `${error.path}: ${error.message}`).join("; ");
      throw new Error(
        `FakeToolExecutor: tool call "${call.toolCallId}" failed validation: ${detail}`,
      );
    }

    const outputHash = recordedOutputHash(call.input);

    return {
      schemaVersion: 1,
      toolResultId: `result-${call.toolCallId}`,
      executionId: `exec-${call.toolCallId}`,
      toolCallId: call.toolCallId,
      causal: {
        runId: call.runId,
        sessionId: call.sessionId,
        correlationId: call.toolCallId,
      },
      status: "succeeded",
      outputHash,
      redaction: "not-needed",
      createdAt: RECORDED_CREATED_AT,
    };
  }
}
