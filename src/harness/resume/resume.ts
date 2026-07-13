// Durable resume + transient-retry wrapper (flow 011, W8 / RS-01, R0-02).
//
// Two capabilities, both deterministic and OFFLINE, assembled over the already
// GREEN W7 session (S2) and W7 run loop (R0-03) plus the W6 FakeProvider — no new
// dependency, no SDK, no clock/RNG/network/filesystem of their own (every source
// of non-determinism is injected via `deps`):
//
//   1. `resumeSessionFrom` — reconstruct the current leaf of a persisted session
//      and decide whether resume may CONTINUE in place or must start a NEW
//      immutable attempt. It reuses `resumeSession` (W7) so prior entries are
//      preserved byte-for-byte and the content-dedup index is rebuilt: replaying
//      an already-accepted evidence append is idempotent while genuinely new
//      (post-crash / stale) work still appends as a fresh entry. Fingerprint
//      drift (`worktree`/`toolchain`) makes the recorded work stale and forces a
//      new attempt; a matching environment continues; an empty session is new
//      work. Resume NEVER appends by itself — a pending approval and prior
//      evidence survive untouched (@SC_R05 / @SC_R11).
//
//   2. `runWithResume` — a MINIMAL wrapper over `runOffline` (W7) that, on a
//      RETRYABLE provider error, records a NEW attempt within `maxAttempts`
//      (@SC_R12). It reuses `runOffline` unchanged (run.ts is NOT edited): each
//      attempt is one `runOffline` call (one provider `stream()`), the failed
//      attempt's `provider_error` stays in the returned event trail (a retry
//      appends history, it never erases the prior attempt), and the retry bound
//      stops deterministically with a typed non-`completed` status rather than
//      looping unboundedly.
import type { HarnessConfig } from "../config";
import type { NormalizedEvent } from "../provider/types";
import type { RunDeps, RunResult } from "../run/run";
import { runOffline } from "../run/run";
import { AppendOnlySession, resumeSession, type SessionDeps } from "../session/session";
import type { SessionEntry } from "../session/types";
import type { HarnessRunInput } from "../types";
import { type Fingerprints, fingerprintsMatch } from "./fingerprint";
import type { SessionStore } from "./store";

/** Why a resume took the branch it did. */
export type ResumeReason = "continue" | "stale-fingerprint" | "new-work";

/**
 * The outcome of a durable resume: the reconstructed live `session`, the leaf it
 * reopened on, the (relative) `attempt` number, and whether a new immutable
 * attempt was started because the recorded environment was stale.
 */
export interface ResumeResult {
  session: AppendOnlySession;
  currentLeafEntryId?: string;
  attempt: number;
  startedNewAttempt: boolean;
  reason: ResumeReason;
}

/** Inputs to a single durable resume. */
export interface ResumeInput {
  sessionId: string;
  store: SessionStore;
  /** The environment fingerprints observed right now. */
  current: Fingerprints;
  /** The environment fingerprints recorded when the session was last written. */
  recorded: Fingerprints;
}

/** Typed rejection for a resume against a session the store does not know. */
export class ResumeSessionNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`resumeSessionFrom: no persisted snapshot for session ${sessionId}`);
    this.name = "ResumeSessionNotFoundError";
  }
}

/**
 * Count the distinct prior attempts recorded on a session's entries. Deterministic
 * (a pure fold over the persisted causal ids); an empty/attempt-less session is
 * attempt 1. Numbering is RELATIVE — the only invariant callers depend on is that
 * a stale resume's attempt is strictly greater than a continued one on identical
 * state.
 */
function deriveBaseAttempt(entries: readonly SessionEntry[]): number {
  const attemptIds = new Set<string>();
  for (const entry of entries) {
    const attemptId = entry.causal.attemptId;
    if (attemptId !== undefined) attemptIds.add(attemptId);
  }
  return Math.max(1, attemptIds.size);
}

/**
 * Reconstruct the current leaf of a persisted session and decide the resume
 * branch. Reuses the W7 `resumeSession` so prior entries stay immutable and
 * content-dedup is preserved; resume itself never appends.
 */
export function resumeSessionFrom(input: ResumeInput, deps: SessionDeps): ResumeResult {
  const snapshot = input.store.read(input.sessionId);
  if (snapshot === undefined) {
    throw new ResumeSessionNotFoundError(input.sessionId);
  }

  const { manifest, entries } = snapshot;
  const session = resumeSession({ manifest, entries }, deps);
  const baseAttempt = deriveBaseAttempt(entries);
  const matches = fingerprintsMatch(input.current, input.recorded);

  let reason: ResumeReason;
  let attempt: number;
  let startedNewAttempt: boolean;

  if (entries.length === 0) {
    // Nothing recorded yet: this is fresh work on the reconstructed session.
    reason = "new-work";
    attempt = baseAttempt;
    startedNewAttempt = false;
  } else if (matches) {
    // Same environment: continue the recorded work on the reconstructed leaf.
    reason = "continue";
    attempt = baseAttempt;
    startedNewAttempt = false;
  } else {
    // Drifted environment: the recorded work is stale — start a NEW immutable
    // attempt (a strictly higher relative attempt number) over the preserved,
    // untouched prior entries.
    reason = "stale-fingerprint";
    attempt = baseAttempt + 1;
    startedNewAttempt = true;
  }

  const result: ResumeResult = { session, attempt, startedNewAttempt, reason };
  if (manifest.currentLeafEntryId.length > 0) {
    result.currentLeafEntryId = manifest.currentLeafEntryId;
  }
  return result;
}

/** True when the attempt failed with at least one retryable provider error. */
function hasRetryableProviderError(events: readonly NormalizedEvent[]): boolean {
  return events.some((event) => event.kind === "provider_error" && event.error?.retryable === true);
}

/**
 * Run one offline harness turn with bounded transient-retry. On a retryable
 * provider error the run records a NEW attempt (a fresh `runOffline` call, one
 * provider `stream()`) up to `deps.maxAttempts`. The returned `events` accumulate
 * across attempts so the failed attempt's `provider_error` survives; the final
 * `output` is the last attempt's terminal document. The bound guarantees
 * termination: a run that keeps failing retryably stops with a typed
 * non-`completed` status instead of looping unboundedly.
 */
export async function runWithResume(
  input: HarnessRunInput,
  config: HarnessConfig,
  deps: RunDeps & { maxAttempts: number },
): Promise<RunResult & { attempts: number }> {
  const { maxAttempts, ...runDeps } = deps;
  const cap = Math.max(1, maxAttempts);

  const accumulatedEvents: NormalizedEvent[] = [];
  let attempts = 0;
  let last: RunResult | undefined;

  while (attempts < cap) {
    attempts += 1;
    const result = await runOffline(input, config, runDeps);
    last = result;
    accumulatedEvents.push(...result.events);

    // Success: stop immediately.
    if (result.output.status === "completed") break;
    // Non-retryable failure: a retry cannot help — stop with the typed status.
    if (!hasRetryableProviderError(result.events)) break;
    // Retryable failure: loop to record a new attempt while the bound allows it.
  }

  if (last === undefined) {
    // Unreachable: `cap >= 1` guarantees at least one attempt ran.
    throw new Error("runWithResume: no attempt was executed");
  }

  return { ...last, events: accumulatedEvents, attempts };
}
