// Terminal counterparts of the flow-457 operator cards, and `verify-run` (flow 457, T7).
//
//   keryx review waive-mutation      --package <dir> --reason "<why>"     (TTY; card: review_waive_mutation)
//   keryx review override-reviewers  --package <dir> --reason "<why>"     (TTY; card: review_override_reviewers)
//   keryx review confirm-plan        --package <dir>                      (TTY; card: review_confirm_plan)
//   keryx review decide-premise      --package <dir> --finding <id> --answer uphold|dismiss --reason "<why>"  (TTY; card: review_decide_premise)
//   keryx review verify-run          --package <dir> --finding <id> [--timeout <s>] -- <command…>
//
// The first four record the operator's own decision, so each asks at the terminal and refuses when stdin or stdout
// is not a TTY: an agent's shell cannot answer for the operator. verify-run only runs a command and saves its output.
//
// Flow 467: the same four also take the operator's answer to a question the HOST asked through its own tool (Claude Code,
// Codex, keryx shell, a Telegram poll), with no TTY:
//
//   keryx review <verb> ... --answered-by <source>:<ref> --answer-text "<the operator's words>" --question-text "<the question as asked>"
//
// The record says `confirmedVia: "host-question"` with the source, the ref, both texts and the time. keryx cannot see the
// host's question: it records what the agent reports, and says so in the record, the review report and `keryx decisions`.
// An unattended run and a nested keryx (`KERYX_TOOL_CALL=1`) refuse the flag; `review complete` does not take it at all.

import { createInterface } from "node:readline/promises";
import { DECISION_SOURCES, answerDecision, openDecision } from "../decisions/service";
import { optionValue } from "../lib/args";
import { operatorDecisionSubject } from "../review/coverage";
import { recordOperatorDecision, type OperatorDecisionKind } from "../review/operator-decisions";
import { estimatePlan, recordPlanConfirmation } from "../review/plan-confirmation";
import { answerPremiseQuestion, findHeldFinding } from "../review/premise-question";
import { isAutonomousEnv, readRunProfile } from "../review/run-profile";
import { HOST_QUESTION_SOURCES, type HostQuestion } from "../review/types";
import { verifyRun } from "../review/verify-run";
import { cardSafe } from "../lib/card-safe";
import { resolvePackageDir } from "./review-layers";

export const OPERATOR_COMMANDS = ["waive-mutation", "override-reviewers", "confirm-plan", "decide-premise", "verify-run"] as const;
export type OperatorCommand = (typeof OPERATOR_COMMANDS)[number];

export type OperatorCommandSeams = {
  isTerminal?: () => boolean;
  /** The operator's answer to the question; default reads a line from the terminal. */
  ask?: (question: string) => Promise<string>;
  cwd?: string;
  log?: (line: string) => void;
  /** The process environment, for the host-question refusals (default `process.env`). */
  env?: Readonly<Record<string, string | undefined>>;
};

const CARD: Record<Exclude<OperatorCommand, "verify-run">, string> = {
  "waive-mutation": "review_waive_mutation",
  "override-reviewers": "review_override_reviewers",
  "confirm-plan": "review_confirm_plan",
  "decide-premise": "review_decide_premise",
};

export function printOperatorCommandHelp(command: OperatorCommand): void {
  const lines: Record<OperatorCommand, string> = {
    "waive-mutation": `keryx review waive-mutation --package <review-dir> --reason "<why>"

Records the operator's waiver of the mutation pass in <review-dir>/operator-decisions.json: the review may
record \`Not run: mutation pass\` with unrun mutants. Asks at the terminal; refused without a TTY. In keryx
shell the review_waive_mutation tool asks the same as a card.

Without a TTY, record the operator's answer to a question you asked through the host's own question tool:
  keryx review waive-mutation --package <review-dir> --reason "<why>" --answered-by <source>:<ref> \\
    --answer-text "<the operator's words>" --question-text "<the question as asked>"
<source> is claude-code, codex, keryx-shell, helyx-poll or other; <ref> is the host's own id for the question (a poll
or message id). The record says confirmedVia host-question with both texts, and \`keryx decisions\` keeps the question.
keryx cannot see the question: it records what you report. Refused, with nothing recorded, for a decline (n, no, an
empty answer), a blank text, a missing --reason, in an unattended run and under KERYX_TOOL_CALL=1.`,
    "override-reviewers": `keryx review override-reviewers --package <review-dir> --reason "<why>" [--selected a,b]

Records the operator's decision to run a smaller reviewer set than \`keryx review required\` names (an
override or mode diff) in <review-dir>/operator-decisions.json. Asks at the terminal; refused without a TTY.
In keryx shell the review_override_reviewers tool asks the same as a card.

Without a TTY, record the operator's answer to a question you asked through the host's own question tool:
  keryx review override-reviewers --package <review-dir> --reason "<why>" [--selected a,b] --answered-by <source>:<ref> \\
    --answer-text "<the operator's words>" --question-text "<the question as asked>"
<source> is claude-code, codex, keryx-shell, helyx-poll or other; <ref> is the host's own id for the question. The
record says confirmedVia host-question; keryx cannot see the question, it records what you report. Refused, with
nothing recorded, for a decline (n, no, an empty answer), a blank text, a missing --reason, in an unattended run and
under KERYX_TOOL_CALL=1.`,
    "confirm-plan": `keryx review confirm-plan --package <review-dir>

Shows the plan's dispatches and minutes (\`keryx review estimate\`) and records the operator's yes in
<review-dir>/plan-confirmation.json for exactly this plan. Asks at the terminal; refused without a TTY. In
keryx shell the review_confirm_plan tool asks the same as a card.

Without a TTY, record the operator's answer to a question you asked through the host's own question tool:
  keryx review confirm-plan --package <review-dir> --answered-by <source>:<ref> \\
    --answer-text "<the operator's words>" --question-text "<the question as asked>"
The question must show this plan's dispatches and minutes (as \`keryx review estimate\` prints them): a question that
does not is refused as a stale plan, so ask again with the current numbers. <source> is claude-code, codex,
keryx-shell, helyx-poll or other; <ref> is the host's own id for the question. The record says confirmedVia
host-question; keryx cannot see the question, it records what you report. Refused, with nothing recorded, for a
decline (n, no, an empty answer), a blank text, in an unattended run and under KERYX_TOOL_CALL=1.`,
    "decide-premise": `keryx review decide-premise --package <review-dir> --finding <id> --answer uphold|dismiss --reason "<why>"

Answers the premise question on a finding the premise judge held (verdict challenged or owner-decision) and
records it in <review-dir>/operator-decisions.json, with your typed words, and on the finding in findings.json
(so the next round and the published round block read the answer too). uphold returns the finding to kept at its original
severity; dismiss records it dismissed-incorrect with your reason as the evidence. Refused for an unknown
finding, a finding that is not held, or a missing reason. Asks at the terminal; refused without a TTY. In
keryx shell the review_decide_premise tool asks the same as a card.

Without a TTY, record the operator's answer to a question you asked through the host's own question tool:
  keryx review decide-premise --package <review-dir> --finding <id> --answer uphold|dismiss --reason "<why>" \\
    --answered-by <source>:<ref> --answer-text "<the operator's words>" --question-text "<the question as asked>"
<source> is claude-code, codex, keryx-shell, helyx-poll or other; <ref> is the host's own id for the question (a poll
or message id). The operator's words must name the same choice as --answer (uphold or dismiss, or the same in
Russian) and no other. The record says confirmedVia host-question with both texts, the finding changes as on the
terminal path, and \`keryx decisions\` keeps the question. keryx cannot see the question: it records what you report.
Refused, with nothing recorded, for a decline (n, no, an empty answer), words that name the other choice or none, a
blank text, a missing --reason, an unknown or not-held finding, in an unattended run and under KERYX_TOOL_CALL=1.`,
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

  // Flow 467: the host asked the operator; the agent records the answer. No terminal, no ask: a different path with its own refusals.
  if (own.some((arg) => arg === "--answered-by" || arg.startsWith("--answered-by="))) {
    return recordHostQuestion(command, own, packageDir, { cwd, log, env: seams.env ?? process.env });
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

  if (command === "decide-premise") {
    const ref = optionValue(own, "--finding");
    if (ref === undefined || ref.trim() === "") throw new Error("Missing --finding <id>. See `keryx review decide-premise --help`.");
    const answerArg = optionValue(own, "--answer");
    if (answerArg !== "uphold" && answerArg !== "dismiss") throw new Error("--answer must be uphold or dismiss. See `keryx review decide-premise --help`.");
    const held = await findHeldFinding(packageDir, ref);
    if (!held.ok) throw new Error(held.refusal);
    const finding = held.finding;
    // The finding's problem and the judge's question are model-written: cleaned as the card cleans them, so neither can
    // draw a line of its own into the prompt, and the effect is printed last where nothing after it can overwrite it.
    const effect = answerArg === "uphold" ? `keep it at ${cardSafe(finding.severity)}` : "dismiss it as incorrect";
    const question =
      `Premise question on ${cardSafe(finding.key)} (${cardSafe(finding.severity)}: ${cardSafe(finding.problem)}; judge ${cardSafe(finding.verdict)}: ${cardSafe(finding.question)})` +
      `${finding.answered === undefined ? "" : `; already answered ${finding.answered}, this answer replaces it`}; reason: ${cardSafe(reason.trim())}. Answer: ${effect}?`;
    const answer = (await ask(`${question} Type your own words to confirm, or nothing to decline: `)).trim();
    if (answer === "" || /^n(o)?$/i.test(answer)) {
      log("not confirmed; nothing was recorded");
      return 1;
    }
    await answerPremiseQuestion(packageDir, { finding, answer: answerArg, reason: reason.trim(), quote: answer, at, confirmedVia: "terminal" }, { cwd, warn: (line) => log(`warning: ${line}`) });
    log(`premise-question ${answerArg} recorded for ${finding.key} (terminal, ${at}) in operator-decisions.json and findings.json`);
    return 0;
  }
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

// ---------------------------------------------------------------------------------------------------------------------
// Flow 467: a question the host asked, answered by the operator in the host's own tool, recorded by the agent.
// ---------------------------------------------------------------------------------------------------------------------

type HostVerb = Exclude<OperatorCommand, "verify-run">;

/** The options of the question each verb records: the one that records the decision, the one that declines it. */
const HOST_OPTIONS: Record<HostVerb, { confirm: string; decline: string; options: Array<{ id: string; label: string }> }> = {
  "decide-premise": {
    confirm: "uphold",
    decline: "dismiss",
    options: [
      { id: "uphold", label: "Uphold: the finding stands at its original severity" },
      { id: "dismiss", label: "Dismiss: the finding is incorrect" },
    ],
  },
  "confirm-plan": {
    confirm: "yes",
    decline: "no",
    options: [
      { id: "yes", label: "Yes: run the plan as estimated" },
      { id: "no", label: "No: do not run it" },
    ],
  },
  "waive-mutation": {
    confirm: "waive",
    decline: "keep",
    options: [
      { id: "waive", label: "Waive: the mutation pass is not run" },
      { id: "keep", label: "Keep: run the mutation pass" },
    ],
  },
  "override-reviewers": {
    confirm: "override",
    decline: "keep",
    options: [
      { id: "override", label: "Override: run the smaller reviewer set" },
      { id: "keep", label: "Keep: run the required reviewers" },
    ],
  },
};

/** Words that open a refusal. An answer that starts with one declines: nothing is recorded. */
const LEAD_DECLINE = new Set(["n", "no", "nope", "nah", "not", "never", "cancel", "stop", "decline", "declined", "reject", "нет", "не", "отмена"]);

/** What decide-premise's operator words must say. A word of the other choice, or none of this one, refuses. */
const CHOICE_WORDS: Record<"uphold" | "dismiss", ReadonlySet<string>> = {
  uphold: new Set(["uphold", "upheld", "upholds", "keep", "kept", "оставить", "оставляем", "оставляю", "подтвердить", "подтверждаю", "поддержать"]),
  dismiss: new Set(["dismiss", "dismissed", "dismisses", "drop", "dropped", "отклонить", "отклоняю", "отклоняем", "снять", "закрыть"]),
};
const NEGATIONS = new Set(["not", "never", "no", "dont", "don", "t", "nt", "не", "нет"]);

const wordsOf = (text: string): string[] => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word !== "");

/** The `--answered-by` value as `<source>:<ref>`, split on the first colon (a ref may hold colons: a poll id plus a message id). */
function parseAnsweredBy(raw: string | undefined, command: HostVerb): Pick<HostQuestion, "source" | "ref"> {
  const refuse = (): never => {
    throw new Error(
      `--answered-by must be <source>:<ref>: <source> one of ${HOST_QUESTION_SOURCES.join(", ")} and <ref> the host's own id for the question, not empty` +
        `${raw === undefined ? " (the flag has no value)" : ` (got ${JSON.stringify(raw.slice(0, 80))})`}. See \`keryx review ${command} --help\`.`,
    );
  };
  if (raw === undefined) return refuse();
  const colon = raw.indexOf(":");
  const source = colon <= 0 ? "" : raw.slice(0, colon);
  const ref = colon <= 0 ? "" : raw.slice(colon + 1).trim();
  if (!(HOST_QUESTION_SOURCES as readonly string[]).includes(source) || ref === "") return refuse();
  return { source: source as HostQuestion["source"], ref };
}

/** The operator's words refuse when they decline (an empty answer, n, no, nope, ...). The message names the refusal. */
function refuseDecline(answerText: string, verb: HostVerb): void {
  const words = wordsOf(answerText);
  if (words.length === 0 || LEAD_DECLINE.has(words[0] as string)) {
    throw new Error(`--answer-text reads as a decline (${JSON.stringify(answerText.trim().slice(0, 80))}): a declined question records nothing. Ask again if the operator meant yes. See \`keryx review ${verb} --help\`.`);
  }
}

/** decide-premise: the words must name the chosen option and not the other one, and not behind a negation. */
function refuseOtherChoice(answerText: string, answer: "uphold" | "dismiss"): void {
  const words = wordsOf(answerText);
  const other = answer === "uphold" ? "dismiss" : "uphold";
  const chosen = CHOICE_WORDS[answer];
  const named = words.some((word) => chosen.has(word));
  const namesOther = words.some((word) => CHOICE_WORDS[other].has(word));
  const negated = words.some((word, index) => (chosen.has(word) || CHOICE_WORDS[other].has(word)) && NEGATIONS.has(words[index - 1] ?? ""));
  if (!named || namesOther || negated) {
    throw new Error(
      `--answer-text does not name the same choice as --answer ${answer}: the operator's words must say ${answer} (and not ${other}, and not behind a "not"). ` +
        `Nothing was recorded; ask the operator again, or pass the --answer they gave.`,
    );
  }
}

function requireText(flag: "--answer-text" | "--question-text", value: string | undefined, command: HostVerb): string {
  if (value === undefined || value.trim() === "") throw new Error(`${flag} "<text>" is required and must not be blank: it holds ${flag === "--answer-text" ? "the operator's own words" : "the question as it was asked"}. See \`keryx review ${command} --help\`.`);
  return value;
}

/** An unattended run, and a keryx started from an agent's shell, have no operator to have asked: the flag is refused for both. */
function refuseHostQuestionHere(command: HostVerb, packageDir: string, env: Readonly<Record<string, string | undefined>>): void {
  if (env["KERYX_TOOL_CALL"] === "1") {
    throw new Error(
      `keryx review ${command} --answered-by is refused: this keryx was started from an agent's shell (KERYX_TOOL_CALL=1), and an agent can type into it. ` +
        `Nothing was recorded. The operator answers the ${CARD[command]} card instead.`,
    );
  }
  if (isAutonomousEnv(env) || readRunProfile(packageDir)?.mode === "unattended") {
    throw new Error(`keryx review ${command} --answered-by is refused in an unattended run: nobody is there to be asked, so nothing was recorded.`);
  }
}

async function recordHostQuestion(
  command: HostVerb,
  own: string[],
  packageDir: string,
  context: { cwd: string; log: (line: string) => void; env: Readonly<Record<string, string | undefined>> },
): Promise<number> {
  const { cwd, log, env } = context;
  refuseHostQuestionHere(command, packageDir, env);
  const by = parseAnsweredBy(optionValue(own, "--answered-by"), command);
  const answerText = requireText("--answer-text", optionValue(own, "--answer-text"), command);
  const questionText = requireText("--question-text", optionValue(own, "--question-text"), command);
  const choices = HOST_OPTIONS[command];
  const answerArg = optionValue(own, "--answer");
  // Everything below refuses before the first write; the writes come last, in one run of statements.
  let premiseAnswer: "uphold" | "dismiss" | undefined;
  if (command === "decide-premise") {
    if (answerArg !== "uphold" && answerArg !== "dismiss") throw new Error("--answer must be uphold or dismiss. See `keryx review decide-premise --help`.");
    premiseAnswer = answerArg;
  } else if (answerArg !== undefined && answerArg !== choices.confirm) {
    throw new Error(
      answerArg === choices.decline
        ? `--answer ${answerArg} is a decline: a declined question records nothing. See \`keryx review ${command} --help\`.`
        : `--answer must be ${choices.confirm} (the option this verb records) or left out; got ${JSON.stringify(answerArg.slice(0, 40))}. See \`keryx review ${command} --help\`.`,
    );
  }
  const at = new Date().toISOString();
  const hostQuestion: HostQuestion = { source: by.source, ref: by.ref, questionText, answerText, time: at };
  const where = `host-question, ${by.source}:${by.ref}`;

  const reason = optionValue(own, "--reason");
  if (command !== "confirm-plan" && (reason === undefined || reason.trim() === "")) throw new Error(`Missing --reason "<why>". See \`keryx review ${command} --help\`.`);

  let recorded: () => Promise<string>;
  if (command === "confirm-plan") {
    const estimate = await estimatePlan(packageDir);
    const shown = new Set(questionText.match(/\d+/g) ?? []);
    if (![estimate.dispatches, estimate.minutes.min, estimate.minutes.max].every((value) => shown.has(String(value)))) {
      throw new Error(
        `The plan changed, or the question does not show it: the plan now is ${estimate.dispatches} reviewer dispatches (${estimate.minutes.min}-${estimate.minutes.max} min) ` +
          `and --question-text names other numbers. Ask the operator again with the current numbers in the question. Nothing was recorded.`,
      );
    }
    refuseDecline(answerText, command);
    recorded = async () => {
      const record = await recordPlanConfirmation(packageDir, estimate, { quote: `${questionText}: ${answerText}`, confirmedVia: "host-question", at, hostQuestion });
      return `plan confirmed (${where}): ${record.dispatches} dispatch(es), ${record.minutes[0]}-${record.minutes[1]} min`;
    };
  } else if (command === "decide-premise") {
    const ref = optionValue(own, "--finding");
    if (ref === undefined || ref.trim() === "") throw new Error("Missing --finding <id>. See `keryx review decide-premise --help`.");
    const held = await findHeldFinding(packageDir, ref);
    if (!held.ok) throw new Error(held.refusal);
    refuseDecline(answerText, command);
    refuseOtherChoice(answerText, premiseAnswer as "uphold" | "dismiss");
    const finding = held.finding;
    recorded = async () => {
      await answerPremiseQuestion(
        packageDir,
        { finding, answer: premiseAnswer as "uphold" | "dismiss", reason: (reason as string).trim(), quote: answerText, at, confirmedVia: "host-question", hostQuestion },
        { cwd, warn: (line) => log(`warning: ${line}`) },
      );
      return `premise-question ${premiseAnswer} recorded for ${finding.key} (${where}, ${at}) in operator-decisions.json and findings.json`;
    };
  } else {
    const kind: OperatorDecisionKind = command === "waive-mutation" ? "mutation-waiver" : "reviewer-override";
    const selectedArg = optionValue(own, "--selected");
    const selected = selectedArg === undefined ? undefined : selectedArg.split(",").map((item) => item.trim()).filter(Boolean);
    const subject = await operatorDecisionSubject(packageDir, kind, kind === "mutation-waiver" ? undefined : selected);
    refuseDecline(answerText, command);
    recorded = async () => {
      await recordOperatorDecision(packageDir, { kind, quote: answerText, reason: (reason as string).trim(), confirmedVia: "host-question", at, subject, hostQuestion });
      return `${kind} recorded (${where}, ${at}) in operator-decisions.json`;
    };
  }

  const line = await recorded();
  log(line);
  // The keryx decisions journal keeps the question beside the others. The review record is already written: a journal that
  // cannot be written is a warning, not a reason to leave the operator's answer unrecorded or to record it twice on a retry.
  try {
    const opened = await openDecision({
      cwd,
      question: questionText,
      options: choices.options,
      stage: `review ${command}`,
      channel: by.source,
      source: DECISION_SOURCES.hostQuestion,
      hostQuestion: { source: by.source, ref: by.ref, verb: command, answerText },
      salt: "host-question",
    });
    await answerDecision({ cwd, id: opened.id, choice: premiseAnswer ?? choices.confirm });
  } catch (error) {
    log(`warning: the answer is recorded, but the keryx decisions journal was not updated (${error instanceof Error ? error.message : String(error)})`);
  }
  return 0;
}
