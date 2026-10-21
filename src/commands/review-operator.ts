import { formatCompletionException } from "../flow/service";
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
import { DECISION_SOURCES, MAX_OPERATOR_TEXT_LENGTH, answerDecision, openDecision, resolveFlowContext } from "../decisions/service";
import { optionValue } from "../lib/args";
import { operatorDecisionSubject } from "../review/coverage";
import { readOperatorDecisions, readPremiseDecisions, recordOperatorDecision, type OperatorDecisionKind } from "../review/operator-decisions";
import { estimatePlan, readPlanConfirmation, recordPlanConfirmation } from "../review/plan-confirmation";
import { answerPremiseQuestion, findHeldFinding } from "../review/premise-question";
import { isAutonomousEnv, readRunProfile } from "../review/run-profile";
import { HOST_QUESTION_SOURCES, type HostQuestion } from "../review/types";
import { verifyRun } from "../review/verify-run";
import { cardSafe, hiddenInCard } from "../lib/card-safe";
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

const hostHelpTail = (refusedFor: string): string =>
  `<source> is ${HOST_QUESTION_SOURCES.join(", ")}; <ref> is the host's own id for the question (a poll or message id, at most ${REF_MAX_LENGTH} characters).
The record says confirmedVia host-question with both texts (each at most ${MAX_OPERATOR_TEXT_LENGTH} characters), and \`keryx decisions\` keeps the question.
keryx cannot see the question: it records what you report. Refused, with nothing recorded, for ${refusedFor}, the same host question recorded twice,
in an unattended run and under KERYX_TOOL_CALL=1.`;

export function printOperatorCommandHelp(command: OperatorCommand): void {
  const lines: Record<OperatorCommand, string> = {
    "waive-mutation": `keryx review waive-mutation --package <review-dir> --reason "<why>"

Records the operator's waiver of the mutation pass in <review-dir>/operator-decisions.json: the review may
record \`Not run: mutation pass\` with unrun mutants. Asks at the terminal; refused without a TTY. In keryx
shell the review_waive_mutation tool asks the same as a card.

Without a TTY, record the operator's answer to a question you asked through the host's own question tool:
  keryx review waive-mutation --package <review-dir> --reason "<why>" --answered-by <source>:<ref> \\
    --answer-text "<the operator's words>" --question-text "<the question as asked>"
${hostHelpTail("an --answer-text that is not a plain yes (a decline, a negation, the word keep, no yes at all), a blank or oversize text, a missing --reason")}`,
    "override-reviewers": `keryx review override-reviewers --package <review-dir> --reason "<why>" [--selected a,b]

Records the operator's decision to run a smaller reviewer set than \`keryx review required\` names (an
override or mode diff) in <review-dir>/operator-decisions.json. Asks at the terminal; refused without a TTY.
In keryx shell the review_override_reviewers tool asks the same as a card.

Without a TTY, record the operator's answer to a question you asked through the host's own question tool:
  keryx review override-reviewers --package <review-dir> --reason "<why>" [--selected a,b] --answered-by <source>:<ref> \\
    --answer-text "<the operator's words>" --question-text "<the question as asked>"
${hostHelpTail("an --answer-text that is not a plain yes (a decline, a negation, the word keep, no yes at all), a blank or oversize text, a missing --reason")}`,
    "confirm-plan": `keryx review confirm-plan --package <review-dir>

Shows the plan's dispatches and minutes (\`keryx review estimate\`) and records the operator's yes in
<review-dir>/plan-confirmation.json for exactly this plan. Asks at the terminal; refused without a TTY. In
keryx shell the review_confirm_plan tool asks the same as a card.

Without a TTY, record the operator's answer to a question you asked through the host's own question tool:
  keryx review confirm-plan --package <review-dir> --answered-by <source>:<ref> \\
    --answer-text "<the operator's words>" --question-text "<the question as asked>"
The question must show this plan's dispatches and minutes (as \`keryx review estimate\` prints them): a question that
does not is refused as a stale plan, so ask again with the current numbers.
${hostHelpTail("an --answer-text that is not a plain yes (a decline, a negation, no yes at all), a blank or oversize text")}`,
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
The operator's words must name the same choice as --answer (uphold or dismiss, or the same in Russian) and no other;
the finding changes as on the terminal path.
${hostHelpTail("words that name the other choice or none, a blank or oversize text, a missing --reason, an unknown or not-held finding")}`,
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
type GateVerb = "waive-mutation" | "override-reviewers";

const REF_MAX_LENGTH = 200;
const SYNTHESIZED_OPTION = "Synthesized by keryx from the verb: not an option the host offered.";

/** The options of the question each verb records: the one that records the decision, the one that declines it. */
const HOST_OPTIONS: Record<HostVerb, { confirm: string; decline: string; alsoAffirms?: readonly string[]; options: Array<{ id: string; label: string }> }> = {
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
    alsoAffirms: ["run"],
    options: [
      { id: "yes", label: "Yes: run the plan as estimated" },
      { id: "no", label: "No: do not run it" },
    ],
  },
  "waive-mutation": {
    confirm: "waive",
    decline: "keep",
    options: [
      { id: "waive", label: "Waive: skip the mutation pass" },
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
// `don`, `t` and `nt` are what "don't", "can't" and "dont" leave once a non-letter splits the word.
const NEGATIONS = new Set(["not", "never", "no", "nope", "nah", "dont", "don", "t", "nt", "cannot", "cant", "нет", "не", "ни", "без"]);
/** What a yes sounds like, with the verb's own confirming word added per verb. A text with none of them is not an answer. */
const AFFIRMATIVE = new Set([
  "yes", "y", "yep", "yeah", "ok", "okay", "sure", "confirm", "confirmed", "approve", "approved", "agree", "agreed", "go",
  "да", "ок", "окей", "подтверждаю", "согласен", "давай", "запускай",
]);

const wordsOf = (text: string): string[] => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word !== "");
const shortened = (text: string): string => JSON.stringify(text.trim().slice(0, 80));

/** The `--answered-by` value as `<source>:<ref>`, split on the first colon (a ref may hold colons: a poll id plus a message id). */
function parseAnsweredBy(raw: string | undefined, command: HostVerb | "flow-complete" | "complete"): Pick<HostQuestion, "source" | "ref"> {
  const refuse = (why: string): never => {
    throw new Error(
      `--answered-by must be <source>:<ref>: <source> one of ${HOST_QUESTION_SOURCES.join(", ")} and <ref> the host's own id for the question, not empty, at most ${REF_MAX_LENGTH} characters, no control characters` +
        `${raw === undefined ? " (the flag has no value)" : ` (got ${shortened(raw)}${why})`}. See \`keryx review ${command} --help\`.`,
    );
  };
  if (raw === undefined) return refuse("");
  const colon = raw.indexOf(":");
  const source = colon <= 0 ? "" : raw.slice(0, colon);
  const ref = colon <= 0 ? "" : raw.slice(colon + 1).trim();
  if (!(HOST_QUESTION_SOURCES as readonly string[]).includes(source) || ref === "") return refuse("");
  if (ref.length > REF_MAX_LENGTH) return refuse(`: the ref is ${ref.length} characters`);
  if ([...ref].some((char) => /\p{Cc}/u.test(char))) return refuse(": the ref holds a control character");
  return { source: source as HostQuestion["source"], ref };
}

/**
 * confirm-plan, waive-mutation and override-reviewers record a yes, so the operator's words must be one: no decline or
 * negation anywhere, no word of the verb's decline option, and at least one affirmative word. A free text is not a decision.
 */
function refuseNonAffirmative(answerText: string, verb: Exclude<HostVerb, "decide-premise">): void {
  const words = wordsOf(answerText);
  const choices = HOST_OPTIONS[verb];
  const fix = `Nothing was recorded. Ask the operator again and pass their own words, which must say yes (for example "yes, ${choices.confirm} it") and nothing against it. See \`keryx review ${verb} --help\`.`;
  if (words.length === 0 || LEAD_DECLINE.has(words[0] as string)) {
    throw new Error(`--answer-text reads as a decline (${shortened(answerText)}): a declined question records nothing. ${fix}`);
  }
  if (words.some((word) => NEGATIONS.has(word))) throw new Error(`--answer-text reads as a decline (${shortened(answerText)}): it holds a negation, so it is not a yes. ${fix}`);
  if (words.includes(choices.decline)) throw new Error(`--answer-text reads as a decline (${shortened(answerText)}): it names the other option, "${choices.decline}". ${fix}`);
  if (!words.some((word) => AFFIRMATIVE.has(word) || word === choices.confirm || choices.alsoAffirms?.includes(word) === true)) {
    throw new Error(`--answer-text is not a yes (${shortened(answerText)}): free text that does not say yes is not a decision. ${fix}`);
  }
}

/**
 * decide-premise: both options are decisions, so the words must name the chosen option and not the other one, and not
 * behind a negation in the same clause ("No, dismiss it" names dismiss; "do not dismiss it" does not).
 */
function refuseOtherChoice(answerText: string, answer: "uphold" | "dismiss"): void {
  const clauses = answerText.toLowerCase().split(/[,.;:!?()\n]+/u).map(wordsOf).filter((clause) => clause.length > 0);
  const other = answer === "uphold" ? "dismiss" : "uphold";
  const chosen = CHOICE_WORDS[answer];
  const words = clauses.flat();
  const named = words.some((word) => chosen.has(word));
  const namesOther = words.some((word) => CHOICE_WORDS[other].has(word));
  const negated = clauses.some((clause) => clause.some((word, index) => (chosen.has(word) || CHOICE_WORDS[other].has(word)) && NEGATIONS.has(clause[index - 1] ?? "")));
  if (!named || namesOther || negated) {
    throw new Error(
      `--answer-text does not name the same choice as --answer ${answer}: the operator's words must say ${answer} (and not ${other}, and not behind a "not"; a bare yes or no is not a choice here). ` +
        `Nothing was recorded; ask the operator again, or pass the --answer they gave.`,
    );
  }
}

function requireText(flag: "--answer-text" | "--question-text", value: string | undefined, command: HostVerb | "flow-complete" | "complete"): string {
  if (value === undefined || value.trim() === "") throw new Error(`${flag} "<text>" is required and must not be blank: it holds ${flag === "--answer-text" ? "the operator's own words" : "the question as it was asked"}. See \`keryx review ${command} --help\`.`);
  const limit = flag === "--question-text" && (command === "flow-complete" || command === "complete") ? 100_000 : MAX_OPERATOR_TEXT_LENGTH;
  if (value.length > limit) throw new Error(`${flag} is ${value.length} characters; at most ${limit} are recorded. Pass the operator's words or the question as asked, shortened. See \`keryx review ${command} --help\`.`);
  return value;
}

function requireReason(own: string[], command: HostVerb): string {
  const reason = optionValue(own, "--reason");
  if (reason === undefined || reason.trim() === "") throw new Error(`Missing --reason "<why>". See \`keryx review ${command} --help\`.`);
  return reason.trim();
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

/** What the host-question flags carry, once parsed; the per-verb prepare functions take it with their own narrowed inputs. */
type HostAnswer = { hostQuestion: HostQuestion; answerText: string; questionText: string; at: string; where: string };
/** The write runs only after every refusal and returns the line to log; `choice` is the option the journal entry answers. */
type Prepared = { commit: () => Promise<string>; choice: string };
type CommitDeps = { cwd: string; log: (line: string) => void };

/** The same host question (source and ref) recorded twice is one answer: a retry records nothing again. */
function refuseRepeat(command: HostVerb, host: HostAnswer, held: HostQuestion | undefined): void {
  if (held === undefined || held.source !== host.hostQuestion.source || held.ref !== host.hostQuestion.ref) return;
  throw new Error(
    `keryx review ${command}: the host question ${held.source}:${held.ref} is already recorded here, so this call recorded nothing again. ` +
      `If this is a new question, give it its own <ref> in --answered-by.`,
  );
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const namesToken = (text: string, token: string): boolean => new RegExp(`(?<![\\p{L}\\p{N}_-])${escapeRegExp(token)}(?![\\p{L}\\p{N}_-])`, "iu").test(text);

/** The recorded answer is bound to its subject: the question must name what the operator was asked about (finding id, unrun mutants, reviewers left out). */
function refuseUnboundQuestion(command: HostVerb, questionText: string, subject: string, tokens: readonly string[], countAlso: boolean): void {
  if (tokens.length === 0) return;
  if (tokens.every((token) => namesToken(questionText, token))) return;
  if (countAlso && namesToken(questionText, String(tokens.length))) return;
  throw new Error(
    `--question-text does not name the ${subject}: ${tokens.length === 1 ? tokens[0] : `${tokens.slice(0, 6).join(", ")}${tokens.length > 6 ? ", ..." : ""}`}${countAlso ? ` (or their count, ${tokens.length})` : ""}. ` +
      `An answer to a question that does not say what it is about is not recorded. Ask the operator again with the ${subject} in the question. Nothing was recorded. See \`keryx review ${command} --help\`.`,
  );
}

async function prepareConfirmPlan(packageDir: string, host: HostAnswer): Promise<Prepared> {
  const estimate = await estimatePlan(packageDir);
  const shown = new Set(host.questionText.match(/\d+/g) ?? []);
  if (![estimate.dispatches, estimate.minutes.min, estimate.minutes.max].every((value) => shown.has(String(value)))) {
    throw new Error(
      `The plan changed, or the question does not show it: the plan now is ${estimate.dispatches} reviewer dispatches (${estimate.minutes.min}-${estimate.minutes.max} min) ` +
        `and --question-text names other numbers. Ask the operator again with the current numbers in the question. Nothing was recorded.`,
    );
  }
  refuseNonAffirmative(host.answerText, "confirm-plan");
  refuseRepeat("confirm-plan", host, (await readPlanConfirmation(packageDir))?.hostQuestion);
  const commit = async () => {
    const record = await recordPlanConfirmation(packageDir, estimate, { quote: `${host.questionText}: ${host.answerText}`, confirmedVia: "host-question", at: host.at, hostQuestion: host.hostQuestion });
    return `plan confirmed (${host.where}): ${record.dispatches} dispatch(es), ${record.minutes[0]}-${record.minutes[1]} min`;
  };
  return { commit, choice: HOST_OPTIONS["confirm-plan"].confirm };
}

async function preparePremise(packageDir: string, host: HostAnswer, input: { ref: string; answer: "uphold" | "dismiss"; reason: string }, deps: CommitDeps): Promise<Prepared> {
  const held = await findHeldFinding(packageDir, input.ref);
  if (!held.ok) throw new Error(held.refusal);
  const finding = held.finding;
  const shortId = finding.key.split("#").pop() as string;
  if (!namesToken(host.questionText, finding.key)) refuseUnboundQuestion("decide-premise", host.questionText, "finding id", [shortId], false);
  refuseOtherChoice(host.answerText, input.answer);
  const prior = (await readPremiseDecisions(packageDir)).find((decision) => decision.finding === finding.key && decision.hostQuestion?.source === host.hostQuestion.source && decision.hostQuestion.ref === host.hostQuestion.ref);
  refuseRepeat("decide-premise", host, prior?.hostQuestion);
  const commit = async () => {
    await answerPremiseQuestion(
      packageDir,
      { finding, answer: input.answer, reason: input.reason, quote: host.answerText, at: host.at, confirmedVia: "host-question", hostQuestion: host.hostQuestion },
      { cwd: deps.cwd, warn: (line) => deps.log(`warning: ${line}`) },
    );
    return `premise-question ${input.answer} recorded for ${finding.key} (${host.where}, ${host.at}) in operator-decisions.json and findings.json`;
  };
  return { commit, choice: input.answer };
}

async function prepareGate(packageDir: string, host: HostAnswer, input: { command: GateVerb; reason: string; selected: string[] | undefined }): Promise<Prepared> {
  const kind: OperatorDecisionKind = input.command === "waive-mutation" ? "mutation-waiver" : "reviewer-override";
  const subject = await operatorDecisionSubject(packageDir, kind, kind === "mutation-waiver" ? undefined : input.selected);
  refuseUnboundQuestion(input.command, host.questionText, kind === "mutation-waiver" ? "unrun mutants" : "reviewers left out", subject.items, true);
  refuseNonAffirmative(host.answerText, input.command);
  const prior = (await readOperatorDecisions(packageDir)).find((decision) => decision.kind === kind && decision.hostQuestion?.source === host.hostQuestion.source && decision.hostQuestion.ref === host.hostQuestion.ref);
  refuseRepeat(input.command, host, prior?.hostQuestion);
  const commit = async () => {
    await recordOperatorDecision(packageDir, { kind, quote: host.answerText, reason: input.reason, confirmedVia: "host-question", at: host.at, subject, hostQuestion: host.hostQuestion });
    return `${kind} recorded (${host.where}, ${host.at}) in operator-decisions.json`;
  };
  return { commit, choice: HOST_OPTIONS[input.command].confirm };
}

/** The flags every verb but decide-premise takes as `--answer`: the verb's confirming option, or left out. */
function refuseOtherAnswer(own: string[], command: Exclude<HostVerb, "decide-premise">): void {
  const choices = HOST_OPTIONS[command];
  const answerArg = optionValue(own, "--answer");
  if (answerArg === undefined || answerArg === choices.confirm) return;
  throw new Error(
    answerArg === choices.decline
      ? `--answer ${answerArg} is a decline: a declined question records nothing. See \`keryx review ${command} --help\`.`
      : `--answer must be ${choices.confirm} (the option this verb records) or left out; got ${JSON.stringify(answerArg.slice(0, 40))}. See \`keryx review ${command} --help\`.`,
  );
}

async function prepareVerb(command: HostVerb, own: string[], packageDir: string, host: HostAnswer, deps: CommitDeps): Promise<Prepared> {
  switch (command) {
    case "decide-premise": {
      const answer = optionValue(own, "--answer");
      if (answer !== "uphold" && answer !== "dismiss") throw new Error("--answer must be uphold or dismiss. See `keryx review decide-premise --help`.");
      const reason = requireReason(own, command);
      const ref = optionValue(own, "--finding");
      if (ref === undefined || ref.trim() === "") throw new Error("Missing --finding <id>. See `keryx review decide-premise --help`.");
      return preparePremise(packageDir, host, { ref, answer, reason }, deps);
    }
    case "confirm-plan":
      refuseOtherAnswer(own, command);
      return prepareConfirmPlan(packageDir, host);
    case "waive-mutation":
    case "override-reviewers": {
      refuseOtherAnswer(own, command);
      const reason = requireReason(own, command);
      const selectedArg = optionValue(own, "--selected");
      const selected = selectedArg === undefined ? undefined : selectedArg.split(",").map((item) => item.trim()).filter(Boolean);
      return prepareGate(packageDir, host, { command, reason, selected });
    }
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
  const at = new Date().toISOString();
  const host: HostAnswer = { hostQuestion: { source: by.source, ref: by.ref, questionText, answerText, time: at }, answerText, questionText, at, where: `host-question, ${by.source}:${by.ref}` };

  // Every prepare function refuses before the first write; the commit is the only write.
  const { commit, choice } = await prepareVerb(command, own, packageDir, host, { cwd, log });
  log(await commit());
  await journalHostQuestion(command, host, choice, { cwd, log, env });
  return 0;
}

/**
 * The keryx decisions journal keeps the question beside the others. The review record is already written: a journal that
 * cannot be written is a warning, not a reason to leave the operator's answer unrecorded or to record it twice on a retry.
 */
async function journalHostQuestion(command: HostVerb, host: HostAnswer, choice: string, context: { cwd: string; log: (line: string) => void; env: Readonly<Record<string, string | undefined>> }): Promise<void> {
  const { cwd, log, env } = context;
  const { source, ref } = host.hostQuestion;
  const choices = HOST_OPTIONS[command];
  try {
    const flow = await resolveFlowContext(cwd, env);
    const opened = await openDecision({
      cwd,
      question: host.questionText,
      options: choices.options.map((option) => ({ ...option, description: SYNTHESIZED_OPTION })),
      stage: `review ${command}`,
      flow: flow.flow,
      flowSource: flow.flowSource,
      channel: source,
      source: DECISION_SOURCES.hostQuestion,
      hostQuestion: { source, ref, verb: command, answerText: host.answerText },
      salt: "host-question",
    });
    await answerDecision({ cwd, id: opened.id, choice });
  } catch (error) {
    log(`warning: the answer is recorded, but the keryx decisions journal was not updated (${error instanceof Error ? error.message : String(error)})`);
  }
}

/** Bind the host answer to every current refusal, reason and the flow identity. */
export function completionHostAnswer(
  args: string[],
  selected: readonly import("../flow/service").CompletionExceptionSelection[],
  flowId: string,
  cwd: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): { operatorWords: string; confirmedVia: "host-question"; hostQuestion: HostQuestion } {
  if (env["KERYX_TOOL_CALL"] === "1" || env["KERYX_UNATTENDED"] === "1" ||
      isAutonomousEnv(env) || readRunProfile(cwd)?.mode === "unattended") {
    throw new Error("flow complete --answered-by is refused in a nested agent shell or unattended run; use the operator card.");
  }
  const by = parseAnsweredBy(optionValue(args, "--answered-by"), "flow-complete");
  const answerText = requireText("--answer-text", optionValue(args, "--answer-text"), "flow-complete");
  const questionText = requireText("--question-text", optionValue(args, "--question-text"), "flow-complete");
  if (!/^(yes|y|да)$/iu.test(answerText.trim())) {
    throw new Error("Exception completion requires the operator's plain yes; nothing was recorded.");
  }
  if (hiddenInCard(questionText) || hiddenInCard(answerText) || hiddenInCard(by.ref)) {
    throw new Error("Host question and answer must contain no hidden or control characters.");
  }
  const expected = `Complete flow ${flowId} with exceptions? ` + selected.map(formatCompletionException).join(" ");
  if (questionText !== expected) {
    throw new Error(`Ask the current completion question verbatim: ${expected}`);
  }
  return {
    operatorWords: answerText,
    confirmedVia: "host-question",
    hostQuestion: { ...by, questionText, answerText, time: new Date().toISOString() },
  };
}

/** Parse the existing host-question protocol; completion validates its package snapshot separately. */
export function reviewCompletionHostAnswer(args: string[]): HostQuestion | undefined {
  const supplied = ["--answered-by", "--answer-text", "--question-text"].some((flag) => optionValue(args, flag) !== undefined);
  if (!supplied) return undefined;
  return {
    ...parseAnsweredBy(optionValue(args, "--answered-by"), "complete"),
    answerText: requireText("--answer-text", optionValue(args, "--answer-text"), "complete"),
    questionText: requireText("--question-text", optionValue(args, "--question-text"), "complete"),
    time: new Date().toISOString(),
  };
}
