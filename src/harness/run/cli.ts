// CLI transport over the assembled offline run loop (flow 009, W7 / S5,
// task-R0-03).
//
// `runViaCli` is a thin transport: it delegates verbatim to `runOffline` and
// returns its `RunResult` unchanged. The CLI framing carries no policy of its
// own, so it can never change a decision the in-process engine made
// (@SC_R13_TRANSPORT_CANNOT_CHANGE_POLICY) and its semantics are identical to
// the JSONL/RPC transport (@SC_R13_CLI_RPC_PARITY). Deterministic + offline:
// it adds no clock, randomness, network, or filesystem surface.
import type { HarnessConfig } from "../config";
import type { HarnessRunInput } from "../types";
import { type RunDeps, type RunResult, runOffline } from "./run";

/**
 * Run `input` through the CLI transport. Semantically identical to
 * {@link runOffline}; the same `(input, config, deps)` yields the same
 * `RunResult` as the JSONL/RPC transport.
 */
export async function runViaCli(
  input: HarnessRunInput,
  config: HarnessConfig,
  deps: RunDeps,
): Promise<RunResult> {
  return runOffline(input, config, deps);
}
