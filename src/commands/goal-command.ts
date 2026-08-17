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

import type { AgentDeps, AgentIO } from "./agent";
import { runAgentTurn } from "./agent";
import type { NormalizedMessage } from "../harness/provider/types";
import { ensureSlateOpened, type SlateSessionRef } from "../session/slate-lifecycle";
import { readSlate, renderAnchorsBlock, writeSlate, type Slate } from "../session/slate";
import { resolveWorkspaceForActor } from "../sac/workspace-service";
import { resolveOrCreateWorkspace, type ResolveOrCreateResult } from "../sac/workspace-resolve";

/** `/goal <text> [--workspace <id>]`, successfully parsed. */
export interface ParsedGoalArgs {
  text: string;
  workspaceId?: string;
}

/** `/goal` args failed to parse (empty text, or a value-less `--workspace`). */
export interface GoalArgsError {
  error: string;
}

/**
 * Pure parse of the text after the `/goal` token. `--workspace <id>` is only
 * recognized when it TRAILS the input — the last two whitespace-separated
 * tokens of `rest` are `--workspace <id>` — and is stripped from the
 * returned `text`, which otherwise preserves word order. Both an
 * empty/whitespace-only `rest` and a trailing `--workspace` with no
 * following value are errors — a goal always needs real text, and a
 * dangling flag is a caller mistake worth surfacing explicitly rather than
 * silently ignoring.
 *
 * Review finding 5: this used to locate `--workspace` via `tokens.indexOf`
 * — an exact-token (not substring) match, but at ANY position in `rest` —
 * so an ordinary goal that merely happened to contain the literal token
 * `--workspace` mid-sentence (e.g. "/goal document how --workspace flag
 * works") silently had the FOLLOWING WORD ("flag") swallowed as a
 * `workspaceId` and stripped from the text actually sent to the model —
 * genuine corruption of ordinary goal text, not just an edge case. There is
 * no content-based way to tell "the caller typed a real flag" apart from
 * "the goal text's prose happens to contain this token" without an
 * escape/quoting convention this CLI does not have — the position of
 * `--workspace w-42`/`--workspace flag` relative to the rest of the
 * sentence is structurally IDENTICAL in both cases. The safe, CLI-
 * conventional resolution adopted here: `--workspace <id>` is recognized
 * ONLY when it trails the input, matching how a trailing flag+value pair
 * works in ordinary CLI usage — never leading or embedded mid-sentence.
 * This is a deliberate, documented narrowing of the previous "anywhere in
 * `rest`" contract (see `goal-command.test.ts`'s own updated tests for the
 * before/after behavior this replaces).
 */
export function parseGoalArgs(rest: string): ParsedGoalArgs | GoalArgsError {
  const trimmed = rest.trim();
  if (trimmed.length === 0) {
    return { error: "a goal <text> is required, e.g. /goal implement the login flow [--workspace <id>]" };
  }
  const tokens = trimmed.split(/\s+/);
  const lastToken = tokens[tokens.length - 1];
  const secondLastToken = tokens[tokens.length - 2];

  let workspaceId: string | undefined;
  let textTokens = tokens;
  if (lastToken === "--workspace") {
    // A dangling trailing flag with nothing after it — an explicit error,
    // never silently treated as "no --workspace given".
    return { error: "--workspace requires a value, e.g. /goal <text> --workspace <id>" };
  }
  if (secondLastToken === "--workspace") {
    workspaceId = lastToken;
    textTokens = tokens.slice(0, tokens.length - 2);
  }

  const text = textTokens.join(" ").trim();
  if (text.length === 0) {
    return { error: "a goal <text> is required, e.g. /goal implement the login flow [--workspace <id>]" };
  }
  return workspaceId !== undefined ? { text, workspaceId } : { text };
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

/**
 * Run `/goal`'s full sequence: parse → (if `--workspace` was given) validate
 * it FIRST via `resolveWorkspaceForActor` — fail-closed, no slate opened, no
 * turn run on rejection (AC1) → open the slate (bypassing `isActionRequest`'s
 * heuristic; `/goal` IS the deterministic alternative) → bind
 * `slate.workspaceId`: an explicit, validated `--workspace` always wins
 * (AC2, v1 behavior, unchanged); when `--workspace` was omitted, SLATE-16's
 * resolve-or-create now runs instead (supersedes v1's "leave unset") and
 * only when this slate has no workspaceId bound yet — a `/goal` reusing an
 * already-bound slate mid-session is never re-resolved (AC-25) → run the
 * turn with the parsed text.
 */
export async function runGoalCommand(params: RunGoalCommandParams): Promise<void> {
  const { raw, cwd, io, deps, history, slateSession, mintAttemptId, resolveWorkspace } = params;
  const parsed = parseGoalArgs(raw);
  if ("error" in parsed) {
    systemLine(io, `/goal: ${parsed.error}\n`);
    return;
  }

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
    } catch (err) {
      systemLine(io, `/goal: slate bookkeeping failed (ignored): ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  // Review finding: `/goal` already opened the slate (and bound workspaceId)
  // above, deterministically — `runAgentTurn`'s own heuristic close-phrase
  // check must not re-examine the same `parsed.text` and immediately undo
  // that open/bind whenever the goal text happens to contain a close-phrase
  // substring (e.g. "wrap up documentation").
  await runAgentTurn(io, deps, history, parsed.text, slateSession !== undefined ? { slateSession, skipCloseTrigger: true } : {});
}
