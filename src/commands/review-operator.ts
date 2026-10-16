// Terminal counterparts of the flow-457 operator cards, and `verify-run` (flow 457, T7).
//
//   keryx review waive-mutation      --package <dir> --reason "<why>"     (TTY; card: review_waive_mutation)
//   keryx review override-reviewers  --package <dir> --reason "<why>"     (TTY; card: review_override_reviewers)
//   keryx review confirm-plan        --package <dir>                      (TTY; card: review_confirm_plan)
//   keryx review verify-run          --package <dir> --finding <id> [--timeout <s>] -- <command…>
//
// The first three record the operator's own decision, so each asks at the terminal and refuses when stdin or stdout
// is not a TTY: an agent's shell cannot answer for the operator. verify-run only runs a command and saves its output.

import { createInterface } from "node:readline/promises";
import { optionValue } from "../lib/args";
import { operatorDecisionSubject } from "../review/coverage";
import { recordOperatorDecision, type OperatorDecisionKind } from "../review/operator-decisions";
import { estimatePlan, recordPlanConfirmation } from "../review/plan-confirmation";
import { verifyRun } from "../review/verify-run";
import { resolvePackageDir } from "./review-layers";

export const OPERATOR_COMMANDS = ["waive-mutation", "override-reviewers", "confirm-plan", "verify-run"] as const;
export type OperatorCommand = (typeof OPERATOR_COMMANDS)[number];

export type OperatorCommandSeams = {
  isTerminal?: () => boolean;
  /** The operator's answer to the question; default reads a line from the terminal. */
  ask?: (question: string) => Promise<string>;
  cwd?: string;
  log?: (line: string) => void;
};

const CARD: Record<Exclude<OperatorCommand, "verify-run">, string> = {
  "waive-mutation": "review_waive_mutation",
  "override-reviewers": "review_override_reviewers",
  "confirm-plan": "review_confirm_plan",
};

export function printOperatorCommandHelp(command: OperatorCommand): void {
  const lines: Record<OperatorCommand, string> = {
    "waive-mutation": `keryx review waive-mutation --package <review-dir> --reason "<why>"

Records the operator's waiver of the mutation pass in <review-dir>/operator-decisions.json: the review may
record \`Not run: mutation pass\` with unrun mutants. Asks at the terminal; refused without a TTY. In keryx
shell the review_waive_mutation tool asks the same as a card.`,
    "override-reviewers": `keryx review override-reviewers --package <review-dir> --reason "<why>" [--selected a,b]

Records the operator's decision to run a smaller reviewer set than \`keryx review required\` names (an
override or mode diff) in <review-dir>/operator-decisions.json. Asks at the terminal; refused without a TTY.
In keryx shell the review_override_reviewers tool asks the same as a card.`,
    "confirm-plan": `keryx review confirm-plan --package <review-dir>

Shows the plan's dispatches and minutes (\`keryx review estimate\`) and records the operator's yes in
<review-dir>/plan-confirmation.json for exactly this plan. Asks at the terminal; refused without a TTY. In
keryx shell the review_confirm_plan tool asks the same as a card.`,
    "verify-run": `keryx review verify-run --package <review-dir> --finding <id> [--timeout <seconds>] -- <command…>

Runs a verification command in this (the parent's) session and saves its stdout, stderr and exit status to
<review-dir>/research-evidence/verify-<id>-<n>.txt. Hand that file to the verifier as context; a verification
claim whose evidence cites it is recorded as executed (method execution), not reasoning. One argument after --
runs through sh -c. Default timeout 600 s.`,
  };
  console.log(lines[command]);
}

async function terminalAsk(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

function requireTerminal(command: Exclude<OperatorCommand, "verify-run">, isTerminal: () => boolean): void {
  if (isTerminal()) return;
  throw new Error(
    `keryx review ${command} records the operator's own decision and needs a terminal: refused when stdin or stdout is not a TTY. ` +
      `Inside keryx shell, call the ${CARD[command]} tool: the operator answers it as a card. Outside keryx shell, the operator runs this command in a terminal.`,
  );
}

/** Returns the exit code. */
export async function runOperatorCommand(command: OperatorCommand, args: string[], seams: OperatorCommandSeams = {}): Promise<number> {
  const log = seams.log ?? ((line: string) => console.log(line));
  if (args.includes("--help") || args.includes("-h")) {
    printOperatorCommandHelp(command);
    return 0;
  }
  const cwd = seams.cwd ?? process.cwd();
  const separator = args.indexOf("--");
  const own = separator === -1 ? args : args.slice(0, separator);
  const packageDir = resolvePackageDir(own, cwd, command);

  if (command === "verify-run") {
    const finding = optionValue(own, "--finding");
    if (finding === undefined) throw new Error("Missing --finding <id>. See `keryx review verify-run --help`.");
    const timeout = optionValue(own, "--timeout");
    const timeoutMs = timeout === undefined ? undefined : Number(timeout) * 1000;
    if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) throw new Error("--timeout must be a positive number of seconds");
    const result = await verifyRun({ packageDir, finding, argv: separator === -1 ? [] : args.slice(separator + 1), cwd, timeoutMs });
    log(`verify-run: exit ${result.exitCode}${result.timedOut ? " (timed out)" : ""}; saved to ${result.file}`);
    log("Hand that file to the verifier (context_files) and have it cite the file in the claim's evidence.");
    return 0;
  }

  const isTerminal = seams.isTerminal ?? (() => process.stdin.isTTY === true && process.stdout.isTTY === true);
  requireTerminal(command, isTerminal);
  const ask = seams.ask ?? terminalAsk;
  const at = new Date().toISOString();

  if (command === "confirm-plan") {
    const estimate = await estimatePlan(packageDir);
    const question = `Run ${estimate.dispatches} reviewer dispatches (${estimate.minutes.min}-${estimate.minutes.max} min) for ${packageDir}?`;
    const answer = (await ask(`${question} [y/N] `)).trim();
    if (!/^y(es)?$/i.test(answer)) {
      log("not confirmed; nothing was recorded");
      return 1;
    }
    const record = await recordPlanConfirmation(packageDir, estimate, { quote: `${question}: ${answer}`, confirmedVia: "terminal", at });
    log(`plan confirmed (terminal, ${record.at}): ${record.dispatches} dispatch(es), ${record.minutes[0]}-${record.minutes[1]} min`);
    return 0;
  }

  const reason = optionValue(own, "--reason");
  if (reason === undefined || reason.trim() === "") throw new Error(`Missing --reason "<why>". See \`keryx review ${command} --help\`.`);
  const kind: OperatorDecisionKind = command === "waive-mutation" ? "mutation-waiver" : "reviewer-override";
  const selectedArg = optionValue(own, "--selected");
  const selected = selectedArg === undefined ? undefined : selectedArg.split(",").map((item) => item.trim()).filter(Boolean);
  // Security review M4: the record binds to what this question shows (head, mutant ids or reviewers left out).
  const subject = await operatorDecisionSubject(packageDir, kind, kind === "mutation-waiver" ? undefined : selected);
  const shown = `head ${subject.head ?? "not recorded"}; ${kind === "mutation-waiver" ? "unrun mutants" : "reviewers left out"}: ${subject.items.join(", ") || "none"}`;
  const question = command === "waive-mutation" ? `Waive the mutation pass for ${packageDir} (${reason.trim()}; ${shown})?` : `Run a smaller reviewer set than required for ${packageDir} (${reason.trim()}; ${shown})?`;
  const answer = (await ask(`${question} Type your own words to confirm, or nothing to decline: `)).trim();
  if (answer === "" || /^n(o)?$/i.test(answer)) {
    log("not confirmed; nothing was recorded");
    return 1;
  }
  await recordOperatorDecision(packageDir, { kind, quote: answer, reason: reason.trim(), confirmedVia: "terminal", at, subject });
  log(`${kind} recorded (terminal, ${at}) in operator-decisions.json`);
  return 0;
}
