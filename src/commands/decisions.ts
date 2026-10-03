// `keryx decisions` (flow 392) — the recommendation journal. Any agent that asks a
// human a question with options drives it through four calls:
//
//   open    record the question, the options and the recommendation BEFORE showing
//           it; it says blind or ordinary, the order to show and whether to mark
//   answer  record the human's choice; it returns the reveal and whether the
//           human should be asked for a reason (once, optional; the command itself
//           does not wait, the caller asks). A second answer is a changed answer.
//   reason  record the optional reason (the latest one wins when it is changed)
//   report  deterministic summary, no model: match share by mode and stage,
//           deviations with their reasons; backfilled decisions in a block apart
//   import  load historical decisions (backfilled), kept apart from the live ones
//
// keryx and a chat bridge know nothing of each other: the bridge calls this and
// shows what it says.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { optionValue, optionValues } from "../lib/args";
import {
  answerDecision,
  importBackfill,
  openDecision,
  recordReason,
  renderImportResult,
  reportLine,
  reportText,
  loadReport,
  resolveFlowContext,
  type DecisionOption,
  type FlowContext,
} from "../decisions/service";

const OPEN_FLAGS = ["--question", "--option", "--options-json", "--recommend", "--reason", "--stage", "--flow", "--action", "--json"] as const;
const ANSWER_FLAGS = ["--choice", "--other", "--reason", "--json"] as const;
const REASON_FLAGS = ["--text", "--json"] as const;
const REPORT_FLAGS = ["--json", "--line"] as const;
const IMPORT_FLAGS = ["--dry-run", "--json"] as const;

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
  // --flow / --stage win; otherwise the flow and stage are derived from KERYX_FLOW, the branch or the one flow in progress
  const given = { flow: optionValue(args, "--flow"), stage: optionValue(args, "--stage") };
  const context: FlowContext = given.flow !== undefined && given.stage !== undefined ? {} : await resolveFlowContext(process.cwd());
  const flow = given.flow ?? context.flow;
  const result = await openDecision({
    cwd: process.cwd(),
    question,
    options,
    recommendation: recommend === undefined ? undefined : { optionId: recommend, reason: optionValue(args, "--reason") ?? "" },
    stage: given.stage ?? context.stage,
    flow,
    flowSource: given.flow === undefined ? context.flowSource : undefined,
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
  const result = await answerDecision({ cwd: process.cwd(), id, choice, other: rest.includes("--other") });
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
  if (askReason) console.log(`the human may add an optional reason (offer it once, and do not hold the answer for it): keryx decisions reason ${result.id} --text "<reason>"`);
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

async function runImport(args: string[]): Promise<void> {
  const file = positionalId(args);
  if (file === undefined) throw new Error("keryx decisions import needs the file: keryx decisions import <file.jsonl> [--dry-run] [--json]");
  const rest = args.slice(1);
  rejectUnknownFlags("import", rest, IMPORT_FLAGS);
  let text: string;
  try {
    text = await readFile(path.resolve(process.cwd(), file), "utf8");
  } catch {
    throw new Error(`cannot read ${file}`);
  }
  const result = await importBackfill(process.cwd(), text, { dryRun: rest.includes("--dry-run") });
  if (rest.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(renderImportResult(result));
}

async function runReport(args: string[]): Promise<void> {
  rejectUnknownFlags("report", args, REPORT_FLAGS);
  if (args.includes("--line") && args.includes("--json")) throw new Error("keryx decisions report: --line and --json cannot be combined");
  if (args.includes("--line")) {
    console.log(await reportLine(process.cwd()));
    return;
  }
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
    if (command === "import") return await runImport(args.slice(1));
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    // a caller that asked for JSON gets JSON on stdout for a failure too, not prose on stderr
    if (command === "import" && args.includes("--json")) console.log(JSON.stringify({ error: message }, null, 2));
    else console.error(message);
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
  keryx decisions answer <id> --choice <id> [--other] [--reason "<why>"] [--json]
  keryx decisions reason <id> --text "<why>" [--json]
  keryx decisions report [--json | --line]
  keryx decisions import <file.jsonl> [--dry-run] [--json]

Every agent question with options leaves one record: what was asked, what the
agent recommended and why, how it was shown, what the human chose and how long
it took. Call \`open\` BEFORE showing the question and \`answer\` after.

  open     puts the question in one of four arms, seeded from a per-repository
           salt (A 40%: agent order, mark shown, recommended preselected; B 20%:
           mark shown, nothing preselected; C 20%: shuffled, mark shown; D 20%:
           blind, no mark, shuffled; weights under "arms" in decisions.config.json),
           and prints the arm, the order to show, whether to mark the recommendation
           and whether to preselect it. A question about a release, a delete or
           a push (the strong irreversible terms, English and Russian, such as
           release, ship, rollout, promote, publish to npm, tag a version,
           выпустить, залить, отправить в прод, накатить, git reset --hard,
           rm -rf, plus .metaproject/decisions.config.json) is never blind: it is
           always arm A.
           Merge, drop, remove, force and the like count next to main,
           production, a branch, a PR, a table, ... or with no real object
           ("Merge it now?"); an identifier in a question about code
           (rename deleteUser to removeUser) is not read as an action.
           PASS --action FOR ANYTHING IRREVERSIBLE: any non-empty tag makes
           the question non-blind, and that is the reliable path; the text
           match is only a safety net.
  answer   records the choice (it must be one of the options; --other marks a
           free-form answer), prints the recommendation (the reveal) and the
           time to answer. A second answer for the same id is a changed answer:
           both are kept. After a deviation it says the human should be asked
           for a reason, once; the command does not wait, the caller asks, and
           the reason can come later through \`reason\`. In the TUI the reason
           is asked once and the tool result waits for it (an empty answer
           releases the wait); /decisions reason <why> and /decisions change
           <option> add or change them later.
  report   no model: match share by mode and by stage, and every deviation with
           its reason. It also counts the questions that looked irreversible
           and the ones where blind was refused because of it, per stage: a
           high number on ordinary questions means the list over-matches.
           Backfilled decisions (see import) are reported in a separate block
           "до (историческое, дозаполнено задним числом)" and never counted in
           the live shares or in the time to answer. --line prints ONE line in
           Russian for the daily topic message: the total (before, after) and the
           match share of the visible, the hidden and the historical decisions.
  import   loads historical decisions from a JSON-lines file, one per line:
             {"id","at","flow","stage","question","options":[{"id","label"}],
              "recommendation":{"optionId","reason"}|null,"source",
              "answer":{"choice","other"?}|null,"reason"?}
           Every one is marked backfilled (its recommendation was written down
           after the fact), is never blind, and keeps the time it was asked in
           "at"; its time to answer is unknown and never used. The file is
           read line by line: a line that is not a decision is skipped, named
           (line number and why) and counted, and the rest is imported. An id
           already in the journal is skipped and reported, so the same file can
           be imported twice; a backfilled decision whose answer is missing from
           the journal (an interrupted write) gets just that answer on the next
           import. --dry-run checks and counts without writing. It prints:
           Imported: N, skipped: S, with recommendation: R, answered: A,
           deviations: D, plus ", repaired: R" and ", malformed: M" when
           there are any. With --json a failure is {"error": "..."}. A bare /decisions change never touches a backfilled
           decision.

The journal is one file per repository, .metaproject/data/decisions/journal.jsonl
under the main checkout (every worktree shares it; it is git-ignored). Inside a
flow (--flow <id>, KERYX_FLOW, the flow's branch, or the only flow in progress;
the last is a guess, recorded as "inferred" and shown so in the report)
the answer also adds a line to that flow's journal.md, except for an inferred
flow, which only stays in the project-wide journal. A failure here never
stops the question.`);
}
