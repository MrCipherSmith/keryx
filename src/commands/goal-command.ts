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
import { writeSlate, type Slate } from "../session/slate";
import { resolveWorkspaceForActor } from "../sac/workspace-service";

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
 * Pure parse of the text after the `/goal` token. `--workspace <id>` may
 * appear anywhere in `rest` (before, after, or amid the goal text) and is
 * stripped from the returned `text`, which otherwise preserves word order.
 * Both an empty/whitespace-only `rest` and a `--workspace` with no following
 * value are errors — a goal always needs real text, and a dangling flag is a
 * caller mistake worth surfacing explicitly rather than silently ignoring.
 */
export function parseGoalArgs(rest: string): ParsedGoalArgs | GoalArgsError {
  const trimmed = rest.trim();
  if (trimmed.length === 0) {
    return { error: "a goal <text> is required, e.g. /goal implement the login flow [--workspace <id>]" };
  }
  const tokens = trimmed.split(/\s+/);
  const workspaceIdx = tokens.indexOf("--workspace");
  let workspaceId: string | undefined;
  let textTokens: string[];
  if (workspaceIdx === -1) {
    textTokens = tokens;
  } else {
    const value = tokens[workspaceIdx + 1];
    if (value === undefined) {
      return { error: "--workspace requires a value, e.g. /goal <text> --workspace <id>" };
    }
    workspaceId = value;
    textTokens = [...tokens.slice(0, workspaceIdx), ...tokens.slice(workspaceIdx + 2)];
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
 * heuristic; `/goal` IS the deterministic alternative) → (only if a validated
 * `--workspace` was given) bind `slate.workspaceId` (never auto-created,
 * never guessed — AC2) → run the turn with the parsed text.
 */
export async function runGoalCommand(params: RunGoalCommandParams): Promise<void> {
  const { raw, cwd, io, deps, history, slateSession, mintAttemptId } = params;
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
    await ensureSlateOpened(slateSession, mintAttemptId, { provider: deps.providerId, model: deps.modelId });
    if (parsed.workspaceId !== undefined) {
      const workspaceId = parsed.workspaceId;
      await writeSlate(slateSession.dir, (prev) => {
        const base: Slate = prev ?? { anchors: { root: "", touched: [] }, course: {}, seeds: [] };
        return { ...base, workspaceId };
      });
    }
  }

  await runAgentTurn(io, deps, history, parsed.text, slateSession !== undefined ? { slateSession } : {});
}
