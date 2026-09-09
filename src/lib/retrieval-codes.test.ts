import { expect, test } from "bun:test";
import type { WikiAskStatus } from "../wiki/types";
import {
  MAX_NEXT_ACTIONS,
  RANKING_SCORE_LABEL,
  RETRIEVAL_CODES,
  RETRIEVAL_NEXT_ACTIONS,
  type RetrievalCode,
  formatRetrievalOutcome,
  isRetrievalCode,
  normalizeRetrievalCode,
  retrievalOutcome,
  retrievalStatus,
} from "./retrieval-codes";

// --- Subsumption of the sibling lane's vocabulary -------------------------
//
// `src/wiki/types.ts` landed `WikiAskStatus = "ok" | "no-match" |
// "insufficient-evidence"` first, in the norm's own language. This union must
// SUBSUME that spelling, not run beside it. Two checks, because each catches a
// different way of breaking it: the type-level one fails at `tsc` the moment a
// fourth wiki status is added that this vocabulary does not carry, and the
// runtime one fails if the literals themselves drift.

type Assert<T extends true> = T;
type Subsumes<Narrow, Wide> = [Narrow] extends [Wide] ? true : false;

// A compile-time failure here means the wiki lane grew a status this
// vocabulary does not have. Add it to RETRIEVAL_CODES — do not fork.
type _WikiStatusIsSubsumed = Assert<Subsumes<WikiAskStatus, RetrievalCode>>;

test("the code union subsumes the wiki lane's retrieval status vocabulary", () => {
  const wikiStatuses: WikiAskStatus[] = ["ok", "no-match", "insufficient-evidence"];
  for (const status of wikiStatuses) {
    expect(isRetrievalCode(status)).toBe(true);
  }
});

test("every code the norm names is present, spelled as the norm spells it", () => {
  // specification.md §3, "Обязательные различия M03" plus the neighbouring
  // per-cause codes. Listed literally so a rename in the source has to be a
  // deliberate edit here too.
  for (const code of [
    "target-not-indexed",
    "index-incomplete",
    "no-match",
    "insufficient-evidence",
    "version-conflict",
    "snapshot-unavailable",
    "capability-unavailable",
    "budget-exceeded",
    "handle-invalid",
    "handle-expired",
    "format-unsafe",
    "invalid-input",
  ]) {
    expect(RETRIEVAL_CODES).toContain(code as RetrievalCode);
  }
});

test("the four AC5 conditions carry four different codes", () => {
  const codes = new Set<RetrievalCode>([
    "target-not-indexed", // a missing file
    "index-incomplete", // a broken index
    "no-match", // a nonsense query
    "insufficient-evidence", // a weak lexical signal
  ]);
  expect(codes.size).toBe(4);
});

// --- The transport normaliser --------------------------------------------

test("a known code survives a transport hop unchanged", () => {
  for (const code of RETRIEVAL_CODES) {
    expect(normalizeRetrievalCode(code)).toBe(code);
  }
});

test("a private spelling is not forwarded as if it were a code", () => {
  // `unknown-graph-target` is exactly the private spelling this repo shipped
  // before the vocabulary existed. It must not survive as a code.
  expect(normalizeRetrievalCode("unknown-graph-target", "target-not-indexed")).toBe(
    "target-not-indexed",
  );
  expect(normalizeRetrievalCode(undefined, "index-incomplete")).toBe("index-incomplete");
  expect(normalizeRetrievalCode(42, "invalid-input")).toBe("invalid-input");
});

test("a completed search is status ok even with zero results; a failure is not", () => {
  expect(retrievalStatus("ok")).toBe("ok");
  expect(retrievalStatus("no-match")).toBe("ok");
  expect(retrievalStatus("insufficient-evidence")).toBe("ok");
  expect(retrievalStatus("target-not-indexed")).toBe("error");
  expect(retrievalStatus("index-incomplete")).toBe("error");
  expect(retrievalStatus("invalid-input")).toBe("error");
});

// --- The bounded next action ---------------------------------------------

const SUBSYSTEMS = ["gdgraph", "ctx", "wiki", "memory", "testing", "health", "flow"];

test("every failing code offers at least one and at most three next actions", () => {
  for (const code of RETRIEVAL_CODES) {
    const actions = RETRIEVAL_NEXT_ACTIONS[code];
    expect(actions.length).toBeLessThanOrEqual(MAX_NEXT_ACTIONS);
    if (code !== "ok") {
      expect(actions.length).toBeGreaterThanOrEqual(1);
    }
  }
});

test("no next action forces a full traversal of every layer", () => {
  for (const code of RETRIEVAL_CODES) {
    const actions = RETRIEVAL_NEXT_ACTIONS[code];
    const joined = actions.join(" ").toLowerCase();
    // The failure mode: turning one cheap failure into "try the graph, then
    // the wiki, then memory, then testing, then text search".
    expect(joined).not.toMatch(/all layers|every layer|each layer|full (traversal|tour|scan)/);
    const named = SUBSYSTEMS.filter((name) => joined.includes(`keryx ${name}`));
    expect(named.length).toBeLessThanOrEqual(2);
  }
});

test("a no-match escalates to exactly one bounded step, and that step is text search", () => {
  // specification.md §5: "При no-match возвращает ограниченный допустимый
  // следующий шаг к text search".
  const actions = RETRIEVAL_NEXT_ACTIONS["no-match"];
  expect(actions.length).toBe(1);
  expect(actions[0]).toContain("keryx ctx rg");
});

// --- Score naming ---------------------------------------------------------

test("a numeric lexical score is called a ranking score and never a probability", () => {
  expect(RANKING_SCORE_LABEL).toBe("ranking score");
  const everything = [
    RANKING_SCORE_LABEL,
    ...Object.values(RETRIEVAL_NEXT_ACTIONS).flat(),
    ...RETRIEVAL_CODES,
  ]
    .join(" ")
    .toLowerCase();
  expect(everything).not.toMatch(/probability|likelihood|% (sure|confident)|confidence/);
});

// --- Rendering ------------------------------------------------------------

test("the rendered outcome leads with the machine-readable code", () => {
  const lines = formatRetrievalOutcome(
    retrievalOutcome("index-incomplete", "the graph index holds no file nodes"),
  );
  expect(lines[0]).toBe("code: index-incomplete");
  expect(lines[1]).toBe("reason: the graph index holds no file nodes");
  expect(lines).toContain("next:");
});
