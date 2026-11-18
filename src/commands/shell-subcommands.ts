// The text subcommands behind the picker and modal commands (Keryx Desktop Client M2a,
// specification §3.9.1, decision D-10).
//
// The full-screen shell's modals act through closures (`/schedules` `p`/`r`/`d`, `/routing`
// enter, `/jevprofile` space, `/review` `a` then `y`, `/ci` `t`, ...). A desktop view
// instead sends every action back as a command line, so each of those actions needs a
// text form that both surfaces share. They live here, with no renderer and no ACP type:
// `src/acp/shell-views-*.ts` builds the views and calls these, and the shell's own
// dispatcher can call them for the same lines.
//
// Each function answers `{ ok, text }`. `ok: false` is a refusal or a failure with its
// reason in `text`; nothing here throws for an operator-level problem.

import { randomUUID } from "node:crypto";
import { acceptProposalViaShell, declineProposalViaShell } from "../tui/review-accept";
import { makeCommandRunner } from "../harness/tool/builtin/shell-exec-tool";
import { RECOMMENDED_JEV_PROFILE } from "../review/jev-profile";
import { applyRecommendedJevProfileForShell, readJevProfileForShell, toggleJevProfileKeyForShell } from "./review-jev-profile";
import { approveProjectRouting, readRoutingSettings, setRoutingCategory, type RoutingLocation } from "../harness/routing/settings";
import { ROUTING_CATEGORIES, type RoutingCategory } from "../harness/routing/table";
import type { RoutingAssignment } from "../harness/routing/config";
import { describeLayerForApproval, describeRoutingAssignment } from "../harness/routing/trust";
import { routingDigest } from "../harness/routing/config";
import { loadCiTriageList, runCiTriageForItem } from "../tui/ci-triage-source";
import { renderCiTriageAdvisory } from "../review/ci-triage";
import { loadConformSetup, runConformForTarget } from "../tui/conform-source";
import { formatConformClauseLines, formatConformDetailLines, flattenConformClauses } from "../tui/conform-inspector";
import { buildGovernanceReport, writeGovernanceArtifacts } from "../governance/service";
import { createGovernanceFlowActions } from "../tui/governance-flow-actions";
import { formatCheckLines, formatCloseLines } from "../tui/governance-flows";
import { loadTriggerLedgerView } from "../tui/trigger-ledger";
import { createTriggerRunNow, type TriggerRunNow } from "../tui/trigger-run-now";
import { pauseStoredSchedule, removeSchedule, resumeStoredSchedule } from "../trigger/schedules";
import { runCheckAc } from "./flow-check-ac";
import { renderAcCheckReport } from "../flow/service";
import { resolveQuickStartSender, quickStartAcceptedLine } from "../tui/quick-start-command";
import { buildQuickStartRequest, parseCriteriaField } from "../tui/quick-start-request";
import { QUICK_MODES } from "../hub/work/quick-modes";
import { describeFire } from "../trigger/describe";
import { loadProjectContextStatus } from "../gdskills/project-context-status";
import { formatRunDetailText, formatRunsText, listScheduleRuns, readScheduleRun } from "./schedule-runs";

// What the view builders in `src/acp/` read from owners they may not import directly (the import
// policy keeps `src/acp` to facades and the shells' own command modules).
export { RECOMMENDED_JEV_PROFILE, QUICK_MODES, describeFire, loadProjectContextStatus, listScheduleRuns, readScheduleRun };
export { RUN_LOG_TAIL_BYTES, type RunDetail, type RunSection, type ScheduleRunSummary } from "./schedule-runs";
export type { ProjectContextStatus } from "../gdskills/project-context-status";

export interface ActionResult {
  readonly ok: boolean;
  readonly text: string;
  /** The action wrote something, so the client refreshes the view that sent it. */
  readonly changed?: boolean;
}

const done = (text: string, changed = true): ActionResult => ({ ok: true, text: text.endsWith("\n") ? text : `${text}\n`, changed });
const fail = (text: string): ActionResult => ({ ok: false, text: text.endsWith("\n") ? text : `${text}\n` });
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// ---------------------------------------------------------------------------
// /routing
// ---------------------------------------------------------------------------

export const ROUTING_SET_USAGE = "Usage: /routing set <category> <provider/model | baseline>";

/** `baseline` = follow the session; `provider/model` = that model. The model id may itself contain slashes. */
export function parseRoutingTarget(text: string): RoutingAssignment | undefined {
  const target = text.trim();
  if (target === "baseline" || target === "session") return { mode: "baseline" };
  const slash = target.indexOf("/");
  if (slash <= 0 || slash === target.length - 1) return undefined;
  return { mode: "model", target: { providerId: target.slice(0, slash), modelId: target.slice(slash + 1) } };
}

export async function routingSet(location: RoutingLocation, args: string): Promise<ActionResult> {
  const [category, ...rest] = args.trim().split(/\s+/);
  if (category === undefined || category.length === 0 || rest.length === 0) return fail(ROUTING_SET_USAGE);
  if (!(ROUTING_CATEGORIES as readonly string[]).includes(category)) {
    return fail(`Unknown routing category '${category}'. Categories: ${ROUTING_CATEGORIES.join(", ")}.`);
  }
  const assignment = parseRoutingTarget(rest.join(" "));
  if (assignment === undefined) return fail(ROUTING_SET_USAGE);
  try {
    await setRoutingCategory("user", location, category as RoutingCategory, assignment);
  } catch (error) {
    return fail(`routing: ${message(error)}`);
  }
  return done(`${category} -> ${describeRoutingAssignment(assignment)}  [user]`);
}

/** What approving the project's `routing.config.json` would trust, or why there is nothing to approve. */
export function routingTrustPreview(location: RoutingLocation): { readonly lines: readonly string[]; readonly pending: boolean } {
  try {
    const settings = readRoutingSettings(location);
    if (settings.project.trusted) return { lines: [], pending: false };
    const layer = settings.project.layer;
    const lines = layer === undefined ? [] : describeLayerForApproval(layer);
    return { lines, pending: lines.length > 0 };
  } catch {
    return { lines: [], pending: false };
  }
}

export function routingTrust(location: RoutingLocation, expectedDigest?: string): ActionResult {
  try {
    const layer = readRoutingSettings(location).project.layer;
    if (layer === undefined || describeLayerForApproval(layer).length === 0) {
      return fail("routing.config.json declares no routing settings — nothing to approve.");
    }
    if (expectedDigest !== undefined && routingDigest(layer) !== expectedDigest) {
      return fail("routing.config.json changed since it was shown; nothing was approved.");
    }
    const result = approveProjectRouting(location);
    return result.ok ? done(`Approved (${result.file}).`) : fail(`routing: ${result.error}`);
  } catch (error) {
    return fail(`routing: ${message(error)}`);
  }
}

// ---------------------------------------------------------------------------
// /jevprofile
// ---------------------------------------------------------------------------

export const JEV_PROFILE_USAGE = "Usage: /jevprofile set <key> on|off | /jevprofile apply";

export async function jevProfileSet(cwd: string, args: string): Promise<ActionResult> {
  const [key, value, ...extra] = args.trim().split(/\s+/);
  if (key === undefined || (value !== "on" && value !== "off") || extra.length > 0) return fail(JEV_PROFILE_USAGE);
  if (!RECOMMENDED_JEV_PROFILE.some((entry) => entry.key === key)) {
    return fail(`Unknown review.jev key '${key}'. Keys: ${RECOMMENDED_JEV_PROFILE.map((entry) => entry.key).join(", ")}.`);
  }
  try {
    const current = (await readJevProfileForShell(cwd))[key];
    if (current === (value === "on")) return done(`review.jev.${key} is already ${value}.`, false);
    await toggleJevProfileKeyForShell(cwd, key);
  } catch (error) {
    return fail(`/jevprofile: ${message(error)}`);
  }
  return done(`review.jev.${key}: ${value}`);
}

export async function jevProfileApply(cwd: string): Promise<ActionResult> {
  try {
    await applyRecommendedJevProfileForShell(cwd);
  } catch (error) {
    return fail(`/jevprofile: ${message(error)}`);
  }
  return done("Applied the recommended review.jev profile.");
}

// ---------------------------------------------------------------------------
// /review accept | decline
// ---------------------------------------------------------------------------

export const REVIEW_DECIDE_USAGE = "Usage: /review accept|accept-ack|decline <workspace-id> <proposal-id>";

/**
 * Accepting a proposal mints a confirm token and spends it: the human keying accept and then
 * confirming is the proof of presence (src/tui/review-accept.ts). Over a view that is the
 * action's own `confirm`, so a client must never send this line without asking first.
 */
export async function reviewDecide(cwd: string, verb: string, args: string): Promise<ActionResult> {
  const [workspaceId, proposalId, ...extra] = args.trim().split(/\s+/);
  if (workspaceId === undefined || workspaceId.length === 0 || proposalId === undefined || extra.length > 0) {
    return fail(REVIEW_DECIDE_USAGE);
  }
  const run = makeCommandRunner(cwd);
  const outcome =
    verb === "decline"
      ? await declineProposalViaShell(run, workspaceId, proposalId)
      : await acceptProposalViaShell(run, workspaceId, proposalId, { acknowledgeSecurity: verb === "accept-ack" });
  if (!outcome.ok) return fail(`${verb} failed: ${outcome.message}`);
  return done(
    verb === "decline"
      ? `Declined ${proposalId}.`
      : `Accepted ${proposalId}${verb === "accept-ack" ? " (security findings acknowledged)" : ""}.`,
  );
}

// ---------------------------------------------------------------------------
// /ci triage
// ---------------------------------------------------------------------------

export async function ciTriage(cwd: string, args: string): Promise<ActionResult> {
  const [runId, ...jobWords] = args.trim().split(/\s+/);
  if (runId === undefined || runId.length === 0) return fail("Usage: /ci triage <run id> [job name]");
  const listed = await loadCiTriageList(cwd);
  const jobName = jobWords.join(" ");
  const item = listed.items.find((candidate) => candidate.runId === runId && (jobName.length === 0 || candidate.jobName === jobName));
  if (item === undefined) return fail(`No failed job found for run ${runId}${jobName.length > 0 ? ` (${jobName})` : ""}. Reopen /ci for the current list.`);
  const result = await runCiTriageForItem(cwd, item);
  if (!result.ok) return fail(result.timedOut === true ? `Timed out triaging ${item.jobName}: ${result.reason}` : `Could not triage ${item.jobName}: ${result.reason}`);
  return done(
    renderCiTriageAdvisory({
      runId: item.runId,
      jobName: item.jobName,
      ...(result.testName !== undefined ? { testName: result.testName } : {}),
      verdict: result.verdict,
      ...(result.signalLines !== undefined && result.signalLines.length > 0 ? { signalLines: result.signalLines } : {}),
    }),
    false,
  );
}

// ---------------------------------------------------------------------------
// /conform run
// ---------------------------------------------------------------------------

export async function conformRun(cwd: string, args: string): Promise<ActionResult> {
  const [targetId, ...docWords] = args.trim().split(/\s+/);
  const refPath = docWords.join(" ");
  if (targetId === undefined || targetId.length === 0 || refPath.length === 0) return fail("Usage: /conform run <target id> <reference document>");
  const setup = await loadConformSetup(cwd);
  const target = setup.targets.find((candidate) => candidate.id === targetId);
  if (target === undefined) return fail(`Unknown conform target '${targetId}'. ${setup.note ?? `Targets: ${setup.targets.map((t) => t.id).join(", ") || "none"}.`}`);
  const outcome = await runConformForTarget(cwd, refPath, target);
  if (!outcome.ok) return fail(`conform: ${outcome.reason}`);
  const clauses = outcome.clauses;
  const lines = [
    `Conformance of ${outcome.target.label} against ${outcome.refPath}`,
    "",
    ...formatConformClauseLines(clauses, -1, outcome.hunkBudget),
  ];
  for (const row of flattenConformClauses(clauses)) {
    if (row.status === "likely-violated") lines.push("", ...formatConformDetailLines(row));
  }
  return done(lines.join("\n"), false);
}

// ---------------------------------------------------------------------------
// /governance
// ---------------------------------------------------------------------------

/** What bare `keryx governance report` builds, in this process: read-only over recorded artifacts, no model, no network. */
export async function governanceRun(cwd: string): Promise<ActionResult> {
  try {
    const report = await buildGovernanceReport({
      cwd,
      filters: { flow: undefined, owner: undefined, since: undefined, until: undefined },
      allProjects: false,
      now: () => new Date(),
    });
    await writeGovernanceArtifacts(cwd, report);
    return done(`Governance report written (${report.generatedAt}).`);
  } catch (error) {
    return fail(`Governance report failed: ${message(error)}`);
  }
}

export async function governanceCheck(cwd: string, id: string): Promise<ActionResult> {
  if (id.length === 0) return fail("Usage: /governance check <flow id>");
  try {
    return done(formatCheckLines(await createGovernanceFlowActions(cwd).check(id)).join("\n"), false);
  } catch (error) {
    return fail(`governance check: ${message(error)}`);
  }
}

/** `keryx flow complete`, signed as the CLI signs it. A flow that needs a confirmation token is closed in a terminal. */
export async function governanceClose(cwd: string, id: string): Promise<ActionResult> {
  if (id.length === 0) return fail("Usage: /governance close <flow id>");
  const actions = createGovernanceFlowActions(cwd);
  try {
    const check = await actions.check(id);
    if (check.confirmationRequired) {
      return fail(`Flow ${id} needs a confirmation token: run \`keryx flow confirm ${id}\` and then \`keryx flow complete ${id} --confirm-token <token>\` in a terminal.`);
    }
    const result = await actions.close(id);
    const text = formatCloseLines(result).join("\n");
    return result.passed ? done(text) : fail(text);
  } catch (error) {
    return fail(`governance close: ${message(error)}`);
  }
}

// ---------------------------------------------------------------------------
// /triggers run, /schedules pause | resume | run | delete
// ---------------------------------------------------------------------------

const runners = new Map<string, TriggerRunNow>();
/** One run-now owner per project root, so a second `run` of a trigger that is still going is refused. */
function runNowFor(root: string): TriggerRunNow {
  let runner = runners.get(root);
  if (runner === undefined) {
    runner = createTriggerRunNow({ root });
    runners.set(root, runner);
  }
  return runner;
}

/** Starts `keryx trigger run <name>` detached, bound by the CLI's own locks, budget and refusals, and answers once it is running. */
export async function triggerRunNow(cwd: string, name: string, options: { readonly schedule?: boolean } = {}): Promise<ActionResult> {
  if (name.length === 0) return fail(options.schedule === true ? "Usage: /schedules run <name>" : "Usage: /triggers run <name>");
  const view = await loadTriggerLedgerView(cwd);
  const found = view.entries.find((candidate) => candidate.entry.name === name);
  if (found === undefined) {
    const rejected = view.rejected.find((candidate) => candidate.name === name);
    return fail(
      rejected !== undefined
        ? `${name} is malformed and cannot run: ${rejected.reasons.join("; ")} — fix .metaproject/triggers.json`
        : `No trigger or schedule named '${name}'.`,
    );
  }
  if (!found.entry.enabled) return fail(`${name} is disabled — \`keryx trigger run\` would do nothing but record a no-op; enable it first.`);
  if (options.schedule === true && !found.scheduled) return fail(`${name} is an event trigger, not a schedule. Use /triggers run ${name}.`);
  const runner = runNowFor(cwd);
  const pending = runner.run(name, options.schedule === true ? { schedule: true } : {});
  if (pending === undefined) return fail(`${name} is already running from this session.`);
  const log = runner.inFlightRuns().find((run) => run.name === name)?.logPath;
  return done(`Started ${name}. It keeps running in the background${log !== undefined ? `; log: ${log}` : ""}.`);
}

export async function schedulePause(cwd: string, name: string): Promise<ActionResult> {
  if (name.length === 0) return fail("Usage: /schedules pause <name>");
  try {
    await pauseStoredSchedule(cwd, name);
  } catch (error) {
    return fail(`schedules pause: ${message(error)}`);
  }
  return done(`Paused ${name}.`);
}

export async function scheduleResume(cwd: string, name: string): Promise<ActionResult> {
  if (name.length === 0) return fail("Usage: /schedules resume <name>");
  try {
    await resumeStoredSchedule(cwd, name);
  } catch (error) {
    return fail(`schedules resume: ${message(error)}`);
  }
  return done(`Resumed ${name}.`);
}

export async function scheduleDelete(cwd: string, name: string): Promise<ActionResult> {
  if (name.length === 0) return fail("Usage: /schedules delete <name>");
  try {
    const removed = await removeSchedule(cwd, name);
    return done(`Deleted ${name}${removed.skipped.length > 0 ? ` (left in place: ${removed.skipped.join(", ")})` : ""}.`);
  } catch (error) {
    return fail(`schedules delete: ${message(error)}`);
  }
}

/** `/schedules runs [<name>]`: recent runs, newest first (every schedule's when no name). */
export async function scheduleRuns(cwd: string, name: string): Promise<ActionResult> {
  const read = await listScheduleRuns(cwd, name.trim());
  return read.ok ? done(formatRunsText(read.runs, name.trim()), false) : fail(read.reason);
}

/** `/schedules run-log <name> <run id>`: one run's report and the tail of its log (64 KB at most, said when cut). */
export async function scheduleRunLog(cwd: string, args: string): Promise<ActionResult> {
  const [name, runId, ...extra] = args.trim().split(/\s+/);
  if (name === undefined || name.length === 0 || runId === undefined || extra.length > 0) return fail("Usage: /schedules run-log <name> <run id>");
  const read = await readScheduleRun(cwd, name, runId);
  return read.ok ? done(formatRunDetailText(read.detail), false) : fail(read.reason);
}

// ---------------------------------------------------------------------------
// /ac recheck
// ---------------------------------------------------------------------------

export async function acRecheck(cwd: string, flowId: string): Promise<ActionResult> {
  if (flowId.length === 0) return fail("Usage: /ac recheck <flow id>");
  try {
    const result = await runCheckAc(cwd, flowId, {});
    return done(
      renderAcCheckReport({
        flowId: result.flowId,
        verdicts: result.verdicts,
        jevAsked: result.jevAsked,
        ...(result.usage !== undefined ? { usage: result.usage } : {}),
        at: result.at,
        criteriaChecksum: result.criteriaChecksum,
        diffHash: result.diffHash,
      }),
      true,
    );
  } catch (error) {
    return fail(`acceptance-criteria check failed: ${message(error)}`);
  }
}

// ---------------------------------------------------------------------------
// /task
// ---------------------------------------------------------------------------

export const TASK_USAGE = `Usage: /task <${QUICK_MODES.map((mode) => mode.id).join("|")}> <description> [|| criterion; criterion]`;

/** `<mode> <description> [|| criteria]`: the criteria field uses `;` between sentences, as the web dialog does. */
export function parseTaskArgs(args: string): { readonly mode: string; readonly description: string; readonly criteria: string[] } | undefined {
  const text = args.trim();
  const space = text.search(/\s/);
  if (space <= 0) return undefined;
  const mode = text.slice(0, space);
  const rest = text.slice(space + 1);
  const bar = rest.lastIndexOf("||");
  const description = (bar >= 0 ? rest.slice(0, bar) : rest).trim();
  if (description.length === 0 || !QUICK_MODES.some((candidate) => candidate.id === mode)) return undefined;
  return { mode, description, criteria: bar >= 0 ? parseCriteriaField(rest.slice(bar + 2)) : [] };
}

/** The Hub's quick-start route, through the connection `keryx work` uses. Refused when this checkout is not connected or the token is unset. */
export async function taskSubmit(cwd: string, args: string, env?: Record<string, string | undefined>): Promise<ActionResult> {
  const parsed = parseTaskArgs(args);
  if (parsed === undefined) return fail(TASK_USAGE);
  const resolved = await resolveQuickStartSender({ cwd, ...(env !== undefined ? { env } : {}) });
  if (!resolved.ok) return fail(`/task: ${resolved.reason}`);
  const outcome = await resolved.send(randomUUID(), buildQuickStartRequest({ mode: parsed.mode, description: parsed.description, answers: {}, criteria: parsed.criteria }));
  if (outcome.kind === "accepted") return done(quickStartAcceptedLine(outcome.flowId));
  return fail(`/task: ${outcome.message}`);
}
