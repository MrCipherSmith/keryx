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

/** Every durable harness contract in Release 0 is schemaVersion 1. */
const SCHEMA_VERSION = 1;

/**
 * The recomputable hash surface a fixture binds to.
 *
 * Declared here rather than imported as `RunResult` (flow 134 / S5) so a
 * recorded run read back from disk — which carries these five fields and not a
 * live `ProviderPort` or an event array — can be replayed by the same code an
 * in-process run uses. `RunResult` satisfies this structurally, so every
 * existing caller is unchanged.
 */
export interface RecomputableRun {
  sessionManifestHash: string;
  eventLogHash: string;
  toolRegistryHash: string;
  transcriptHash: string;
  expectedStateHash: string;
}

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
function recomputeHashes(run: RecomputableRun): {
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
export function buildReplayFixture(run: RecomputableRun, deps: BuildReplayFixtureDeps): ReplayFixture {
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

/**
 * A recorded run, as written to disk so it can be replayed later (flow 134 / S5).
 *
 * The five hashes are the whole replayable surface; `runId`/`status`/`recordedAt`
 * are there so a human looking at the file can tell which run it is. It is
 * deliberately NOT the full `RunResult`: events, decisions and session entries
 * are already folded into `eventLogHash` and `expectedStateHash`, and writing
 * them again would put raw model and tool output on disk for no gain in what
 * `validate-log` can check.
 */
export interface HarnessRunRecord extends RecomputableRun {
  schemaVersion: number;
  runId: string;
  status: string;
  recordedAt: string;
}

/** Snapshot a completed run into the durable {@link HarnessRunRecord} form. */
export function toRunRecord(
  run: RecomputableRun,
  meta: { runId: string; status: string; recordedAt: string },
): HarnessRunRecord {
  return {
    schemaVersion: SCHEMA_VERSION,
    runId: meta.runId,
    status: meta.status,
    recordedAt: meta.recordedAt,
    sessionManifestHash: run.sessionManifestHash,
    eventLogHash: run.eventLogHash,
    toolRegistryHash: run.toolRegistryHash,
    transcriptHash: run.transcriptHash,
    expectedStateHash: run.expectedStateHash,
  };
}

const HASH_FIELDS = [
  "sessionManifestHash",
  "eventLogHash",
  "toolRegistryHash",
  "transcriptHash",
  "expectedStateHash",
] as const;

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function hasEveryHash(record: Record<string, unknown>): boolean {
  return HASH_FIELDS.every((field) => nonEmptyString(record[field]));
}

/**
 * Read back a {@link HarnessRunRecord} from parsed JSON, or `undefined` when the
 * document is not one. Shape-checked rather than schema-validated: the frozen
 * schemas live in the requirements package, which an installed CLI does not
 * necessarily ship, and a replay that cannot run without them would be no more
 * reachable than the one this replaces.
 */
export function parseRunRecord(value: unknown): HarnessRunRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (!hasEveryHash(record) || !nonEmptyString(record.runId)) return undefined;
  return {
    schemaVersion: typeof record.schemaVersion === "number" ? record.schemaVersion : SCHEMA_VERSION,
    runId: record.runId,
    status: nonEmptyString(record.status) ? record.status : "unknown",
    recordedAt: nonEmptyString(record.recordedAt) ? record.recordedAt : "",
    sessionManifestHash: record.sessionManifestHash as string,
    eventLogHash: record.eventLogHash as string,
    toolRegistryHash: record.toolRegistryHash as string,
    transcriptHash: record.transcriptHash as string,
    expectedStateHash: record.expectedStateHash as string,
  };
}

/** Read back a {@link ReplayFixture} from parsed JSON, or `undefined`. */
export function parseReplayFixture(value: unknown): ReplayFixture | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (!hasEveryHash(record) || !nonEmptyString(record.fixtureId)) return undefined;
  const mode = record.mode;
  if (mode !== "validate-log" && mode !== "simulate-recorded-results" && mode !== "isolated-re-execute") {
    return undefined;
  }
  return {
    schemaVersion: typeof record.schemaVersion === "number" ? record.schemaVersion : SCHEMA_VERSION,
    fixtureId: record.fixtureId,
    mode,
    sessionManifestHash: record.sessionManifestHash as string,
    eventLogHash: record.eventLogHash as string,
    toolRegistryHash: record.toolRegistryHash as string,
    transcriptHash: record.transcriptHash as string,
    expectedStateHash: record.expectedStateHash as string,
    noSideEffects: record.noSideEffects !== false,
    ...(nonEmptyString(record.isolationProfile) ? { isolationProfile: record.isolationProfile } : {}),
  };
}

/** Ordered fixture-hash checks; the first divergence wins. */
const HASH_CHECKS: ReadonlyArray<{
  field: keyof ReturnType<typeof recomputeHashes>;
  kind: ReplayMismatch["kind"];
  detail: string;
}> = [
  { field: "sessionManifestHash", kind: "state", detail: "sessionManifestHash diverged on replay (session manifest)" },
  { field: "eventLogHash", kind: "event-order", detail: "eventLogHash diverged on replay (event order)" },
  { field: "toolRegistryHash", kind: "tool-result", detail: "toolRegistryHash diverged on replay (tool registry)" },
  { field: "transcriptHash", kind: "provider-transcript", detail: "transcriptHash diverged on replay (provider transcript)" },
  { field: "expectedStateHash", kind: "state", detail: "expectedStateHash diverged on replay (terminal state)" },
];

/**
 * Replay `fixture` against its recorded `run`, entirely offline and without any
 * live effect. Returns `{ ok: true }` when every recomputed hash matches the
 * fixture; otherwise a typed {@link ReplayMismatch} for the first divergence.
 * Synchronous by contract — it carries no provider/executor/network handle.
 */
export function replayOffline(fixture: ReplayFixture, run: RecomputableRun, deps: ReplayDeps): ReplayOutcome {
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
