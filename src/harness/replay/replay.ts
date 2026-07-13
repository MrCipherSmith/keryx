// Effect-free offline replay (flow 009, W7 / S5, task-R0-03).
//
// `buildReplayFixture` snapshots the deterministic, recomputable state of a
// recorded `RunResult` into a `ReplayFixture` (validates against the frozen
// `replay-fixture.schema.json`, `mode: "validate-log"`, `noSideEffects: true`;
// Release 0 never selects `isolated-re-execute`). `replayOffline` is a PURE,
// SYNCHRONOUS recomputation: it re-derives the same hashes from the recorded
// `RunResult` and compares them to the fixture. It carries no `ProviderPort` /
// `ToolExecutorPort` and touches no network, so there is structurally nothing
// for it to invoke live (@SC_R17_NO_LIVE_EFFECT_ON_REPLAY /
// @SC_R14_OFFLINE_REPLAY). On any divergence it returns a typed
// `ReplayMismatch` (validates against `replay-mismatch.schema.json`) rather than
// ever falling back to a live execution (@SC_R12_REPLAY_MISMATCH /
// @SC_R17_REPLAY_MISMATCH_REPORTED).
//
// Deterministic + offline: no `Date.now`, `Math.random`, network, real timer,
// or filesystem surface; the clock/id used to stamp a mismatch arrive via deps.
import type { RunResult } from "../run/run";

/** Every durable harness contract in Release 0 is schemaVersion 1. */
const SCHEMA_VERSION = 1;

/**
 * A recorded replay fixture. Mirrors `replay-fixture.schema.json`
 * (`additionalProperties: false`): a constructed value validates unchanged.
 */
export interface ReplayFixture {
  schemaVersion: number;
  fixtureId: string;
  mode: "validate-log" | "simulate-recorded-results" | "isolated-re-execute";
  sessionManifestHash: string;
  eventLogHash: string;
  toolRegistryHash: string;
  transcriptHash: string;
  expectedStateHash: string;
  noSideEffects: boolean;
  isolationProfile?: string;
}

/** Typed replay mismatch. Mirrors `replay-mismatch.schema.json`. */
export interface ReplayMismatch {
  schemaVersion: number;
  mismatchId: string;
  fixtureId: string;
  kind:
    | "schema"
    | "event-order"
    | "state"
    | "tool-result"
    | "provider-transcript"
    | "policy"
    | "unexpected-side-effect";
  expectedHash: string;
  actualHash: string;
  detectedAt: string;
  detail?: string;
}

/** The outcome of an offline replay: a clean match, or a typed mismatch. */
export type ReplayOutcome = { ok: true } | { ok: false; mismatch: ReplayMismatch };

/** Dependencies for building a fixture: a monotonic id source for `fixtureId`. */
export interface BuildReplayFixtureDeps {
  idSeq: () => string;
}

/** Dependencies for a replay: a fixed clock + id source to stamp a mismatch. */
export interface ReplayDeps {
  clock: () => string;
  idSeq: () => string;
}

/**
 * The recomputable hash surface of a recorded run. Both `buildReplayFixture`
 * and `replayOffline` derive it through this single function, so a fixture and
 * a fresh recomputation of the same run agree by construction, and any
 * tampering with the fixture is detected as a mismatch.
 */
function recomputeHashes(run: RunResult): {
  sessionManifestHash: string;
  eventLogHash: string;
  toolRegistryHash: string;
  transcriptHash: string;
  expectedStateHash: string;
} {
  return {
    sessionManifestHash: run.sessionManifestHash,
    eventLogHash: run.eventLogHash,
    toolRegistryHash: run.toolRegistryHash,
    transcriptHash: run.transcriptHash,
    expectedStateHash: run.expectedStateHash,
  };
}

/**
 * Snapshot `run` into a deterministic, schema-valid replay fixture. Two builds
 * of the same run (with a fresh identical `idSeq`) are byte-identical. The mode
 * is always the side-effect-free `validate-log` — Release 0 never selects
 * isolated re-execution.
 */
export function buildReplayFixture(run: RunResult, deps: BuildReplayFixtureDeps): ReplayFixture {
  const hashes = recomputeHashes(run);
  return {
    schemaVersion: SCHEMA_VERSION,
    fixtureId: deps.idSeq(),
    mode: "validate-log",
    sessionManifestHash: hashes.sessionManifestHash,
    eventLogHash: hashes.eventLogHash,
    toolRegistryHash: hashes.toolRegistryHash,
    transcriptHash: hashes.transcriptHash,
    expectedStateHash: hashes.expectedStateHash,
    noSideEffects: true,
  };
}

/** Ordered fixture-hash checks; the first divergence wins. */
const HASH_CHECKS: ReadonlyArray<{
  field: keyof ReturnType<typeof recomputeHashes>;
  kind: ReplayMismatch["kind"];
  detail: string;
}> = [
  { field: "sessionManifestHash", kind: "state", detail: "session manifest hash diverged on replay" },
  { field: "eventLogHash", kind: "event-order", detail: "event log hash diverged on replay" },
  { field: "toolRegistryHash", kind: "tool-result", detail: "tool registry hash diverged on replay" },
  { field: "transcriptHash", kind: "provider-transcript", detail: "provider transcript hash diverged on replay" },
  { field: "expectedStateHash", kind: "state", detail: "expected terminal state hash diverged on replay" },
];

/**
 * Replay `fixture` against its recorded `run`, entirely offline and without any
 * live effect. Returns `{ ok: true }` when every recomputed hash matches the
 * fixture; otherwise a typed {@link ReplayMismatch} for the first divergence.
 * Synchronous by contract — it carries no provider/executor/network handle.
 */
export function replayOffline(fixture: ReplayFixture, run: RunResult, deps: ReplayDeps): ReplayOutcome {
  const actual = recomputeHashes(run);

  for (const check of HASH_CHECKS) {
    const expectedHash = fixture[check.field];
    const actualHash = actual[check.field];
    if (expectedHash !== actualHash) {
      return {
        ok: false,
        mismatch: {
          schemaVersion: SCHEMA_VERSION,
          mismatchId: deps.idSeq(),
          fixtureId: fixture.fixtureId,
          kind: check.kind,
          expectedHash,
          actualHash,
          detectedAt: deps.clock(),
          detail: check.detail,
        },
      };
    }
  }

  return { ok: true };
}
