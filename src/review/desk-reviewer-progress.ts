import { isReviewAssignmentTier } from "./assignment-tier";
// An attempt is selected by the account/repository/PR-scoped store before this reader is called.
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import path from "node:path";
import type { DeskReviewerProgress, DeskReviewerSession, DeskRun, DeskRunKey } from "./desk-run-types";
import { assignedReviewerWave, finishedReviewerSession, identifier, reviewerName, summarizeReviewerAssignments, waveNumber } from "./reviewer-activity";
import { isReviewerResult, parseReviewResult } from "./ledger";
import { publicReviewerOutput, publicReviewText } from "./desk-public-text";
import { finishedDesktopAssignment } from "./desktop-assignment-result";
import { splitUsage } from "./dispatch-usage";
import { usageCounts, validUsageCounts } from "./run-usage";

const maxFileBytes = 2 * 1024 * 1024;
const maxPlanFiles = 80;
const maxPlanChecks = 64;
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

function projectPlanSummary(root: string, parts: string[], plan: Record<string, unknown>, run: DeskRun) {
  const filesRecord = readObject(root, [...parts, "scope-files.json"]);
  const rawFiles = filesRecord?.version === 1 && Array.isArray(filesRecord.files) ? filesRecord.files : [];
  const allFiles = [...new Set(rawFiles.filter((file): file is string => typeof file === "string" && file.length > 0))];
  const files = allFiles.slice(0, maxPlanFiles).map(file => publicReviewText(file, 240));
  const checks = new Map<string, Set<string>>();
  const roster = new Set(Array.isArray(plan.roster) ? plan.roster.filter(reviewerName) : []);
  const queue = readObject(root, [...parts, "desktop-dispatch.json"]);
  const calls = Array.isArray(queue?.calls) ? queue.calls : undefined;
  const dispatched = new Set(calls?.flatMap(call => isRecord(call) && reviewerName(call.label) ? [call.label] : []) ?? []);
  const included = [...roster].filter(name => !calls || dispatched.has(name)).sort();
  const slices = isRecord(plan.slices) ? plan.slices : {};
  for (const kind of ["fix", "new", "secondLook"] as const) {
    const rows = slices[kind];
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      if (!isRecord(row) || typeof row.id !== "string" || !Array.isArray(row.roles)) continue;
      const paths = Array.isArray(row.files) ? row.files.filter((file): file is string => typeof file === "string" && file.length > 0).slice(0, 6) : [];
        const label = `${kind === "secondLook" ? "second-look" : kind} slice ${publicReviewText(row.id, 80)}${paths.length ? ` covering ${paths.map(file => publicReviewText(file, 160)).join(", ")}` : ""}`;
      for (const role of row.roles) {
        if (!reviewerName(role) || !included.includes(role)) continue;
        const assigned = checks.get(role) ?? new Set<string>();
        assigned.add(`${row.id} · ${label}`);
        checks.set(role, assigned);
      }
    }
  }
  const projectedChecks = included.slice(0, maxPlanChecks).map(name => ({
    name,
    category: "baseline" as const,
    slices: [...(checks.get(name) ?? [])].map(label => label.split(" · ")[0]!).slice(0, 24),
  }));
  const sliceManifest = readObject(root, [...parts, "slices", "manifest.json"]);
  const projectRoles = new Set(Array.isArray(sliceManifest?.projectRoles) ? sliceManifest.projectRoles.filter(reviewerName) : []);
  const includedSlices = new Set(projectedChecks.flatMap(check => check.slices));
  const sliceReasons = Array.isArray(sliceManifest?.slices) ? sliceManifest.slices.flatMap((item): { id: string; depth?: string; reasons: string[] }[] => {
    if (!isRecord(item) || typeof item.id !== "string" || !includedSlices.has(item.id)) return [];
    const reasons = isRecord(item.risk) && Array.isArray(item.risk.why)
      ? item.risk.why.filter((reason): reason is string => typeof reason === "string").slice(0, 5).map(reason => publicReviewText(reason, 240)) : [];
    return [{ id: publicReviewText(item.id, 80), ...(typeof item.depth === "string" && { depth: item.depth }), reasons }];
  }).slice(0, 24) : [];
  const modelRouting = new Map<string, Record<string, unknown>>();
  if (Array.isArray(queue?.modelRouting)) {
    for (const entry of queue.modelRouting) {
      if (isRecord(entry) && typeof entry.result === "string") modelRouting.set(entry.result, entry);
    }
  }
  const classifiedChecks: NonNullable<DeskReviewerProgress["planSummary"]>["checks"] = projectedChecks.map(check => {
    const assignments = (calls ?? []).flatMap(call => {
      if (!isRecord(call) || call.label !== check.name || typeof call.save_result_to !== "string") return [];
      const wave = assignedReviewerWave(check.name, path.basename(call.save_result_to));
      const route = modelRouting.get(call.save_result_to);
      if (!wave || !route || !isReviewAssignmentTier(route.tier) || typeof route.tierReason !== "string") return [];
      const expected = isRecord(call.expected_model) ? call.expected_model : {};
      const slices = Array.isArray(route.slices) ? route.slices.filter(identifier).map(id => publicReviewText(id, 80)).slice(0, 24) : [];
      return [{ wave, slices, tier: route.tier, tierReason: publicReviewText(route.tierReason, 300),
        ...(identifier(expected.provider) && { provider: expected.provider }),
        ...(identifier(expected.model) && { model: expected.model }) }];
    }).slice(0, 24);
    return { ...check, category: projectRoles.has(check.name) ? "project" : "baseline",
      ...(assignments.length && { assignments }) };
  });
  const depth = readObject(root, [...parts, "round-depth.json"]);
  const changedLines = filesRecord?.changedLines;
  const recordedFiles = Array.isArray(depth?.files) && depth.files.every((file): file is string => typeof file === "string")
    ? [...new Set(depth.files)].sort() : undefined;
  const depthMatchesScope = depth?.head === run.headSha && recordedFiles !== undefined &&
    recordedFiles.join("\n") === [...allFiles].sort().join("\n") &&
    typeof changedLines === "number" && depth.changedLines === changedLines;
  let depthValue: "full" | "light" | undefined;
  if (depthMatchesScope && depth && (depth.depth === "full" || depth.depth === "light")) depthValue = depth.depth;
  const depthReason = depthValue && typeof depth?.reason === "string" ? publicReviewText(depth.reason, 500) : undefined;
  return {
    baseSha: run.baseSha,
    headSha: run.headSha,
    files,
    filesComplete: filesRecord?.version === 1 && allFiles.length <= maxPlanFiles,
    checks: classifiedChecks,
    sliceReasons,
    checksComplete: calls !== undefined && included.length <= maxPlanChecks,
    ...(depthValue && depthReason ? { depth: depthValue, depthReason } : {}),
  };
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
  if (value.usagePartial === true) session.usagePartial = true;
  if (detailed && Array.isArray(value.activity)) {
    session.activity = value.activity.slice(-24).flatMap((entry): NonNullable<DeskReviewerSession["activity"]> => {
      if (!isRecord(entry) || !isClock(entry.at) || typeof entry.label !== "string") return [];
      if (entry.kind === "message" || entry.kind === "answer") return [{ at: entry.at, kind: entry.kind, label: publicReviewText(entry.label, 1200) }];
      const kind = entry.kind;
      if (kind !== undefined && kind !== "status" && kind !== "tool" && kind !== "result" && kind !== "error") return [];
      if (!/^(?:Reviewer (?:started|completed|partial|failed|cancelled)|Started [\w-]{1,96}(?: · [\w.-]{1,96})?|[\w-]{1,96} (?:finished|failed))$/.test(entry.label)) return [];
      return [{ at: entry.at, label: publicReviewText(entry.label, 220), ...(kind ? { kind } : {}) }];
    });
    if (value.truncated === true || value.activity.length > 24) session.truncated = true;
  }
  if (value.needsContext === true && session.state === "partial") session.needsContext = true;
  if (detailed && typeof value.finalOutput === "string" && finishedReviewerSession(session)) {
    session.finalOutput = publicReviewText(value.finalOutput, 4800);
  }
  if (detailed && typeof value.outcomeReason === "string" && finishedReviewerSession(session)) {
    session.outcomeReason = publicReviewText(value.outcomeReason, 1800);
  }
  return session;
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
  if (!active) for (const session of sessions) if (session.state === "running" || session.state === "planned") session.state = "unknown";

  // A prior round can be imported alongside this round. The runner's own
  // package pointer and the manifest's PR + immutable range identify the plan.
  const candidates = [["package"]];
  const pkg = ownProgress?.packageId;
  if (typeof pkg === "string" && /^[\w-][\w.-]{0,199}$/.test(pkg)) candidates.push(["checkout", ".metaproject", "reviews", pkg]);
  let planned: number | null = null;
  let planSummary: DeskReviewerProgress["planSummary"];
  let assignmentsKnown = false;
  for (const parts of candidates) {
    const target = readObject(directory, [...parts, "manifest.json"])?.target;
    if (!isRecord(target) || typeof target.ref !== "string" || target.ref.toLowerCase() !== ref ||
        target.base !== run.baseSha || target.head !== run.headSha) continue;
    const plan = readObject(directory, [...parts, "plan.json"]);
    const matches = isRecord(plan?.target) && plan.target.ref === target.ref && plan.target.base === run.baseSha && plan.target.head === run.headSha;
    if (matches && plan) planSummary = projectPlanSummary(directory, parts, plan, run);
    const dispatches = matches ? plan?.dispatches : undefined;
    if (typeof dispatches === "number" && Number.isSafeInteger(dispatches) && dispatches > 0) planned = dispatches;
    const queue = readObject(directory, [...parts, "desktop-dispatch.json"]);
    const calls = queue?.calls;
    if (!Array.isArray(calls)) {
      if (planned !== null) break; // The host writes the plan before preparing its dispatch payloads.
      continue;
    }
    const observed = new Map<string, DeskReviewerSession | null>();
    for (const session of sessions) {
      const pair = `${session.reviewer}:${session.wave}`;
      observed.set(pair, observed.has(pair) ? null : session); // A raw file cannot identify which retry produced it.
    }
    const queued = new Set<string>();
    const completed = new Set(Array.isArray(queue?.completedAssignments) ? queue.completedAssignments : []);
    const routes = new Map(Array.isArray(queue?.modelRouting) ? queue.modelRouting.filter(isRecord).map(route => [route.result, route]) : []);
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
      const checkpoint = observed.get(key);
      if (checkpoint === null || (checkpoint && !detailed && (active || finishedReviewerSession(checkpoint)))) continue;
      if (active && checkpoint && !finishedReviewerSession(checkpoint)) continue;
      const retained = completed.has(call.save_result_to);
      const session: DeskReviewerSession = checkpoint ?? { id: key, reviewer, wave, state: retained ? "completed" : active ? "planned" : "unknown" };
      if (isRecord(call.expected_model)) {
        if (!session.model && identifier(call.expected_model.model)) session.model = call.expected_model.model;
        if (!session.provider && identifier(call.expected_model.provider)) session.provider = call.expected_model.provider;
      }
      const raw = detailed || !active ? readEvidence(directory, [...parts, "raw", file], Math.min(remaining, 512 * 1024)) : undefined;
      if (raw) {
        remaining -= Buffer.byteLength(raw);
        const { body, incomplete, usage } = splitUsage(raw);
        const saved = parseReviewResult(body);
        const route = routes.get(call.save_result_to);
        const currentResult = typeof route?.assignmentKey !== "string" ||
          (Array.isArray(route.slices) && finishedDesktopAssignment(raw, reviewer, route.assignmentKey, route.slices));
        if (!incomplete && isReviewerResult(saved) && saved.reviewer === reviewer) {
          const savedState = saved.status === "DONE" || saved.status === "DONE_WITH_CONCERNS" ? (currentResult ? "completed" : undefined)
            : saved.status === "BLOCKED" || saved.status === "NEEDS_CONTEXT" ? "partial" : undefined;
          if (savedState && (!checkpoint || !finishedReviewerSession(checkpoint))) session.state = savedState;
          if (saved.status === "NEEDS_CONTEXT" && session.state === "partial") session.needsContext = true;
          if (detailed && savedState === session.state) {
            Object.assign(session, publicReviewerOutput(saved));
            const activity = session.activity ??= [];
            activity.push({ label: "Reviewer result saved", kind: "result" });
            if (activity.length > 24) { activity.shift(); session.truncated = true; }
          }
        }
        if (!session.usage && usage && !usage.reported) {
          session.usage = usageCounts({ inputTokens: usage.tokens_in, outputTokens: usage.tokens_out });
          if (usage.partial || incomplete) session.usagePartial = true;
        }
      }
      if (!checkpoint) sessions.push(session);
    }
    if (queued.size === calls.length) {
      // Old checkpoints could include auxiliary children saving outside the review package.
      sessions = sessions.filter(session => queued.has(`${session.reviewer}:${session.wave}`));
      assignmentsKnown = true;
      // Keep the entire plan in the denominator, including assignments that failed preparation.
      planned = Math.max(planned ?? 0, queued.size + (Array.isArray(queue?.blocked) ? queue.blocked.length : 0));
    }
    break;
  }
  if (!sessions.length && planned === null) return;
  const summary = summarizeReviewerAssignments(sessions);
  if (planned !== null && !assignmentsKnown) summary.completed = 0;
  return { planned, ...summary, sessions, ...(planSummary && { planSummary }) };
}
