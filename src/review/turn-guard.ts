// Turn guard — flow 329, frozen acceptance criteria
// (`.metaproject/flows/329-2026-09-25-jev-turn-guard-in-keryx-shell-after-the-/
// acceptance-criteria.md`): after an agent turn in `keryx shell` ends with a
// final assistant message, check whether the user's request was actually
// done, and catch a final message that contradicts what the tools really
// did. Advisory only — this module never blocks or auto-continues anything.
//
// THIS MODULE IS CORE (`src/review/`, `src/lib/import-zones.ts`) AND NEVER
// IMPORTS THE CLIENT-ZONE JEV CLIENT (`src/harness/decision/jev-client.ts`) —
// same discipline `ci-triage.ts` and `conform-jev.ts` already follow in this
// directory (see either file's own header). `TurnGuardQuestion` is a plain,
// structural stand-in for `JevQuestion` (`type: "noul"`); the adapter that
// actually calls `callJevSystemOne` (`src/tui/turn-guard-source.ts`, a CLIENT
// module, which may import both this core module and the client-zone Jev
// client) glues the two together.
//
// AC1: `extractTurnGuardFacts` builds bounded, DETERMINISTIC facts from one
// turn's transcript — no model call, pure and synchronous. AC3: deterministic
// contradictions (`detectTurnGuardContradiction`) decide WITHOUT Jev — a
// caller checks these first and only asks Jev when nothing conclusive was
// already found deterministically (or asks Jev in parallel and still raises
// the notice on a deterministic hit even if Jev disagrees/fails/times out).

import { estimateTokens } from "./cost";
// Through the security facade, not `security/redact` directly — the
// import-policy ratchet (`src/lib/import-policy.live.test.ts`) is at its cap,
// and every caller outside `src/security/` reaches redaction through
// `src/security/service.ts` (that file's own header explains why).
import { redactSensitiveText } from "../security/service";

/** The vendor's documented combined `state`+`questions` budget (mirrors `jev-client.ts`'s `JEV_TOKEN_BUDGET`). */
export const TURN_GUARD_TOKEN_BUDGET = 64_000;

/**
 * AC2's documented wall-clock ceiling for one guard call — short because the
 * guard runs AFTER the turn has already settled and must never delay the
 * user's next prompt (it is fired non-blocking; this bound only prevents a
 * hung request from lingering indefinitely in the background).
 */
export const TURN_GUARD_JEV_TIMEOUT_MS = 8_000;

/** Below this Jev "done" probability, or at/above it for "contradiction", the turn is flagged (AC2/AC4). */
export const DEFAULT_TURN_GUARD_THRESHOLD = 0.5;

/** AC6: a turn with no tool calls and a request/reply both at or under these bounds is skipped without asking Jev. */
export const TURN_GUARD_TRIVIAL_REQUEST_CHARS = 80;
export const TURN_GUARD_TRIVIAL_REPLY_CHARS = 200;

/** Characters of user-request / final-message text kept in `state`, after redaction (AC1/AC2). */
export const TURN_GUARD_TEXT_CHARS = 8_000;

/** One tool call this turn made, as the shell observed it (`AgentIO.onToolCall`/`onToolResult`). */
export interface TurnGuardToolCall {
  readonly name: string;
  /** Raw JSON arguments string the model proposed, when available — best-effort, never required. */
  readonly input?: string;
  readonly output: string;
  readonly isError: boolean;
}

/** One turn's raw transcript, as the shell hands it to the guard (AC1). */
export interface TurnGuardTranscript {
  readonly userRequest: string;
  readonly finalMessage: string;
  readonly toolCalls: readonly TurnGuardToolCall[];
}

export interface TurnGuardCommandFact {
  readonly command: string;
  readonly ok: boolean;
  /** Parsed best-effort from the tool's own output text; absent when not recoverable. */
  readonly exitCode?: number;
}

export interface TurnGuardTestFact {
  readonly command: string;
  /** `false` when a fail count was detected (>0) or the tool call itself errored. */
  readonly ok: boolean;
  readonly passed?: number;
  readonly failed?: number;
}

/** AC1: the bounded, deterministic facts computed from one turn's transcript. */
export interface TurnGuardFacts {
  readonly toolCallCount: number;
  /** Tool names, in call order (repeats kept — a tool called 3 times appears 3 times). */
  readonly toolsCalled: readonly string[];
  /** Names of calls that came back `isError: true`, in call order. */
  readonly failedTools: readonly string[];
  readonly anyToolFailed: boolean;
  /**
   * Item 1 (PR #720 review): the subset of `failedTools` eligible for
   * `detectTurnGuardContradiction`'s deterministic "unmentioned-failure" —
   * every non-shell tool failure (unchanged), plus a `shell_exec`-shaped
   * failure only when it is a REAL failure: the tool itself failed/timed
   * out/was denied, or the command is classified as build/test/install/
   * typecheck (`isBuildTestInstallTypecheckCommand`). A plain nonzero exit
   * from an ordinary command (`grep`, `test -f`, `diff`, …) is excluded here
   * even though it still appears in `failedTools`/`commandsRun` — it is a
   * FACT for Jev, not an automatic contradiction.
   */
  readonly deterministicFailedTools: readonly string[];
  /** Best-effort file paths written/edited this turn (from `apply_patch`-shaped calls). */
  readonly filesWritten: readonly string[];
  /** Best-effort shell-command facts (from `shell_exec`-shaped calls), in call order. */
  readonly commandsRun: readonly TurnGuardCommandFact[];
  /** The subset of `commandsRun` whose command text looks like a test runner. */
  readonly testsRun: readonly TurnGuardTestFact[];
  /** AC3(b): the LAST detected test run's own outcome — `false` when `testsRun` is empty. */
  readonly lastTestRunFailed: boolean;
  /** Explicit incompleteness phrases found in the final message ("I could not", "TODO", "not done", ...). */
  readonly markers: readonly string[];
  /** The final message ends by asking the user something. */
  readonly asksQuestion: boolean;
  /** Rendered, ready to place in `state` (`buildTurnGuardState`) or print as advisory evidence. */
  readonly factLines: readonly string[];
}

/**
 * Tool-name classification is a heuristic, not a registry lookup (AC1 note):
 * keryx's own interactive tools are named `apply_patch` (file writes/edits)
 * and `shell_exec` (commands), matched exactly first; a broader pattern match
 * is kept as a fallback so a renamed or third-party tool (an MCP server's own
 * write/exec tool) still counts, rather than silently vanishing from the
 * facts the moment a tool name changes.
 */
const WRITE_TOOL_NAME_RE = /^apply_patch$|write|edit|patch/i;
const SHELL_TOOL_NAME_RE = /^shell_exec$|shell|exec|run_command|bash/i;

const TEST_RUNNER_RE = /\b(bun\s+test|npm\s+(?:run\s+)?test|yarn\s+test|pnpm\s+test|vitest|jest|pytest|go\s+test|cargo\s+test)\b/i;

/**
 * Item 1 (PR #720 review): `shell_exec` (`src/harness/tool/builtin/
 * shell-exec-tool.ts`) marks ANY nonzero exit `isError: true` — `grep` with
 * no match, `test -f` false, `diff` showing differences, `git diff
 * --exit-code` and similar all trip this, with no failure at all. Text this
 * function matches only appears on the tool's OWN failure modes — aborted
 * (run time limit), timed out and killed, denied approval, or a spawn that
 * never started — never on a plain nonzero exit, whose own output is either
 * the command's real stdout/stderr or the literal `(no output; exit N)`
 * fallback. These are always real failures regardless of what command ran.
 */
const SHELL_TOOL_INFRA_FAILURE_RE =
  /\bnot approved by the user; not executed\b|\btimed out after\b|\baborted: run time limit\b|\bcommand failed to start:/i;

/**
 * Best-effort, conservative tokenisation of a shell command into its
 * shell-chained segments (split on `&&`/`||`/`;`/`|`), then each segment's
 * own whitespace-separated tokens — never a substring match against the
 * whole command line, which would also fire on a build tool's name merely
 * mentioned inside an unrelated command (`echo "run tsc later"`,
 * `grep tsc file.ts`). Not a real shell parser (same heuristic-not-registry
 * note as the tool-name regexes above); good enough to classify.
 */
function commandSegments(command: string): string[] {
  return command
    .split(/&&|\|\||[;|]/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

function commandTokens(segment: string): string[] {
  return segment.split(/\s+/).filter((t) => t.length > 0);
}

/** Programs whose own name alone (any subcommand/arguments) counts as build/test/install/typecheck. */
const STANDALONE_BUILD_TEST_PROGRAMS = new Set(["tsc", "eslint", "pytest", "make", "cargo"]);

/** Package-manager-style runners: only certain leading subcommands count. */
const RUNNER_SUBCOMMAND_RE: Readonly<Record<string, RegExp>> = {
  bun: /^(?:test|run)$/i,
  npm: /^(?:test|run|ci|install)$/i,
  yarn: /^(?:test|build|install|typecheck|lint)$/i,
  pnpm: /^(?:test|run|install)$/i,
  go: /^(?:test|build|vet)$/i,
};

/**
 * Item 1 (PR #720 review): the narrowed AC3 rule — a nonzero exit from an
 * ordinary command (`grep`, `test -f`, `diff`, `git diff --exit-code`, `ls`,
 * …) is normal and expected, not a failure; only a build, test, install or
 * typecheck invocation's nonzero exit counts deterministically. Every other
 * nonzero exit is still recorded in `commandsRun`/`factLines` as a FACT for
 * Jev to weigh, just not as an automatic contradiction.
 */
function isBuildTestInstallTypecheckCommand(command: string): boolean {
  return commandSegments(command).some((segment) => {
    const tokens = commandTokens(segment);
    const program = tokens[0];
    if (program === undefined) return false;
    const base = (program.split("/").pop() ?? program).toLowerCase();
    if (STANDALONE_BUILD_TEST_PROGRAMS.has(base)) return true;
    const subRe = RUNNER_SUBCOMMAND_RE[base];
    const sub = tokens[1];
    return subRe !== undefined && sub !== undefined && subRe.test(sub);
  });
}

const INCOMPLETE_MARKERS: ReadonlyArray<{ readonly re: RegExp; readonly label: string }> = [
  { re: /\bI\s+could\s+not\b/i, label: "I could not" },
  { re: /\bI\s+(?:was|am)\s+unable\s+to\b/i, label: "unable to" },
  { re: /\bTODO\b/, label: "TODO" },
  { re: /\bnot\s+(?:yet\s+)?done\b/i, label: "not done" },
  { re: /\bnot\s+yet\s+(?:finished|complete(?:d)?)\b/i, label: "not yet finished" },
  { re: /\bstill\s+need(?:s)?\s+to\b/i, label: "still needs to" },
  { re: /\bpartially\s+(?:done|complete(?:d)?)\b/i, label: "partially done" },
  { re: /\bcould\s+not\s+(?:find|complete|finish|locate)\b/i, label: "could not complete/find" },
];

function safeParseJson(text: string | undefined): Record<string, unknown> | undefined {
  if (text === undefined || text.trim().length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Best-effort command text: the parsed `command`/`cmd` field, or the raw input string as a fallback. */
function commandTextOf(call: TurnGuardToolCall): string {
  const parsed = safeParseJson(call.input);
  const fromField = parsed?.command ?? parsed?.cmd;
  if (typeof fromField === "string" && fromField.length > 0) return fromField;
  return call.input ?? call.name;
}

/** Best-effort file path: the parsed `path`/`file`/`filePath` field, or `undefined`. */
function filePathOf(call: TurnGuardToolCall): string | undefined {
  const parsed = safeParseJson(call.input);
  const fromField = parsed?.path ?? parsed?.file ?? parsed?.filePath;
  return typeof fromField === "string" && fromField.length > 0 ? fromField : undefined;
}

/** Best-effort exit code, parsed from a `shell_exec`-shaped tool's own output text (e.g. `"(no output; exit 1)"`). */
function exitCodeOf(output: string): number | undefined {
  const match = /\bexit\s+(-?\d+)\b/i.exec(output);
  if (match === undefined || match === null) return undefined;
  const n = Number(match[1]);
  return Number.isInteger(n) ? n : undefined;
}

/**
 * Best-effort pass/fail counts out of a test runner's own output text. Tries
 * a few common shapes (bun/jest-style "N passed"/"N failed" in either order,
 * bun's own "N pass"/"N fail") and falls back to `undefined` counts (outcome
 * decided by `isError` alone) rather than guessing — a caller that cannot
 * parse the numbers still knows PASS/FAIL from the tool's own `isError`.
 */
function parseTestCounts(output: string): { passed?: number; failed?: number } {
  const passFailRe = /(\d+)\s+pass(?:ed)?\b[\s\S]{0,200}?(\d+)\s+fail(?:ed|ing)?\b/i;
  const failPassRe = /(\d+)\s+fail(?:ed|ing)?\b[\s\S]{0,200}?(\d+)\s+pass(?:ed)?\b/i;
  const passOnlyRe = /(\d+)\s+pass(?:ed)?\b/i;
  const failOnlyRe = /(\d+)\s+fail(?:ed|ing)?\b/i;
  const pf = passFailRe.exec(output);
  if (pf !== null) return { passed: Number(pf[1]), failed: Number(pf[2]) };
  const fp = failPassRe.exec(output);
  if (fp !== null) return { failed: Number(fp[1]), passed: Number(fp[2]) };
  const passed = passOnlyRe.exec(output);
  const failed = failOnlyRe.exec(output);
  return {
    ...(passed !== null ? { passed: Number(passed[1]) } : {}),
    ...(failed !== null ? { failed: Number(failed[1]) } : {}),
  };
}

/** The final message asks the user something, rather than only reporting. */
function detectAsksQuestion(finalMessage: string): boolean {
  const trimmed = finalMessage.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.endsWith("?")) return true;
  // Also true when the last non-empty line ends in "?" (a trailing sign-off
  // line, e.g. "Let me know!", can otherwise hide a real question above it).
  const lines = trimmed.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  const last = lines[lines.length - 1];
  return last !== undefined && last.endsWith("?");
}

/**
 * AC1: pure, deterministic fact extraction — no model call, no I/O. Every
 * heuristic used here is documented at its own definition above; nothing in
 * this function guesses about intent, only about SHAPE (is this call's name
 * shaped like a write, is this output shaped like a test summary).
 */
export function extractTurnGuardFacts(transcript: TurnGuardTranscript): TurnGuardFacts {
  const toolsCalled = transcript.toolCalls.map((c) => c.name);
  const failedTools = transcript.toolCalls.filter((c) => c.isError).map((c) => c.name);
  const anyToolFailed = failedTools.length > 0;

  const filesWritten: string[] = [];
  const commandsRun: TurnGuardCommandFact[] = [];
  const testsRun: TurnGuardTestFact[] = [];
  const deterministicFailedTools: string[] = [];

  for (const call of transcript.toolCalls) {
    if (WRITE_TOOL_NAME_RE.test(call.name)) {
      const path = filePathOf(call);
      if (path !== undefined && !filesWritten.includes(path)) filesWritten.push(path);
    }
    const isShellTool = SHELL_TOOL_NAME_RE.test(call.name);
    if (isShellTool) {
      const command = commandTextOf(call);
      const ok = !call.isError;
      const exitCode = exitCodeOf(call.output);
      commandsRun.push({ command, ok, ...(exitCode !== undefined ? { exitCode } : {}) });
      if (TEST_RUNNER_RE.test(command)) {
        const counts = parseTestCounts(call.output);
        const testOk = counts.failed !== undefined ? counts.failed === 0 : ok;
        testsRun.push({ command, ok: testOk, ...counts });
      }
      if (call.isError && (SHELL_TOOL_INFRA_FAILURE_RE.test(call.output) || isBuildTestInstallTypecheckCommand(command))) {
        deterministicFailedTools.push(call.name);
      }
    } else if (call.isError) {
      deterministicFailedTools.push(call.name);
    }
  }

  const lastTestRunFailed = testsRun.length > 0 && !testsRun[testsRun.length - 1]!.ok;

  const markers = INCOMPLETE_MARKERS.filter((m) => m.re.test(transcript.finalMessage)).map((m) => m.label);
  const asksQuestion = detectAsksQuestion(transcript.finalMessage);

  const factLines: string[] = [
    `tools: ${transcript.toolCalls.length} called` +
      (toolsCalled.length > 0 ? ` (${toolsCalled.join(", ")})` : "") +
      `; ${anyToolFailed ? `${failedTools.length} failed (${failedTools.join(", ")})` : "none failed"}`,
    `files written/edited: ${filesWritten.length > 0 ? filesWritten.join(", ") : "none"}`,
    `commands run: ${
      commandsRun.length === 0
        ? "none"
        : commandsRun
            .map((c) => `${c.command} (${c.ok ? "ok" : `exit${c.exitCode !== undefined ? ` ${c.exitCode}` : " nonzero"}`})`)
            .join("; ")
    }`,
    `tests run: ${
      testsRun.length === 0
        ? "none detected"
        : testsRun
            .map(
              (t) =>
                `${t.command} (${t.ok ? "pass" : "fail"}${t.passed !== undefined ? `, ${t.passed} passed` : ""}${
                  t.failed !== undefined ? `, ${t.failed} failed` : ""
                })`,
            )
            .join("; ")
    }`,
    `final-message markers: ${markers.length > 0 ? markers.join(", ") : "none"}${asksQuestion ? "; asks the user a question" : ""}`,
  ];

  return {
    toolCallCount: transcript.toolCalls.length,
    toolsCalled,
    failedTools,
    anyToolFailed,
    deterministicFailedTools,
    filesWritten,
    commandsRun,
    testsRun,
    lastTestRunFailed,
    markers,
    asksQuestion,
    factLines,
  };
}

/** AC6: a turn with no tool calls and a short reply to a short request is skipped without asking Jev — rule documented above at the two char-bound consts. */
export function shouldSkipTurnGuard(transcript: TurnGuardTranscript, facts: TurnGuardFacts): boolean {
  if (facts.toolCallCount > 0) return false;
  return (
    transcript.userRequest.trim().length <= TURN_GUARD_TRIVIAL_REQUEST_CHARS &&
    transcript.finalMessage.trim().length <= TURN_GUARD_TRIVIAL_REPLY_CHARS
  );
}

export type TurnGuardContradictionKind = "unmentioned-failure" | "false-test-pass-claim";

export interface TurnGuardContradiction {
  readonly kind: TurnGuardContradictionKind;
  readonly reason: string;
}

/** Claims like "tests pass"/"all tests passing"/"test suite is green"/"tests succeeded". */
const TEST_PASS_CLAIM_RE = /\b(?:tests?|test suite|all tests)\b[^.?!\n]{0,60}\b(?:pass(?:es|ed|ing)?|green|succeed(?:ed|s)?)\b/i;

/**
 * Item 1 (PR #720 review): the final message HONESTLY acknowledges a failing
 * test — a fail count, "pre-existing", "flaky", or "except" — rather than
 * claiming a clean pass. Narrows `false-test-pass-claim` so e.g. "9 passed, 1
 * failed — a known flaky test, the rest pass cleanly" is not flagged.
 */
const TEST_FAILURE_ACKNOWLEDGED_RE = /\b\d+\s+fail(?:ed|ing|ures?)?\b|\bpre-?existing\b|\bflaky\b|\bexcept\b/i;

/** A failed tool's own name appears, or the message uses generic failure language at all. */
function mentionsFailure(finalMessage: string, toolName: string): boolean {
  if (finalMessage.toLowerCase().includes(toolName.toLowerCase())) return true;
  return /\b(fail(?:s|ed|ure|ing)?|error(?:s|ed)?|could not|unable to|did not work|didn't work|broke|broken)\b/i.test(finalMessage);
}

/**
 * AC3: deterministic contradictions, decided WITHOUT Jev — checked first by
 * every caller (`turn-guard-source.ts`), so the notice is raised even when
 * Jev is unavailable, not configured, or times out. Returns the FIRST
 * contradiction found; a turn can only ever be flagged once by this path, so
 * there is nothing to gain from collecting every possible one.
 */
export function detectTurnGuardContradiction(facts: TurnGuardFacts, finalMessage: string): TurnGuardContradiction | undefined {
  if (
    facts.testsRun.length > 0 &&
    facts.lastTestRunFailed &&
    TEST_PASS_CLAIM_RE.test(finalMessage) &&
    !TEST_FAILURE_ACKNOWLEDGED_RE.test(finalMessage)
  ) {
    const last = facts.testsRun[facts.testsRun.length - 1]!;
    return {
      kind: "false-test-pass-claim",
      reason:
        `the final message claims tests pass, but the last test run ("${last.command}") failed` +
        (last.failed !== undefined ? ` (${last.failed} failing)` : "") +
        ".",
    };
  }
  if (facts.deterministicFailedTools.length > 0) {
    const unmentioned = facts.deterministicFailedTools.find((name) => !mentionsFailure(finalMessage, name));
    if (unmentioned !== undefined) {
      return {
        kind: "unmentioned-failure",
        reason: `"${unmentioned}" failed during this turn, and the final message does not mention it.`,
      };
    }
  }
  return undefined;
}

/** A plain, structural stand-in for `JevQuestion` (`type: "noul"`) — see the file header. */
export interface TurnGuardQuestion {
  readonly type: "noul";
  readonly instructions: string;
}

/** AC2: the two `noul` questions asked of Jev — (a) done, (b) contradiction. */
export function buildTurnGuardQuestions(): Readonly<Record<"done" | "contradiction", TurnGuardQuestion>> {
  return {
    done: {
      type: "noul",
      instructions:
        "Given the state above — the user's request for this turn, the final assistant message, and deterministic " +
        "facts computed by a tool (tools called and any failures, files written/edited, commands run and their exit " +
        "status, tests run and their pass/fail counts when detected, and any explicit incompleteness markers or " +
        "questions back to the user in the final message) — how likely is it that the user's request was FULLY done " +
        "by the end of this turn?",
    },
    contradiction: {
      type: "noul",
      instructions:
        "Given the same state, how likely is it that the final assistant message CLAIMS success or completion that " +
        "the deterministic facts above CONTRADICT — for example claiming tests pass while the last recorded test run " +
        "failed, or describing a tool/command as having succeeded while it is recorded as failed?",
    },
  };
}

/**
 * AC1/AC2: the bounded, redacted `state` text. `redactSensitiveText` runs
 * BEFORE truncation for the same reason `ci-triage.ts`'s `buildCiTriageState`
 * documents: truncating first could cut a secret in half at the cut point and
 * let the redactor miss the remaining half.
 */
export function buildTurnGuardState(transcript: TurnGuardTranscript, facts: TurnGuardFacts): string {
  const userRequest = redactSensitiveText(transcript.userRequest).slice(0, TURN_GUARD_TEXT_CHARS);
  const finalMessage = redactSensitiveText(transcript.finalMessage).slice(0, TURN_GUARD_TEXT_CHARS);
  return [
    "user's request for this turn (redacted):",
    userRequest,
    "",
    "final assistant message (redacted):",
    finalMessage,
    "",
    "deterministic facts (computed by keryx, not by the model):",
    ...facts.factLines.map((line) => redactSensitiveText(line)),
  ].join("\n");
}

/** `state`+`questions`'s estimated token count, for a caller that wants to report it. */
export function estimateTurnGuardStateTokens(state: string): number {
  return estimateTokens(state);
}

export interface TurnGuardVerdict {
  readonly doneProbability?: number;
  readonly contradictionProbability?: number;
  readonly flagged: boolean;
  readonly reason: string;
  /** Set only when {@link detectTurnGuardContradiction} decided this verdict — see that function's own doc comment. */
  readonly deterministic?: TurnGuardContradiction;
}

/**
 * Combine a deterministic contradiction (if any, AC3 — always wins and never
 * needs Jev) with Jev's own `noul` answers (if any were asked, AC2) into one
 * verdict. `jevAnswers` fields are independently optional: a caller that
 * skipped Jev (AC6, unavailable, or timed out) can still pass a deterministic
 * contradiction through and get a flagged verdict with no Jev probabilities
 * attached at all.
 */
export function computeTurnGuardVerdict(input: {
  readonly contradiction?: TurnGuardContradiction;
  readonly jevAnswers?: { readonly done?: number; readonly contradiction?: number };
  readonly threshold?: number;
}): TurnGuardVerdict {
  const threshold = input.threshold ?? DEFAULT_TURN_GUARD_THRESHOLD;
  const doneProbability = input.jevAnswers?.done;
  const contradictionProbability = input.jevAnswers?.contradiction;
  if (input.contradiction !== undefined) {
    return {
      flagged: true,
      reason: input.contradiction.reason,
      deterministic: input.contradiction,
      ...(doneProbability !== undefined ? { doneProbability } : {}),
      ...(contradictionProbability !== undefined ? { contradictionProbability } : {}),
    };
  }
  if (doneProbability === undefined && contradictionProbability === undefined) {
    return { flagged: false, reason: "not checked (Jev unavailable, not configured, or skipped) and no deterministic contradiction found." };
  }
  const doneFlag = doneProbability !== undefined && doneProbability < threshold;
  const contradictionFlag = contradictionProbability !== undefined && contradictionProbability >= threshold;
  const flagged = doneFlag || contradictionFlag;
  const pct = (n: number): string => `${Math.round(n * 100)}%`;
  const reason = contradictionFlag
    ? `Jev estimates the final message likely contradicts the facts (≈${pct(contradictionProbability ?? 0)}).`
    : doneFlag
      ? `Jev estimates the request was likely not fully done (≈${pct(doneProbability ?? 0)} done).`
      : "the turn looks done.";
  return {
    flagged,
    reason,
    ...(doneProbability !== undefined ? { doneProbability } : {}),
    ...(contradictionProbability !== undefined ? { contradictionProbability } : {}),
  };
}

/** AC4: the one compact notice line under the turn — English, names the concrete reason. */
export function renderTurnGuardNoticeLine(verdict: TurnGuardVerdict): string {
  return `Guard: request may be incomplete — ${verdict.reason} /guard for details`;
}

/** AC4/AC6: the `/guard` modal's detail text — facts, Jev's probabilities (when asked) and the reason. */
export function renderTurnGuardAdvisory(input: {
  readonly verdict: TurnGuardVerdict;
  readonly facts: TurnGuardFacts;
  readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number; readonly cost?: number };
}): string {
  const { verdict, facts, usage } = input;
  const pct = (n: number): string => `${Math.round(n * 100)}%`;
  const probLines = [
    verdict.doneProbability !== undefined ? `done: ≈${pct(verdict.doneProbability)}` : undefined,
    verdict.contradictionProbability !== undefined ? `contradiction: ≈${pct(verdict.contradictionProbability)}` : undefined,
  ].filter((l): l is string => l !== undefined);
  const usageLine =
    usage !== undefined
      ? `usage: ↑${usage.inputTokens ?? 0} ↓${usage.outputTokens ?? 0}${usage.cost !== undefined ? ` · $${usage.cost.toFixed(4)}` : ""}`
      : undefined;
  return [
    "# Turn guard (advisory)",
    "",
    verdict.flagged ? `FLAGGED: ${verdict.reason}` : `looks done: ${verdict.reason}`,
    ...(verdict.deterministic !== undefined ? [`deterministic: ${verdict.deterministic.kind}`] : []),
    ...(probLines.length > 0 ? ["", ...probLines] : []),
    ...(usageLine !== undefined ? ["", usageLine] : []),
    "",
    "facts:",
    ...facts.factLines.map((l) => `  - ${l}`),
    "",
    "ADVISORY ONLY: a vendor-reported probability from a structured-decision model (Jev/TypeSafe System One), " +
      "not a verified diagnosis. The guard never blocks the shell and never auto-continues the agent.",
  ].join("\n");
}
