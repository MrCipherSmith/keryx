// JSONL/RPC transport over the assembled offline run loop (flow 009, W7 / S5,
// task-R0-03).
//
// `encodeRpc`/`decodeRpc` frame a single `RpcEnvelope` as exactly one JSONL
// line (no embedded newline) and round-trip it byte-for-byte; the envelope
// validates against the frozen `rpc-jsonl-envelope.schema.json`. `runViaRpc`
// carries a run request across that framing and delegates to the SAME
// `runOffline` assembly the CLI transport uses, so the two transports never
// diverge in semantics (@SC_R13_CLI_RPC_PARITY) and neither can upgrade an
// in-process policy decision (@SC_R13_TRANSPORT_CANNOT_CHANGE_POLICY): the
// transport only frames bytes, the engine decides policy.
//
// Deterministic + offline: framing is pure `JSON.stringify`/`JSON.parse`; no
// clock, randomness, network, or filesystem surface is added here.
import type { HarnessConfig } from "./config";
import { type RunDeps, type RunResult, runOffline } from "./run/run";
import type { HarnessRunInput } from "./types";

/** Every durable harness contract in Release 0 is schemaVersion 1. */
const SCHEMA_VERSION = 1;

/**
 * A single JSONL/RPC envelope. Mirrors `rpc-jsonl-envelope.schema.json`
 * (`additionalProperties: false`): a constructed value validates unchanged.
 */
export interface RpcEnvelope {
  schemaVersion: number;
  messageId: string;
  correlationId: string;
  kind: "request" | "event" | "response" | "error";
  payload: Record<string, unknown>;
  sequence?: number;
}

/**
 * Encode an envelope as exactly one JSONL line. The result contains no newline,
 * so a stream of envelopes is one-per-line.
 */
export function encodeRpc(envelope: RpcEnvelope): string {
  return JSON.stringify(envelope);
}

/** Decode a single JSONL line back into an {@link RpcEnvelope}. */
export function decodeRpc(line: string): RpcEnvelope {
  const parsed: unknown = JSON.parse(line);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("decodeRpc: line does not encode a JSON object envelope");
  }
  return parsed as RpcEnvelope;
}

/**
 * Run `input` through the JSONL/RPC transport. The run request is framed into a
 * request envelope and recovered across the framing (proving the transport
 * round-trips), then executed by {@link runOffline}. The returned `RunResult`
 * is semantically identical to the CLI transport's for the same
 * `(input, config, deps)`.
 */
export async function runViaRpc(
  input: HarnessRunInput,
  config: HarnessConfig,
  deps: RunDeps,
): Promise<RunResult> {
  // Frame the request across the transport and recover it. `runInput` is a
  // structural clone of `input`; the transport carries data, never policy.
  const requestEnvelope: RpcEnvelope = {
    schemaVersion: SCHEMA_VERSION,
    messageId: "rpc-run-request",
    correlationId: "rpc-run",
    kind: "request",
    payload: { input: input as unknown as Record<string, unknown> },
  };
  const recovered = decodeRpc(encodeRpc(requestEnvelope));
  const runInput = (recovered.payload as { input: HarnessRunInput }).input;

  return runOffline(runInput, config, deps);
}
