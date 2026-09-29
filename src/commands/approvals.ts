// `keryx approvals list|allow|deny <id>` (flow 369 / R4d): the local answer path
// over the store `keryx serve` writes. ADAPTER: it reads and writes the store
// directly, so it needs no running server and a second process can answer what a
// waiting turn is blocked on.
//
// An answer given here is exactly as narrow as one given over HTTP: this one call,
// once, bound to the fingerprint on the record. It never grants a session trust.

import { approvalsText, splitApprovals } from "../lib/serve-approvals-format";
import { answerApproval, listApprovals, toPublicApproval } from "../lib/serve-approvals-store";

export const LOCAL_ANSWERER = "local-cli";

function printApprovalsHelp(): void {
  console.log(
    [
      "Usage: keryx approvals <subcommand>",
      "",
      "  keryx approvals list [--all] [--json]",
      "                              Pending approvals (summary, scope, consequence, expiry).",
      "                              --all adds the recently resolved ones.",
      "  keryx approvals allow <id>  Allow the one call this approval was raised for, once.",
      "  keryx approvals deny <id>   Deny it.",
      "",
      "An answer never grants a session-wide trust and never lifts a destructive,",
      "credential or publish floor: the next identical call asks again.",
    ].join("\n"),
  );
}

function runList(args: readonly string[]): void {
  const unknown = args.filter((arg) => arg !== "--all" && arg !== "--json");
  if (unknown.length > 0) {
    throw new Error(`Unknown option${unknown.length > 1 ? "s" : ""} for \`keryx approvals list\`: ${unknown.join(", ")}. Accepted: --all, --json.`);
  }
  const now = new Date();
  const all = args.includes("--all");
  const views = listApprovals(undefined, { now });
  if (args.includes("--json")) {
    const shown = all ? views : views.filter((view) => view.state === "pending");
    console.log(JSON.stringify({ approvals: shown.map(toPublicApproval) }, null, 2));
    return;
  }
  console.log(approvalsText(views, now, { all }).join("\n"));
}

export interface AnswerResult {
  ok: boolean;
  text: string;
}

/** One answer, described for a person; `ok` is false when nothing was (or can be) applied. */
export function answerApprovalText(decision: "allow" | "deny", id: string): AnswerResult {
  const outcome = answerApproval(id, decision, LOCAL_ANSWERER);
  switch (outcome.kind) {
    case "not-found":
      return { ok: false, text: `No such approval: ${id}` };
    case "expired":
      return { ok: false, text: `Approval ${id} is ${outcome.view.state} (${outcome.view.reason ?? "no reason recorded"}); it can no longer be answered.` };
    case "replay":
      return { ok: true, text: `Approval ${id} was already ${outcome.view.state}; nothing changed.` };
    case "applied":
      return { ok: true, text: `Approval ${id} ${outcome.view.state}. The waiting call ${decision === "allow" ? "may run once" : "will not run"}.` };
  }
}

function runAnswer(decision: "allow" | "deny", args: readonly string[]): void {
  const [id, ...extra] = args;
  if (id === undefined || extra.length > 0 || id.startsWith("-")) {
    throw new Error(`Usage: keryx approvals ${decision} <id>`);
  }
  const result = answerApprovalText(decision, id);
  if (!result.ok) {
    throw new Error(result.text);
  }
  console.log(result.text);
}

/** The readline `/approvals [allow|deny <id>]`: the same store, the same words, as text. */
export function approvalsSlashText(rest: string, now: Date = new Date()): string {
  const [sub, id, ...extra] = rest.split(/\s+/).filter((part) => part.length > 0);
  if (sub === "allow" || sub === "deny") {
    if (id === undefined || extra.length > 0 || id.startsWith("-")) {
      return `Usage: /approvals ${sub} <id>\n`;
    }
    return `${answerApprovalText(sub, id).text}\n`;
  }
  if (sub !== undefined && sub !== "list") {
    return "Usage: /approvals [list | allow <id> | deny <id>]\n";
  }
  const views = listApprovals(undefined, { now });
  const lines = approvalsText(views, now, { all: true });
  if (splitApprovals(views, now).pending.length > 0) {
    lines.push("", "Answer with /approvals allow <id> or /approvals deny <id> (that one call, once).");
  }
  return `${lines.join("\n")}\n`;
}

export async function approvalsCommand(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  if (sub === "--help" || sub === "-h" || sub === "help") {
    printApprovalsHelp();
    return;
  }
  if (sub === undefined || sub === "list") {
    runList(rest);
    return;
  }
  if (sub === "allow" || sub === "deny") {
    runAnswer(sub, rest);
    return;
  }
  throw new Error(`Unknown approvals subcommand: ${sub}. Run \`keryx approvals --help\`.`);
}
