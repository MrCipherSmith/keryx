// SLATE-15: `/goal <text> [--workspace <id>]` — the deterministic alternative
// to `isActionRequest`'s heuristic slate-open trigger (flow 161, T11 —
// AC1/AC2). Extracted as its own module (rather than inlined per-surface in
// `commands/shell.ts` / `tui/tui-shell.ts`) because `runAgentRepl` is
// explicitly "NOT unit-tested" per its own doc comment, and the TUI's command
// switch has no injection seam of its own — this is the same kind of
// extracted, independently-testable core `applyRuntimeSwitchToSlate`
// (`tui/tui-shell.ts`) is for `/model`'s SLATE-2a wiring. BOTH surfaces call
// `runGoalCommand`; testing it once here covers the real AC1/AC2 behavior,
// and the per-surface wiring only needs to prove it is actually called (see
// `shell.test.ts` / `tui-shell.test.ts`'s source-text audits).

import path from "node:path";
import { readFile } from "node:fs/promises";
import type { AgentDeps, AgentIO } from "./agent";
import { runAgentTurn } from "./agent";
import type { NormalizedMessage } from "../harness/provider/types";
import { ensureSlateOpened, type SlateSessionRef } from "../session/slate-lifecycle";
import { readSlate, renderAnchorsBlock, writeSlate, type Slate, type SlateSeed } from "../session/slate";
import { resolveWorkspaceForActor } from "../sac/workspace-service";
import { resolveOrCreateWorkspace, type ResolveOrCreateResult } from "../sac/workspace-resolve";
import { createFlowService } from "../flow/service";
import type { FlowService } from "../flow/types";
import { acPath, resolveFlowDir } from "../flow/store";
import type { InteractiveToolResult } from "../harness/tool/builtin/interactive-tools";
import { writeFileAtomic } from "../lib/fs";

/** `/goal <text> [--workspace <id>] [--auto [N]]`, successfully parsed. */
export interface ParsedGoalArgs {
  text: string;
  workspaceId?: string;
  /**
   * Present when `--auto` was given (SLATE-27, flow 186). `rounds` is the
   * explicit `--auto <N>` round-cap override; `undefined` means "use the
   * default cap". T6 (this parse) does not itself change any runtime
   * behavior — the continuation loop this flag will drive is later work
   * in the same flow (T7-T12).
   */
  auto?: { rounds?: number };
}

/** `/goal` args failed to parse (empty text, or a value-less `--workspace`). */
export interface GoalArgsError {
  error: string;
}

const POSITIVE_INTEGER = /^[1-9][0-9]*$/;

/**
 * SLATE-27 (flow 186, T8/AC5): the continuation round budget when `--auto`
 * is given with no explicit `--auto <N>` override. Counts ADDITIONAL rounds
 * beyond the always-runs first turn — bare `--auto` on a goal that never
 * reaches `isCourseDone` runs this many extra turns, then stops.
 */
export const DEFAULT_AUTO_GOAL_ROUNDS = 8;

/**
 * Pure parse of the text after the `/goal` token. `--workspace <id>` and
 * `--auto [N]` (SLATE-27, flow 186) are both recognized only when they
 * TRAIL the input, in either order, and are stripped from the returned
 * `text`, which otherwise preserves word order. An empty/whitespace-only
 * `rest`, a trailing `--workspace` with no following value, or a `rest`
 * that is nothing but flags (no real goal text left after stripping them)
 * are all errors.
 *
 * Review finding 5 (originally `--workspace`-only, generalized here to both
 * flags): this used to locate `--workspace` via `tokens.indexOf` — an
 * exact-token (not substring) match, but at ANY position in `rest` — so an
 * ordinary goal that merely happened to contain the literal token
 * `--workspace` mid-sentence (e.g. "/goal document how --workspace flag
 * works") silently had the FOLLOWING WORD ("flag") swallowed as a
 * `workspaceId` and stripped from the text actually sent to the model —
 * genuine corruption of ordinary goal text, not just an edge case. There is
 * no content-based way to tell "the caller typed a real flag" apart from
 * "the goal text's prose happens to contain this token" without an
 * escape/quoting convention this CLI does not have — the position of
 * `--workspace w-42`/`--workspace flag` relative to the rest of the
 * sentence is structurally IDENTICAL in both cases. The safe, CLI-
 * conventional resolution adopted here: a flag is recognized ONLY when it
 * trails the input, matching how a trailing flag+value pair works in
 * ordinary CLI usage — never leading or embedded mid-sentence.
 *
 * `--auto`'s own value is OPTIONAL (`--auto` alone is valid — "use the
 * default round cap"), which makes it structurally different from
 * `--workspace`: there is no unambiguous "dangling `--auto`" shape the way
 * a value-less trailing `--workspace` is unambiguous (nothing can follow
 * it, so a lone trailing `--workspace` can ONLY be a caller mistake).
 * Consequently `--auto <token>` is recognized as an explicit round-cap
 * override ONLY when `<token>` is both the very last token AND parses as a
 * positive integer; when it does not, this is deliberately NOT a parse
 * error — flow 186's acceptance criteria were revised during this
 * implementation specifically to avoid reintroducing Review finding 5's
 * corruption class for `--auto`: "/goal explain how --auto mode differs"
 * must keep "mode differs" as ordinary goal text, not fail because "mode"
 * isn't a number. In that case `--auto` is simply not recognized as a flag
 * at this position at all; the whole tail, `--auto` included, stays part
 * of `text`.
 *
 * The two flags compose in either trailing order (`--workspace <id> --auto
 * [N]` or `--auto [N] --workspace <id>`) via a small bounded peel: each
 * flag is consumed AT MOST ONCE, working from the very end of the token
 * list inward, one flag per loop iteration (bounded by the fixed number of
 * recognized flags, not an open-ended "peel until nothing matches" loop). A
 * flag encountered a second time (either flag, already consumed once) is
 * left embedded in `text` rather than silently overwriting the first —
 * matches how a duplicate `--workspace` already behaved before `--auto`
 * existed (never explicitly handled; a second occurrence stayed in the
 * text because the original parser only ever inspected the tail once).
 */
export function parseGoalArgs(rest: string): ParsedGoalArgs | GoalArgsError {
  const trimmed = rest.trim();
  if (trimmed.length === 0) {
    return {
      error: "a goal <text> is required, e.g. /goal implement the login flow [--workspace <id>] [--auto [N]]",
    };
  }
  let tokens = trimmed.split(/\s+/);

  let workspaceId: string | undefined;
  let auto: { rounds?: number } | undefined;
  let sawWorkspace = false;
  let sawAuto = false;

  // Exactly two recognized flags today, each consumable at most once — the
  // loop is bounded by that fact, not by "keep going until nothing left".
  for (let i = 0; i < 2; i++) {
    const last = tokens[tokens.length - 1];
    const secondLast = tokens[tokens.length - 2];

    if (!sawAuto && secondLast === "--auto" && last !== undefined && POSITIVE_INTEGER.test(last)) {
      auto = { rounds: Number(last) };
      sawAuto = true;
      tokens = tokens.slice(0, tokens.length - 2);
      continue;
    }
    if (!sawAuto && last === "--auto") {
      auto = {};
      sawAuto = true;
      tokens = tokens.slice(0, tokens.length - 1);
      continue;
    }
    if (!sawWorkspace && last === "--workspace") {
      // A dangling trailing flag with nothing after it — an explicit error,
      // never silently treated as "no --workspace given". `--auto` has no
      // equivalent case (see this function's own docstring for why).
      return { error: "--workspace requires a value, e.g. /goal <text> --workspace <id>" };
    }
    if (!sawWorkspace && secondLast === "--workspace") {
      workspaceId = last;
      sawWorkspace = true;
      tokens = tokens.slice(0, tokens.length - 2);
      continue;
    }
    break;
  }

  const text = tokens.join(" ").trim();
  if (text.length === 0) {
    return {
      error: "a goal <text> is required, e.g. /goal implement the login flow [--workspace <id>] [--auto [N]]",
    };
  }
  const parsed: ParsedGoalArgs = { text };
  if (workspaceId !== undefined) {
    parsed.workspaceId = workspaceId;
  }
  if (auto !== undefined) {
    parsed.auto = auto;
  }
  return parsed;
}

export interface RunGoalCommandParams {
  /** Text after the "/goal" token (readline: `rest`; TUI: line.slice(command.name.length).trim()). */
  raw: string;
  /** Project cwd — passed to `resolveWorkspaceForActor` AND `ensureSlateOpened`. */
  cwd: string;
  io: AgentIO;
  deps: AgentDeps;
  history: NormalizedMessage[];
  slateSession: SlateSessionRef | undefined;
  mintAttemptId: () => string;
  /**
   * SLATE-16 test seam, mirrors `agent.ts`'s `RunAgentTurnOptions.resolveWorkspace`
   * exactly — every real call site leaves this unset and gets the real
   * `resolveOrCreateWorkspace` (real tool calls, a real bounded model turn).
   */
  resolveWorkspace?: (input: { cwd: string; topicHint: string; provider?: string; model?: string }) => Promise<ResolveOrCreateResult>;
}

/** Emit `text` via `io.onSystem` when present, else `io.write` (mirrors `agent.ts`'s own `system` helper). */
function systemLine(io: AgentIO, text: string): void {
  if (io.onSystem !== undefined) {
    io.onSystem(text);
  } else {
    io.write(text);
  }
}

let flowService: FlowService | undefined;

/**
 * A private instance, separate from `src/commands/flow.ts`'s own module-level
 * singleton (not exported there). Safe: `createFlowService` closes only over
 * its `deps`, and real mutation safety comes from `withFileLock`
 * (`src/flow/service.ts`) on the filesystem, not from any in-memory state —
 * two independent instances operating on the same `cwd` do not conflict.
 * `tracker: null` and a `healthGate` stub that is never called: `init`,
 * `freeze`, and `start` (the only methods `autoProvisionFlow` uses) read
 * neither.
 */
function getFlowService(): FlowService {
  flowService ??= createFlowService({
    tracker: null,
    healthGate: async () => ({ status: "skipped", reasons: [] }),
    now: () => new Date(),
  });
  return flowService;
}

/**
 * SLATE-27 (flow 186, T7): auto-provision a Task Manager flow for a `/goal
 * --auto` run whose slate has none bound yet (AC2).
 *
 * Deliberately minimal — no model call. Plan step 2 originally called for
 * reusing `keryx flow plan <id>`'s "model-suggested task breakdown"; on
 * inspection during implementation, `runPlan` (`src/commands/flow.ts`) turned
 * out to be PURELY ADVISORY console output — it calls `narrate()` and writes
 * nothing to flow state at all (its own system prompt: "This is a suggestion
 * only — it does not modify flow state"). There is no structured task list
 * to reuse programmatically, so v1 does not call it. This was an anticipated
 * risk (plan.md's own "Risks" section flagged exactly this before
 * implementation), now confirmed rather than hypothetical.
 *
 * Uses `flow init`'s default four-task scaffold (context/implement/test/
 * review) as-is, and writes exactly ONE acceptance criterion tied directly
 * to the goal text — `flow freeze` refuses an unmodified placeholder AC file
 * (`isPlaceholderAc`, `src/flow/service.ts`), so *some* real criterion is
 * required regardless of the missing task breakdown. That criterion is
 * deliberately the SAME thing T10's verifier subagent will check before the
 * continuation loop stops — one completion definition, not two independent
 * ones that could disagree.
 *
 * Throws on any failure (flow-service error, a write failure) rather than
 * swallowing it here — `runGoalCommand`'s existing outer try/catch around
 * all slate bookkeeping already degrades this exactly the same way it
 * degrades a workspaceId-resolution failure: log via `systemLine`, skip
 * this attempt's `--auto` arming, let the turn still run.
 *
 * Known gap (review finding BOSS-004, not yet fixed): if `init()` succeeds
 * but `freeze()`/`start()` then throws, the just-created flow directory is
 * left on disk, orphaned and unbound (`slate.course.flowRef` is only
 * written by the caller after this function returns successfully) — Task
 * Manager has no `flow delete`, so there is nothing safe to clean up here.
 * A retried `--auto` on the same slate calls this function again, since
 * `course.flowRef` is still unset, leaving a second orphan, and so on per
 * retry. Not user-visible breakage — just accumulating garbage in
 * `.metaproject/flows/` — but a real gap, not a hypothetical one.
 */
async function autoProvisionFlow(cwd: string, goalText: string): Promise<string> {
  const service = getFlowService();
  const result = await service.init({ cwd, title: goalText });
  const acFile = path.join(cwd, result.dir, "acceptance-criteria.md");
  await writeFileAtomic(
    acFile,
    [
      "# Acceptance Criteria",
      "",
      "Rules:",
      "",
      "- Criteria lines use the exact format `- ACn: <criterion>`.",
      "- After `flow freeze` this file is checksum-protected: any edit outside",
      "  `keryx flow ac update` fails every gate and status transition.",
      "- Completion requires every ACn to be confirmed via",
      "  `keryx flow ac confirm <id> <ACn>`.",
      "",
      "Source: auto-provisioned by `/goal --auto` (SLATE-27, flow 186) — the",
      "goal text itself is the spec; no separate description/plan pair exists.",
      "",
      "## Criteria",
      "",
      `- AC1: The stated goal — "${goalText}" — is achieved, judged by the`,
      "  verifier subagent this session's continuation loop runs before",
      "  stopping (flow 186 T10).",
      "",
    ].join("\n"),
  );
  await service.freeze({ cwd, id: result.flow.id });
  await service.start({ cwd, id: result.flow.id });
  return result.flow.id;
}

/**
 * SLATE-27 (flow 186, T9): the user-turn text for one continuation round —
 * plan step 4's "round N of the flow's current task list". Reads the bound
 * flow's live task list through the SAME `FlowService` instance
 * `autoProvisionFlow` uses (`.get()`, not a CLI subprocess or a re-parsed
 * `flow status --json`), so it is always the current on-disk state, not a
 * stale snapshot from provisioning time. Falls back to a generic
 * continuation line — never throws — when no flow is bound (an `--auto`
 * whose provisioning attempt itself failed, degrading per AC2) or the flow
 * read fails for any reason; a missing task list is not a reason to stop
 * the loop, only to say less about what remains.
 */
/**
 * SLATE-27 (flow 186, T10/#394): a deterministic, model-emittable signal
 * that THIS round's work is genuinely finished — checked after every
 * continuation round (see `continuationRoundClaimsDone` below), not only
 * once at final round-budget exhaustion the way T10's verifier is. Deliberately
 * NOT reusing `slate-lifecycle.ts`'s `CLOSE_PHRASES` heuristic: that scans
 * ordinary natural-language USER text for common phrases ("wrap up", "task
 * complete", …) and is explicitly disabled for `/goal` (`skipCloseTrigger`)
 * because the GOAL text itself can innocently contain one of those phrases.
 * This marker instead scans the MODEL's own final reply for one exact,
 * deliberately unusual literal token this file itself instructs the model to
 * emit ONLY when it judges the round's work complete — there is no goal-text
 * collision risk (the model was never asked to echo arbitrary user text back
 * verbatim), and no fuzzy substring matching that could false-positive on
 * ordinary prose.
 *
 * Why this exists at all (the actual #394 bug): the round loop's ONLY other
 * early-exit path is `slateSession.opened` flipping to `false`, which only
 * happens when the bound flow's on-disk status is independently `"done"`
 * (`isCourseDone`/`closeSlateOnFlowDone`, agent.ts) — and nothing in the
 * model's actual tool set can ever cause that flip (no tool marks a flow
 * task, let alone the whole flow, done). Left unfixed, the loop always burns
 * its full `roundsCap`. This marker gives the loop a second, independent way
 * to stop early WITHOUT touching that flow-status machinery at all — it
 * never closes/archives the slate itself (that remains solely
 * `closeSlateOnFlowDone`'s job); it only ends the round loop early so T10's
 * verifier pass (which always runs next, unconditionally) is reached sooner.
 * A false "done" claim from the model is not fatal: T10 is the authority on
 * whether the goal is ACTUALLY achieved, and can still grant one more round
 * (`roundsLeft > 0` below) if it disagrees — this marker only ever saves
 * rounds, it never skips verification.
 */
export const ROUND_DONE_MARKER = "GOAL_ROUND_COMPLETE";

/**
 * True when the most recent assistant message in `history` (the final
 * text-only reply that just ended a continuation round — `agent.ts` always
 * pushes exactly one of these per completed turn) contains
 * {@link ROUND_DONE_MARKER}. Scans backward from the tail rather than
 * indexing `history.length - 1` directly: `runAgentTurn` can push several
 * messages for one round (tool calls/results, Anchors re-injects, …), and
 * the assistant's own final text is the last `role: "assistant"` entry, not
 * necessarily the very last entry pushed.
 */
function continuationRoundClaimsDone(history: readonly NormalizedMessage[]): boolean {
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i];
    if (message?.role === "assistant") {
      return message.content.includes(ROUND_DONE_MARKER);
    }
  }
  return false;
}

async function buildContinuationMessage(
  cwd: string,
  slateSession: SlateSessionRef,
  round: number,
  roundsCap: number,
): Promise<string> {
  const totalRounds = roundsCap + 1;
  const doneInstruction =
    `If — and only if — the stated goal is now FULLY achieved and there is nothing further to do this round, ` +
    `end your reply with the exact line ${ROUND_DONE_MARKER} on its own, and nothing else on that line. ` +
    `Otherwise do not include that line at all.`;
  const generic = `Continue working toward the stated goal (round ${round} of ${totalRounds}). ${doneInstruction}`;
  const slate = await readSlate(slateSession.dir).catch(() => undefined);
  const flowId = slate?.course.flowRef;
  if (flowId === undefined) {
    return generic;
  }
  try {
    const flow = await getFlowService().get({ cwd, id: flowId });
    const remaining = flow.tasks.filter((task) => task.status !== "done");
    const remainingList =
      remaining.length > 0 ? remaining.map((task) => `${task.id}: ${task.title}`).join("; ") : "(no open tasks recorded)";
    return `${generic} Flow ${flowId} tasks remaining: ${remainingList}.`;
  } catch {
    return generic;
  }
}

/** One independent verifier's verdict on whether the goal was actually achieved (SLATE-27, flow 186, T10, AC4). */
export interface GoalVerifierVerdict {
  achieved: boolean;
  gaps: string[];
}

/**
 * Extract a `{"achieved": boolean, "gaps": [...]}` object from the
 * verifier subagent's free-text summary. The subagent is prompted to reply
 * with nothing but that JSON object, but a model reliably wrapping it in
 * extra prose is exactly the kind of thing not to trust — so this scans for
 * the first `{...}` span rather than requiring the WHOLE output to parse.
 * Returns `undefined` on anything unparseable, never throws — an
 * unreadable verdict must degrade the same way an unreachable verifier
 * does (see `runGoalVerifier`), not crash `/goal`.
 */
export function parseVerifierVerdict(output: string): GoalVerifierVerdict | undefined {
  const match = output.match(/\{[\s\S]*\}/);
  if (match === null) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(match[0]);
    if (typeof parsed !== "object" || parsed === null || !("achieved" in parsed)) {
      return undefined;
    }
    const achieved = (parsed as { achieved: unknown }).achieved;
    if (typeof achieved !== "boolean") {
      return undefined;
    }
    const gapsRaw = (parsed as { gaps?: unknown }).gaps;
    const gaps = Array.isArray(gapsRaw) ? gapsRaw.filter((g): g is string => typeof g === "string") : [];
    return { achieved, gaps };
  } catch {
    return undefined;
  }
}

/** Upper bound on how many recent Seeds are quoted verbatim into the verifier's evidence (#392). Generous but bounded — a Seed's own text is already capped at `SEED_TEXT_MAX_LENGTH`. */
const MAX_EVIDENCE_SEEDS = 10;

function summarizeRecentSeeds(seeds: readonly SlateSeed[]): string[] {
  return seeds.slice(-MAX_EVIDENCE_SEEDS).map((seed) => `- Seed${seed.kind !== undefined ? ` [${seed.kind}]` : ""}: ${seed.text}`);
}

/**
 * Extracts a compact summary of every `workspace_propose` call THIS run
 * made, from `history` — never a fresh SAC/workspace read. `history` already
 * carries the real, ordered dispatch/result pairs for every tool call the
 * normal `executeCall` path ran this session (`agent.ts`), so this is the
 * SAME live evidence the run itself produced, not a re-derived approximation.
 * Pairs each `workspace_propose` call with its own result by `toolCallId` —
 * never assumes adjacency, since a parallel tool-call batch (agent.ts's own
 * `anchorsToAnnounce`/`repeatedFailureHint` deferral comment explains why)
 * can interleave several calls' results together.
 */
function summarizeWorkspaceProposals(history: readonly NormalizedMessage[]): string[] {
  const lines: string[] = [];
  for (const message of history) {
    if (message.role !== "assistant" || message.toolCalls === undefined) {
      continue;
    }
    for (const call of message.toolCalls) {
      if (call.name !== "workspace_propose") {
        continue;
      }
      const resultMessage = history.find((candidate) => candidate.role === "tool" && candidate.toolCallId === call.id);
      let argSummary = call.arguments;
      try {
        const parsedArgs = JSON.parse(call.arguments) as Record<string, unknown>;
        const kind = typeof parsedArgs.kind === "string" ? parsedArgs.kind : "?";
        const note = typeof parsedArgs.note === "string" ? parsedArgs.note : undefined;
        argSummary = `kind=${kind}${note !== undefined ? `, note=${note}` : ""}`;
      } catch {
        // Unparseable arguments (should not happen for a real dispatched call) — fall back to the raw string.
      }
      const outcome = resultMessage !== undefined ? resultMessage.content : "(no result recorded this run)";
      lines.push(`- workspace_propose: ${argSummary} -> ${outcome}`);
    }
  }
  return lines;
}

/**
 * SLATE-27 (flow 186, T10, #392): true when the bound flow's own
 * `acceptance-criteria.md` already defers completion judgment to THIS
 * verifier check, rather than to the flow's own task checkboxes — detected
 * by the exact literal phrase `autoProvisionFlow` (above) writes into that
 * file, not by any flow-id/source check. A `/goal --auto` run can reuse an
 * ALREADY-bound flow (SLATE-27's "existing one is reused" behavior) that a
 * human authored with ordinary completion semantics — that flow's tasks
 * genuinely ARE evidence of non-completion, and must not be waved off just
 * because `/goal --auto` happens to be driving it this time. Fails closed
 * (`false`) on any read error: the "don't trust flow-task state" instruction
 * is only ever ADDED to the verifier's task, never assumed by default.
 */
async function flowDefersCompletionToVerifier(cwd: string, flowId: string): Promise<boolean> {
  try {
    const dir = await resolveFlowDir(cwd, flowId);
    const text = await readFile(acPath(cwd, dir), "utf8");
    // Whitespace-normalized: `autoProvisionFlow`'s own AC1 text (above) wraps
    // this exact phrase across two lines ("...judged by the\n  verifier
    // subagent...") for readability in the rendered markdown file — a plain
    // substring match against the raw file content would never see it as
    // contiguous. Collapsing all whitespace runs to a single space makes the
    // match robust to that line wrap without caring about exact formatting.
    const normalized = text.replace(/\s+/g, " ");
    return normalized.includes("judged by the verifier subagent");
  } catch {
    return false;
  }
}

/** Combined evidence trail + defer-to-verifier detection for one `runGoalVerifier` dispatch (#392). */
async function buildVerifierEvidence(
  cwd: string,
  slateSession: SlateSessionRef,
  history: readonly NormalizedMessage[],
): Promise<{ evidenceText: string; deferToVerifier: boolean }> {
  const slate = await readSlate(slateSession.dir).catch(() => undefined);
  const lines = [...(slate !== undefined ? summarizeRecentSeeds(slate.seeds) : []), ...summarizeWorkspaceProposals(history)];
  const evidenceText = lines.length > 0 ? lines.join("\n") : "(no Seeds or workspace_propose records were recorded this run)";
  const flowId = slate?.course.flowRef;
  const deferToVerifier = flowId !== undefined ? await flowDefersCompletionToVerifier(cwd, flowId) : false;
  return { evidenceText, deferToVerifier };
}

/**
 * SLATE-27 (flow 186, T10, AC4): one independent check on whether the goal
 * text was actually achieved, dispatched through the SAME `spawn_subagent`
 * tool instance already wired into this session (`deps.tools`) — not a
 * second, parallel subagent-dispatch mechanism this module invents. `mode:
 * "read_only"` (no shell, no writes): a verifier that could itself mutate
 * the repo while "checking" it is not an independent check.
 *
 * #392: the child is handed this run's actual evidence trail (recent Slate
 * Seeds and `workspace_propose` records, via `buildVerifierEvidence`) rather
 * than the bare goal text alone, and — when the bound flow's own AC text
 * defers completion judgment to this very check — an explicit instruction
 * not to weight the flow's own (by-design, permanently unchecked) task list
 * as evidence of non-completion.
 *
 * #389: unlike a real assistant-turn tool call, this dispatch never goes
 * through `executeCall`'s `io.onToolCall`/`onToolResult` hooks (this
 * function calls `tool.invoke` directly — see this module's header comment
 * for why: `runGoalVerifier` is not itself a model-driven turn). This
 * function now fires those SAME hooks itself, and pushes the SAME shape of
 * assistant-tool-call + tool-result pair into `history` a real dispatch
 * would have produced (`NormalizedMessage.toolCalls`/`toolCallId`) — so a
 * resumed/exported session transcript shows whether T10 actually ran, not
 * just its final achieved/not-achieved verdict.
 *
 * Returns `undefined` — never throws — when: the session has no
 * `spawn_subagent` tool wired in, the dispatch itself errors, or the
 * child's summary does not parse as a verdict. Every one of those means
 * "the loop's existing stop decision stands, unverified" — an unavailable
 * or unparseable verifier must never be the reason `/goal --auto` loops
 * forever chasing a second opinion it can't get. Also unlike a silent
 * `undefined` return alone, EVERY one of these outcomes is now recorded in
 * `history` (or, when no tool is wired in at all, is simply not dispatchable
 * — there is no call to record) so the caller's own `systemLine` on every
 * outcome (achieved / not achieved / unavailable) is backed by a real trace.
 */
async function runGoalVerifier(
  deps: AgentDeps,
  goalText: string,
  cwd: string,
  slateSession: SlateSessionRef,
  history: NormalizedMessage[],
  io: AgentIO,
  mintCallId: () => string,
): Promise<GoalVerifierVerdict | undefined> {
  const tool = deps.tools.find((candidate) => candidate.definition.name === "spawn_subagent");
  if (tool === undefined) {
    return undefined;
  }
  const { evidenceText, deferToVerifier } = await buildVerifierEvidence(cwd, slateSession, history);
  const task = [
    "Independently verify whether the following goal has ACTUALLY been achieved, based on the",
    "current, real state of the repository (read the real files/tests — never trust a prior",
    "claim in conversation history without checking it yourself).",
    "",
    `Goal: "${goalText}"`,
    "",
    "Evidence this run already produced (recent Slate Seeds and workspace_propose records) —",
    "weigh this as real evidence of what was actually done, not merely a claim:",
    evidenceText,
    "",
    ...(deferToVerifier
      ? [
          "This run's Task Manager flow acceptance criteria explicitly defer the completion",
          "judgment to THIS verifier check, not to the flow's own task checkboxes — its tasks",
          "are expected to remain unchecked even when the goal is genuinely achieved. Do NOT",
          "treat an incomplete/unchecked flow task list, by itself, as evidence the goal is NOT",
          "achieved; judge achievement from the real repository state and the evidence above.",
          "",
        ]
      : []),
    "Reply with EXACTLY one JSON object and nothing else, no prose before or after it:",
    '{"achieved": true or false, "gaps": ["specific reason it is not fully achieved", ...]}',
    '"gaps" must be empty when "achieved" is true.',
  ].join("\n");
  const input = { task, mode: "read_only", label: "goal-verifier" };
  const callId = mintCallId();
  io.onToolCall?.("spawn_subagent", JSON.stringify(input));
  history.push({
    role: "assistant",
    content: "",
    provenance: "model",
    toolCalls: [{ id: callId, name: "spawn_subagent", arguments: JSON.stringify(input) }],
  });
  io.onHistoryChange?.("tool");
  let result: InteractiveToolResult;
  try {
    result = await tool.invoke(input);
  } catch (err) {
    const errorResult: InteractiveToolResult = {
      output: `spawn_subagent dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
    io.onToolResult?.("spawn_subagent", errorResult);
    history.push({ role: "tool", content: errorResult.output, provenance: "tool", toolCallId: callId });
    io.onHistoryChange?.("tool");
    return undefined;
  }
  io.onToolResult?.("spawn_subagent", result);
  history.push({ role: "tool", content: result.output, provenance: "tool", toolCallId: callId });
  io.onHistoryChange?.("tool");
  if (result.isError) {
    return undefined;
  }
  return parseVerifierVerdict(result.output);
}

/**
 * Run `/goal`'s full sequence: parse → (if `--workspace` was given) validate
 * it FIRST via `resolveWorkspaceForActor` — fail-closed, no slate opened, no
 * turn run on rejection (AC1) → open the slate (bypassing `isActionRequest`'s
 * heuristic; `/goal` IS the deterministic alternative) → bind
 * `slate.workspaceId`: an explicit, validated `--workspace` always wins
 * (AC2, v1 behavior, unchanged); when `--workspace` was omitted, SLATE-16's
 * resolve-or-create now runs instead (supersedes v1's "leave unset") and
 * only when this slate has no workspaceId bound yet — a `/goal` reusing an
 * already-bound slate mid-session is never re-resolved (AC-25) → (if
 * `--auto` was given) auto-provision/reuse a bound Task Manager flow and arm
 * a per-attempt continuation budget → run the turn with the parsed text →
 * (SLATE-27, flow 186) when armed, re-drive the turn in a round-capped loop
 * until the bound flow's course is done (observed via `slateSession.opened`,
 * the same signal `closeSlateOnFlowDone` already computes — no second
 * `isCourseDone` call) or the round budget is exhausted, then run one
 * independent `spawn_subagent` verifier pass before the final stop, with at
 * most one extra "second chance" round if it disagrees.
 */
export async function runGoalCommand(params: RunGoalCommandParams): Promise<void> {
  const { raw, cwd, io, deps, history, slateSession, mintAttemptId, resolveWorkspace } = params;
  const parsed = parseGoalArgs(raw);
  if ("error" in parsed) {
    systemLine(io, `/goal: ${parsed.error}\n`);
    return;
  }
  // T10: snapshot of what --auto bound this slate to, captured at arm time
  // (below) while it is still guaranteed fresh — used only if the verifier
  // pass needs to reopen an already-closed slate for one more round.
  let boundFlowRef: string | undefined;
  let boundWorkspaceId: string | undefined;

  if (parsed.workspaceId !== undefined) {
    const resolved = await resolveWorkspaceForActor(cwd, parsed.workspaceId);
    if (!resolved.ok) {
      systemLine(
        io,
        `/goal: --workspace "${parsed.workspaceId}" was rejected (${resolved.error.code}): ${resolved.error.message}. ` +
          `The slate was not opened and the goal was not run.\n`,
      );
      return;
    }
  }

  if (slateSession !== undefined) {
    // Review finding 3 (crash risk): every comparable slate-touching call
    // site added in this PR (agent.ts's open/close triggers, tui-shell.ts's
    // `/model` handler) is wrapped in try/catch with a documented "must
    // never crash the turn/command" rationale — this block previously was
    // not. A corrupted `slate.json` or an `EACCES` makes `ensureSlateOpened`'s
    // internal `readSlate` throw (via `openSlateAtomic`); `tui-shell.ts`'s
    // call site is a bare `void (async () => { await runGoalCommand(...) })()`
    // with no `.catch`, so an unhandled rejection there crashes/hangs the
    // TUI, and `shell.ts`'s call site sits outside the REPL's own turn
    // try/finally. Degrade the same way `agent.ts`'s own open/close triggers
    // do: on any failure here, skip slate lifecycle bookkeeping for this
    // attempt (open / Anchors-inject / workspaceId bind) and let the goal's
    // actual turn still run — a lost Anchors injection or workspace binding
    // is recoverable; crashing mid-`/goal` is not. This is safe to do even
    // for a rejected `--workspace` id: fail-closed validation via
    // `resolveWorkspaceForActor` already ran and returned ABOVE this block,
    // so proceeding here can never silently resurrect a rejected bind.
    try {
      // Review finding 2 (AC4 violation on this phase's own new entry
      // point): `/goal` calls `ensureSlateOpened` itself (bypassing
      // `isActionRequest`'s heuristic by design — see this function's own
      // doc comment), which sets `slateSession.opened = true` BEFORE
      // `runAgentTurn`/`runAgentTurnCore` ever runs. `runAgentTurnCore`'s own
      // SLATE-2a Anchors-inject trigger (agent.ts, the `!wasOpened &&
      // ref.opened` transition check) detects a fresh open by snapshotting
      // `ref.opened` immediately before ITS OWN `ensureSlateOpened` call —
      // but by the time it runs, `slateSession.opened` is already `true`
      // (set here, moments earlier), so that transition never appears to
      // happen and a `/goal`-started turn got ZERO initial Anchors
      // visibility. Fix: produce the SAME "fresh open" injection ourselves,
      // right here, mirroring `runAgentTurnCore`'s own fresh-open path
      // (agent.ts, ~line 827-838) exactly, rather than relying on
      // `runAgentTurnCore` to redundantly detect an open it did not itself
      // perform.
      const wasOpened = slateSession.opened;
      await ensureSlateOpened(slateSession, mintAttemptId, { provider: deps.providerId, model: deps.modelId });
      if (!wasOpened && slateSession.opened) {
        const freshSlate = await readSlate(slateSession.dir);
        if (freshSlate !== undefined) {
          history.push({ role: "user", content: renderAnchorsBlock(freshSlate.anchors), provenance: "project" });
          io.onHistoryChange?.("tool");
        }
      }
      if (parsed.workspaceId !== undefined) {
        const workspaceId = parsed.workspaceId;
        await writeSlate(slateSession.dir, (prev) => {
          const base: Slate = prev ?? { anchors: { root: "", touched: [] }, course: {}, seeds: [] };
          return { ...base, workspaceId };
        });
      } else {
        // SLATE-16 supersedes SLATE-15's old "omitted --workspace = leave
        // unset" behavior: `/goal` without `--workspace` now triggers
        // resolve-or-create instead. Only when this slate does not already
        // have a workspaceId bound (AC-25) — a `/goal` reusing an
        // already-bound slate mid-session is never re-resolved.
        const current = await readSlate(slateSession.dir);
        if (current !== undefined && current.workspaceId === undefined) {
          const resolver = resolveWorkspace ?? resolveOrCreateWorkspace;
          const resolved = await resolver({ cwd, topicHint: parsed.text, provider: deps.providerId, model: deps.modelId });
          if (resolved.ok) {
            await writeSlate(slateSession.dir, (prev) => {
              if (!prev) throw new Error(`SLATE-16 bind: no open slate in ${slateSession.dir}`);
              return { ...prev, workspaceId: resolved.workspaceId };
            });
          }
        }
      }
      // SLATE-27 (flow 186, T7, AC2): --auto provisions a Task Manager flow
      // when this slate's course has none bound yet — never re-provisioned
      // for an already-bound course, mirroring SLATE-16's own "only when
      // unset" rule directly above. Shares this try block deliberately: a
      // provisioning failure degrades the same way a workspace-resolution
      // failure already does (log, skip, let the turn run) rather than
      // needing a second, parallel degrade-safe wrapper.
      if (parsed.auto !== undefined) {
        const forCourse = await readSlate(slateSession.dir);
        // T10 (review finding BOSS-003): derive the binding to snapshot from
        // values ALREADY in scope — `forCourse`'s own read above, and
        // `flowId` when a new flow is provisioned below — rather than a
        // second `readSlate` after arming. A second read there raced the
        // outer catch's own contract ("on any failure here, `--auto` simply
        // does not arm for this attempt"): arming happened before that read,
        // so a failure IN the read alone would still leave the loop armed,
        // just with no binding to reopen/rebind against later (T10).
        let flowRefForBinding = forCourse?.course.flowRef;
        if (forCourse !== undefined && forCourse.course.flowRef === undefined) {
          const flowId = await autoProvisionFlow(cwd, parsed.text);
          await writeSlate(slateSession.dir, (prev) => {
            if (!prev) throw new Error(`SLATE-27 bind: no open slate in ${slateSession.dir}`);
            return { ...prev, course: { ...prev.course, flowRef: flowId } };
          });
          flowRefForBinding = flowId;
        }
        // T8 (AC7): arm the in-memory continuation budget for THIS attempt
        // only, whether the flow was just provisioned above or was already
        // bound (reused, per AC2's "no new flow... existing one is reused").
        // Lives on `slateSession` itself — never `slate.json` — so a resumed
        // or forked session (a brand-new `SlateSessionRef`) never inherits
        // it. Consumed (and cleared) exactly once, at the top of the
        // continuation-loop block below (review finding BOSS-001) — arming
        // here alone is NOT enough to guarantee "this attempt only": without
        // that clear, `slateSession` is a per-SESSION object reused across
        // every later `/goal` call (`shell.ts`/`tui-shell.ts` construct it
        // once, not per-call), so a stale armed budget would silently hijack
        // the NEXT `/goal` too, even one with no `--auto` in its own text.
        slateSession.autoGoalRounds = parsed.auto.rounds ?? DEFAULT_AUTO_GOAL_ROUNDS;
        boundFlowRef = flowRefForBinding;
        boundWorkspaceId = forCourse?.workspaceId;
      }
    } catch (err) {
      systemLine(io, `/goal: slate bookkeeping failed (ignored): ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  // Review finding: `/goal` already opened the slate (and bound workspaceId)
  // above, deterministically — `runAgentTurn`'s own heuristic close-phrase
  // check must not re-examine the same `parsed.text` and immediately undo
  // that open/bind whenever the goal text happens to contain a close-phrase
  // substring (e.g. "wrap up documentation").
  const turnOptions = slateSession !== undefined ? { slateSession, skipCloseTrigger: true } : {};
  await runAgentTurn(io, deps, history, parsed.text, turnOptions);

  // SLATE-27 (flow 186, T9): bounded continuation loop, armed only when T8
  // set `slateSession.autoGoalRounds` above (AC7 — in-memory, this attempt
  // only). AC3's stop condition: `runAgentTurn`'s own `finally` block
  // (`closeSlateOnFlowDone`, agent.ts) ALREADY ran `isCourseDone`/
  // `courseFromSlate` for the turn just above, and — if the course was
  // done — already archived the slate and flipped `slateSession.opened` to
  // `false` (`closeSlateSession`, slate-lifecycle.ts) before this line
  // runs. Reading `slateSession.opened` here observes that SAME check's
  // result rather than invoking a second implementation of it: calling
  // `isCourseDone` again here would either recompute the identical answer
  // from the same live state (redundant) or, once the course is genuinely
  // done, read a slate that closeSlateOnFlowDone already archived out from
  // under it. `slateSession.opened` is the correct, already-computed signal
  // either way.
  if (slateSession !== undefined && slateSession.autoGoalRounds !== undefined) {
    const roundsCap = slateSession.autoGoalRounds;
    // Review finding BOSS-001: clear the arm the moment it's consumed, not
    // just set it once at arm time. `slateSession` is a per-SESSION object
    // (`shell.ts`/`tui-shell.ts` construct it once, reused across every
    // `/goal` call in the session, reassigned only on `/new`/`/clear`) — an
    // arm that outlived this call would silently hijack the NEXT `/goal`
    // too, including one with no `--auto` in its own text. This is what
    // makes "armed only for the current attempt" (AC7, this file's own
    // header comment on `autoGoalRounds`) actually true, not just documented.
    delete slateSession.autoGoalRounds;
    let roundsLeft = roundsCap;
    let round = 1;
    while (roundsLeft > 0 && slateSession.opened) {
      roundsLeft -= 1;
      round += 1;
      const continuationText = await buildContinuationMessage(cwd, slateSession, round, roundsCap);
      systemLine(io, `/goal --auto: round ${round}/${roundsCap + 1} — continuing toward the goal.\n`);
      await runAgentTurn(io, deps, history, continuationText, turnOptions);
      // #394: a real, deterministic way for the model to end the round loop
      // short of full round-budget exhaustion — see `continuationRoundClaimsDone`'s
      // own doc comment for why this (rather than flow-status/`slateSession.opened`)
      // is the actual fix. Never closes/archives the slate itself; it only stops
      // THIS loop early so T10's verifier pass (below, unconditional) is reached
      // sooner, with the remaining `roundsLeft` budget still available to it.
      if (continuationRoundClaimsDone(history)) {
        systemLine(
          io,
          `/goal --auto: model signaled this round's work is complete (round ${round}/${roundsCap + 1}) — ` +
            `ending the round budget early; the verifier will confirm.\n`,
        );
        break;
      }
    }

    // T10 (AC4): one verifier pass before the loop finally stops. This
    // never gates or reverses whatever `closeSlateOnFlowDone` already did
    // above (AC8 — the same close/wrap-up path, untouched) — it is a
    // post-hoc check on the OUTCOME, with at most one extra "second
    // chance" round (plan step 5's own wording: "run one more round", not
    // "keep looping until the verifier is satisfied" — an unresolvable
    // disagreement between the verifier and the course tracker must still
    // terminate, not spin).
    const wasOpenBeforeVerifier = slateSession.opened;
    const verdict = await runGoalVerifier(deps, parsed.text, cwd, slateSession, history, io, mintAttemptId);
    // #389: every outcome — achieved, not achieved, unavailable — is now
    // observable, not only the "not achieved" branch. "Unavailable" covers
    // every reason `runGoalVerifier` returns `undefined` (no `spawn_subagent`
    // tool wired in, the dispatch itself errored, or the child's summary did
    // not parse as a verdict) — all mean the same thing to the caller: the
    // outcome was never independently checked.
    if (verdict === undefined) {
      systemLine(io, "/goal --auto: verifier unavailable — outcome not independently checked.\n");
    } else if (verdict.achieved) {
      systemLine(io, "/goal --auto: verifier confirmed the goal is achieved.\n");
    } else {
      systemLine(
        io,
        `/goal --auto: verifier found the goal not fully achieved${
          verdict.gaps.length > 0 ? ` — ${verdict.gaps.join("; ")}` : " (no specific gaps reported)"
        }\n`,
      );
      if (roundsLeft > 0) {
        let reopenOk = true;
        if (!wasOpenBeforeVerifier) {
          // The course was done and closeSlateOnFlowDone already archived
          // the slate + dispatched wrap-up (AC8, unchanged). Reopen for one
          // more round, mirroring the initial-open Anchors-inject pattern
          // above exactly, and rebind the SAME flow/workspace this attempt
          // was already bound to (`boundFlowRef`/`boundWorkspaceId`,
          // snapshotted at arm time) — never re-provisioning a new flow.
          //
          // Review finding BOSS-002: guarded, matching this file's own
          // "Review finding 3" rationale on the initial open a few dozen
          // lines above — a bare `void (async () => { await
          // runGoalCommand(...) })()` in `tui-shell.ts` has no `.catch`, so
          // an unhandled rejection here (a corrupted `slate.json`, `EACCES`,
          // or a second process archiving this session's slate between
          // `ensureSlateOpened` and the `writeSlate` rebind — all real,
          // already-documented possibilities elsewhere in this file) would
          // crash/hang the TUI. Degrade the same way: skip the extra round
          // rather than risk propagating an uncaught rejection.
          try {
            await ensureSlateOpened(slateSession, mintAttemptId, { provider: deps.providerId, model: deps.modelId });
            const reopened = await readSlate(slateSession.dir);
            if (reopened !== undefined) {
              history.push({ role: "user", content: renderAnchorsBlock(reopened.anchors), provenance: "project" });
              io.onHistoryChange?.("tool");
            }
            await writeSlate(slateSession.dir, (prev) => {
              if (!prev) throw new Error(`SLATE-27 verifier-reopen: no open slate in ${slateSession.dir}`);
              return {
                ...prev,
                course: { ...prev.course, ...(boundFlowRef !== undefined ? { flowRef: boundFlowRef } : {}) },
                ...(boundWorkspaceId !== undefined ? { workspaceId: boundWorkspaceId } : {}),
              };
            });
          } catch (err) {
            reopenOk = false;
            systemLine(
              io,
              `/goal --auto: could not reopen the slate for one more round (ignored): ${err instanceof Error ? err.message : String(err)}\n`,
            );
          }
        }
        if (!reopenOk) {
          return;
        }
        roundsLeft -= 1;
        round += 1;
        const continuationText = await buildContinuationMessage(cwd, slateSession, round, roundsCap);
        systemLine(io, `/goal --auto: round ${round}/${roundsCap + 1} — one more round after the verifier found gaps.\n`);
        await runAgentTurn(io, deps, history, continuationText, turnOptions);
      }
    }
  }
}
