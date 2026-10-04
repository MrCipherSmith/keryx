// Flow 403 (AC1-3, AC14-17): one poll of intake, and the delivery of its cards.
//
// A poll is one more run on the machinery of the scheduled digest (flow 295/389): the same granted read-only gh
// tools with a fixed argv, the same `GhRunner` seam, the same pinned `gh`, the same path-chosen GitHub account, the
// same limits (time, memory, dollars) and the same delivery back-off. What differs is what it does with the answers:
// the digest summarises them, a poll turns each NEW event into one card.
//
//   1. lock, config, pinned `gh`, scratch directory, limits
//   2. collect: gh per repository, and the board
//   3. baseline: a source read for the first time marks everything seen and makes no card
//   4. new events -> one model assessment each (no tools, inside the budget) -> a registered card
//   5. state (what is now seen), then flush: quiet hours, the hourly limit, the overflow card
//   6. report, and a status line in the topic when something went wrong
//
// Nothing here writes to GitHub or to a flow. A human's press (parts 2-3) is the only thing that does.

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { agentTaskScratchParent, pruneReports, scrubGrantedOutput } from "../commands/trigger-agent-task";
import { dispatchLockPath } from "../commands/trigger-dispatch";
import { ensureScratchParent } from "../commands/unattended-scratch";
import { withFileLock } from "../lib/fs";
import { ensureLocksDir } from "../lib/maintenance-lock";
import { backoffMs, DELIVERY_MAX_ATTEMPTS } from "../scheduler/digest-delivery";
import { defaultGhRunner, ghEnvForProject, type GhAccount, type GhRunner } from "../scheduler/digest-gh";
import { startLimits, type DigestLimitDeps } from "../scheduler/digest-limits";
import { pinGrantedBinary, resolveOnPath, verifyGrantedBinary, type VerifiedFile } from "../trigger/granted-binary";
import { inQuietHours, intakeDataDir, readIntakeConfig } from "./config";
import { collectIntakeEvents, type IntakeCollectResult } from "./events";
import {
  appendIntakeIfState,
  cardIdFor,
  ensureIntakeDataIgnored,
  overflowCardId,
  readIntakeCardView,
  readIntakeCards,
  readIntakeLedger,
  readIntakeLedgerCards,
  readIntakeState,
  registerIntakeCard,
  updateIntakeCard,
  updateIntakeState,
} from "./store";
import {
  INTAKE_ACTIONS_BY_KIND,
  INTAKE_OPEN_STATES,
  type IntakeAction,
  type IntakeAssessor,
  type IntakeCardContent,
  type IntakeCardSink,
  type IntakeConfig,
  type IntakeEvent,
  type IntakeFailure,
  type IntakePollResult,
  type IntakeRunOutcome,
  type IntakeState,
  type IntakeStopReason,
} from "./types";

/** Injectable seams. Production passes `sink` (serve's Telegram path) and `assess` (the model); a test passes fakes. */
export interface IntakeDeps {
  readonly now?: () => Date;
  readonly runId?: () => string;
  /** The environment gh inherits (allowlisted) and PATH is searched in. Default `process.env`. */
  readonly env?: Record<string, string | undefined>;
  readonly runGh?: GhRunner;
  readonly limits?: DigestLimitDeps;
  /** The model call that writes the assessment. Without one a card carries no assessment and no suggestion. */
  readonly assess?: IntakeAssessor;
  readonly sink?: IntakeCardSink;
  /** Replaces the stored config. */
  readonly config?: IntakeConfig;
  /** A poll the operator asked for (`keryx intake poll`): it runs even while the automatic poll is paused. */
  readonly manual?: boolean;
}

const ASSESSMENT_MAX = 400;
const STATUS_LINE_MAX = 600;
const STATUS_REPEAT_MS = 60 * 60_000;
const HOUR_MS = 60 * 60_000;
const REPORTS_KEEP = 50;

export const intakeReportsDir = (root: string): string => path.join(intakeDataDir(root), "reports");

/** True when the automatic poll is due: never polled, or the interval has passed. */
export function intakePollDue(config: IntakeConfig, state: IntakeState, now: Date): boolean {
  if (!config.enabled || state.paused || config.repos.length === 0) return false;
  if (state.lastPollAt === undefined) return true;
  return now.getTime() - Date.parse(state.lastPollAt) >= config.intervalMinutes * 60_000;
}

/** When the next automatic poll is due, or null while disabled, paused or never polled yet. */
export function nextIntakePollAt(config: IntakeConfig, state: IntakeState): string | null {
  if (!config.enabled || state.paused || config.repos.length === 0 || state.lastPollAt === undefined) return null;
  return new Date(Date.parse(state.lastPollAt) + config.intervalMinutes * 60_000).toISOString();
}

function newRunId(now: Date): string {
  return `ink-${now.toISOString().replace(/[-:.]/g, "").slice(0, 15)}-${randomUUID().slice(0, 8)}`;
}

function emptyResult(runId: string, outcome: IntakeRunOutcome, detail: string): IntakePollResult {
  return { runId, outcome, detail, baseline: false, newEvents: 0, cardIds: [], sent: 0, collapsed: 0, held: 0, failures: [], costUsd: 0 };
}

// ---- cards ---------------------------------------------------------------------------------

function cardContent(event: IntakeEvent, assessed: { assessment?: string; suggestion?: string }, config: IntakeConfig, account: GhAccount, now: Date): IntakeCardContent {
  const takeAllowed = event.kind === "issue" && (account === "personal" || config.allowTakeInWork);
  const actions = INTAKE_ACTIONS_BY_KIND[event.kind].filter((a) => a !== "take" || takeAllowed);
  const suggestion = actions.find((a) => a === assessed.suggestion);
  const assessment = assessed.assessment?.trim();
  return {
    id: cardIdFor(event.key, event.stamp),
    eventKey: event.key,
    stamp: event.stamp,
    kind: event.kind,
    ...(event.repo !== undefined ? { repo: event.repo } : {}),
    ref: event.ref,
    title: event.title,
    ...(event.url !== undefined ? { url: event.url } : {}),
    ...(assessment !== undefined && assessment.length > 0 ? { assessment: assessment.slice(0, ASSESSMENT_MAX) } : {}),
    ...(suggestion !== undefined ? { suggestion } : {}),
    actions,
    takeAllowed,
    account,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + config.buttonTtlHours * HOUR_MS).toISOString(),
  };
}

// ---- the poll ------------------------------------------------------------------------------

export async function runIntakePoll(root: string, deps: IntakeDeps = {}): Promise<IntakePollResult> {
  const now = deps.now ?? (() => new Date());
  const runId = deps.runId?.() ?? newRunId(now());
  const config = deps.config ?? (await readIntakeConfig(root));
  if (!config.enabled) return emptyResult(runId, "skipped", "intake is disabled in its config");
  if (config.repos.length === 0) return emptyResult(runId, "skipped", "no repository is configured for intake");
  const state = await readIntakeState(root);
  if (state.paused && deps.manual !== true) return emptyResult(runId, "skipped", "intake is paused — resume it, or poll by hand");
  await ensureLocksDir(root);
  try {
    return await withFileLock(dispatchLockPath(root, "intake-poll"), () => pollLocked(root, config, deps, runId, now), { timeoutMs: 0 });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Timed out waiting for lock:")) return emptyResult(runId, "skipped", "an intake poll is already running");
    throw error;
  }
}

async function verifyGh(root: string, env: Record<string, string | undefined>): Promise<{ ok: true; bin: string; files: readonly VerifiedFile[] } | { ok: false; reason: string }> {
  const found = resolveOnPath("gh", env["PATH"]);
  if (found === undefined) return { ok: false, reason: '"gh" was not found on PATH' };
  const pinned = pinGrantedBinary("gh", found, root, env["PATH"]);
  if (!pinned.ok) return pinned;
  const verified = await verifyGrantedBinary("gh", found, pinned.pin, root, env["PATH"]);
  if (!verified.ok) return verified;
  return { ok: true, bin: verified.realpath, files: verified.files };
}

async function pollLocked(root: string, config: IntakeConfig, deps: IntakeDeps, runId: string, now: () => Date): Promise<IntakePollResult> {
  const env = deps.env ?? process.env;
  const startedAt = now();
  const ghEnv = ghEnvForProject(root, env);
  const account: GhAccount = ghEnv["GH_ACCOUNT"] === "work" ? "work" : "personal";
  const state = await readIntakeState(root);
  const failures: IntakeFailure[] = [];
  let collected: IntakeCollectResult = { reads: [], failures: [], calls: [], stopped: false };
  const cardIds: string[] = [];
  let newEvents = 0;
  let baseline = false;
  let costUsd = 0;
  let crashed: string | undefined;
  let stopReason: string | undefined;
  let stoppedBy: IntakeStopReason | undefined;
  const modelFailures = new Map<string, number>();

  const parent = await ensureScratchParent(agentTaskScratchParent(env));
  let scratch: string | undefined;
  if (!parent.ok) failures.push({ source: "gh", detail: `not started: ${parent.reason}` });
  else scratch = await mkdtemp(path.join(parent.dir, "intake-"));
  const limits = startLimits({ maxSeconds: config.maxSeconds, memoryLimitMb: config.memoryLimitMb }, deps.limits ?? {});

  try {
    if (scratch !== undefined) {
      const cwd = path.join(scratch, "granted-cwd");
      await mkdir(cwd, { recursive: true, mode: 0o700 });
      const gh = await verifyGh(root, env);
      if (!gh.ok) failures.push({ source: "gh", detail: `refusing to run: ${gh.reason}` });
      else {
        collected = await collectIntakeEvents({
          projectRoot: root,
          repos: config.repos,
          rows: config.rows,
          bin: gh.bin,
          stats: gh.files,
          cwd,
          // The account follows the PROJECT'S path (work vs personal). No `auth` subcommand is ever run.
          env: ghEnv,
          runGh: deps.runGh ?? defaultGhRunner,
          limits,
        });
        failures.push(...collected.failures);
      }
    }

    // --- baseline and new events -----------------------------------------------------------
    const baselined = new Set(state.baselined);
    const newlyBaselined: string[] = [];
    const found: IntakeEvent[] = [];
    const seenUpdates: Record<string, string> = {};
    let baselineReads = 0;
    for (const read of collected.reads) {
      if (!baselined.has(read.source)) {
        for (const e of read.events) seenUpdates[e.key] = e.stamp;
        newlyBaselined.push(read.source);
        baselineReads += 1;
        continue;
      }
      for (const e of read.events) {
        const before = state.seen[e.key];
        // A board entry that MOVED is news; a ticket, review, run or comment that merely changed `updatedAt` is not.
        if (before === undefined || (e.kind === "board" && before !== e.stamp)) found.push(e);
      }
    }
    baseline = collected.reads.length > 0 && baselineReads === collected.reads.length;
    found.sort((a, b) => a.stamp.localeCompare(b.stamp));
    newEvents = found.length;

    // --- assess, register -------------------------------------------------------------------
    const known = await readIntakeCards(root);
    const recent: IntakeState["recent"][number][] = [];
    const assess = deps.assess !== undefined && config.budgetUsd > 0 ? deps.assess : undefined;
    for (const event of found) {
      if (limits.signal.aborted) break;
      const id = cardIdFor(event.key, event.stamp);
      if (known[id] !== undefined) {
        seenUpdates[event.key] = event.stamp;
        newEvents -= 1;
        continue;
      }
      let assessed: { assessment?: string; suggestion?: string } = {};
      if (assess !== undefined) {
        try {
          const result = await assess({ event, allowed: INTAKE_ACTIONS_BY_KIND[event.kind] as readonly IntakeAction[], signal: limits.signal, remainingUsd: Math.max(0, config.budgetUsd - costUsd) });
          costUsd += result.costUsd;
          if (result.ok) assessed = { assessment: result.assessment, ...(result.suggestion !== undefined ? { suggestion: result.suggestion } : {}) };
          else modelFailures.set(result.reason, (modelFailures.get(result.reason) ?? 0) + 1);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          modelFailures.set(reason, (modelFailures.get(reason) ?? 0) + 1);
        }
        // Over budget the run stops; events not yet carded stay unseen, so the next poll cards them.
        if (costUsd >= config.budgetUsd) limits.spendStopped();
      }
      const content = cardContent(event, assessed, config, account, startedAt);
      await registerIntakeCard(root, content);
      cardIds.push(content.id);
      seenUpdates[event.key] = event.stamp;
      recent.push({ at: startedAt.toISOString(), key: event.key, kind: event.kind, cardId: content.id });
    }
    for (const [reason, count] of modelFailures) failures.push({ source: "model", detail: `${count} assessment(s) failed: ${reason}` });

    await updateIntakeState(root, (s) => ({
      ...s,
      seen: { ...s.seen, ...seenUpdates },
      baselined: [...new Set([...s.baselined, ...newlyBaselined])],
      recent: [...s.recent, ...recent],
    }));
  } catch (error) {
    crashed = error instanceof Error ? error.message : String(error);
  } finally {
    stopReason = limits.reason();
    const tripped = limits.tripped();
    if (tripped !== undefined) stoppedBy = tripped;
    limits.dispose();
    if (scratch !== undefined) await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }

  // --- flush ---------------------------------------------------------------------------------
  let flushed = { sent: 0, collapsed: 0, held: 0 };
  try {
    const f = await flushIntakeCards(root, deps);
    flushed = f;
    failures.push(...f.failures);
  } catch (error) {
    failures.push({ source: "delivery", detail: `flush failed: ${error instanceof Error ? error.message : String(error)}` });
  }

  // --- outcome -------------------------------------------------------------------------------
  const firstCause = failures.find((f) => f.source !== "board");
  const unread = `no GitHub source could be read${firstCause !== undefined ? ` — ${firstCause.source}: ${firstCause.detail}` : ""}`;
  const why = stopReason ?? (crashed !== undefined ? `the poll threw: ${crashed}` : collected.reads.every((r) => r.source === "board") ? unread : undefined);
  const outcome: IntakeRunOutcome = why === undefined ? "ok" : "failed";
  const detail =
    outcome === "ok"
      ? baseline
        ? "baseline taken — nothing was reported"
        : `${newEvents} new event(s), ${cardIds.length} card(s)`
      : `run failed: ${why}`;

  const reportPath = await writeReport(root, {
    runId,
    at: startedAt.toISOString(),
    outcome,
    detail,
    baseline,
    repos: config.repos,
    account: ghEnv["GH_ACCOUNT"],
    costUsd,
    budgetUsd: config.budgetUsd,
    calls: collected.calls.map((c) => `${c.tool} → ${c.ok ? "ok" : `failed (exit ${c.exitCode ?? "?"})`}`),
    failures,
    cards: cardIds.length,
    flushed,
    env,
  });

  // --- the status line -------------------------------------------------------------------------
  const statusLine = await announce(root, deps, now, env, why, failures, reportPath);

  await updateIntakeState(root, (s) => ({
    ...s,
    lastPollAt: startedAt.toISOString(),
    lastRun: { runId, at: startedAt.toISOString(), outcome, detail, newEvents, cards: cardIds.length, failures: failures.length },
  }));

  return {
    runId,
    outcome,
    detail,
    baseline,
    newEvents,
    cardIds,
    sent: flushed.sent,
    collapsed: flushed.collapsed,
    held: flushed.held,
    failures,
    costUsd,
    ...(stoppedBy !== undefined ? { stoppedBy } : {}),
    ...(statusLine !== undefined ? { statusLine } : {}),
    ...(reportPath !== undefined ? { reportPath } : {}),
    ghAccount: ghEnv["GH_ACCOUNT"] ?? "none",
  };
}

// ---- report and status line --------------------------------------------------------------------

interface ReportInput {
  readonly runId: string;
  readonly at: string;
  readonly outcome: IntakeRunOutcome;
  readonly detail: string;
  readonly baseline: boolean;
  readonly repos: readonly string[];
  readonly account: string | undefined;
  readonly costUsd: number;
  readonly budgetUsd: number;
  readonly calls: readonly string[];
  readonly failures: readonly IntakeFailure[];
  readonly cards: number;
  readonly flushed: { readonly sent: number; readonly collapsed: number; readonly held: number };
  readonly env: Record<string, string | undefined>;
}

async function writeReport(root: string, r: ReportInput): Promise<string | undefined> {
  const lines = [
    `# Intake poll ${r.at}`,
    "",
    `- run: ${r.runId}`,
    `- outcome: ${r.outcome} (${r.detail})`,
    `- kind: ${r.baseline ? "baseline (first read of every source, nothing to compare with)" : "diff against what was seen before"}`,
    `- repositories: ${r.repos.join(", ")}`,
    `- gh account asked for: ${r.account ?? "none"} (set through GH_ACCOUNT; only the gh wrapper honours it, the real gh uses its active login)`,
    `- model cost: $${r.costUsd.toFixed(4)} of $${r.budgetUsd.toFixed(2)}`,
    `- cards made: ${r.cards}; sent: ${r.flushed.sent}; folded into the overflow card: ${r.flushed.collapsed}; still waiting: ${r.flushed.held}`,
    "",
    "## Granted tool calls",
    "",
    ...(r.calls.length === 0 ? ["- none"] : r.calls.map((c) => `- ${c}`)),
    "",
    "## Failures",
    "",
    ...(r.failures.length === 0 ? ["- none"] : r.failures.map((f) => `- ${f.source}: ${f.detail}`)),
    "",
  ];
  try {
    await ensureIntakeDataIgnored(root);
    const dir = intakeReportsDir(root);
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${r.runId}.md`);
    await writeFile(file, scrubGrantedOutput(lines.join("\n"), r.env), "utf8");
    await pruneReports(dir, REPORTS_KEEP);
    return path.relative(root, file);
  } catch {
    return undefined;
  }
}

/** A missing product index is the normal state of a project that never built one: it is in the report, not in the topic. */
function worthAStatusLine(f: IntakeFailure): boolean {
  return !(f.source === "board" && f.detail.startsWith("no product index"));
}

async function announce(
  root: string,
  deps: IntakeDeps,
  now: () => Date,
  env: Record<string, string | undefined>,
  why: string | undefined,
  failures: readonly IntakeFailure[],
  reportPath: string | undefined,
): Promise<string | undefined> {
  const loud = failures.filter(worthAStatusLine);
  if (why === undefined && loud.length === 0) return undefined;
  const core =
    why !== undefined
      ? `Intake: опрос остановлен — ${why}`
      : `Intake: не все источники прочитаны (${loud.length}): ${loud.slice(0, 4).map((f) => `${f.source}: ${f.detail}`).join("; ")}`;
  const text = scrubGrantedOutput(core.length > STATUS_LINE_MAX ? `${core.slice(0, STATUS_LINE_MAX)}…` : core, env);
  const state = await readIntakeState(root);
  const at = now();
  if (state.lastStatus !== undefined && state.lastStatus.text === text && at.getTime() - Date.parse(state.lastStatus.at) < STATUS_REPEAT_MS) return text;
  if (deps.sink === undefined) return text;
  let ok = false;
  try {
    ok = (await deps.sink.sendStatus(`${text}${reportPath !== undefined ? `\nОтчёт: ${reportPath}` : ""}`)).ok;
  } catch {
    ok = false;
  }
  if (ok) await updateIntakeState(root, (s) => ({ ...s, lastStatus: { text, at: at.toISOString() } }));
  return text;
}

// ---- delivery: quiet hours, the hourly limit, the overflow card -----------------------------------

export interface IntakeFlushResult {
  readonly sent: number;
  readonly collapsed: number;
  readonly held: number;
  readonly expired: number;
  readonly reminded: number;
  readonly failures: readonly IntakeFailure[];
  readonly overflowCardId?: string;
  /** True when another flush held the lock: nothing was done. */
  readonly skipped?: boolean;
}

const NOTHING: IntakeFlushResult = { sent: 0, collapsed: 0, held: 0, expired: 0, reminded: 0, failures: [] };

/**
 * Send what is queued, within quiet hours and the hourly limit. Safe to call at any time (the serve ticker calls it
 * after a restart: a card queued while serve was stopped goes out then); a second concurrent call does nothing.
 */
export async function flushIntakeCards(root: string, deps: IntakeDeps = {}): Promise<IntakeFlushResult> {
  await ensureLocksDir(root);
  try {
    return await withFileLock(dispatchLockPath(root, "intake-flush"), () => flushLocked(root, deps), { timeoutMs: 0 });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Timed out waiting for lock:")) return { ...NOTHING, skipped: true };
    throw error;
  }
}

async function flushLocked(root: string, deps: IntakeDeps): Promise<IntakeFlushResult> {
  const now = deps.now ?? (() => new Date());
  const config = deps.config ?? (await readIntakeConfig(root));
  const at = now();
  const quiet = inQuietHours(at, config.quietHours);
  const failures: IntakeFailure[] = [];
  let expired = 0;
  let reminded = 0;

  const contents = await readIntakeCards(root);
  for (const c of await readIntakeLedgerCards(root)) {
    const content = contents[c.cardId];
    if (content !== undefined && INTAKE_OPEN_STATES.includes(c.state) && Date.parse(content.expiresAt) <= at.getTime()) {
      const r = await appendIntakeIfState(root, c.cardId, [c.state], { state: "expired", at: at.toISOString(), reason: "buttons expired" });
      if (r.ok) expired += 1;
    }
    // «Позже» brings the card back once, outside quiet hours, with a fresh button lifetime.
    if (!quiet && content !== undefined && c.state === "decided" && c.choice === "later" && !c.reminded && c.remindAt !== undefined && Date.parse(c.remindAt) <= at.getTime()) {
      const r = await appendIntakeIfState(root, c.cardId, ["decided"], { state: "queued", at: at.toISOString(), reason: "reminder" });
      if (r.ok) {
        reminded += 1;
        const expiresAt = new Date(at.getTime() + config.buttonTtlHours * HOUR_MS).toISOString();
        await updateIntakeCard(root, c.cardId, (card) => ({ ...card, expiresAt }));
      }
    }
  }

  const folded = await readIntakeLedgerCards(root);
  const queued = folded.filter((c) => c.state === "queued").sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  const base = { expired, reminded, failures };
  if (quiet || deps.sink === undefined) return { ...base, sent: 0, collapsed: 0, held: queued.length };

  const state = await readIntakeState(root);
  const due = queued.filter((c) => {
    const retry = state.delivery[c.cardId];
    return retry === undefined || Date.parse(retry.nextAt) <= at.getTime();
  });
  const overflowDue = due.filter((c) => c.kind === "overflow");
  const regular = due.filter((c) => c.kind !== "overflow");

  const ledger = await readIntakeLedger(root);
  const since = at.getTime() - HOUR_MS;
  const sentThisHour = ledger.filter((r) => r.state === "sent" && r.kind !== "overflow" && Date.parse(r.at) > since).length;
  const allowance = Math.max(0, config.cardsPerHour - sentThisHour);

  let sent = 0;
  const deliver = async (cardId: string): Promise<boolean> => {
    const view = await readIntakeCardView(root, cardId);
    if (view === undefined) return false;
    let outcome: Awaited<ReturnType<IntakeCardSink["sendCard"]>>;
    try {
      outcome = await deps.sink!.sendCard(view);
    } catch (error) {
      outcome = { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
    if (outcome.ok) {
      await appendIntakeIfState(root, cardId, ["queued"], {
        state: "sent",
        at: now().toISOString(),
        ...(outcome.chatId !== undefined ? { chatId: outcome.chatId } : {}),
        ...(outcome.messageId !== undefined ? { messageId: outcome.messageId } : {}),
      });
      await updateIntakeState(root, (s) => {
        const { [cardId]: _gone, ...rest } = s.delivery;
        return { ...s, delivery: rest };
      });
      sent += 1;
      return true;
    }
    const attempts = (state.delivery[cardId]?.attempts ?? 0) + 1;
    if (attempts >= DELIVERY_MAX_ATTEMPTS) {
      await appendIntakeIfState(root, cardId, ["queued"], { state: "undelivered", at: now().toISOString(), reason: `gave up after ${attempts} attempts` });
      failures.push({ source: "delivery", detail: `card ${cardId}: gave up after ${attempts} attempts: ${outcome.reason}` });
    } else {
      const nextAt = new Date(now().getTime() + backoffMs(attempts)).toISOString();
      await updateIntakeState(root, (s) => ({ ...s, delivery: { ...s.delivery, [cardId]: { attempts, nextAt } } }));
      failures.push({ source: "delivery", detail: `card ${cardId}: ${outcome.reason} (attempt ${attempts}, retrying after ${nextAt})` });
    }
    return false;
  };

  for (const c of overflowDue) await deliver(c.cardId);
  for (const c of regular.slice(0, allowance)) await deliver(c.cardId);

  // Over the limit: one "ещё N событий" card, never a lost event. The folded cards stay open for a decision in the TUI.
  const over = regular.slice(allowance);
  let collapsed = 0;
  let overflowId: string | undefined;
  if (over.length > 0) {
    const recentOverflow = [...ledger].reverse().find((r) => r.kind === "overflow" && r.state === "sent" && Date.parse(r.at) > since);
    const ids = over.map((c) => c.cardId);
    if (recentOverflow !== undefined) {
      overflowId = recentOverflow.cardId;
      for (const id of ids) {
        const r = await appendIntakeIfState(root, id, ["queued"], { state: "collapsed", at: at.toISOString(), collapsedInto: recentOverflow.cardId });
        if (r.ok) collapsed += 1;
      }
      await updateIntakeCard(root, recentOverflow.cardId, (card) => {
        const all = [...(card.collapsedIds ?? []), ...ids];
        return { ...card, collapsedIds: all, title: `ещё ${all.length} событий`, ref: String(all.length) };
      });
    } else {
      overflowId = overflowCardId(`${at.toISOString()}|${ids.join(",")}`);
      const first = contents[ids[0]!];
      const content: IntakeCardContent = {
        id: overflowId,
        eventKey: `overflow:${overflowId}`,
        stamp: at.toISOString(),
        kind: "overflow",
        ref: String(ids.length),
        title: `ещё ${ids.length} событий`,
        actions: [],
        takeAllowed: false,
        account: first?.account ?? "personal",
        createdAt: at.toISOString(),
        expiresAt: new Date(at.getTime() + config.buttonTtlHours * HOUR_MS).toISOString(),
        collapsedIds: ids,
      };
      if (await registerIntakeCard(root, content)) {
        for (const id of ids) {
          const r = await appendIntakeIfState(root, id, ["queued"], { state: "collapsed", at: at.toISOString(), collapsedInto: overflowId });
          if (r.ok) collapsed += 1;
        }
        await deliver(overflowId);
      }
    }
  }

  const held = (await readIntakeLedgerCards(root)).filter((c) => c.state === "queued").length;
  return { ...base, sent, collapsed, held, ...(overflowId !== undefined ? { overflowCardId: overflowId } : {}) };
}

// ---- the tick ---------------------------------------------------------------------------------

/** What `keryx serve` calls on every tick: send what is waiting, then poll when the interval has passed. */
export async function runIntakeTick(root: string, deps: IntakeDeps = {}): Promise<{ readonly poll?: IntakePollResult; readonly flush: IntakeFlushResult }> {
  const now = deps.now ?? (() => new Date());
  const config = deps.config ?? (await readIntakeConfig(root));
  const withConfig: IntakeDeps = { ...deps, config };
  if (!config.enabled) return { flush: NOTHING };
  const state = await readIntakeState(root);
  if (!intakePollDue(config, state, now())) return { flush: await flushIntakeCards(root, withConfig) };
  const poll = await runIntakePoll(root, withConfig);
  // The poll flushed on its own unless it was refused before it started.
  return poll.outcome === "skipped" ? { poll, flush: await flushIntakeCards(root, withConfig) } : { poll, flush: NOTHING };
}
