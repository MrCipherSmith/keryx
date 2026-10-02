// Flow 389 (AC2, AC4-AC7): one run of the scheduled digest.
//
// A digest is an `agent-task` schedule (flow 295) whose action carries a `digest` block.
// `runTriggerOnce` hands it here instead of to the agent loop. Everything flow 295 gives
// a scheduled run still holds: the per-schedule lock, the confirmed-content hash, the
// pinned `gh` binary, the 0700 scratch directory, the spend reservation and the report
// under `.metaproject/data/trigger/reports/<name>/`. What differs is who calls the tools:
// the DISPATCHER does, in a fixed order, for every allowed repository. The model (if one
// runs at all) only summarises the result and has no tools.
//
//   1. lock, confirmed hash, pinned binaries      -> refusal before anything runs
//   2. limits (time, memory, dollars)             -> one AbortSignal that stops everything
//   3. gh: the granted read-only tools, per repo  -> items, or a failure entry per source
//   4. the board: the product index               -> items, and the "merged, effect not checked" chains
//   5. snapshot, diff, content                    -> what changed, what is stuck, what needs a decision
//   6. an optional model summary                  -> above the text, never instead of it
//   7. the report, then the delivery queue        -> serve flushes the queue (digest-delivery.ts)
//
// A failure of one source never stops the others: it becomes a line in the digest and in
// the report. A limit stops the whole run, and the report and the topic say which one.

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { ensureScratchParent } from "../commands/unattended-scratch";
import {
  agentTaskScratchParent,
  pruneReports,
  refusal,
  type AgentTaskDeps,
  type AgentTaskResult,
} from "../commands/trigger-agent-task";
import { dispatchLockPath } from "../commands/trigger-dispatch";
import { withFileLock } from "../lib/fs";
import { ensureLocksDir } from "../lib/maintenance-lock";
import { buildOpenReport, checkStaleness, readIntentIndex, type OpenEntry } from "../product/service";
import type { AgentTaskAction, TriggerEntry } from "../trigger/config";
import { DIGEST_TOOL_IDS } from "../trigger/granted-tools";
import type { TriggerRunCost, TriggerRunOutcomeKind } from "../trigger/record";
import { confirmedContentProblem, verifyGrantedBinaries } from "../trigger/schedule-verify";
import { ensureTriggerDataIgnored, triggerReportsDir } from "../trigger/store";
import { collectFromGithub, type CollectResult } from "./digest-collect";
import { buildDigestContent, renderDigestText, type DigestContent, type DigestFailure } from "./digest-content";
import { appendDeliveryLine, enqueueDelivery, flushDeliveries, type DigestSink } from "./digest-delivery";
import { defaultGhRunner, ghEnvForProject, type GhRunner } from "./digest-gh";
import { startLimits, type DigestLimitDeps } from "./digest-limits";
import { diffSnapshot, nextSnapshot, readSnapshot, writeSnapshot, type DigestItem } from "./digest-snapshot";
import { defaultSummarize, type DigestSummarizer } from "./digest-summary";

/** Injectable seams. Production passes none (serve passes `sink`). */
export interface DigestDeps extends AgentTaskDeps {
  /** Replaces `gh`. A test passes a fake that answers from fixtures. */
  readonly runGh?: GhRunner;
  /** Replaces the clock-, memory- and watch-based parts of the limits. */
  readonly limits?: DigestLimitDeps;
  /** Replaces the model summary. */
  readonly summarize?: DigestSummarizer;
  /** Serve's Telegram path. When present the run flushes its delivery queue before returning. */
  readonly sink?: DigestSink;
}

/** A Telegram message is at most 4096 characters; leave room for the pointer. */
export const DELIVERY_TEXT_MAX = 3800;

function boardItems(entries: readonly { id: string; status: string; closedAt: string | null; verdict: string; title: string }[]): DigestItem[] {
  return entries.map((e) => ({ key: `board:${e.id}`, kind: "board" as const, id: e.id, title: e.title, stamp: `${e.status}|${e.closedAt ?? ""}|${e.verdict}` }));
}

interface BoardRead {
  readonly items: readonly DigestItem[];
  readonly chains: readonly OpenEntry[];
  readonly failure?: DigestFailure;
  readonly note?: string;
}

/** The flow board comes from the product index in `.metaproject/data/product/`, never from HTML. */
async function readBoard(projectRoot: string): Promise<BoardRead> {
  const read = await readIntentIndex(projectRoot);
  if (read.state === "absent") {
    return { items: [], chains: [], failure: { source: "board", detail: "no product index — run `keryx product index` to build it" } };
  }
  if (read.state === "malformed") {
    return { items: [], chains: [], failure: { source: "board", detail: `the product index is unreadable: ${read.reason}` } };
  }
  const stale = await checkStaleness(projectRoot, read.index);
  const items = boardItems(
    read.index.intents.map((i) => ({
      id: i.id,
      title: i.title,
      status: i.status,
      closedAt: i.closedAt,
      verdict: i.outcome?.verdict ?? "",
    })),
  );
  return {
    items,
    chains: buildOpenReport(read.index).entries,
    ...(stale.stale ? { note: `the product index is stale (${stale.reason})` } : {}),
  };
}

function capForDelivery(text: string, reportPath: string | undefined): string {
  if (text.length <= DELIVERY_TEXT_MAX) return text;
  const pointer = `\n… (cut — the full digest is in ${reportPath ?? "the run report"})`;
  return `${text.slice(0, DELIVERY_TEXT_MAX - pointer.length)}${pointer}`;
}

/** Run one digest. Same result shape as every other scheduled run, so `recordRun` and the history need nothing new. */
export async function runDigestDispatch(
  projectRoot: string,
  entry: TriggerEntry,
  action: AgentTaskAction,
  deps: DigestDeps = {},
): Promise<AgentTaskResult> {
  const now = deps.now ?? (() => new Date());
  const runId = deps.runId?.() ?? `dig-${now().toISOString().replace(/[-:.]/g, "").slice(0, 15)}-${randomUUID().slice(0, 8)}`;
  await ensureLocksDir(projectRoot);
  try {
    return await withFileLock(dispatchLockPath(projectRoot, `schedule-${entry.name}`), () => runLocked(projectRoot, entry, action, deps, runId, now), {
      timeoutMs: 0,
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Timed out waiting for lock:")) {
      return refusal(runId, "dispatch-locked", `digest "${entry.name}" is already running — refusing a second concurrent run. It runs again on the next fire.`, action);
    }
    throw error;
  }
}

async function runLocked(
  projectRoot: string,
  entry: TriggerEntry,
  action: AgentTaskAction,
  deps: DigestDeps,
  runId: string,
  now: () => Date,
): Promise<AgentTaskResult> {
  const digest = action.digest;
  if (digest === undefined) return refusal(runId, "grants-changed", `schedule "${entry.name}" has no digest block`, action);
  const dispatch = action.dispatch;
  const env = deps.grantedEnv ?? process.env;

  // --- 1. refusals before anything runs -------------------------------------
  const changed = await confirmedContentProblem(projectRoot, entry);
  if (changed !== undefined) return refusal(runId, changed.code, changed.reason, action);
  const binaries = await verifyGrantedBinaries(projectRoot, action, env["PATH"]);
  if (!binaries.ok) return refusal(runId, "grants-changed", `refusing to run: ${binaries.reason}`, action);

  const parent = await ensureScratchParent(agentTaskScratchParent());
  if (!parent.ok) {
    return {
      outcome: "failed",
      detail: `digest "${entry.name}" not started: ${parent.reason}`,
      cost: { recorded: false, reason: "no model was called — the scratch directory was not safe" },
      agentTask: { runId, permissionMode: dispatch.permissionMode, network: action.grants.network },
      exitCode: 1,
    };
  }
  const scratch = await mkdtemp(path.join(parent.dir, `${entry.name.replace(/[^A-Za-z0-9._-]/g, "-")}-`));
  // gh runs from this empty, keryx-owned directory (flow 295 N2), never from the project.
  const grantedCwd = path.join(scratch, "granted-cwd");
  await mkdir(grantedCwd, { recursive: true, mode: 0o700 });

  // --- 2. limits ------------------------------------------------------------
  const limits = startLimits({ maxSeconds: dispatch.maxSeconds, memoryLimitMb: digest.memoryLimitMb }, { ...(deps.armTimeout !== undefined ? { armTimeout: deps.armTimeout } : {}), ...(deps.limits ?? {}) });

  let crashed: string | undefined;
  let collected: CollectResult = { items: [], failures: [], failedSources: new Set(), raw: [], calls: [], stopped: false };
  let board: BoardRead = { items: [], chains: [] };
  let content: DigestContent | undefined;
  let text = "";
  let summaryText: string | undefined;
  let cost: TriggerRunCost = { recorded: true, usd: 0 };
  let baseline = false;
  const startedAt = now();

  try {
    // --- 3. gh ----------------------------------------------------------------
    collected = await collectFromGithub({
      action,
      bin: binaries.realpaths["gh"],
      stats: binaries.stats,
      cwd: grantedCwd,
      // The account follows the PROJECT'S path (work vs personal). No `auth` subcommand is ever run.
      env: ghEnvForProject(projectRoot, env),
      runGh: deps.runGh ?? defaultGhRunner,
      limits,
    });

    // --- 4. the board -----------------------------------------------------------
    if (!limits.checkpoint()) board = await readBoard(projectRoot);

    // --- 5. diff and content ------------------------------------------------------
    const failures: DigestFailure[] = [...collected.failures, ...(board.failure !== undefined ? [board.failure] : []), ...(board.note !== undefined ? [{ source: "board", detail: board.note }] : [])];
    const failedSources = new Set(collected.failedSources);
    if (board.failure !== undefined) failedSources.add("board");
    const items = [...collected.items, ...board.items];
    const previous = await readSnapshot(projectRoot, entry.name);
    const diff = diffSnapshot(previous, items, failedSources);
    baseline = diff.baseline;
    content = buildDigestContent({ items, diff, previous, failures, chains: board.chains, now: startedAt });
    text = renderDigestText(content, { name: entry.name, at: startedAt.toISOString() });

    // --- 6. the optional model summary ----------------------------------------------
    if (!limits.signal.aborted && !content.baseline && !content.quiet) {
      const summarize = deps.summarize ?? defaultSummarize;
      const result = await summarize({
        projectRoot,
        entry,
        action,
        runId,
        now,
        text,
        signal: limits.signal,
        env,
        onSpendStop: limits.spendStopped,
        ...(deps.makeProvider !== undefined ? { makeProvider: deps.makeProvider } : {}),
      });
      cost = result.cost;
      if (result.ok) summaryText = result.text;
      else {
        // The digest is complete without the summary: say it failed and send the plain text.
        content = { ...content, failures: [...content.failures, { source: "model", detail: result.reason }] };
        text = renderDigestText(content, { name: entry.name, at: startedAt.toISOString() });
      }
    }

    // --- the snapshot ---------------------------------------------------------------
    // A run that was stopped saw only part of the world, and a first run that could not read
    // a source would call all of it "new" next time; neither is stored.
    const partialBaseline = diff.baseline && failedSources.size > 0;
    if (!limits.signal.aborted && !partialBaseline) {
      await writeSnapshot(projectRoot, entry.name, nextSnapshot(previous, items, failedSources, startedAt.toISOString()));
    }
  } catch (error) {
    crashed = error instanceof Error ? error.message : String(error);
  } finally {
    limits.dispose();
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }

  // --- outcome ----------------------------------------------------------------------
  const tools = DIGEST_TOOL_IDS.filter((id) => action.grants.tools.includes(id));
  const attempted = tools.length * action.grants.repos.length;
  const githubDown = attempted > 0 && collected.failedSources.size >= attempted;
  const everySourceFailed = githubDown && board.failure !== undefined;
  const stopReason = limits.reason();
  const why = stopReason ?? (crashed !== undefined ? `the digest run threw: ${crashed}` : everySourceFailed ? "no source could be read (gh and the board both failed)" : undefined);
  const outcome: TriggerRunOutcomeKind = why === undefined ? "ok" : "failed";
  const partial = content !== undefined ? content.failures.filter((f) => f.source !== "board" || board.failure !== undefined) : [];

  // --- 7. the report -----------------------------------------------------------------
  const body = text.length > 0 ? text : `Digest ${entry.name} — no digest was produced.`;
  let reportPath: string | undefined;
  let reportNote = "";
  try {
    await ensureTriggerDataIgnored(projectRoot);
    const dir = path.join(triggerReportsDir(projectRoot), entry.name);
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${runId}.md`);
    await writeFile(
      file,
      renderDigestReport({
        entry,
        runId,
        at: startedAt.toISOString(),
        outcome,
        why,
        baseline,
        summary: summaryText,
        body,
        collected,
        failures: content?.failures ?? [...collected.failures],
        cost,
        repos: action.grants.repos,
      }),
      "utf8",
    );
    await pruneReports(dir, action.report.keep);
    reportPath = path.relative(projectRoot, file);
  } catch (error) {
    reportNote = ` (report NOT written: ${error instanceof Error ? error.message : String(error)})`;
  }

  // --- delivery -------------------------------------------------------------------------
  // A run that was stopped, or that could read nothing at all, sends a short status line instead of a
  // partial or empty digest. The failures that left it with nothing are named under the line.
  const statusReason = stopReason ?? (crashed !== undefined ? `the run threw: ${crashed}` : everySourceFailed ? "no source could be read" : undefined);
  const statusDetail = everySourceFailed && stopReason === undefined && crashed === undefined ? partial.slice(0, 6).map((f) => `\n- ${f.source}: ${f.detail}`).join("") : "";
  const message =
    statusReason !== undefined
      ? `Digest ${entry.name} stopped — ${statusReason}${statusDetail}${reportPath !== undefined ? `\nReport: ${reportPath}` : ""}`
      : capForDelivery(summaryText !== undefined ? `Summary (written by the model)\n${summaryText}\n\n${body}` : body, reportPath);
  await enqueueDelivery(projectRoot, entry.name, { runId, text: message, topic: digest.topic, ...(reportPath !== undefined ? { reportPath } : {}) }, now());
  if (deps.sink !== undefined) await flushDeliveries(projectRoot, entry.name, deps.sink, now);
  else await appendDeliveryLine(projectRoot, reportPath, `${now().toISOString()} queued — serve delivers it to the "${digest.topic}" topic (or the project's remote session) on its next tick`);

  const partialNote = partial.length > 0 ? `; ${partial.length} source note(s): ${partial.map((f) => f.source).join(", ")}` : "";
  return {
    outcome,
    detail:
      `${outcome === "ok" ? (baseline ? "digest written (baseline)" : content?.quiet === true ? "digest written (nothing changed)" : `digest written (${content?.changeCount ?? 0} change(s))`) : `run ${outcome}: ${why}`}` +
      `${reportPath !== undefined ? ` → ${reportPath}` : ""}${reportNote} [${collected.calls.length} gh call(s)${partialNote}]`,
    cost,
    agentTask: {
      runId,
      ...(reportPath !== undefined ? { reportPath } : {}),
      grantedCalls: collected.calls,
      permissionMode: dispatch.permissionMode,
      network: action.grants.network,
    },
    exitCode: outcome === "ok" ? 0 : 1,
  };
}

interface DigestReportInput {
  readonly entry: TriggerEntry;
  readonly runId: string;
  readonly at: string;
  readonly outcome: TriggerRunOutcomeKind;
  readonly why: string | undefined;
  readonly baseline: boolean;
  readonly summary: string | undefined;
  readonly body: string;
  readonly collected: CollectResult;
  readonly failures: readonly DigestFailure[];
  readonly cost: TriggerRunCost;
  readonly repos: readonly string[];
}

function renderDigestReport(r: DigestReportInput): string {
  const lines: string[] = [
    `# Digest ${r.entry.name} — ${r.at}`,
    "",
    `- run: ${r.runId}`,
    `- outcome: ${r.outcome}${r.why !== undefined ? ` (${r.why})` : ""}`,
    `- kind: ${r.baseline ? "baseline (first run, nothing to compare with)" : "diff against the previous run"}`,
    `- repositories: ${r.repos.join(", ")}`,
    `- cost: ${r.cost.recorded ? `$${r.cost.usd.toFixed(4)}` : `not recorded (${r.cost.reason})`}`,
    "",
  ];
  if (r.summary !== undefined) lines.push("## Summary (written by the model)", "", r.summary, "");
  lines.push("## Digest", "", r.body, "");
  lines.push("## Granted tool calls", "");
  if (r.collected.calls.length === 0) lines.push("- none");
  for (const call of r.collected.calls) lines.push(`- ${call.tool} → ${call.ok ? "ok" : `failed (exit ${call.exitCode ?? "?"})`}`);
  lines.push("");
  lines.push("## Failures", "");
  if (r.failures.length === 0) lines.push("- none");
  for (const f of r.failures) lines.push(`- ${f.source}: ${f.detail}`);
  lines.push("");
  lines.push("## Raw answers", "");
  if (r.collected.raw.length === 0) lines.push("- none");
  for (const raw of r.collected.raw) {
    lines.push(`### ${raw.source} (${raw.tool})`, "", "```json", raw.text.replace(/```/g, "'''"), "```", "");
  }
  lines.push("## Delivery", "");
  return `${lines.join("\n")}\n`;
}
