// The closed retrieval-outcome vocabulary (AFC-M03, flow 235 AC5), verbatim from
// `docs/requirements/keryx-agent-first-core/specification.md` §3.
//
// WHY A MODULE AND NOT A STRING PER CALL SITE
//
// The measured defect this closes is not "the CLI says nothing". `gdgraph
// affected` already told a caller, in careful prose, that an unknown target is
// not the same thing as an indexed target with zero edges — and it exited 1
// while an edge-less node exited 0. What it did not have was a STABLE code: the
// JSON carried `error: "unknown-graph-target"`, a spelling that appears nowhere
// in the norm, and every other retrieval surface invented (or omitted) its own.
// A caller cannot branch on prose, and a transport that re-wraps prose loses it.
//
// So the vocabulary lives in one shared module below both the owners
// (`src/gdgraph`, `src/wiki`, …) and the transports (`src/commands`, `src/mcp`,
// `src/harness`), because "нормализатор транспорта сохраняет коды" is only
// checkable if there is one list to check against.
//
// SUBSUMPTION, NOT A PARALLEL SPELLING
//
// `WikiAskStatus` (`src/wiki/types.ts`) already spells three of these — `ok`,
// `no-match`, `insufficient-evidence` — in the norm's own language. This union
// is a superset of it by construction, and `retrieval-codes.test.ts` pins that
// with a type-level assertion, so a fourth wiki status added later fails here
// loudly instead of quietly forking the vocabulary.
//
// This module is deliberately pure and dependency-free (`src/lib` is the shared
// zone, see `./import-zones.ts`): it must be reachable from a core owner, a
// client and an adapter alike without any of them importing the others.

/**
 * Every retrieval outcome code, `ok` included.
 *
 * `ok` is not an error code — it is the value the same field carries when the
 * operation succeeded, which is what lets a caller read ONE field instead of
 * inferring success from the absence of another.
 */
export const RETRIEVAL_CODES = [
  // Completed operations. The last two carry zero or unusable results, which is
  // an answer, not a failure.
  "ok",
  "no-match",
  "insufficient-evidence",
  // The operation produced no result.
  "target-not-indexed",
  "index-incomplete",
  "version-conflict",
  "snapshot-unavailable",
  "capability-unavailable",
  "budget-exceeded",
  "handle-invalid",
  "handle-expired",
  "format-unsafe",
  "invalid-input",
] as const;

export type RetrievalCode = (typeof RETRIEVAL_CODES)[number];

const CODE_SET: ReadonlySet<string> = new Set<string>(RETRIEVAL_CODES);

/**
 * The three codes that describe a search that RAN. `no-match` and
 * `insufficient-evidence` are completed operations whose result is empty or
 * too weak to stand on — the spec's `status=ok` with a zero-element result,
 * which "не стирает coverage".
 */
const COMPLETED: ReadonlySet<RetrievalCode> = new Set<RetrievalCode>([
  "ok",
  "no-match",
  "insufficient-evidence",
]);

/**
 * The spec's `status` axis, collapsed to the two values a retrieval outcome can
 * actually take: `ok` (the operation completed in its declared scope, with any
 * number of results including zero) and `error` ("результата операции нет").
 *
 * A CLI maps this straight onto its exit code, which is why a genuine no-match
 * must not exit non-zero: it completed.
 */
export function retrievalStatus(code: RetrievalCode): "ok" | "error" {
  return COMPLETED.has(code) ? "ok" : "error";
}

export function isRetrievalCode(value: unknown): value is RetrievalCode {
  return typeof value === "string" && CODE_SET.has(value);
}

/**
 * The transport normaliser (specification.md §3: "Нормализатор транспорта
 * сохраняет коды").
 *
 * A code that IS in the vocabulary survives a hop unchanged — that is the whole
 * contract, and it is the half that gets broken silently when each transport
 * re-derives a code from a message. Anything else collapses to `fallback`
 * rather than being forwarded as a private spelling the next hop cannot branch
 * on.
 */
export function normalizeRetrievalCode(
  value: unknown,
  fallback: RetrievalCode = "capability-unavailable",
): RetrievalCode {
  return isRetrievalCode(value) ? value : fallback;
}

/**
 * A retrieval outcome as it crosses a boundary: the code, a safe one-line
 * reason, and the bounded next actions.
 */
export interface RetrievalOutcome {
  readonly code: RetrievalCode;
  /** Safe prose. No stack, no secret, no closed identifier (specification.md §3). */
  readonly reason: string;
  readonly nextActions: readonly string[];
}

/**
 * The upper bound on suggested next actions, and the reason AC5 states one:
 * "next action не заставляет полный обход". A failed retrieval that answers
 * with "now try the graph, then the wiki, then memory, then testing, then text
 * search" has converted one cheap failure into a full tour of every layer,
 * which is the cost the norm exists to avoid.
 */
export const MAX_NEXT_ACTIONS = 3;

/**
 * The bounded continuation per code. Each list is a SHORT, ordered escalation
 * — at most `MAX_NEXT_ACTIONS`, naming at most two subsystems — not a menu of
 * everything available.
 *
 * `no-match` follows specification.md §5 literally: "При no-match возвращает
 * ограниченный допустимый следующий шаг к text search" — one step, to text
 * search, and nothing else.
 */
export const RETRIEVAL_NEXT_ACTIONS: Readonly<Record<RetrievalCode, readonly string[]>> = {
  ok: [],
  "no-match": ['keryx ctx rg "<pattern>" — text search over file contents'],
  "insufficient-evidence": [
    "re-run with a term that is not corpus-wide (an identifier, a module name, a filename)",
    'keryx ctx rg "<pattern>" if the concept has no name in the index',
  ],
  "target-not-indexed": [
    "keryx gdgraph build — if the file is new since the last build",
    'keryx gdgraph find "<terms>" — to get the path this index actually holds',
  ],
  "index-incomplete": ["keryx gdgraph build — the index cannot answer until it exists"],
  "version-conflict": ["re-read the current version, then retry the write against it"],
  "snapshot-unavailable": ["retry once; if it repeats, rebuild the producing index"],
  "capability-unavailable": ["enable the named capability, then re-run this one command"],
  "budget-exceeded": ["re-run with a narrower scope or a larger --budget"],
  "handle-invalid": ["re-run the operation that issues the handle"],
  "handle-expired": ["re-run the operation that issues the handle"],
  "format-unsafe": ["inspect the flagged content directly; do not forward it"],
  "invalid-input": ["correct the argument named in the reason and re-run"],
};

/**
 * The label for a numeric lexical score, everywhere it is rendered.
 *
 * specification.md §3: "Численный lexical score называется ranking score, не
 * вероятностью правильности". The constant exists so the naming rule is
 * enforceable by a test rather than by reviewer memory across renderers.
 */
export const RANKING_SCORE_LABEL = "ranking score";

/** Round a ranking score for display. Never a percentage, never a probability. */
export function formatRankingScore(score: number): string {
  return (Math.round(score * 100) / 100).toFixed(2);
}

/** Build a well-formed outcome with this code's bounded continuation attached. */
export function retrievalOutcome(code: RetrievalCode, reason: string): RetrievalOutcome {
  return { code, reason, nextActions: RETRIEVAL_NEXT_ACTIONS[code] };
}

/**
 * Render an outcome for a human-readable surface. The code comes FIRST and on
 * its own line, so it is greppable and so a reader cannot mistake the prose for
 * the machine-readable part.
 */
export function formatRetrievalOutcome(outcome: RetrievalOutcome): string[] {
  const lines = [`code: ${outcome.code}`, `reason: ${outcome.reason}`];
  if (outcome.nextActions.length > 0) {
    lines.push("next:");
    for (const action of outcome.nextActions) {
      lines.push(`  - ${action}`);
    }
  }
  return lines;
}
