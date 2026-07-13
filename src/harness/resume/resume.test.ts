// RED tests for R0-02 / RS-01 durable resume (flow 011, W8 / T5, sub-slice RS-01).
//
// Pins the durable-resume contract per
// docs/requirements/keryx-project-agent-harness/acceptance.feature
// `@task-RS-01` scenarios exercised in this suite:
//   - @SC_R05_APPROVAL_RESUME            "Resume an unchanged pending approval"
//   - @SC_R11_EVIDENCE_SURVIVES_RESUME   "Preserve evidence across resume"
//   - @SC_R12_TRANSIENT_RETRY            "Retry one transient provider error within budget"
// plus the reconstruct-leaf / stale-attempt / immutability invariants shared
// with the already-GREEN W7 @SC_R06_APPEND_ONLY_SESSION /
// @SC_R06_RESUME_NO_DUPLICATE session suite (reused here at the resume-module
// boundary rather than re-tested at the session boundary).
//
// RS-01 impl (next dispatch) implements:
//   - src/harness/resume/fingerprint.ts (`Fingerprints`, `fingerprintsMatch`)
//   - src/harness/resume/store.ts       (`Checkpoint`, `SessionSnapshot`,
//                                         `SessionStore`, `InMemorySessionStore`)
//   - src/harness/resume/resume.ts      (`ResumeResult`, `resumeSessionFrom`,
//                                         `runWithResume`)
// to make this suite GREEN; until then the missing-module imports below are
// the expected RED failure ("Cannot find module './fingerprint'" etc).
//
// API DELTA vs. the dispatch's pinned sketch: NONE. `Checkpoint` matches
// `checkpoint.schema.json` verbatim (required: schemaVersion, checkpointId,
// sessionId, atEntryId, stateHash, createdAt, evidenceLedgerCursor); the
// reused `SessionManifest`/`SessionEntry` shapes from `../session/types` are
// unchanged from the W7 slice. `runWithResume`'s extra `maxAttempts` knob is
// carried on `deps` (RunDeps & { maxAttempts: number }), never on
// `HarnessConfig` or `HarnessRunInput`, so no frozen input/config schema is
// touched.
//
// Deterministic: `clock`/`idSeq` are always injected via `makeDeps()`; no
// `Date.now()`, `Math.random()`, or network anywhere in this file. Retryable
// provider failures are modelled by a scripted, offline `FakeProviderTranscript`
// (`kind: "error", retryable: true`) — never a real wall-clock wait or live
// provider.
import { createHash } from "node:crypto";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { validateAgainstSchema } from "../../contracts/validator";
import type { HarnessConfig } from "../config";
import type { PolicyProfile } from "../policy/types";
import { FakeProvider, type FakeProviderTranscript, requestHashOf } from "../provider/fake-provider";
import type { NormalizedRequest, ProviderPort } from "../provider/types";
import type { RunDeps } from "../run/run";
import { AppendOnlySession } from "../session/session";
import type { SessionEntry, SessionManifest, SessionSeed } from "../session/types";
import { ToolRegistry } from "../tool/registry";
import type { ToolExecutorPort } from "../tool/types";
import type { HarnessRunInput } from "../types";

// PINNED API (see dispatch) — RS-01 impl exports these from the modules below;
// imports fail until then (expected RED: "Cannot find module './fingerprint'").
import { type Fingerprints, fingerprintsMatch } from "./fingerprint";
import { resumeSessionFrom, type ResumeResult, runWithResume } from "./resume";
import { type Checkpoint, InMemorySessionStore } from "./store";

// Frozen schemas dir, computed relative to this file
// (src/harness/resume/ -> repo root).
const SCHEMA_DIR = path.join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "docs",
  "requirements",
  "keryx-project-agent-harness",
  "schemas",
);

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Deterministic deps: fixed clock, fresh monotonic id sequence per call.
// Mirrors `src/harness/session/session.test.ts` / `src/harness/run/run.test.ts`
// `makeDeps()`.
// ---------------------------------------------------------------------------
function makeDeps(): { clock: () => string; idSeq: () => string } {
  let counter = 0;
  return {
    clock: () => "2026-01-01T00:00:00.000Z",
    idSeq: () => `id-${counter++}`,
  };
}

const SHA_PLACEHOLDER = "c".repeat(64);

function artifactRef(artifactId: string, kind = "evidence"): { artifactId: string; kind: string; hash: string } {
  return { artifactId, kind, hash: SHA_PLACEHOLDER };
}

const seed: SessionSeed = {
  sessionId: "session-resume-1",
  runId: "run-resume-1",
  createdAt: "2026-01-01T00:00:00.000Z",
  policyFingerprint: "a".repeat(64),
  contextManifestHash: "b".repeat(64),
};

function validateEntry(entry: SessionEntry): void {
  const result = validateAgainstSchema("session-entry.schema.json", entry, { schemaDir: SCHEMA_DIR });
  expect(result.valid).toBe(true);
  expect(result.errors).toEqual([]);
}

// ---------------------------------------------------------------------------
// Fingerprint fixtures.
// ---------------------------------------------------------------------------
const fpA: Fingerprints = { worktree: "/repo", toolchain: "bun-1.2.0" };
const fpAAgain: Fingerprints = { worktree: "/repo", toolchain: "bun-1.2.0" };
const fpToolchainChanged: Fingerprints = { worktree: "/repo", toolchain: "bun-1.3.0" };
const fpWorktreeChanged: Fingerprints = { worktree: "/repo-other", toolchain: "bun-1.2.0" };

// --- 1. Fingerprint match / mismatch ----------------------------------------

describe("fingerprintsMatch", () => {
  test("true when worktree and toolchain are both equal", () => {
    expect(fingerprintsMatch(fpA, fpAAgain)).toBe(true);
  });

  test("false when the toolchain differs", () => {
    expect(fingerprintsMatch(fpA, fpToolchainChanged)).toBe(false);
  });

  test("false when the worktree differs", () => {
    expect(fingerprintsMatch(fpA, fpWorktreeChanged)).toBe(false);
  });
});

// --- 2. Reconstruct the current leaf by fingerprints ------------------------

/** Builds a small persisted (manifest, entries) pair via the real W7 session. */
function buildOriginalSession(): { manifest: SessionManifest; entries: SessionEntry[] } {
  const session = new AppendOnlySession(seed, makeDeps());
  const e0 = session.append({ type: "user_message", text: "start" });
  const e1 = session.append(
    {
      type: "model_response",
      modelAttemptId: "attempt-1",
      artifactRef: artifactRef("artifact-1", "model-response"),
    },
    { parentEntryId: e0.entryId },
  );
  session.append({ type: "tool_call", toolCallId: "tc-1" }, { parentEntryId: e1.entryId });
  return { manifest: session.manifest(), entries: session.entries() };
}

describe("resumeSessionFrom — reconstruct the current leaf by fingerprints", () => {
  test("matching fingerprints rebuild the session with the correct currentLeafEntryId and reason 'continue'", () => {
    const { manifest, entries } = buildOriginalSession();
    const store = new InMemorySessionStore({ [seed.sessionId]: { manifest, entries } });

    const result: ResumeResult = resumeSessionFrom(
      { sessionId: seed.sessionId, store, current: fpA, recorded: fpA },
      makeDeps(),
    );

    expect(result.reason).toBe("continue");
    expect(result.startedNewAttempt).toBe(false);
    expect(result.currentLeafEntryId).toBe(manifest.currentLeafEntryId);
    expect(result.session.currentLeaf()?.entryId).toBe(manifest.currentLeafEntryId);
    expect(result.session.entries()).toEqual(entries);
  });
});

// --- 3. Stale fingerprint -> new immutable attempt --------------------------

describe("resumeSessionFrom — stale fingerprint starts a new immutable attempt", () => {
  test("fingerprint mismatch reports stale-fingerprint, increments attempt, and never mutates prior entries", () => {
    const { manifest, entries } = buildOriginalSession();
    const originalEntries = [...entries];
    const store = new InMemorySessionStore({ [seed.sessionId]: { manifest, entries } });

    const continued = resumeSessionFrom(
      { sessionId: seed.sessionId, store, current: fpA, recorded: fpA },
      makeDeps(),
    );
    const stale = resumeSessionFrom(
      { sessionId: seed.sessionId, store, current: fpToolchainChanged, recorded: fpA },
      makeDeps(),
    );

    expect(stale.reason).toBe("stale-fingerprint");
    expect(stale.startedNewAttempt).toBe(true);
    expect(stale.attempt).toBeGreaterThan(continued.attempt);

    // Prior entries remain byte-identical and reachable after the stale resume.
    for (const original of originalEntries) {
      const found = stale.session.entries().find((entry: SessionEntry) => entry.entryId === original.entryId);
      expect(found).toEqual(original);
    }
    expect(stale.session.entries()).toHaveLength(originalEntries.length);
  });

  test("re-appending an already-accepted evidenceId after a stale resume does not duplicate it (reuses W7 dedup)", () => {
    const session = new AppendOnlySession(seed, makeDeps());
    const first = session.append({ type: "user_message", text: "start" });
    const accepted = session.append(
      { type: "evidence_link", artifactRef: artifactRef("evidence-1") },
      { parentEntryId: first.entryId, evidenceId: "evidence-1" },
    );
    const manifest = session.manifest();
    const persistedEntries = session.entries();
    const store = new InMemorySessionStore({ [seed.sessionId]: { manifest, entries: persistedEntries } });

    const stale = resumeSessionFrom(
      { sessionId: seed.sessionId, store, current: fpWorktreeChanged, recorded: fpA },
      makeDeps(),
    );
    expect(stale.reason).toBe("stale-fingerprint");

    // Re-appending the SAME evidence (same evidenceId, same payload+parent)
    // must not duplicate it.
    const replay = stale.session.append(
      { type: "evidence_link", artifactRef: artifactRef("evidence-1") },
      { parentEntryId: first.entryId, evidenceId: "evidence-1" },
    );
    expect(replay.entryId).toBe(accepted.entryId);
    expect(
      stale.session.entries().filter((entry: SessionEntry) => entry.entry.type === "evidence_link"),
    ).toHaveLength(1);

    // Genuinely new (stale) work still appends as a fresh immutable entry.
    const newWork = stale.session.append(
      { type: "assistant_message", text: "stale retry after crash" },
      { parentEntryId: accepted.entryId },
    );
    expect(newWork.entryId).not.toBe(accepted.entryId);
    expect(stale.session.entries()).toHaveLength(3);
  });
});

// --- 4. Approval survives resume (SC_R05_APPROVAL_RESUME) -------------------

describe("resumeSessionFrom — approval survives resume (SC_R05_APPROVAL_RESUME)", () => {
  test("a pending approval_request entry is preserved after resume: not dropped, not re-created", () => {
    const session = new AppendOnlySession(seed, makeDeps());
    const request = session.append({ type: "user_message", text: "please approve" });
    const pendingApproval = session.append(
      { type: "approval_request", toolCallId: "tc-approval-1" },
      { parentEntryId: request.entryId },
    );
    // No approval_result is ever appended: the approval remains pending.
    const manifest = session.manifest();
    const entries = session.entries();
    const store = new InMemorySessionStore({ [seed.sessionId]: { manifest, entries } });

    const result = resumeSessionFrom(
      { sessionId: seed.sessionId, store, current: fpA, recorded: fpA },
      makeDeps(),
    );

    const approvalsAfter = result.session
      .entries()
      .filter((entry: SessionEntry) => entry.entry.type === "approval_request");
    expect(approvalsAfter).toHaveLength(1);
    const approvalEntry = approvalsAfter[0];
    if (!approvalEntry) throw new Error("expected exactly one pending approval_request entry after resume");
    expect(approvalEntry).toEqual(pendingApproval);

    // The model request is not repeated: appendCursor/entry count is unchanged
    // by resume alone (resume never appends by itself).
    expect(result.session.entries()).toHaveLength(entries.length);
  });
});

// --- 5. Evidence survives resume (SC_R11_EVIDENCE_SURVIVES_RESUME) ----------

describe("resumeSessionFrom — evidence survives resume (SC_R11_EVIDENCE_SURVIVES_RESUME)", () => {
  test("evidence_link entries remain reachable, immutable, and count-unchanged after resume", () => {
    const session = new AppendOnlySession(seed, makeDeps());
    const root = session.append({ type: "user_message", text: "start" });
    const evidence1 = session.append(
      { type: "evidence_link", artifactRef: artifactRef("evidence-a") },
      { parentEntryId: root.entryId, evidenceId: "evidence-a" },
    );
    const evidence2 = session.append(
      { type: "evidence_link", artifactRef: artifactRef("evidence-b") },
      { parentEntryId: evidence1.entryId, evidenceId: "evidence-b" },
    );
    const manifest = session.manifest();
    const entries = session.entries();
    const evidenceCountBefore = entries.filter((entry: SessionEntry) => entry.entry.type === "evidence_link").length;
    const store = new InMemorySessionStore({ [seed.sessionId]: { manifest, entries } });

    const result = resumeSessionFrom(
      { sessionId: seed.sessionId, store, current: fpA, recorded: fpA },
      makeDeps(),
    );

    const evidenceAfter = result.session
      .entries()
      .filter((entry: SessionEntry) => entry.entry.type === "evidence_link");
    expect(evidenceAfter).toHaveLength(evidenceCountBefore);
    expect(evidenceAfter.map((entry: SessionEntry) => entry.entryId).sort()).toEqual(
      [evidence1.entryId, evidence2.entryId].sort(),
    );
    for (const entry of evidenceAfter) {
      validateEntry(entry);
    }
  });
});

// --- 6. Transient-retry within reservation (SC_R12_TRANSIENT_RETRY) --------

const readOnlyProfile: PolicyProfile = {
  schemaVersion: 1,
  profileId: "read-only-review",
  profileVersion: "1.0.0",
  fingerprint: sha256("read-only-review:1.0.0"),
  trustMode: "read-only",
  defaults: { read: "allow", write: "deny", shell: "deny", network: "deny", delegate: "deny" },
  requiredControls: { isolation: "not-required", redactionFailure: "deny", networkBrokerFailure: "deny" },
};

function buildConfig(): HarnessConfig {
  return {
    schemaVersion: 1,
    enabled: true,
    defaultRole: "build",
    defaultProvider: "fake-provider",
    defaultModel: "fixture-model",
    policyProfile: "read-only-review",
    limits: { maxRunSeconds: 300, maxConcurrentChildren: 1, maxToolOutputBytes: 65_536, maxRetries: 1 },
  };
}

function buildInput(overrides?: Partial<HarnessRunInput>): HarnessRunInput {
  return {
    schemaVersion: 1,
    request: "run the resume fixture scenario",
    projectRoot: "/repo",
    role: "build",
    policy: "read-only-review",
    budget: { maxSeconds: 60, maxToolCalls: 5, maxRetries: 1 },
    provider: "fake-provider",
    model: "fixture-model",
    credentialRef: "cred-ref-1",
    ...overrides,
  };
}

function buildFixtureRequest(requestId: string): NormalizedRequest {
  return {
    providerId: "fake-provider",
    modelId: "fixture-model",
    systemInstruction: "fixture system instruction",
    messages: [{ role: "user", content: "fixture prompt" }],
    budget: { maxOutputTokens: 1000, runReservation: 1000 },
    stream: true,
    requestId,
    parentRunId: "run-fixture",
  };
}

function transcriptWithRetryableError(transcriptId: string): FakeProviderTranscript {
  return {
    schemaVersion: 1,
    transcriptId,
    providerId: "fake-provider",
    providerRevision: "fake-1.0.0",
    requestHash: "0".repeat(64), // stamped to the fixture request hash below
    events: [
      { sequence: 0, kind: "text_delta", payload: { text: "Processing" } },
      {
        sequence: 1,
        kind: "error",
        payload: { kind: "overloaded", message: "Provider temporarily overloaded", retryable: true },
      },
    ],
  };
}

function transcriptSuccess(transcriptId: string, finalText = "Task complete."): FakeProviderTranscript {
  return {
    schemaVersion: 1,
    transcriptId,
    providerId: "fake-provider",
    providerRevision: "fake-1.0.0",
    requestHash: "0".repeat(64), // stamped to the fixture request hash below
    events: [
      { sequence: 0, kind: "text_delta", payload: { text: finalText } },
      { sequence: 1, kind: "finish", payload: {} },
    ],
  };
}

// Delegates each successive `stream()` call to the next real, committed
// `FakeProvider` in `transcripts` (each wrapping exactly one transcript,
// stamped to the same fixture request hash) so a retry loop observes a
// DIFFERENT scripted outcome per attempt while still replaying through the
// real FakeProvider — same technique as `run.test.ts`'s `fixtureProvider`,
// extended across multiple sequential attempts.
function sequencedFixtureProvider(
  transcripts: FakeProviderTranscript[],
  requestId: string,
): { provider: ProviderPort; streamCalls: { count: number } } {
  const request = buildFixtureRequest(requestId);
  const hash = requestHashOf(request);
  const fakes = transcripts.map((transcript) => new FakeProvider([{ ...transcript, requestHash: hash }]));
  const firstFake = fakes[0];
  if (!firstFake) throw new Error("sequencedFixtureProvider requires at least one transcript");
  const streamCalls = { count: 0 };
  const provider: ProviderPort = {
    describe: () => firstFake.describe(),
    stream: (_request, opts) => {
      const index = Math.min(streamCalls.count, fakes.length - 1);
      streamCalls.count++;
      const fake = fakes[index];
      if (!fake) throw new Error("unreachable: sequencedFixtureProvider index out of bounds");
      return fake.stream(request, opts);
    },
  };
  return { provider, streamCalls };
}

const noToolExecutor: ToolExecutorPort = {
  invoke: async () => {
    throw new Error("no tool call expected in this fixture transcript");
  },
};

describe("runWithResume — retries one transient provider error within budget (SC_R12_TRANSIENT_RETRY)", () => {
  test("a retryable provider_error is followed by a new attempt that succeeds within maxAttempts", async () => {
    const registry = new ToolRegistry();
    const { provider, streamCalls } = sequencedFixtureProvider(
      [transcriptWithRetryableError("t-retry-fail"), transcriptSuccess("t-retry-success")],
      "req-transient-retry",
    );
    const { clock, idSeq } = makeDeps();
    const deps: RunDeps & { maxAttempts: number } = {
      provider,
      toolRegistry: registry,
      toolExecutor: noToolExecutor,
      policyProfile: readOnlyProfile,
      clock,
      idSeq,
      interactive: true,
      maxAttempts: 3,
    };

    const result = await runWithResume(buildInput(), buildConfig(), deps);

    // A NEW attempt is recorded within the reservation; the run recovers.
    expect(result.attempts).toBeGreaterThanOrEqual(2);
    expect(result.attempts).toBeLessThanOrEqual(3);
    expect(streamCalls.count).toBe(result.attempts);
    expect(result.output.status).toBe("completed");

    // The failed first attempt's provider_error remains in the trail: a retry
    // appends new history, it never erases the prior (failed) attempt.
    expect(
      result.events.some(
        (event: { kind: string; error?: { retryable: boolean } }) =>
          event.kind === "provider_error" && event.error?.retryable === true,
      ),
    ).toBe(true);

    // No exact-duplicate entries: every persisted session entry has a unique
    // (payload, parent) combination, mirroring AppendOnlySession's own content
    // dedup — evidence is never recorded twice across the retry.
    const seenKeys = new Set<string>();
    for (const entry of result.sessionEntries) {
      const key = `${JSON.stringify(entry.entry)}::${entry.causal.parentEventId ?? ""}`;
      expect(seenKeys.has(key)).toBe(false);
      seenKeys.add(key);
    }

    const validation = validateAgainstSchema("harness-run-output.schema.json", result.output, {
      schemaDir: SCHEMA_DIR,
    });
    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);
  });

  test("retries exceeding maxAttempts stop deterministically with a non-completed typed status, never looping unboundedly", async () => {
    const registry = new ToolRegistry();
    // Every attempt fails the same retryable way — the bound must still stop it.
    const { provider, streamCalls } = sequencedFixtureProvider(
      [
        transcriptWithRetryableError("t-retry-fail-1"),
        transcriptWithRetryableError("t-retry-fail-2"),
        transcriptWithRetryableError("t-retry-fail-3"),
      ],
      "req-transient-retry-exhausted",
    );
    const { clock, idSeq } = makeDeps();
    const deps: RunDeps & { maxAttempts: number } = {
      provider,
      toolRegistry: registry,
      toolExecutor: noToolExecutor,
      policyProfile: readOnlyProfile,
      clock,
      idSeq,
      interactive: true,
      maxAttempts: 2,
    };

    const result = await runWithResume(buildInput(), buildConfig(), deps);

    expect(result.attempts).toBeLessThanOrEqual(2);
    expect(streamCalls.count).toBeLessThanOrEqual(2);
    expect(result.output.status).not.toBe("completed");
  });
});

// --- 7. Checkpoint validity --------------------------------------------------

describe("Checkpoint — validates against the frozen checkpoint schema", () => {
  test("a constructed Checkpoint round-trips through validateAgainstSchema unchanged", () => {
    const checkpoint: Checkpoint = {
      schemaVersion: 1,
      checkpointId: "checkpoint-1",
      sessionId: seed.sessionId,
      atEntryId: "entry-leaf-1",
      stateHash: sha256("checkpoint-state"),
      createdAt: "2026-01-01T00:00:00.000Z",
      evidenceLedgerCursor: 3,
    };

    const result = validateAgainstSchema("checkpoint.schema.json", checkpoint, { schemaDir: SCHEMA_DIR });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });
});
