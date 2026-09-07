import type { MemoryStatus } from "./types";
import { currentDay, isValidCalendarDate } from "./temporal";

export type LifecycleError = {
  code: "invalid-transition" | "terminal-state";
  from: MemoryStatus;
  to: MemoryStatus;
  message: string;
};

export type LifecycleTransition =
  | { ok: true; changed: boolean }
  | { ok: false; error: LifecycleError };

const ALLOWED: Record<MemoryStatus, readonly MemoryStatus[]> = {
  draft: ["accepted", "conflict", "deprecated"],
  accepted: ["draft", "conflict", "deprecated"],
  conflict: ["draft", "accepted", "deprecated"],
  deprecated: ["draft"],
  superseded: [],
};

/** Pure lifecycle transition table. Supersession is a separate pair operation. */
export function transitionMemoryStatus(from: MemoryStatus, to: MemoryStatus): LifecycleTransition {
  if (from === to) {
    return { ok: true, changed: false };
  }
  if (from === "superseded") {
    return {
      ok: false,
      error: {
        code: "terminal-state",
        from,
        to,
        message: "A superseded memory entry is terminal and cannot be transitioned.",
      },
    };
  }
  if (!ALLOWED[from].includes(to)) {
    return {
      ok: false,
      error: {
        code: "invalid-transition",
        from,
        to,
        message: `Cannot transition memory entry from ${from} to ${to}.`,
      },
    };
  }
  return { ok: true, changed: true };
}

// --- AFC-06 canonical freshness classifier -------------------------------
//
// Normative source: docs/requirements/keryx-agent-first-core/policies.md,
// "Lifecycle и freshness":
//
//   current = accepted AND validFrom <= observedAt
//             AND (validTo absent OR observedAt < validTo)
//             AND no effective supersededBy
//
// This is the single canonical implementation of that formula (AFC-06 AC1:
// "date boundary, future, deprecated, conflict, superseded и malformed have
// the same tolerance in wiki/memory"). It is intentionally decoupled from
// `MemoryEntry` (raw status/date strings only) so `src/wiki/provenance.ts`
// can classify a wiki page's frontmatter through the exact same function
// instead of re-deriving the rule.
//
// Existing narrower helpers (`transitionMemoryStatus` above, and
// `isValidAt`/`isCurrentAt` in `./temporal.ts`) are left as-is: they serve
// hot-path, status-blind boolean checks already exercised by
// `search.ts`/`relevant.ts`, and rewriting their call sites is out of scope
// for this task. `computeLifecycle` reuses their date-validity primitive
// (`isValidCalendarDate`) rather than duplicating it.

/**
 * The classifier's fine-grained verdict. `historical` below is always
 * `state !== "current"` — callers that only need "is this an instruction I
 * can act on" should read `historical`/`current`, never compare `state`
 * against a hand-picked string list (AC1 requirement #3).
 */
export type LifecycleState =
  | "current"
  | "future"
  | "expired"
  | "draft"
  | "deprecated"
  | "conflict"
  | "superseded"
  | "unknown"
  | "invalid";

/** Raw, unvalidated fields as read from frontmatter — memory or wiki alike. */
export type LifecycleInput = {
  /** Raw status text. Only the literal `"accepted"` is ever eligible for `current`. */
  status: string | null | undefined;
  /** Event-time start (YYYY-MM-DD). Absent ⇒ no lower bound. */
  validFrom?: string | null | undefined;
  /** Event-time end (YYYY-MM-DD), exclusive. Absent ⇒ no upper bound. */
  validTo?: string | null | undefined;
  /** Pointer (relative path or id) to the item that replaces this one. */
  supersededBy?: string | null | undefined;
};

export type LifecycleResult = {
  state: LifecycleState;
  /** `true` iff `state === "current"`. */
  current: boolean;
  /**
   * `true` iff `state !== "current"`. History is reachable only through an
   * explicit mode (policy: "История ... доступна только по явному режиму и
   * с полным status"); this flag is what lets a caller enforce that without
   * string-comparing `state`.
   */
  historical: boolean;
  /** Machine-readable reason codes; always non-empty for a non-current state. */
  reasons: string[];
};

const KNOWN_HISTORICAL_STATUSES: ReadonlySet<string> = new Set([
  "draft",
  "deprecated",
  "conflict",
  "superseded",
]);

function historicalResult(state: LifecycleState, reason: string): LifecycleResult {
  return { state, current: false, historical: true, reasons: [reason] };
}

/**
 * Resolves whether a `supersededBy` pointer refers to an item that is
 * itself effective (currently in force). Pure: the caller supplies a
 * synchronous lookup over already-loaded items (memory entries, wiki pages,
 * or a mix) rather than this module reaching into any store.
 *
 * A pointer that does not resolve, or a chain that loops back on itself, is
 * a conflict — never silently "superseded" and never silently "current"
 * (policy: "циклическая/сломанная цепочка — conflict/unknown с причиной").
 */
export type SupersessionLookup = (pointer: string) => LifecycleInput | undefined;

function resolveSupersessionEffectiveness(
  pointer: string,
  observedAt: Date,
  lookup: SupersessionLookup,
  visited: Set<string>,
): { effective: boolean; reason: string } {
  if (visited.has(pointer)) {
    return { effective: false, reason: "cyclic-supersession-chain" };
  }
  visited.add(pointer);
  const next = lookup(pointer);
  if (!next) {
    return { effective: false, reason: "broken-supersession-chain" };
  }
  const nextResult = computeLifecycleInternal(next, observedAt, lookup, visited);
  if (nextResult.current) {
    return { effective: true, reason: "superseded-by-effective-replacement" };
  }
  // A conflict deeper in the chain (broken/cyclic) is more specific than a
  // generic "not effective yet" verdict — surface it rather than masking it.
  if (nextResult.state === "conflict") {
    return { effective: false, reason: nextResult.reasons[0] ?? "superseding-item-not-effective" };
  }
  return { effective: false, reason: "superseding-item-not-effective" };
}

function computeLifecycleInternal(
  input: LifecycleInput,
  observedAt: Date,
  lookup: SupersessionLookup | undefined,
  visited: Set<string>,
): LifecycleResult {
  // 1. Malformed/ambiguous dates are an invalid lifecycle, unconditionally —
  // never silently folded into "not current" alongside a normal future/
  // expired/deprecated verdict, and never treated as current by omission.
  if (input.validFrom != null && !isValidCalendarDate(input.validFrom)) {
    return historicalResult("invalid", "malformed-valid-from");
  }
  if (input.validTo != null && !isValidCalendarDate(input.validTo)) {
    return historicalResult("invalid", "malformed-valid-to");
  }
  if (Number.isNaN(observedAt.getTime())) {
    return historicalResult("invalid", "malformed-observed-at");
  }

  // 2. Status gate. Missing/unknown status never becomes accepted.
  const status = input.status ?? null;
  if (status !== "accepted") {
    if (status && KNOWN_HISTORICAL_STATUSES.has(status)) {
      return historicalResult(status as LifecycleState, `status-${status}`);
    }
    return historicalResult("unknown", "status-not-accepted");
  }

  // 3. Date boundary (UTC calendar days). Missing dates ⇒ absent bound, not
  // failure. Lower bound inclusive, upper bound exclusive, per the formula.
  const observedDay = currentDay(observedAt);
  if (input.validFrom && input.validFrom > observedDay) {
    return historicalResult("future", "not-yet-valid");
  }
  if (input.validTo && observedDay >= input.validTo) {
    return historicalResult("expired", "validity-interval-ended");
  }

  // 4. Supersession. Presence alone means superseded when the caller gives
  // no lookup (matches the existing memory boolean checks' behavior). When a
  // lookup is supplied, the replacement's own effectiveness is checked.
  if (input.supersededBy) {
    if (!lookup) {
      return historicalResult("superseded", "superseded-by-pointer");
    }
    const { effective, reason } = resolveSupersessionEffectiveness(
      input.supersededBy,
      observedAt,
      lookup,
      visited,
    );
    if (effective) {
      return historicalResult("superseded", reason);
    }
    return historicalResult("conflict", reason);
  }

  return { state: "current", current: true, historical: false, reasons: [] };
}

/**
 * Classify a memory entry or wiki page against AFC-06's freshness formula.
 * See the module-level comment above for the normative source. `observedAt`
 * is the caller's "now" (injectable for deterministic tests); `lookup`, when
 * supplied, lets a broken or cyclic supersession chain resolve to
 * `conflict` instead of being taken on faith.
 */
export function computeLifecycle(
  input: LifecycleInput,
  observedAt: Date,
  lookup?: SupersessionLookup,
): LifecycleResult {
  return computeLifecycleInternal(input, observedAt, lookup, new Set());
}
