// review-jev-contract — flow 335, an ADDITIONAL orchestrator reviewer that
// checks a PR DESCRIPTION's own claims (and, when a flow is linked, that
// flow's frozen acceptance criteria) against the diff.
//
// Two independent tracks, both advisory, both merged into one report:
//
// 1. CLAIMS — extracted deterministically from the PR description (bullets,
//    plus prose sentences carrying a verb cue: adds, fixes, removes, "does
//    not change", tests). For every claim, keryx computes deterministic
//    facts FIRST — named files/symbols/flags present in the diff, whether any
//    test file was touched (for a "tests added" claim), whether an EXPORTED
//    symbol changed (for a "no API change" claim) — then asks Jev exactly one
//    `noul`: "does the diff support this claim?". A claim scoring below
//    threshold is `minor` ("unsupported"); a claim the deterministic facts
//    directly contradict (e.g. "no API change" with exported symbols touched)
//    is `major`, with `class_scope`, regardless of what Jev answered — a
//    contradiction is a FACT, not an opinion Jev could outvote.
// 2. CRITERIA — the linked flow's frozen acceptance criteria, when `--flow
//    <id>` names one. This track reuses flow 328's `src/flow/check-ac.ts`
//    WHOLESALE (via `src/commands/flow-check-ac.ts`'s `runCheckAc`, which
//    itself reaches `check-ac.ts` only through `src/flow/service.ts` — see
//    that adapter's own header) — no criterion-checking logic is duplicated
//    here.
//
// CORE ZONE (`src/lib/import-zones.ts`): this module never imports the
// client-zone Jev client (`src/harness/decision/jev-client.ts`) — the same
// discipline `jev-risk.ts`/`jev-rules.ts`/`conform-jev.ts` already establish.
// `src/commands/review-jev-contract.ts` (the ADAPTER) is where the
// question/answer shapes below meet the real client.
//
// Through the security facade, not `security/redact` directly — the
// import-policy ratchet is at its cap; every caller outside `src/security/`
// reaches redaction through `src/security/service.ts`.

import { touchedExportedSymbols } from "./jev-risk";
import { estimateTokens } from "./cost";
import type { ScopedRegion } from "./scope";
import { redactSensitiveText } from "../security/service";
// AC5: reused, not duplicated — the SAME artefact-token extractor
// `check-ac.ts` uses for a flow's frozen criteria (backticked tokens, file
// paths, `keryx <cmd>` names) applies equally well to a PR-description claim,
// which is prose of the identical shape. Reached through `flow/service.ts`,
// the facade every non-`flow` caller of `check-ac.ts` already goes through.
import { extractCriterionTokens } from "../flow/service";

// ---------------------------------------------------------------------------
// Claim extraction — deterministic, from the PR description's raw text.
// ---------------------------------------------------------------------------

export type ClaimSource = "bullet" | "sentence";
export type ClaimIntent = "no-change" | "tests-added" | "other";

export interface Claim {
  readonly text: string;
  readonly source: ClaimSource;
}

const BULLET_LINE_RE = /^\s*(?:[-*+]|\d+[.)])\s+(.+?)\s*$/;
const CHECKBOX_PREFIX_RE = /^\[[ xX]\]\s*/;
const FENCE_RE = /^\s*```/;
const HEADING_RE = /^(#{1,6})\s+(.*?)\s*$/;

/**
 * Journal/retrospective prose, not a claim about the change — "Live: jev-docs
 * on #710/#711/#713 found 0…" and "Follow-ups: …" read exactly like a claim
 * to the verb-cue extractor (found, fixed, adds…) and were extracted as one
 * in flow 335's own live check (AC9's journal entry), which is how this fix
 * was found: the noul scorer correctly marked them unsupported by the diff —
 * they are a report ABOUT the PR process, not a statement about the diff — so
 * the "unsupported claim" finding was a false positive on a true negative.
 * Matched case-insensitively, an optional bold wrapper (`**Live**:`) and
 * trailing whitespace allowed around the label.
 */
const RETROSPECTIVE_LABEL = "(?:live(?:\\s+check)?|follow-?up(?:s)?|notes?|known\\s+limitations?|testing|test\\s*plan|screenshots?)";
/** A heading (or a bare labelled line) whose ENTIRE text, once markdown decoration is stripped, is one of the labels above — this is what opens a skip zone that runs until the next heading of the same or shallower level. */
const RETROSPECTIVE_HEADING_RE = new RegExp(`^${RETROSPECTIVE_LABEL}\\s*:?\\s*$`, "i");
/** A bullet or sentence that STARTS with one of the labels followed by a colon and more text — e.g. "Live: …", "**Follow-ups:** …" — skipped on its own, independent of any heading/skip-zone state. */
const RETROSPECTIVE_LABEL_PREFIX_RE = new RegExp(`^(?:\\*{1,2})?\\s*${RETROSPECTIVE_LABEL}\\s*(?:\\*{1,2})?\\s*:\\s*\\S`, "i");

/** Strips a leading/trailing markdown bold wrapper (`**text**` -> `text`), for testing heading/label text against {@link RETROSPECTIVE_HEADING_RE}. */
function stripBold(text: string): string {
  return text.replace(/^\*{1,2}\s*/, "").replace(/\s*\*{1,2}$/, "");
}

/**
 * The verb cues the spec names (adds, fixes, removes, "does not change",
 * tests) plus the ordinary synonyms a PR description actually uses for the
 * same claims — over-matching a claim out of ordinary prose costs one extra
 * (cheap, deterministic-facts-first) Jev call; under-matching drops a real
 * claim from the check entirely, which is the worse failure for a reviewer
 * whose whole job is catching an unevidenced claim.
 */
const CLAIM_VERB_RE =
  /\b(adds?|added|adding|fixe[sd]?|fixing|remov(?:e[sd]?|ing)|delet(?:e[sd]?|ing)|introduc(?:e[sd]?|ing)|implement(?:s|ed|ing)?|test(?:s|ed|ing)?|cover(?:s|ed|ing)?|updat(?:e[sd]?|ing)|renam(?:e[sd]?|ing)|refactor(?:s|ed|ing)?|deprecat(?:e[sd]?|ing)|chang(?:e[sd]?|ing)|does not change|do not change|no change|unchanged)\b/i;

const NO_CHANGE_RE = /\bdoes not change\b|\bdo not change\b|\bno (?:api |public )?change\b|\bunchanged\b|\bwithout (?:any )?(?:api |public )?change/i;
const API_SHAPED_RE = /\b(api|public|export(?:ed)?|interface|signature|contract)\b/i;
const TESTS_ADDED_RE = /\btest(?:s|ed|ing)?\b/i;
const TESTS_ADDED_HINT_RE = /\b(add(?:s|ed|ing)?|new|cover(?:s|ed|ing)?|introduc(?:e[sd]?|ing))\b/i;

/** `undefined` — never a code fence's contents, and never inside one. */
function stripCodeFences(description: string): string {
  const lines = description.split(/\r?\n/);
  const out: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) out.push(line);
  }
  return out.join("\n");
}

/** Sentence split — a hand-written boundary, same discipline `check-ac.ts`'s own criterion tokenizer documents: deterministic, regex-based, over/under-match expected and accepted. */
function splitSentences(paragraph: string): string[] {
  return paragraph
    .split(/(?<=[.!?])\s+(?=[A-Z0-9`"'])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * AC3: split a PR description into claims. Every bullet/numbered-list line
 * (list items are, by PR-description convention, already discrete claims) is
 * one claim regardless of verb cue; every OTHER sentence is a claim only when
 * it carries one of the named verb cues. Code fences are stripped first — a
 * fenced snippet is evidence, never itself a claim.
 *
 * Journal/retrospective sections are skipped entirely, not scored: a heading
 * (or a bare label line) reading `Live`, `Live check`, `Follow-up(s)`,
 * `Notes`, `Known limitations`, `Testing`, `Test plan`, or `Screenshots`
 * opens a skip zone that runs until the next heading at the same or a
 * shallower level (or the end of the description) — every bullet and
 * sentence under it is prose ABOUT the review/PR process, not a claim about
 * the diff, and is dropped before it ever reaches a Jev call. Independent of
 * that: any bullet or sentence starting with one of those labels followed by
 * a colon (`Live: …`, `**Follow-ups:** …`) is dropped on its own, whether or
 * not it sits under a matching heading.
 */
export function extractClaims(description: string): readonly Claim[] {
  const claims: Claim[] = [];
  const seen = new Set<string>();
  const stripped = stripCodeFences(description);
  let currentParagraph: string[] = [];
  /** `undefined` when not skipping; otherwise the heading level (`#` count) that opened the current retrospective skip zone. */
  let skipHeadingLevel: number | undefined;

  // Reading order matters for a human skimming the result — a paragraph's
  // sentence-claims are emitted the moment the paragraph ends (a blank line,
  // or the next bullet/end of input), not batched to the end, so bullets and
  // prose interleave the same way the description itself does.
  const flushParagraph = (): void => {
    if (currentParagraph.length === 0) return;
    const paragraph = currentParagraph.join(" ");
    currentParagraph = [];
    for (const sentence of splitSentences(paragraph)) {
      if (RETROSPECTIVE_LABEL_PREFIX_RE.test(sentence)) continue;
      if (!CLAIM_VERB_RE.test(sentence)) continue;
      if (seen.has(sentence)) continue;
      seen.add(sentence);
      claims.push({ text: sentence, source: "sentence" });
    }
  };

  for (const rawLine of stripped.split(/\r?\n/)) {
    const headingMatch = HEADING_RE.exec(rawLine);
    if (headingMatch?.[1] !== undefined && headingMatch[2] !== undefined) {
      flushParagraph();
      const level = headingMatch[1].length;
      if (skipHeadingLevel !== undefined && level <= skipHeadingLevel) {
        skipHeadingLevel = undefined;
      }
      if (RETROSPECTIVE_HEADING_RE.test(stripBold(headingMatch[2].trim()))) {
        skipHeadingLevel = level;
      }
      continue;
    }
    if (skipHeadingLevel !== undefined) {
      // Inside a retrospective skip zone: every bullet and prose line is
      // dropped, not just paused — a blank line does not end the zone (only
      // the next heading does), so `flushParagraph` never sees this text.
      continue;
    }
    const bulletMatch = BULLET_LINE_RE.exec(rawLine);
    if (bulletMatch?.[1]) {
      flushParagraph();
      const text = bulletMatch[1].replace(CHECKBOX_PREFIX_RE, "").trim();
      if (text.length > 0 && !seen.has(text) && !RETROSPECTIVE_LABEL_PREFIX_RE.test(text)) {
        seen.add(text);
        claims.push({ text, source: "bullet" });
      }
      continue;
    }
    if (rawLine.trim().length === 0) {
      flushParagraph();
      continue;
    }
    // Quotes/tables are prose too, for sentence purposes — only a literal
    // bullet/numbered line gets the unconditional bullet treatment, and a
    // heading line was already consumed above.
    currentParagraph.push(rawLine.trim());
  }
  flushParagraph();

  return claims;
}

/** AC5/AC6: which extra deterministic checks a claim's text asks for. Not exclusive with anything else about the claim — used only to pick which extra fact function runs. */
export function classifyClaimIntent(text: string): ClaimIntent {
  if (NO_CHANGE_RE.test(text)) return "no-change";
  if (TESTS_ADDED_RE.test(text) && TESTS_ADDED_HINT_RE.test(text)) return "tests-added";
  return "other";
}

// ---------------------------------------------------------------------------
// AC5: deterministic facts per claim, computed before any Jev call.
// ---------------------------------------------------------------------------

export interface ClaimFacts {
  readonly intent: ClaimIntent;
  readonly tokens: readonly string[];
  readonly tokensPresent: readonly string[];
  readonly tokensAbsent: readonly string[];
  /** AC5: test files touched anywhere in this diff — populated only when `intent === "tests-added"`, since it is only meaningful evidence for that claim shape. */
  readonly testFilesInDiff: readonly string[];
  /** AC5/AC6: exported symbols touched anywhere in this diff — populated only when `intent === "no-change"` AND the claim's own text is API-shaped (mentions api/public/export/interface/signature/contract). */
  readonly exportedSymbolsChanged: readonly string[];
  /** True exactly when the claim says "no API change" and the diff touches an exported symbol — a FACT, not an opinion; drives the `major` severity path regardless of Jev's answer. */
  readonly contradicted: boolean;
  readonly factLines: readonly string[];
}

const TEST_FILE_RE = /\.(test|spec)\.[a-z]+$/i;

export function computeClaimFacts(claim: Claim, diffText: string, changedFiles: readonly string[], regions: readonly ScopedRegion[]): ClaimFacts {
  const intent = classifyClaimIntent(claim.text);
  const tokens = extractCriterionTokens(claim.text);
  const tokensPresent = tokens.filter((token) => diffText.includes(token) || changedFiles.some((file) => file.includes(token)));
  const tokensAbsent = tokens.filter((token) => !tokensPresent.includes(token));

  const testFilesInDiff = intent === "tests-added" ? changedFiles.filter((file) => TEST_FILE_RE.test(file)) : [];

  let exportedSymbolsChanged: string[] = [];
  let contradicted = false;
  if (intent === "no-change" && API_SHAPED_RE.test(claim.text)) {
    const symbols = new Set<string>();
    for (const region of regions) {
      for (const symbol of touchedExportedSymbols(region.text)) symbols.add(symbol);
    }
    exportedSymbolsChanged = [...symbols];
    contradicted = exportedSymbolsChanged.length > 0;
  }

  const factLines = [
    tokens.length === 0
      ? "no backticked token, file path, or `keryx <cmd>` name was found in this claim's text — no artefact to check for."
      : `named artefacts: ${tokens.map((t) => `\`${t}\``).join(", ")}`,
    ...(tokens.length > 0
      ? [
          tokensPresent.length > 0
            ? `present in the diff/tree: ${tokensPresent.map((t) => `\`${t}\``).join(", ")}`
            : "none of the named artefacts appear in the diff or the changed-file list.",
          ...(tokensAbsent.length > 0 && tokensPresent.length > 0 ? [`absent: ${tokensAbsent.map((t) => `\`${t}\``).join(", ")}`] : []),
        ]
      : []),
    ...(intent === "tests-added"
      ? [testFilesInDiff.length > 0 ? `test file(s) touched in this diff: ${testFilesInDiff.join(", ")}` : "no test file was touched anywhere in this diff."]
      : []),
    ...(intent === "no-change" && API_SHAPED_RE.test(claim.text)
      ? [
          contradicted
            ? `CONTRADICTED: this claim says no API/contract change, but the diff touches exported symbol(s): ${exportedSymbolsChanged.join(", ")}.`
            : "no exported symbol was touched anywhere in this diff — consistent with a no-API-change claim.",
        ]
      : []),
  ];

  return { intent, tokens, tokensPresent, tokensAbsent, testFilesInDiff, exportedSymbolsChanged, contradicted, factLines };
}

// ---------------------------------------------------------------------------
// AC6: one `noul` per claim, batched under the vendor's 64k token budget —
// same greedy-pack discipline `check-ac.ts`'s own `batchAcCheckItems` and
// `jev-risk.ts`'s own `batchRiskQuestionsForHunk` each independently apply
// (mirrored here, not imported — each Jev-backed reviewer in this codebase
// owns its own batcher over its own item shape).
// ---------------------------------------------------------------------------

export const CONTRACT_TOKEN_BUDGET = 64_000;
/**
 * Conservative on purpose. `estimateTokens` (`src/review/cost.ts`) is a
 * chars÷4 heuristic — cheap, and the honest-labelled `≈` everywhere it's
 * printed, but it UNDERESTIMATES a code-shaped diff, which tokenizes worse
 * than prose (punctuation/symbol-dense hunks cost more tokens per char than
 * the 4:1 the heuristic assumes). A real vendor `HTTP 400 max_tokens_exceeded`
 * on a 4-claim batch (flow 335's own live check against PR #726) is that gap
 * showing up in production, not a one-off: 0.5 of the 64k budget, sized by
 * the same optimistic heuristic, was still over the vendor's real ceiling.
 * 0.4 leaves headroom for exactly that gap. This underestimate is NOT unique
 * to `jev-contract` — `check-ac.ts`'s `batchAcCheckItems` and `jev-risk.ts`'s
 * `batchRiskQuestionsForHunk` size their own batches off the same
 * `estimateTokens`, so the same class of failure is reachable there too. Left
 * alone here on purpose — flow 335 is scoped to `jev-contract`; fixing the
 * shared heuristic (or giving every batcher its own safety margin) is a
 * separate, cross-cutting change.
 */
const BATCH_BUDGET_FRACTION = 0.4;
/** 6 -> 3: fewer claims per batch means a smaller `state` per Jev call, which is the other half of the same margin — independent of the token-budget fraction above, since a claim's evidence can be large enough to dominate a batch of even 2. */
const MAX_CLAIMS_PER_BATCH = 3;
/** A generic claim token can match many regions in a large diff — capped for the same reason `check-ac.ts`'s `MAX_MATCHED_HUNKS_PER_ITEM` is: the smallest matching regions are kept first. */
const MAX_MATCHED_REGIONS_PER_CLAIM = 8;
/**
 * A char cap on ONE claim's total evidence text, applied after the
 * count-based cap above — a diff can match <= 8 regions and still be huge if
 * even one hunk is long. Smallest-first (same tie-break as the count cap),
 * so a claim never loses ALL its evidence to one oversized hunk: the biggest
 * regions are dropped first, not the claim's only match. Chars, not tokens,
 * because this guards against the SAME estimator gap `BATCH_BUDGET_FRACTION`
 * above documents — a hard char ceiling never depends on the estimate being
 * right.
 */
const MAX_EVIDENCE_CHARS_PER_CLAIM = 6_000;

export interface ContractNoulQuestion {
  readonly type: "noul";
  readonly instructions: string;
}

function questionForClaim(claim: Claim): ContractNoulQuestion {
  return {
    type: "noul",
    instructions: `Given the deterministic facts and the redacted diff evidence above, does the diff SUPPORT this PR-description claim? Claim: ${redactSensitiveText(claim.text)}`,
  };
}

/** Drops the largest regions, smallest-first, until the total is under {@link MAX_EVIDENCE_CHARS_PER_CLAIM} — a no-op when already under it, and never drops the single smallest region even if that one alone is over the cap (some evidence beats none). */
function capEvidenceChars(regions: readonly ScopedRegion[]): readonly ScopedRegion[] {
  const totalChars = regions.reduce((sum, region) => sum + region.text.length, 0);
  if (totalChars <= MAX_EVIDENCE_CHARS_PER_CLAIM || regions.length <= 1) return regions;
  const bySize = [...regions].sort((a, b) => a.text.length - b.text.length);
  const kept: ScopedRegion[] = [];
  let total = 0;
  for (const region of bySize) {
    if (kept.length > 0 && total + region.text.length > MAX_EVIDENCE_CHARS_PER_CLAIM) break;
    kept.push(region);
    total += region.text.length;
  }
  return kept;
}

/** Diff regions whose text mentions at least one of the claim's tokens — the smallest matches kept first, same tie-break `check-ac.ts`'s `selectMatchedHunks` uses, then capped by total char count ({@link capEvidenceChars}). */
export function selectMatchedRegionsForClaim(tokens: readonly string[], regions: readonly ScopedRegion[]): readonly ScopedRegion[] {
  if (tokens.length === 0) return [];
  const matched = regions.filter((region) => tokens.some((token) => region.text.includes(token) || region.path.includes(token)));
  const byCount = matched.length <= MAX_MATCHED_REGIONS_PER_CLAIM ? matched : [...matched].sort((a, b) => a.text.length - b.text.length).slice(0, MAX_MATCHED_REGIONS_PER_CLAIM);
  return capEvidenceChars(byCount);
}

export interface ContractClaimItem {
  readonly id: string;
  readonly claim: Claim;
  readonly facts: ClaimFacts;
  readonly matchedRegions: readonly ScopedRegion[];
  readonly changedFiles: readonly string[];
}

/** AC5's default per-claim id: `CLAIM1`, `CLAIM2`, … — stable ordering, used as the Jev question key and the finding's dedupe seed. */
export function computeContractClaimItems(
  claims: readonly Claim[],
  diffText: string,
  changedFiles: readonly string[],
  regions: readonly ScopedRegion[],
): readonly ContractClaimItem[] {
  return claims.map((claim, index) => {
    const facts = computeClaimFacts(claim, diffText, changedFiles, regions);
    return { id: `CLAIM${index + 1}`, claim, facts, matchedRegions: selectMatchedRegionsForClaim(facts.tokens, regions), changedFiles };
  });
}

function renderClaimState(item: ContractClaimItem): string {
  const evidence =
    item.matchedRegions.length > 0
      ? item.matchedRegions.map((region) => `--- ${region.path}\n@@ ${region.startLine},${region.endLine} @@\n${redactSensitiveText(region.text)}`).join("\n\n")
      : `no diff hunk matched this claim's named artefacts; files changed in this diff: ${item.changedFiles.length > 0 ? item.changedFiles.join(", ") : "(none)"}`;
  return [`### ${item.id}`, ...item.facts.factLines, "", evidence].join("\n");
}

export interface ContractClaimBatch {
  readonly items: readonly ContractClaimItem[];
  readonly state: string;
  readonly questions: Readonly<Record<string, ContractNoulQuestion>>;
}

/**
 * Rebuilds one batch's `state`/`questions` from a subset of items. Used by
 * {@link batchContractClaimItems}'s own initial pack, and by the adapter's
 * split-and-retry-once path (`src/commands/review-jev-contract.ts`): a batch
 * that comes back with a real vendor `HTTP 400 max_tokens_exceeded` is split
 * into two item lists and each is rebuilt through this SAME function — never
 * a second, bespoke batch-assembly path that could drift from this one.
 */
export function buildContractClaimBatch(items: readonly ContractClaimItem[]): ContractClaimBatch {
  return {
    items,
    state: items.map(renderClaimState).join("\n\n"),
    questions: Object.fromEntries(items.map((item) => [item.id, questionForClaim(item.claim)])),
  };
}

export function batchContractClaimItems(items: readonly ContractClaimItem[]): readonly ContractClaimBatch[] {
  const batches: ContractClaimBatch[] = [];
  let current: ContractClaimItem[] = [];
  const effectiveBudget = CONTRACT_TOKEN_BUDGET * BATCH_BUDGET_FRACTION;

  const flush = (): void => {
    if (current.length === 0) return;
    batches.push(buildContractClaimBatch(current));
    current = [];
  };

  for (const item of items) {
    const attempt = [...current, item];
    const stateTokens = estimateTokens(attempt.map(renderClaimState).join("\n\n"));
    const questionsTokens = estimateTokens(attempt.map((i) => `${i.id}:noul:${questionForClaim(i.claim).instructions}`).join("\n"));
    if (current.length > 0 && (attempt.length > MAX_CLAIMS_PER_BATCH || stateTokens + questionsTokens > effectiveBudget)) {
      flush();
      current = [item];
    } else {
      current = attempt;
    }
  }
  flush();
  return batches;
}

// ---------------------------------------------------------------------------
// AC5's default `--max-calls` cap and selection (claims, not hunks — one call
// per claim, so the cap is a claim count directly).
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_JEV_CONTRACT_CALLS = 30;

export interface ContractClaimSelection {
  readonly selected: readonly Claim[];
  readonly skipped: readonly Claim[];
  readonly maxCalls: number;
}

export function selectContractClaims(claims: readonly Claim[], maxCalls: number = DEFAULT_MAX_JEV_CONTRACT_CALLS): ContractClaimSelection {
  const cap = Number.isFinite(maxCalls) && maxCalls >= 0 ? Math.trunc(maxCalls) : DEFAULT_MAX_JEV_CONTRACT_CALLS;
  return { selected: claims.slice(0, cap), skipped: claims.slice(cap), maxCalls: cap };
}

// ---------------------------------------------------------------------------
// Findings — severity decided by facts first, Jev's `noul` second.
// ---------------------------------------------------------------------------

export const DEFAULT_JEV_CONTRACT_THRESHOLD = 0.5;

export type ContractFindingSeverity = "minor" | "major";

/** Matches `reviewer-finding.schema.json`'s `class_scope` object shape exactly — required for `major`/`blocker`, never a bare label. */
export interface ContractClassScope {
  readonly sites: readonly string[];
  readonly enumeration_method: string;
}

export interface ContractFinding {
  readonly id: string;
  readonly severity: ContractFindingSeverity;
  readonly claim: string;
  readonly class_scope?: ContractClassScope;
  readonly file?: string;
  readonly line?: number;
  readonly problem: string;
  readonly impact: string;
  readonly suggested_fix: string;
  readonly evidence: string;
  readonly confidence: "high" | "medium" | "low";
  readonly reviewer: "review-jev-contract";
  readonly dedupe_key: string;
}

export interface ScoredClaim {
  readonly item: ContractClaimItem;
  /** `undefined` when Jev was not asked (degrade path) — never defaulted to 0, which would read as a confident "unsupported". */
  readonly probability?: number;
}

function shortHash(input: string): string {
  // FNV-1a 32-bit — deterministic, dependency-free, matches `jev-risk.ts`'s own `shortHash`.
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function confidenceFor(probability: number | undefined): "high" | "medium" | "low" {
  if (probability === undefined) return "low";
  const certainty = Math.max(probability, 1 - probability);
  if (certainty >= 0.85) return "high";
  if (certainty >= 0.65) return "medium";
  return "low";
}

/**
 * AC6: a claim the deterministic facts CONTRADICT is `major`, with
 * `class_scope`, regardless of the `noul` score — a fact beats an opinion. A
 * claim with no contradiction and a `noul` score below `threshold` is
 * `minor` ("unsupported"). A claim at/above threshold with no contradiction
 * produces no finding (the claim is evidenced).
 */
export function synthesizeContractFindings(scored: readonly ScoredClaim[], threshold: number = DEFAULT_JEV_CONTRACT_THRESHOLD): readonly ContractFinding[] {
  const findings: ContractFinding[] = [];
  for (const { item, probability } of scored) {
    const { facts } = item;
    const key = `jev-contract::${item.id}::${item.claim.text}`;
    const primaryRegion = item.matchedRegions[0];
    if (facts.contradicted) {
      findings.push({
        id: `jev-contract-${shortHash(key)}`,
        severity: "major",
        claim: item.claim.text,
        class_scope: {
          sites: item.matchedRegions.length > 0 ? item.matchedRegions.map((region) => `${region.path}:${region.startLine}-${region.endLine}`) : ["(no diff hunk matched this claim's tokens)"],
          enumeration_method: "every diff region matched to this claim's named artefacts (selectMatchedRegionsForClaim), cross-checked for exported-symbol declarations (touchedExportedSymbols)",
        },
        ...(primaryRegion !== undefined ? { file: primaryRegion.path, line: primaryRegion.startLine } : {}),
        problem: `Claim "${item.claim.text}" says no API/contract change, but the diff touches exported symbol(s): ${facts.exportedSymbolsChanged.join(", ")}.`,
        impact: "A description that undersells a public-API/contract change is the shape most likely to blindside a downstream caller who reads the description instead of the diff.",
        suggested_fix: "Update the PR description to name the exported-symbol change, or confirm the change is intentionally non-breaking and say so explicitly.",
        evidence: `exported symbols touched: ${facts.exportedSymbolsChanged.join(", ")}${probability !== undefined ? `; Jev noul=${probability.toFixed(2)}` : ""}`,
        confidence: "high",
        reviewer: "review-jev-contract",
        dedupe_key: key,
      });
      continue;
    }
    if (probability !== undefined && probability < threshold) {
      findings.push({
        id: `jev-contract-${shortHash(key)}`,
        severity: "minor",
        claim: item.claim.text,
        ...(primaryRegion !== undefined ? { file: primaryRegion.path, line: primaryRegion.startLine } : {}),
        problem: `Claim "${item.claim.text}" is not evidenced by the diff (Jev noul=${probability.toFixed(2)}, threshold ${threshold}).`,
        impact: "A claim the diff does not support is the drift a reviewer skimming the description, not the code, would miss.",
        suggested_fix: "Point to the specific hunk that evidences this claim, or remove/correct the claim in the description.",
        evidence: facts.factLines.join("; "),
        confidence: confidenceFor(probability),
        reviewer: "review-jev-contract",
        dedupe_key: key,
      });
    }
  }
  return findings;
}

export function contractFindingStats(findings: readonly ContractFinding[]): Readonly<Record<"blocker" | "major" | "minor" | "info", number>> {
  const stats = { blocker: 0, major: 0, minor: 0, info: 0 };
  for (const finding of findings) stats[finding.severity] += 1;
  return stats;
}

// ---------------------------------------------------------------------------
// Rendering — the non-`--json` text a human reads.
// ---------------------------------------------------------------------------

export interface ContractBudgetReport {
  readonly maxCalls: number;
  readonly claimsScored: number;
  readonly claimsSkipped: number;
}

export interface JevContractRunResult {
  readonly status: "DONE" | "DONE_WITH_CONCERNS";
  readonly reviewer: "review-jev-contract";
  readonly summary: string;
  readonly findings: readonly ContractFinding[];
  readonly stats: Readonly<Record<"blocker" | "major" | "minor" | "info", number>>;
  readonly claims: readonly { readonly id: string; readonly text: string; readonly source: ClaimSource; readonly intent: ClaimIntent; readonly probability?: number }[];
  readonly budget: ContractBudgetReport;
}

export function renderContractMarkdown(result: JevContractRunResult): string {
  const lines: string[] = [
    "# review-jev-contract",
    "",
    `status: ${result.status}`,
    result.summary,
    "",
    `stats: blocker=0, major=${result.stats.major}, minor=${result.stats.minor}, info=${result.stats.info}`,
    `budget: max-calls=${result.budget.maxCalls}, claims scored=${result.budget.claimsScored}, claims skipped=${result.budget.claimsSkipped}`,
    "",
  ];
  lines.push("## Claims", "");
  if (result.claims.length === 0) {
    lines.push("_no claims extracted from the PR description_", "");
  } else {
    for (const claim of result.claims) {
      lines.push(`- [${claim.id}] (${claim.intent}) ${claim.text}${claim.probability !== undefined ? ` — noul=${claim.probability.toFixed(2)}` : ""}`);
    }
    lines.push("");
  }
  if (result.findings.length === 0) {
    lines.push("_no findings_");
    return `${lines.join("\n")}\n`;
  }
  lines.push("## Findings", "");
  for (const finding of result.findings) {
    lines.push(`### [${finding.id}] ${finding.severity}${finding.class_scope !== undefined ? ` (${finding.class_scope})` : ""} — ${finding.claim}`, "");
    lines.push(`- **Problem**: ${finding.problem}`);
    lines.push(`- **Impact**: ${finding.impact}`);
    lines.push(`- **Suggested fix**: ${finding.suggested_fix}`);
    lines.push(`- **Evidence**: ${finding.evidence}`);
    lines.push(`- **Confidence**: ${finding.confidence}`, "");
  }
  return `${lines.join("\n")}\n`;
}
