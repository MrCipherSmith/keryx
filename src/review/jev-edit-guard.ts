// Jev EDIT GUARD — flow 343. A Claude Code `PostToolUse` hook that checks
// every `Edit`/`Write`/`MultiEdit` a coding agent makes against the project's
// written rules, using Jev, and feeds violations straight back to the agent
// through the hook's own `additionalContext` channel.
//
// This module is CORE (`src/lib/import-zones.ts`): pure, deterministic,
// no I/O, no client-zone import. The actual Jev call is `computeJevRulesResult`
// (`src/commands/review-jev-rules.ts`, an ADAPTER that already does discovery,
// clause tagging with a cache, pair selection bounded by `--max-calls`, and
// threshold-based finding synthesis) — this module only decides WHICH file a
// hook payload names, and how to turn its findings into the hook feedback
// text a coding agent reads.
//
// Measured on a real project (10 tasks × 2 runs, a large production
// React/MobX frontend): at threshold 0.5 the guard cut real rule violations
// reaching the first review round from 27 to 10 (-63%) and review rounds from
// 31 to 24, at the same total cost (Jev itself cost $0.04 for 40 runs); the
// agent acted on 79% of the flags. At threshold 0.2 the guard flagged almost
// every edit, the agent learned to ignore it, and it had no effect — hence
// the 0.5 default and the "precision over recall" framing throughout this
// feature (see `DEFAULT_EDIT_GUARD_THRESHOLD` below, and the README/docs
// section this flow adds).

export const DEFAULT_EDIT_GUARD_THRESHOLD = 0.5;

/**
 * A single edit's changed region is usually 1-3 hunks — a small budget is
 * plenty, and it doubles as the "per-run cost cap" the feature asks for: at
 * most this many `(hunk, rule-clause)` pairs are scored for one Edit/Write.
 */
export const DEFAULT_EDIT_GUARD_MAX_CALLS = 24;

/**
 * Hard wall-clock ceiling for the WHOLE hook invocation (gate + diff + every
 * Jev call), not per Jev call — a coding agent waiting on a `PostToolUse`
 * hook must not stall noticeably longer than this. Kept short enough that a
 * slow Jev round trip fails the hook open rather than the agent's own turn.
 */
export const DEFAULT_EDIT_GUARD_TIMEOUT_MS = 4_000;

/** At most this many findings are ever rendered into the hook's feedback text — a long list defeats "feeds violations straight back", it does not inform. */
export const MAX_EDIT_GUARD_FEEDBACK_FINDINGS = 5;

export const EDIT_GUARD_LOG_PATH = ".metaproject/data/jev/edit-guard.jsonl";

/** Tool names the `PostToolUse` hook is installed for and the ones this module reads a `file_path` out of. Any other `tool_name` is ignored (silent, not an error). */
export const EDIT_GUARD_TOOL_NAMES = ["Edit", "Write", "MultiEdit"] as const;
export type EditGuardToolName = (typeof EDIT_GUARD_TOOL_NAMES)[number];

export function isEditGuardToolName(name: string): name is EditGuardToolName {
  return (EDIT_GUARD_TOOL_NAMES as readonly string[]).includes(name);
}

/** The `PostToolUse` hook payload's shape, narrowed to exactly the fields this module reads — a real payload carries many more, all ignored. */
export interface EditGuardHookPayload {
  readonly hook_event_name?: unknown;
  readonly tool_name?: unknown;
  readonly tool_input?: unknown;
  readonly session_id?: unknown;
  readonly cwd?: unknown;
}

/**
 * The single file this hook checks, read out of `tool_input`. `Edit` and
 * `Write` both carry `file_path` directly; `MultiEdit` also edits exactly one
 * file (its `edits` array is many hunks of THAT file), named the same way.
 * Any other shape (missing, non-string) reads as "nothing to check" — never
 * guessed or defaulted.
 */
export function filePathFromToolInput(toolInput: unknown): string | undefined {
  if (typeof toolInput !== "object" || toolInput === null) return undefined;
  const filePath = (toolInput as Record<string, unknown>).file_path;
  return typeof filePath === "string" && filePath.length > 0 ? filePath : undefined;
}

/** A short, stable label for one finding's rule clause — `<ruleId>#<clauseId>`, split out of `dedupe_key` the same way `jev-rules-command.ts`'s `groupFindingsByRule` already does, never re-derived from `problem` text. */
export function findingClauseLabel(dedupeKey: string): string {
  const [ruleId, clauseId] = dedupeKey.split("::");
  if (ruleId === undefined) return dedupeKey;
  return clauseId !== undefined ? `${ruleId}#${clauseId}` : ruleId;
}

/** One finding's shape, narrowed to what {@link renderEditGuardFeedback} reads — matches `RuleFinding` (`src/review/jev-rules.ts`) structurally, so a caller can pass one straight through with no adapter. */
export interface EditGuardFindingLike {
  readonly dedupe_key: string;
  readonly file: string;
  readonly line: number;
  readonly severity: string;
}

/**
 * The hook's own feedback line, matching the documented example verbatim:
 * "Rule check flagged: <clause id/short name> at <file>:<line> — fix it if
 * it is a real violation." A finding's own `probability`/severity is never
 * embedded here — the agent is told WHERE and WHICH clause, not how sure Jev
 * was, which is deliberately no more alarming than a human reviewer's own
 * one-line comment would be.
 */
export function renderEditGuardFindingLine(finding: EditGuardFindingLike): string {
  return `Rule check flagged: ${findingClauseLabel(finding.dedupe_key)} at ${finding.file}:${finding.line} — fix it if it is a real violation.`;
}

/**
 * The full `additionalContext` text for one hook invocation, capped at
 * {@link MAX_EDIT_GUARD_FEEDBACK_FINDINGS} — deterministic order (as given;
 * callers already sort by severity/probability before this). `undefined`
 * when `findings` is empty: the hook stays silent rather than printing an
 * empty "nothing found" line no coding agent needs to read.
 */
export function renderEditGuardFeedback(findings: readonly EditGuardFindingLike[]): string | undefined {
  if (findings.length === 0) return undefined;
  const shown = findings.slice(0, MAX_EDIT_GUARD_FEEDBACK_FINDINGS);
  const lines = shown.map(renderEditGuardFindingLine);
  const omitted = findings.length - shown.length;
  if (omitted > 0) lines.push(`(${omitted} more finding(s) not shown — see .metaproject/data/jev/edit-guard.jsonl)`);
  return lines.join("\n");
}
