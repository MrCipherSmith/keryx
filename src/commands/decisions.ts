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
//   import  load historical decisions (backfilled, legacy), kept apart from the live ones
//   rate    rate the quality of a closed decision's recommendation: the human's own
//           rating, or --blind-model (a model rates it in a clean context; a
//           self-assessment, never the main measure)
//   export  the journal's structure for analysis: no question or option text
//
// keryx and a chat bridge know nothing of each other: the bridge calls this and
// shows what it says.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { optionValue, optionValues } from "../lib/args";
import {
  MODEL_LABEL,
  answerDecision,
  commandModelCall,
  importBackfill,
  isQuality,
  exportSummaryLine,
  loadExportWithSummary,
  openDecision,
  rateBlindModel,
  rateDecision,
  recordReason,
  renderExport,
  renderImportResult,
  reportLine,
  reportText,
  loadReport,
  resolveFlowContext,
  type DecisionOption,
  type FlowContext,
} from "../decisions/service";

const OPEN_FLAGS = ["--question", "--option", "--options-json", "--recommend", "--reason", "--stage", "--flow", "--action", "--channel", "--json"] as const;
const ANSWER_FLAGS = ["--choice", "--other", "--reason", "--json"] as const;
const REASON_FLAGS = ["--text", "--json"] as const;
const REPORT_FLAGS = ["--json", "--line", "--exclude-legacy"] as const;
const RATE_FLAGS = ["--note", "--blind-model", "--model", "--model-cmd", "--since", "--id", "--limit", "--json"] as const;
const EXPORT_FLAGS = ["--since", "--format", "--exclude-legacy"] as const;
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
    // the report cuts by channel, and "Telegram" and "telegram" must be one channel
    channel: optionValue(args, "--channel")?.trim().toLowerCase(),
  });
  const labels = new Map(options.map((option) => [option.id, option]));
  const ordered = result.order.map((id) => ({ id, label: labels.get(id)?.label ?? id, description: labels.get(id)?.description }));
  if (args.includes("--json")) {
    console.log(JSON.stringify({ ...result, options: ordered }, null, 2));
    return;
  }
  console.log(`decision ${result.id}`);
  console.log(`mode: ${result.mode}${result.blindRefused ? " (blind refused: an irreversible action)" : ""}`);
  console.log(`arm: ${result.arm}${result.forced ? " (forced: an irreversible action)" : ""}, channel: ${result.channel}`);
  console.log(`start with the recommended option highlighted: ${result.preselected ? "yes" : "no"}`);
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

function parseSince(args: readonly string[], sub: string): Date | undefined {
  const raw = optionValue([...args], "--since");
  if (raw === undefined) return undefined;
  const at = new Date(raw);
  if (!Number.isFinite(at.getTime())) throw new Error(`keryx decisions ${sub}: --since "${raw}" is not a date (use 2026-10-01 or an ISO time)`);
  return at;
}

async function runRate(args: string[]): Promise<void> {
  rejectUnknownFlags("rate", args, RATE_FLAGS);
  const json = args.includes("--json");
  if (args.includes("--blind-model")) {
    const model = optionValue(args, "--model");
    const command = optionValue(args, "--model-cmd");
    if (model === undefined || command === undefined) {
      throw new Error('keryx decisions rate --blind-model needs --model "<label>" and --model-cmd "<command>" (a command that reads the prompt on stdin and prints the answer, for example "claude -p")');
    }
    const limitRaw = optionValue(args, "--limit");
    const limit = limitRaw === undefined ? undefined : Number(limitRaw);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw new Error("keryx decisions rate: --limit must be a positive whole number");
    const result = await rateBlindModel({ cwd: process.cwd(), model, call: commandModelCall(command), since: parseSince(args, "rate"), id: optionValue(args, "--id"), limit });
    if (json) {
      console.log(JSON.stringify({ label: MODEL_LABEL, ...result }, null, 2));
      return;
    }
    console.log(`${MODEL_LABEL}: rated ${result.rated.length}, skipped ${result.skipped.length} (clean context: ${result.rated.filter((r) => r.cleanContext === true).length} of ${result.rated.length})`);
    for (const rating of result.rated) console.log(`  ${rating.decisionId}: ${rating.unusable === true ? "unusable reply (not counted)" : rating.quality}${rating.modelAgree === true ? " (the model chose the recommended option)" : ""}`);
    for (const skip of result.skipped) console.log(`  skipped ${skip.id}: ${skip.reason}`);
    return;
  }
  const id = args[0];
  const quality = args[1];
  if (id === undefined || id.startsWith("--") || quality === undefined || quality.startsWith("--")) {
    throw new Error('keryx decisions rate needs the decision id and a rating: keryx decisions rate <id> good|bad|unclear [--note "<why>"]');
  }
  if (!isQuality(quality)) throw new Error(`"${quality}" is not a rating. Use good, bad or unclear.`);
  const record = await rateDecision({ cwd: process.cwd(), id, quality, note: optionValue(args.slice(2), "--note") });
  if (json) {
    console.log(JSON.stringify(record, null, 2));
    return;
  }
  console.log(`decision ${id}: rated ${record.quality} by the human (rating ${record.seq})`);
}

async function runExport(args: string[]): Promise<void> {
  rejectUnknownFlags("export", args, EXPORT_FLAGS);
  const format = optionValue(args, "--format") ?? "jsonl";
  if (format !== "jsonl" && format !== "json") throw new Error(`keryx decisions export: --format must be jsonl or json, not "${format}"`);
  const { rows, summary } = await loadExportWithSummary(process.cwd(), { since: parseSince(args, "export"), excludeLegacy: args.includes("--exclude-legacy") });
  const text = renderExport(rows, format);
  if (text.length > 0) console.log(text);
  console.error(exportSummaryLine(summary));
}

async function runReport(args: string[]): Promise<void> {
  rejectUnknownFlags("report", args, REPORT_FLAGS);
  const options = { excludeLegacy: args.includes("--exclude-legacy") };
  if (args.includes("--line") && args.includes("--json")) throw new Error("keryx decisions report: --line and --json cannot be combined");
  if (args.includes("--line")) {
    console.log(await reportLine(process.cwd()));
    return;
  }
  if (args.includes("--json")) {
    console.log(JSON.stringify(await loadReport(process.cwd(), options), null, 2));
    return;
  }
  console.log(await reportText(process.cwd(), options));
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
    if (command === "rate") return await runRate(args.slice(1));
    if (command === "export") return await runExport(args.slice(1));
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
  keryx decisions open --question "<text>" --option <id>=<label> [--option ...] [--recommend <id> --reason "<why>"] [--stage <name>] [--flow <id>] [--action <tag>] [--channel <name>] [--json]
  keryx decisions answer <id> --choice <id> [--other] [--reason "<why>"] [--json]
  keryx decisions reason <id> --text "<why>" [--json]
  keryx decisions report [--json | --line] [--exclude-legacy]
  keryx decisions import <file.jsonl> [--dry-run] [--json]
  keryx decisions rate <id> good|bad|unclear [--note "<why>"] [--json]
  keryx decisions rate --blind-model --model "<label>" --model-cmd "<command>" [--since <date>] [--id <id>] [--limit <n>] [--json]
  keryx decisions export [--since <date>] [--format jsonl|json] [--exclude-legacy]

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
           It also cuts the randomized decisions by arm (A free and A forced
           apart: a forced A is not randomized) and by channel (on telegram
           arms A and B are one row, because a poll cannot preselect), shows
           the records from before the arms in a block of their own
           ("legacy"; --exclude-legacy leaves them out of every number), and
           prints the recommendation-quality matrix (see rate).
           Backfilled decisions (see import) are reported in a separate block
           "до (историческое, дозаполнено задним числом)" and never counted in
           the live shares or in the time to answer. --line prints ONE line in
           Russian for the daily topic message: the total (before, after) and the
           match share of the visible, the hidden and the historical decisions.
  rate     records a rating of the recommendation's quality for a CLOSED
           decision. rate <id> good|bad|unclear is the human's rating, the
           main measure. rate --blind-model has a model rate every closed
           decision that carries a recommendation, in a clean context: the
           model sees only the question and the options in the order the human
           saw them (no mark, no reason, no choice, no history) and the pick it
           makes is compared with the agent's recommendation. --model is the
           label the rating is filed under and --model-cmd is a command that
           reads the prompt on stdin and prints the answer (each call is a new
           process, which is what makes the context clean). Model ratings are
           always shown as "model self-assessment": the model may be the one
           that wrote the recommendation. A decision already rated by the same
           model label is skipped.
  export   prints one JSON object per decision (--format json for an array)
           with structure only: arm, seed, preselected, the display order as
           positions, channel, forced, legacy, deviation, quality ratings and
           times. No question, no option text, no reason, no note: a test
           holds it to that. --since <date> and --exclude-legacy narrow it.
  import   loads historical decisions from a JSON-lines file, one per line:
             {"id","at","flow","stage","question","options":[{"id","label"}],
              "recommendation":{"optionId","reason"}|null,"source",
              "answer":{"choice","other"?}|null,"reason"?}
           Every one is marked backfilled (its recommendation was written down
           after the fact) and legacy (it was not drawn by the arms): ordinary
           records go to arm A, a record with "mode":"blind" to arm D. It keeps
           the time it was asked in "at"; its time to answer is unknown and
           never used. A record already in the journal from before the arms
           (no "arm" field) is read as legacy the same way; the file is
           append-only and is not rewritten. The file is
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
