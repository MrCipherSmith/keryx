import { writeFileAtomic } from "../lib/fs";
import { roleDispatchWaves } from "./estimate";
import type { SliceManifest } from "./slice";
// Called after the worker and its reviewer process group have exited.
import { existsSync, lstatSync, fstatSync, openSync, readFileSync, readdirSync, readSync, closeSync, renameSync } from "node:fs";
import path from "node:path";
import { validRunUsage, type ReviewRunUsage } from "./run-usage";
import { isReviewerResult, parseReviewResult } from "./ledger";
import { splitUsage } from "./dispatch-usage";
import { createEventTail } from "./autonomous-progress";
import type { RunProgress } from "./autonomous-run";
import { countFindings, knownFindingList, renderReport, validateSummary, type AutonomousSummary } from "./autonomous-summary";
import { COVERAGE_FILE, type CoverageReport } from "./coverage-complete";
import { LEGACY_DESK_RUN_SCOPE } from "./desk-run-types";
import { exitCodeFor } from "./autonomous-profile";
import type { ManagedReviewManifest } from "./types";
import { computeVerdict, type InterimVerdict } from "./verdict";
import type { DeskExecutionResult } from "./desk-run-executor";

interface Request { scope: string | undefined; repo: string; number: number; baseSha: string; headSha: string; cancelled?: boolean }

export function recordedSha(value: unknown): string | null {
  return typeof value === "string" && /^[0-9a-f]{40}$/i.test(value) ? value : null;
}

function hasFullCoverage(entries: ManagedReviewManifest["coverage"], dir: string, prepared: boolean): boolean {
  if (!entries.some(e => e?.reviewer && e.reviewer !== "review-orchestrator") || !entries.every(e => e?.status === "run")) return false;
  const file = path.join(dir, COVERAGE_FILE);
  try {
    if (!lstatSync(file, { throwIfNoEntry: false })) {
      // Packages predating prepared Desktop dispatch may have only the manifest roster.
      if (prepared || lstatSync(path.join(dir, "desktop-dispatch.json"), { throwIfNoEntry: false })) return false;
      const planFile = path.join(dir, "plan.json");
      if (!lstatSync(planFile, { throwIfNoEntry: false })) return true;
      const plan = json<{ desktopDispatch?: unknown }>(planFile);
      return !!plan && typeof plan === "object" && !Array.isArray(plan) && plan.desktopDispatch === undefined;
    }
    const report = json<CoverageReport>(file);
    if (report?.schemaVersion !== 1 || report.tracked !== true || report.waived !== false || report.waiver !== undefined ||
        report.counts?.uncovered !== 0 || !Array.isArray(report.files) || report.files.length !== report.counts.inScope) return false;
    let covered = 0, omitted = 0;
    for (const entry of report.files) {
      if (!entry || typeof entry.file !== "string" || !entry.file || (entry.scope !== "A" && entry.scope !== "B")) return false;
      if (entry.status === "covered") covered++;
      else if (entry.status === "omitted" && typeof entry.reason === "string" && entry.reason.trim()) omitted++;
      else return false;
    }
    return covered === report.counts.covered && omitted === report.counts.omitted;
  } catch { return false; }
}

export function checkedDeskSummary(summary: AutonomousSummary,
  result: Pick<DeskExecutionResult, "outcome" | "reason" | "findings" | "findingsKnown">, retained: boolean): AutonomousSummary {
  const status = result.outcome === "complete" ? "complete" : summary.status === "complete" ? "incomplete" : summary.status;
  return { ...summary, status, exitCode: exitCodeFor(status), reason: result.reason, findings: result.findings,
    ...(result.findingsKnown !== undefined ? { findingsKnown: result.findingsKnown } : {}),
    package: retained && summary.package ? { ...summary.package, path: "../package" } : summary.package };
}

/** Publish the report first: until the summary is committed, recovery can retry the publication. */
export async function saveDeskSummary(runDir: string, summary: AutonomousSummary, report: string) {
  await writeFileAtomic(path.join(runDir, "run/report.md"), report, { mode: 0o600 });
  await writeFileAtomic(path.join(runDir, "run/summary.json"), JSON.stringify(summary), { mode: 0o600 });
}

function json<T>(file: string): T | null {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024) return null;
    return JSON.parse(readFileSync(file, "utf8"));
  } catch { return null; }
}

/** Only original slice routing can exempt a roster member from producing a result. */
export function desktopRoutedOut(dir: string): Set<string> {
  const queue = json<{ routedOut?: string[] }>(path.join(dir, "desktop-dispatch.json"));
  const routed = new Set<string>();
  if (!Array.isArray(queue?.routedOut) || !queue.routedOut.length) return routed;
  const manifest = json<SliceManifest>(path.join(dir, "slices/manifest.json"));
  if (!manifest || !Array.isArray(manifest.slices)) return routed;
  try {
    for (const role of queue.routedOut) if (typeof role === "string" && roleDispatchWaves(manifest, role).length === 0) routed.add(role);
  } catch { return new Set(); }
  return routed;
}

/** A new Desktop plan has one saved result per wave and host-observed participation per reviewer.
 * A ledger note explaining a skipped role is useful evidence of the skip, never a reviewer result. */
export function hasDesktopReviewerEvidence(dir: string, usage: ReviewRunUsage | undefined, routed = desktopRoutedOut(dir), prepared = true): boolean {
  const planFile = path.join(dir, "plan.json");
  const plan = json<{ desktopDispatch?: string; roster?: string[]; dispatches?: number }>(planFile);
  const queueFile = path.join(dir, "desktop-dispatch.json");
  if (!prepared && !existsSync(queueFile)) {
    if (!existsSync(planFile)) return true; // Legacy completion with no plan format.
    if (plan && typeof plan === "object" && !Array.isArray(plan) && plan.desktopDispatch === undefined) return true;
  }
  const queue = json<{ blocked?: unknown[]; calls: Array<{ label: string; save_result_to: string }> }>(queueFile);
  if ((prepared && typeof plan?.desktopDispatch !== "string") || !Array.isArray(plan?.roster) || !Array.isArray(queue?.calls) || !!queue.blocked?.length || !queue.calls.length || plan.dispatches !== queue.calls.length) return false;
  const sliceFile = path.join(dir, "slices/manifest.json");
  const expected = new Set<string>();
  if (existsSync(sliceFile)) {
    const manifest = json<SliceManifest>(sliceFile);
    if (!Array.isArray(manifest?.slices)) return false;
    try {
      const original = { ...manifest, slices: manifest.slices.filter(slice => !slice.retryOf) };
      for (const role of plan.roster) {
        roleDispatchWaves(original, role).forEach((_, i) => expected.add(`${role}-w${i + 1}.txt`));
      }
    } catch { return false; }
    if (expected.size !== queue.calls.length) return false;
  }
  const observed = new Set(usage?.reviewers.map(record => record.reviewer));
  const roles = new Set<string>();
  const files = new Set<string>();
  for (const call of queue.calls) {
    if (!call || typeof call.label !== "string" || !plan.roster.includes(call.label) || routed.has(call.label) || !observed.has(call.label) || typeof call.save_result_to !== "string") return false;
    const name = path.basename(call.save_result_to);
    if ((expected.size && !expected.has(name)) || files.has(name) || !name.startsWith(call.label + "-w") || !/-w[1-9][0-9]*\.txt$/.test(name)) return false;
    try {
      const { body, incomplete } = splitUsage(readFileSync(path.join(dir, "raw", name), "utf8"));
      const reply = parseReviewResult(body);
      if (incomplete || !isReviewerResult(reply) || reply.reviewer !== call.label || !["DONE", "DONE_WITH_CONCERNS"].includes(String(reply.status))) return false;
    } catch { return false; }
    files.add(name);
    roles.add(call.label);
  }
  return plan.roster.length > 0 && plan.roster.every(role => roles.has(role) || routed.has(role));
}

/** A zero-finding local verdict needs complete coverage of the requested revision. */
export function deskVerdictHeadline(evaluated: InterimVerdict, complete: boolean) {
  return evaluated.source !== "none" && (evaluated.total || evaluated.held.length || complete) ? evaluated.headline : null;
}

export function completeDeskCoverage(dir: string, entries: ManagedReviewManifest["coverage"], usage: ReviewRunUsage | undefined,
  evaluated: InterimVerdict, prepared: boolean) {
  const routed = desktopRoutedOut(dir);
  const ran = new Set(entries.filter(entry => entry?.status === "run").map(entry => entry.reviewer));
  if (evaluated.unreadable.length || evaluated.pendingReviewers?.some(role => !routed.has(role) && (!evaluated.pendingAmbiguous || !ran.has(role)))) return false;
  const research = json<{ dispatch?: { selected?: string[]; skipped?: unknown[] } }>(path.join(dir, "research.json"));
  const required = research?.dispatch?.selected ?? [];
  return Array.isArray(required) && required.every(role => ran.has(role) || routed.has(role)) && !research?.dispatch?.skipped?.length &&
    hasFullCoverage(entries.filter(entry => !routed.has(entry?.reviewer)), dir, prepared) && hasDesktopReviewerEvidence(dir, usage, routed, prepared);
}

function preview(file: string): string {
  try {
    if (!lstatSync(file).isFile()) return "";
    const fd = openSync(file, "r");
    try {
      const size = fstatSync(fd).size;
      const bytes = Buffer.alloc(Math.min(size, 64 * 1024));
      let read = 0;
      while (read < bytes.length) {
        const count = readSync(fd, bytes, read, bytes.length - read, null);
        if (!count) break;
        read += count;
      }
      return bytes.subarray(0, read).toString("utf8") + (read < size ? `\n\nPreview truncated. Full report: ${file}` : "");
    } finally { closeSync(fd); }
  } catch { return ""; }
}

function readablePackage(dir: string) {
  try {
    return lstatSync(dir).isDirectory() && readdirSync(dir, { recursive: true, withFileTypes: true }).every(entry => entry.isDirectory() || entry.isFile());
  } catch { return false; }
}

export async function recoverDeskExecution(runDir: string, request: Request): Promise<DeskExecutionResult | null> {
  const subject = `https://github.com/${request.repo}/pull/${request.number}`;
  const summaryFile = json<AutonomousSummary>(path.join(runDir, "run/summary.json"));
  const summary = summaryFile && validateSummary(summaryFile).length === 0 && summaryFile.target.ref === subject ? summaryFile : null;
  // A worker killed between polls can leave newer provider receipts than its progress snapshot.
  const progress = json<RunProgress>(path.join(runDir, "run/progress.json"));
  let usage = summary?.usage;
  if (!usage) {
    try { usage = createEventTail(path.join(runDir, "run/events.ndjson")).poll().usage; } catch { /* retain the last checkpoint */ }
    if (!usage && validRunUsage(progress?.usage)) usage = progress.usage;
  }
  const stored = path.join(runDir, "package");
  const liveRoot = path.join(runDir, "checkout/.metaproject/reviews");
  if (!existsSync(stored)) {
    const id = summary?.package?.id ?? progress?.packageId;
    if (id && /^[\w.-]+$/.test(id) && id !== "." && id !== "..") {
      const candidate = path.join(liveRoot, id);
      if (readablePackage(candidate) && json<ManagedReviewManifest>(path.join(candidate, "manifest.json"))?.target?.ref === subject) {
        try { renameSync(candidate, stored); }
        catch (error) { if (!existsSync(stored)) throw error; } // Another reconciler can retain the same attempt first.
      }
    }
  }
  const pkg = readablePackage(stored) ? stored : "";
  const manifest = pkg ? json<ManagedReviewManifest>(path.join(pkg, "manifest.json")) : null;
  const found = manifest?.target?.ref === subject;
  if (!summary && !found && !usage) return null;
  const checkedBase = found ? recordedSha(manifest.target.base) : null;
  const checkedHead = found ? recordedSha(manifest.target.head) : null;
  const items = found ? json<unknown>(path.join(pkg, "findings.json")) : null;
  const entries = found && Array.isArray(manifest.coverage) ? manifest.coverage : [];
  const prepared = request.scope !== undefined && request.scope !== LEGACY_DESK_RUN_SCOPE;
  const matching = checkedBase === request.baseSha && checkedHead === request.headSha;
  const closed = found && manifest.status === "closed";
  const evaluated = found && matching ? await computeVerdict(pkg).catch(() => null) : null;
  const complete = closed && matching && knownFindingList(items) && evaluated !== null && (!summary || summary.status === "complete") &&
    completeDeskCoverage(pkg, entries, usage, evaluated, prepared);
  const coverage = complete ? "complete" : (entries.length && Array.isArray(items)) ? "partial" : "unknown";
  const knownSource = evaluated && (evaluated.source === "raw reviewer results" || knownFindingList(items));
  const findings = knownSource ? evaluated.counts : knownFindingList(items) ? countFindings(items) : summary?.findings ?? countFindings(null);
  const findingsKnown = !!knownSource || knownFindingList(items) || summary?.findingsKnown === true ||
    (summary?.findingsKnown === undefined && Object.values(findings).some(count => count > 0));
  const outcome = complete ? "complete" : request.cancelled ? "cancelled" : summary?.status === "budget" ? "budget" :
    summary?.status === "floor" ? "blocked" : "incomplete";
  const reason = complete ? "Recovered a closed review package for the requested revision." : request.cancelled ? "The review stopped after cancellation." :
    !matching && closed ? "The package did not confirm the requested base and head." :
    summary?.status !== "complete" && summary?.reason ? summary.reason : "Recovered the available evidence; the full round could not be verified.";
  const packageReport = found ? preview(path.join(pkg, "report.md")) : "";
  const result: DeskExecutionResult = { outcome, checkedBase, checkedHead, coverage, findings, findingsKnown, reason,
    verdict: knownSource ? deskVerdictHeadline(evaluated, complete) : null, ...(usage ? { usage } : {}), report: null };
  const retained = !!found && summary?.package?.id === manifest.reviewId;
  const saved = summary ? checkedDeskSummary(summary, result, retained) : null;
  const header = saved ? renderReport(saved) : packageReport ? `# Recovered review: ${subject}\n\n- Status: **${outcome}**\n- Why: ${reason}\n` : "";
  result.report = [header, packageReport].filter(Boolean).join("\n") || null;
  // A dead worker can leave the runner's original complete header. Repair only its own pinned archive.
  if (saved && result.report && summary?.status === "complete" && saved.status !== summary.status && retained &&
      matching && summary.target.head === request.headSha && lstatSync(path.join(runDir, "run")).isDirectory()) {
    await saveDeskSummary(runDir, saved, result.report);
  }
  return result;
}
