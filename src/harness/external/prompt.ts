// External agent prompt assembly (flow 176, T14).
// Package: docs/requirements/keryx-external-agent-runtime — specification §7.3,
// agent-protocol.md §1.
//
// One argv element carries everything an external CLI is told: the runtime
// directive, the task, and the operator's working diff. Three facts shape this
// module, and all three are measured rather than assumed:
//
//   1. An external CLI READS the operator's own project files — here `AGENTS.md`
//      and `.metaproject/index.md`. That discovery is desirable and is not
//      suppressed: an external agent that finds keryx tooling produces better
//      work. What must be suppressed is the ROUTING those files also trigger.
//      Asked to review a change, the reference CLI answered with a numbered menu
//      of review modes — exit 0, non-empty output, and therefore recorded as a
//      successful review. A question is not a review. The directive below exists
//      to close exactly that, and it is written as instruction to the model
//      rather than by editing the operator's CLI config, which belongs to them
//      and is used for other work.
//   2. The prompt is a single argv element and therefore hits `ARG_MAX`. The
//      ceiling is enforced here, and on overflow the WORKING DIFF is what gets
//      cut. The directive and the task are never cut — an agent missing its
//      directive is the failure in (1), and an agent missing half its task
//      silently answers a different question.
//   3. Truncation is stated INSIDE the prompt as well as reported to the caller.
//      A model handed a silently clipped diff reasons confidently about code it
//      was never shown; told the diff is incomplete, it says so.
//
// Sizes are measured in BYTES throughout, never in characters. `ARG_MAX` counts
// bytes, and a diff of this repository's own docs is not one byte per character —
// a character-counted ceiling passes its tests on ASCII fixtures and overflows in
// production on the first non-ASCII hunk.
//
// Pure: no filesystem, no clock, no `process`. The ceiling is a parameter.

/**
 * The runtime directive, verbatim from agent-protocol.md §1, under its own
 * heading. Always the first bytes of the prompt and never truncated.
 *
 * Exported so a test can assert its presence and a reader can see exactly what
 * the child is told before anything else. Changing this text is changing the
 * contract in agent-protocol.md §1; change both together.
 */
export const EXTERNAL_RUNTIME_DIRECTIVE = [
  "# Runtime directive",
  "",
  "You are running non-interactively as a bounded child agent. Produce the work itself as " +
    "your final message, in the requested output schema. Do not ask questions, do not offer a " +
    "choice of modes, do not route to another skill, orchestrator, or flow, do not delegate to " +
    "another agent, and do not create or modify any files. Read-only investigation only. " +
    "Project tooling documented in this repository is available and you are encouraged to use " +
    "it for reading and searching.",
].join("\n");

/**
 * Marker opening every in-prompt statement that the diff was cut.
 *
 * A stable, greppable prefix rather than free prose: the run records a truncation
 * event, and an operator reading the recorded prompt must be able to find the
 * spot where the input stopped being complete.
 */
export const PROMPT_TRUNCATION_MARKER = "TRUNCATION NOTICE:";

/** Heading opening the working-diff section. */
const DIFF_HEADING = "# Operator working diff";

/**
 * Why the diff is in the prompt at all: the child runs in a detached worktree
 * checked out at `HEAD`, so the operator's uncommitted work is not on disk there.
 */
const DIFF_INTRO_COMPLETE =
  "The operator's uncommitted changes are below. Your worktree is checked out at HEAD and " +
  "does not contain them, so this diff is the only place they exist for you.";

/** Inputs to {@link buildExternalPrompt}. */
export interface ExternalPromptInput {
  /** One-line task title. */
  readonly taskTitle: string;
  /** The task body. Never truncated. */
  readonly taskDescription: string;
  /** Frozen acceptance criteria, one per entry. May be empty; never truncated. */
  readonly acceptanceCriteria: readonly string[];
  /** The operator's uncommitted diff. The only cuttable part of the prompt. */
  readonly workingDiff?: string;
  /** Byte ceiling for the whole argv element (`maxPromptBytes`, specification §3). */
  readonly maxPromptBytes: number;
}

/**
 * Outcome of assembly.
 *
 * A discriminated union rather than a bare prompt, because there is one input the
 * caller must be able to REFUSE on: a directive plus task that already exceed the
 * ceiling with no diff attached. Emitting a clipped prompt there would cut the
 * two things this module promises never to cut, so it returns `ok: false` and the
 * caller fails the dispatch with a named reason instead of spawning a child that
 * was handed half a task.
 *
 * `droppedBytes` counts diff bytes only, and is 0 whenever `truncated` is false.
 */
export type ExternalPromptResult =
  | {
      readonly ok: true;
      /** The complete argv element. Guaranteed `<= maxPromptBytes` bytes. */
      readonly prompt: string;
      /** True when any part of the working diff was cut. */
      readonly truncated: boolean;
      /** Bytes of working diff not present in `prompt`. Recorded on the run. */
      readonly droppedBytes: number;
    }
  | {
      readonly ok: false;
      readonly code: "over-ceiling";
      readonly reason: string;
      /** Bytes the un-cuttable part of the prompt needs. */
      readonly requiredBytes: number;
      /** The ceiling it did not fit into, as resolved (floored, non-finite reads as 0). */
      readonly maxPromptBytes: number;
    };

/** UTF-8 byte length. The one measure used everywhere in this module. */
function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * Longest prefix of `text` fitting `budget` bytes, cut on a code-point boundary
 * and then back to the last line break.
 *
 * Two deliberate properties. The code-point walk means a multi-byte character is
 * never split in half — a byte-sliced UTF-8 diff ends in a lone surrogate that
 * some CLIs reject outright and others hand to the model as a replacement
 * character. The line-break rewind means the diff ends on a whole line rather
 * than mid-hunk, which is what makes the visible remainder readable as a diff.
 *
 * When not even one whole line fits, the result is EMPTY rather than a fragment.
 * At a tight ceiling the fragment is a few characters of a header line: it is not
 * a diff, it cannot be reasoned about, and it costs the honest "omitted entirely"
 * statement the caller would otherwise emit.
 *
 * The head is kept and the tail dropped: a diff is ordered, and its first hunks
 * are the ones the task text is most likely to be talking about.
 */
function clipToBytes(text: string, budget: number): string {
  if (budget <= 0) return "";
  if (byteLength(text) <= budget) return text;

  let kept = "";
  let used = 0;
  for (const character of text) {
    const size = byteLength(character);
    if (used + size > budget) break;
    kept += character;
    used += size;
  }

  const lastBreak = kept.lastIndexOf("\n");
  return lastBreak >= 0 ? kept.slice(0, lastBreak + 1) : "";
}

/** In-prompt statement that the diff below is incomplete. */
function truncationNotice(droppedBytes: number): string {
  return (
    `${PROMPT_TRUNCATION_MARKER} the diff below is INCOMPLETE — ${droppedBytes} bytes were dropped ` +
    "from its end to fit the prompt size limit. Do not assume the omitted part is empty or " +
    "unchanged, and say so if your answer depends on it."
  );
}

/** In-prompt statement that no part of the diff fitted. */
function omissionNotice(droppedBytes: number): string {
  return (
    `${PROMPT_TRUNCATION_MARKER} the operator's working diff (${droppedBytes} bytes) did not fit ` +
    "the prompt size limit and was omitted entirely. Your worktree is checked out at HEAD, so " +
    "you cannot see those changes at all. Say so if your answer depends on them."
  );
}

/**
 * The diff section with a body.
 *
 * Byte-exact by construction: appending `body` adds precisely `byteLength(body)`
 * bytes to the section, which is what lets the caller compute a budget in one
 * pass instead of iterating to a fixed point.
 *
 * The diff is NOT wrapped in a code fence. This repository's own working diffs
 * contain fence lines, so a fence would be closed early by the content, and a
 * truncated diff inside one would leave it open.
 */
function renderDiffSection(intro: string, body: string): string {
  return `${DIFF_HEADING}\n${intro}\n\n${body}`;
}

/** The diff section reduced to its notice — used when nothing of the diff fits. */
function renderDiffNoticeOnly(intro: string): string {
  return `${DIFF_HEADING}\n${intro}`;
}

/** Directive plus task. The part of the prompt that is never cut. */
function renderHead(input: ExternalPromptInput): string {
  const lines: string[] = [EXTERNAL_RUNTIME_DIRECTIVE, "", "# Task", ""];

  const title = input.taskTitle.trim();
  if (title.length > 0) lines.push(title, "");

  const description = input.taskDescription.trim();
  if (description.length > 0) lines.push(description, "");

  const criteria = input.acceptanceCriteria.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  if (criteria.length > 0) {
    lines.push("## Acceptance criteria", "");
    for (const entry of criteria) lines.push(`- ${entry}`);
  }

  return lines.join("\n").trimEnd();
}

function refuse(requiredBytes: number, ceiling: number): ExternalPromptResult {
  return {
    ok: false,
    code: "over-ceiling",
    reason:
      `runtime directive and task need at least ${requiredBytes} bytes but maxPromptBytes is ${ceiling}; ` +
      "refusing rather than truncating the directive or the task",
    requiredBytes,
    maxPromptBytes: ceiling,
  };
}

/**
 * Assemble the single argv element an external agent is dispatched with:
 * directive, then task, then the operator's working diff (specification §7.3).
 *
 * On overflow only the diff is cut, the cut is stated inside the prompt, and the
 * exact byte count is returned for the run record. On an `ok: true` result the
 * prompt is guaranteed to be at most `maxPromptBytes` bytes.
 *
 * A non-finite or non-positive ceiling resolves to 0 and therefore refuses,
 * rather than silently disabling the limit: a missing config value must not turn
 * into an unbounded argv that fails at `execve` with `E2BIG`.
 */
export function buildExternalPrompt(input: ExternalPromptInput): ExternalPromptResult {
  const ceiling = Number.isFinite(input.maxPromptBytes) ? Math.floor(input.maxPromptBytes) : 0;
  const head = renderHead(input);
  const diff = input.workingDiff ?? "";

  if (diff.length === 0) {
    const headBytes = byteLength(head);
    if (headBytes > ceiling) return refuse(headBytes, ceiling);
    return { ok: true, prompt: head, truncated: false, droppedBytes: 0 };
  }

  const diffBytes = byteLength(diff);
  const whole = `${head}\n\n${renderDiffSection(DIFF_INTRO_COMPLETE, diff)}`;
  if (byteLength(whole) <= ceiling) {
    return { ok: true, prompt: whole, truncated: false, droppedBytes: 0 };
  }

  // Budget the diff body against a notice rendered with the LARGEST number it
  // could ever carry (`droppedBytes <= diffBytes`, so its digit count bounds the
  // real one). The real notice is therefore never longer than the one measured,
  // which keeps the result inside the ceiling in a single pass — no fixed-point
  // loop between "how much was dropped" and "how long is the sentence saying so".
  const probe = `${head}\n\n${renderDiffSection(truncationNotice(diffBytes), "")}`;
  const kept = clipToBytes(diff, ceiling - byteLength(probe));

  if (kept.length > 0) {
    const droppedBytes = diffBytes - byteLength(kept);
    const prompt = `${head}\n\n${renderDiffSection(truncationNotice(droppedBytes), kept)}`;
    return { ok: true, prompt, truncated: true, droppedBytes };
  }

  // Nothing of the diff fits. The child is still told the diff exists and that it
  // cannot see it, which is the difference between an agent that qualifies its
  // answer and one that reports the working tree as clean.
  const omitted = `${head}\n\n${renderDiffNoticeOnly(omissionNotice(diffBytes))}`;
  const omittedBytes = byteLength(omitted);
  if (omittedBytes > ceiling) return refuse(omittedBytes, ceiling);
  return { ok: true, prompt: omitted, truncated: true, droppedBytes: diffBytes };
}
