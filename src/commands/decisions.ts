// `keryx decisions` (flow 392) — the recommendation journal. Any agent that asks a
// human a question with options drives it through four calls:
//
//   open    record the question, the options and the recommendation BEFORE showing
//           it; it says blind or ordinary, the order to show and whether to mark
//   answer  record the human's choice; it returns the reveal and whether to ask
//           for a reason (once, optional)
//   reason  record that one optional reason
//   report  deterministic summary, no model: match share by mode and stage,
//           deviations with their reasons
//
// keryx and a chat bridge know nothing of each other: the bridge calls this and
// shows what it says.

import { optionValue, optionValues } from "../lib/args";
import {
  answerDecision,
  openDecision,
  recordReason,
  reportText,
  loadReport,
  type DecisionOption,
} from "../decisions/service";

const OPEN_FLAGS = ["--question", "--option", "--options-json", "--recommend", "--reason", "--stage", "--flow", "--action", "--json"] as const;
const ANSWER_FLAGS = ["--choice", "--reason", "--json"] as const;
const REASON_FLAGS = ["--text", "--json"] as const;
const REPORT_FLAGS = ["--json"] as const;

function rejectUnknownFlags(sub: string, args: readonly string[], accepted: readonly string[]): void {
  const unknown = args
    .filter((argument) => argument.startsWith("--"))
    .map((argument) => argument.split("=")[0] as string)
    .filter((name) => !accepted.includes(name));
  if (unknown.length > 0) {
    throw new Error(`Unknown option${unknown.length > 1 ? "s" : ""} for \`keryx decisions ${sub}\`: ${[...new Set(unknown)].join(", ")}. Accepted: ${accepted.join(", ")}.`);
  }
}

/** The positional id: the first argument that is not a flag or a flag's value. */
function positionalId(args: readonly string[]): string | undefined {
  const first = args[0];
  return first !== undefined && !first.startsWith("--") ? first : undefined;
}

function parseOptions(args: string[]): DecisionOption[] {
  const fromJson = optionValue(args, "--options-json");
  if (fromJson !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fromJson);
    } catch {
      throw new Error("--options-json is not valid JSON");
    }
    if (!Array.isArray(parsed)) throw new Error("--options-json must be an array of { id, label, description? }");
    return parsed.map((item, i) => {
      const rec = (item !== null && typeof item === "object" ? item : {}) as Record<string, unknown>;
      const id = typeof rec["id"] === "string" ? rec["id"] : "";
      const label = typeof rec["label"] === "string" && rec["label"].length > 0 ? rec["label"] : id;
      if (id.length === 0) throw new Error(`option ${i + 1} in --options-json has no id`);
      return { id, label, ...(typeof rec["description"] === "string" ? { description: rec["description"] } : {}) };
    });
  }
  return optionValues(args, "--option").map((raw) => {
    const eq = raw.indexOf("=");
    const id = (eq < 0 ? raw : raw.slice(0, eq)).trim();
    const label = eq < 0 ? id : raw.slice(eq + 1).trim();
    if (id.length === 0) throw new Error(`--option "${raw}" has no id (use --option <id>=<label>)`);
    return { id, label: label.length > 0 ? label : id };
  });
}

async function runOpen(args: string[]): Promise<void> {
  rejectUnknownFlags("open", args, OPEN_FLAGS);
  const question = optionValue(args, "--question");
  if (question === undefined || question.trim().length === 0) throw new Error("keryx decisions open needs --question \"<text>\"");
  const options = parseOptions(args);
  const recommend = optionValue(args, "--recommend");
  const flow = optionValue(args, "--flow") ?? (process.env["KERYX_FLOW"] !== undefined && process.env["KERYX_FLOW"].length > 0 ? process.env["KERYX_FLOW"] : undefined);
  const result = await openDecision({
    cwd: process.cwd(),
    question,
    options,
    recommendation: recommend === undefined ? undefined : { optionId: recommend, reason: optionValue(args, "--reason") ?? "" },
    stage: optionValue(args, "--stage"),
    flow,
    action: optionValue(args, "--action"),
  });
  const labels = new Map(options.map((option) => [option.id, option]));
  const ordered = result.order.map((id) => ({ id, label: labels.get(id)?.label ?? id, description: labels.get(id)?.description }));
  if (args.includes("--json")) {
    console.log(JSON.stringify({ ...result, options: ordered }, null, 2));
    return;
  }
  console.log(`decision ${result.id}`);
  console.log(`mode: ${result.mode}${result.blindRefused ? " (blind refused: an irreversible action)" : ""}`);
  console.log(`show the "recommended" mark: ${result.showMark ? "yes" : "no"}`);
  console.log("display order:");
  ordered.forEach((option, i) => console.log(`  ${i + 1}. ${option.id}  ${option.label}`));
  console.log(`After the answer: keryx decisions answer ${result.id} --choice <id>`);
}

async function runAnswer(args: string[]): Promise<void> {
  const id = positionalId(args);
  if (id === undefined) throw new Error("keryx decisions answer needs the decision id: keryx decisions answer <id> --choice <id>");
  const rest = args.slice(1);
  rejectUnknownFlags("answer", rest, ANSWER_FLAGS);
  const choice = optionValue(rest, "--choice");
  if (choice === undefined) throw new Error("keryx decisions answer needs --choice <option id>");
  const result = await answerDecision({ cwd: process.cwd(), id, choice });
  const given = optionValue(rest, "--reason");
  let reasonRecorded = false;
  if (given !== undefined && result.askReason) reasonRecorded = await recordReason(process.cwd(), id, given);
  const askReason = result.askReason && !reasonRecorded;
  if (rest.includes("--json")) {
    console.log(JSON.stringify({ ...result, askReason, reasonRecorded }, null, 2));
    return;
  }
  console.log(`decision ${result.id}: answer ${result.seq}${result.changed ? " (changed)" : ""}: ${result.choice}`);
  if (result.recommendation === null) console.log("recommendation: none was given");
  else {
    console.log(`recommendation (revealed): ${result.recommendation.optionId}${result.recommendation.reason.length > 0 ? ` - ${result.recommendation.reason}` : ""}`);
    console.log(result.matched ? "the human followed the recommendation" : "the human chose differently");
  }
  console.log(`time to answer: ${(result.timeToAnswerMs / 1000).toFixed(1)}s`);
  if (askReason) console.log(`ask the human ONCE for an optional reason, then: keryx decisions reason ${result.id} --text "<reason>" (empty is fine)`);
}

async function runReason(args: string[]): Promise<void> {
  const id = positionalId(args);
  if (id === undefined) throw new Error('keryx decisions reason needs the decision id: keryx decisions reason <id> --text "<reason>"');
  const rest = args.slice(1);
  rejectUnknownFlags("reason", rest, REASON_FLAGS);
  const recorded = await recordReason(process.cwd(), id, optionValue(rest, "--text"));
  if (rest.includes("--json")) {
    console.log(JSON.stringify({ id, recorded }, null, 2));
    return;
  }
  console.log(recorded ? `decision ${id}: reason recorded` : `decision ${id}: the human was already asked once; nothing written`);
}

async function runReport(args: string[]): Promise<void> {
  rejectUnknownFlags("report", args, REPORT_FLAGS);
  if (args.includes("--json")) {
    console.log(JSON.stringify(await loadReport(process.cwd()), null, 2));
    return;
  }
  console.log(await reportText(process.cwd()));
}

export async function decisionsCommand(args: string[] = []): Promise<void> {
  const command = args[0];
  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return;
  }
  try {
    if (command === "open") return await runOpen(args.slice(1));
    if (command === "answer") return await runAnswer(args.slice(1));
    if (command === "reason") return await runReason(args.slice(1));
    if (command === "report") return await runReport(args.slice(1));
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exitCode = 1;
    return;
  }
  console.error(`Unknown decisions subcommand: ${command}`);
  printHelp();
  process.exitCode = 1;
}

export function printDecisionsHelp(): void {
  printHelp();
}

function printHelp(): void {
  console.log(`keryx decisions — the recommendation journal

Usage:
  keryx decisions open --question "<text>" --option <id>=<label> [--option ...] [--recommend <id> --reason "<why>"] [--stage <name>] [--flow <id>] [--action <tag>] [--json]
  keryx decisions answer <id> --choice <id> [--reason "<why>"] [--json]
  keryx decisions reason <id> --text "<why>" [--json]
  keryx decisions report [--json]

Every agent question with options leaves one record: what was asked, what the
agent recommended and why, how it was shown, what the human chose and how long
it took. Call \`open\` BEFORE showing the question and \`answer\` after.

  open     decides blind (a third of the questions: no "recommended" mark,
           random order) or ordinary, and prints the order to show and whether
           to mark the recommendation. A question about a release, a delete or
           a push (the irreversible list, .metaproject/decisions.config.json)
           is never blind.
  answer   records the choice, prints the recommendation (the reveal) and the
           time to answer. A second answer for the same id is a changed answer:
           both are kept. After a deviation it says to ask the human once for
           an optional reason; an empty reason is recorded as absent.
  report   no model: match share by mode and by stage, and every deviation with
           its reason.

Outside a flow the record goes to .metaproject/data/decisions/journal.jsonl;
inside a flow (--flow <id> or KERYX_FLOW) the answer also adds a line to that
flow's journal.md. A failure here never stops the question.`);
}
