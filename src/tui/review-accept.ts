// Runs the two shell commands `keryx workspace confirm-review` and
// `keryx workspace review --decision accepted` need to accept a proposal from
// the /review modal's own [a]-then-[y] confirm — never through the
// model/tool-calling loop and never by calling proposal-lifecycle.ts's
// `review()` in process. `interactive: true` there is documented as honored
// from exactly two real call sites, `src/commands/workspace.ts`'s `review`
// handler and `src/mcp/tools.ts`'s `sac.review` handler (SLATE-20's own doc
// comment in proposal-lifecycle.ts) — a third, in-process call site from this
// TUI would widen that trust boundary. Running the real CLI as two literal
// shell commands keeps this on the same two boundaries, and the human
// keying [a] then [y] inside the modal is the SLATE-20 confirm-token's
// human-presence proof, exactly like a human typing both commands at a
// terminal would be.

import type { CommandRunner } from "../harness/tool/builtin/shell-exec-tool";

export type AcceptProposalOutcome = { ok: true } | { ok: false; message: string };

/** POSIX single-quote escaping — every value interpolated into the two
 * commands below goes through this, even though `workspaceId`/`proposalId`
 * are machine-generated ids and the token is `mintConfirmToken`'s own output:
 * trusting a value's expected shape instead of quoting it is exactly the
 * class of bug `command-risk.ts`'s `hasUnquotedMetacharacter` exists to
 * catch on the other side of this same boundary. */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Mints a confirm token via `keryx workspace confirm-review`, then spends it
 * via `keryx workspace review --decision accepted --confirm-token <token>`.
 * Never throws — a failure at either step is reported in the outcome, not a
 * rejected promise, so a caller painting modal state never needs a try/catch.
 */
export async function acceptProposalViaShell(
  run: CommandRunner,
  workspaceId: string,
  proposalId: string,
): Promise<AcceptProposalOutcome> {
  const mint = await run(`keryx workspace confirm-review ${shQuote(workspaceId)} ${shQuote(proposalId)}`);
  if (mint.isError) {
    return { ok: false, message: mint.output };
  }
  let token: string;
  try {
    const parsed: unknown = JSON.parse(mint.output);
    const candidate = (parsed as { token?: unknown } | null)?.token;
    if (typeof candidate !== "string" || candidate.length === 0) {
      throw new Error("no token in confirm-review output");
    }
    token = candidate;
  } catch (cause) {
    return {
      ok: false,
      message: `could not parse \`keryx workspace confirm-review\` output: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
  const accept = await run(
    `keryx workspace review ${shQuote(workspaceId)} ${shQuote(proposalId)} --decision accepted --confirm-token ${shQuote(token)}`,
  );
  if (accept.isError) {
    return { ok: false, message: accept.output };
  }
  return { ok: true };
}

/**
 * Declines a proposal via `keryx workspace review --decision rejected`.
 * Unlike accept, this never writes to any owning subsystem (wiki/memory/
 * skill) — proposal-lifecycle.ts's `review()` only demands a confirm token
 * when `decision === "accepted"` (its own SLATE-20 comment: the token gate
 * exists because ACCEPTING is the consequential action a caller with only
 * tool access must not be able to do alone). So one shell command is the
 * whole flow here, not `acceptProposalViaShell`'s two.
 */
export async function declineProposalViaShell(
  run: CommandRunner,
  workspaceId: string,
  proposalId: string,
): Promise<AcceptProposalOutcome> {
  const decline = await run(
    `keryx workspace review ${shQuote(workspaceId)} ${shQuote(proposalId)} --decision rejected`,
  );
  if (decline.isError) {
    return { ok: false, message: decline.output };
  }
  return { ok: true };
}
