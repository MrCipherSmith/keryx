// An attempt is selected by the account/repository/PR-scoped store before this reader is called.
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import path from "node:path";
import type { DeskReviewerProgress, DeskReviewerSession, DeskRun, DeskRunKey } from "./desk-run-types";
import { assignedReviewerWave, identifier, reviewerName, waveNumber } from "./reviewer-activity";
import { isReviewerResult, parseReviewResult } from "./ledger";
import { splitUsage } from "./dispatch-usage";
import { usageCounts, validUsageCounts } from "./run-usage";

const maxFileBytes = 2 * 1024 * 1024;
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const isClock = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) && Number.isFinite(Date.parse(v));

/** Only fixed or validated path components. Reject linked directories, leaves, and special files. */
function readEvidence(root: string, parts: string[], limit: number): string | undefined {
  try {
    let directory = root;
    for (const part of parts.slice(0, -1)) {
      if (!lstatSync(directory).isDirectory()) return;
      directory = path.join(directory, part);
    }
    if (!lstatSync(directory).isDirectory()) return;
    const fd = openSync(path.join(directory, parts.at(-1)!), constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > limit) return;
      const buffer = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < buffer.length) {
        const n = readSync(fd, buffer, offset, buffer.length - offset, null);
        if (!n) return;
        offset += n;
      }
      return buffer.toString("utf8");
    } finally { closeSync(fd); }
  } catch { return; } // Evidence can be absent or mid-rename while the worker publishes.
}

function readObject(root: string, parts: string[]): Record<string, unknown> | undefined {
  const data = readEvidence(root, parts, maxFileBytes);
  if (!data) return;
  try {
    const value: unknown = JSON.parse(data);
    return isRecord(value) ? value : undefined;
  } catch { return; }
}

function observedSession(value: unknown, detailed: boolean): DeskReviewerSession | undefined {
  if (!isRecord(value) || !identifier(value.id) || !reviewerName(value.reviewer) || !waveNumber(value.wave)) return;
  const state = value.state;
  if (state !== "running" && state !== "completed" && state !== "failed" && state !== "cancelled" && state !== "partial" && state !== "unknown") return;
  const session: DeskReviewerSession = { id: value.id, reviewer: value.reviewer, wave: value.wave, state };
  if (identifier(value.model)) session.model = value.model;
  if (identifier(value.provider)) session.provider = value.provider;
  if (isClock(value.startedAt)) session.startedAt = value.startedAt;
  if (isClock(value.finishedAt)) session.finishedAt = value.finishedAt;
  if (validUsageCounts(value.usage)) session.usage = usageCounts(value.usage);
  if (detailed && Array.isArray(value.activity)) {
    session.activity = value.activity.slice(-24).flatMap(entry =>
      isRecord(entry) && isClock(entry.at) && typeof entry.label === "string" &&
      /^(?:Reviewer (?:started|completed|partial|failed|cancelled)|Started [\w-]{1,96}|[\w-]{1,96} (?:finished|failed))$/.test(entry.label)
        ? [{ at: entry.at, label: entry.label }] : []);
    if (value.truncated === true || value.activity.length > 24) session.truncated = true;
  }
  return session;
}

function isFinished(session: DeskReviewerSession) {
  return ["completed", "partial", "failed", "cancelled"].includes(session.state);
}
export function readDeskReviewerProgress(directory: string, key: DeskRunKey, run: DeskRun, detailed: boolean): DeskReviewerProgress | undefined {
  if (run.source === "existing" || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(run.id)) return;
  const ref = `https://github.com/${key.repo}/pull/${key.number}`.toLowerCase();
  const progress = readObject(directory, ["run", "progress.json"]);
  const ownProgress = typeof progress?.ref === "string" && progress.ref.toLowerCase() === ref ? progress : undefined;
  let sessions: DeskReviewerSession[] = [];
  if (Array.isArray(ownProgress?.reviewerSessions)) {
    for (const item of ownProgress.reviewerSessions) {
      const session = observedSession(item, detailed);
      if (session) sessions.push(session);
    }
  }
  const active = run.state === "running" || run.state === "cancelling";
  if (!active) for (const session of sessions) if (session.state === "running") session.state = "unknown";

  // A prior round can be imported alongside this round. The runner's own
  // package pointer and the manifest's PR + immutable range identify the plan.
  const candidates = [["package"]];
  const pkg = ownProgress?.packageId;
  if (typeof pkg === "string" && /^[\w-][\w.-]{0,199}$/.test(pkg)) candidates.push(["checkout", ".metaproject", "reviews", pkg]);
  let planned: number | null = null;
  for (const parts of candidates) {
    const target = readObject(directory, [...parts, "manifest.json"])?.target;
    if (!isRecord(target) || typeof target.ref !== "string" || target.ref.toLowerCase() !== ref ||
        target.base !== run.baseSha || target.head !== run.headSha) continue;
    const calls = readObject(directory, [...parts, "desktop-dispatch.json"])?.calls;
    if (!Array.isArray(calls)) continue;
    const byRoleWave = new Set(sessions.map(s => `${s.reviewer}:${s.wave}`));
    const queued = new Set<string>();
    let remaining = 4 * 1024 * 1024;
    for (const call of calls) {
      if (!isRecord(call) || !reviewerName(call.label) || typeof call.save_result_to !== "string") continue;
      const reviewer = call.label;
      const file = path.basename(call.save_result_to);
      const wave = assignedReviewerWave(reviewer, file);
      if (wave === undefined) continue;
      const key = `${reviewer}:${wave}`;
      if (queued.has(key)) continue;
      queued.add(key);
      if (byRoleWave.has(key)) continue;
      const session: DeskReviewerSession = { id: key, reviewer, wave, state: active ? "planned" : "unknown" };
      if (isRecord(call.expected_model)) {
        if (identifier(call.expected_model.model)) session.model = call.expected_model.model;
        if (identifier(call.expected_model.provider)) session.provider = call.expected_model.provider;
      }
      const raw = detailed || !active ? readEvidence(directory, [...parts, "raw", file], Math.min(remaining, 512 * 1024)) : undefined;
      if (raw) {
        remaining -= Buffer.byteLength(raw);
        const { body, incomplete, usage } = splitUsage(raw);
        const saved = parseReviewResult(body);
        if (!incomplete && isReviewerResult(saved) && saved.reviewer === reviewer) {
          if (saved.status === "DONE" || saved.status === "DONE_WITH_CONCERNS") session.state = "completed";
          if (saved.status === "BLOCKED" || saved.status === "NEEDS_CONTEXT") session.state = "partial";
          if (detailed) session.activity = [{ label: "Reviewer result saved" }];
        }
        if (usage && !usage.reported) session.usage = usageCounts({ inputTokens: usage.tokens_in, outputTokens: usage.tokens_out });
      }
      sessions.push(session);
    }
    if (queued.size === calls.length) {
      // Old checkpoints could include auxiliary children saving outside the review package.
      sessions = sessions.filter(session => queued.has(`${session.reviewer}:${session.wave}`));
      planned = sessions.length; // Includes observed retries of real assignments.
    }
    break;
  }
  if (!sessions.length) return;
  const started = sessions.filter(s => s.state !== "planned" && s.state !== "unknown");
  const running = started.filter(s => s.state === "running");
  const wave = (running.length ? running : started).reduce<number | null>((w, s) => Math.max(w ?? 0, s.wave), null);
  return { planned, finished: sessions.filter(isFinished).length, wave, sessions };
}
