// Called under the run-store transaction only after the worker and reviewer process group have exited.
import { existsSync, lstatSync, openSync, readFileSync, readdirSync, readSync, closeSync, renameSync } from "node:fs";
import path from "node:path";
import { validRunUsage, type ReviewRunUsage } from "./run-usage";
import { isReviewerResult, parseReviewResult } from "./ledger";
import { splitUsage } from "./dispatch-usage";
import { createEventTail } from "./autonomous-progress";
import type { RunProgress } from "./autonomous-run";
import { countFindings, renderReport, validateSummary, type AutonomousSummary } from "./autonomous-summary";
import type { CoverageReport } from "./coverage-complete";
import type { ManagedReviewManifest } from "./types";
import type { DeskExecutionResult } from "./desk-run-executor";

interface Request { repo: string; number: number; baseSha: string; headSha: string; cancelled?: boolean }

export function recordedSha(value: unknown): string | null {
  return typeof value === "string" && /^[0-9a-f]{40}$/i.test(value) ? value : null;
}

export function hasFullCoverage(entries: ManagedReviewManifest["coverage"], fileReport: CoverageReport | null) {
  const roster = entries.some(entry => entry.reviewer && entry.reviewer !== "review-orchestrator") && entries.every(entry => entry.status === "run");
  return roster && (!fileReport || (fileReport.tracked === true && fileReport.counts?.uncovered === 0 && !fileReport.waived));
}

function json<T>(file: string): T | null {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024) return null;
    return JSON.parse(readFileSync(file, "utf8"));
  } catch { return null; }
}

/** A new Desktop plan has one saved result per wave and host-observed participation per reviewer.
 * A ledger note explaining a skipped role is useful evidence of the skip, never a reviewer result. */
export function hasDesktopReviewerEvidence(dir: string, usage: ReviewRunUsage | undefined): boolean {
  const plan = json<{ desktopDispatch?: string; roster?: string[]; dispatches?: number }>(path.join(dir, "plan.json"));
  const queueFile = path.join(dir, "desktop-dispatch.json");
  if (!plan?.desktopDispatch && !existsSync(queueFile)) return true; // packages created before prepared dispatch
  const queue = json<{ calls: Array<{ label: string; save_result_to: string }> }>(queueFile);
  if (!Array.isArray(plan?.roster) || !Array.isArray(queue?.calls) || !queue.calls.length || plan.dispatches !== queue.calls.length) return false;
  const observed = new Set(usage?.reviewers.map(record => record.reviewer));
  const roles = new Set<string>();
  const files = new Set<string>();
  for (const call of queue.calls) {
    if (!call || typeof call.label !== "string" || !observed.has(call.label) || typeof call.save_result_to !== "string") return false;
    const name = path.basename(call.save_result_to);
    if (files.has(name) || !name.startsWith(call.label + "-w") || !/-w[1-9][0-9]*\.txt$/.test(name)) return false;
    try {
      const { body, incomplete } = splitUsage(readFileSync(path.join(dir, "raw", name), "utf8"));
      const reply = parseReviewResult(body);
      if (incomplete || !isReviewerResult(reply) || reply.reviewer !== call.label || !["DONE", "DONE_WITH_CONCERNS"].includes(String(reply.status))) return false;
    } catch { return false; }
    files.add(name);
    roles.add(call.label);
  }
  return plan.roster.length > 0 && plan.roster.every(role => roles.has(role));
}

function preview(file: string): string {
  try {
    if (!lstatSync(file).isFile()) return "";
    const fd = openSync(file, "r");
    try {
      const bytes = Buffer.alloc(64 * 1024);
      return bytes.subarray(0, readSync(fd, bytes)).toString("utf8");
    } finally { closeSync(fd); }
  } catch { return ""; }
}

function readablePackage(dir: string) {
  try {
    return lstatSync(dir).isDirectory() && readdirSync(dir, { recursive: true, withFileTypes: true }).every(entry => entry.isDirectory() || entry.isFile());
  } catch { return false; }
}

export function recoverDeskExecution(runDir: string, request: Request): DeskExecutionResult | null {
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
  let pkg = readablePackage(stored) ? stored : "";
  if (!pkg && existsSync(liveRoot)) {
    const id = summary?.package?.id ?? progress?.packageId;
    // A previous round may have been imported. A name from this attempt's own
    // progress/summary is the provenance that distinguishes it during recovery.
    if (id && /^[\w.-]+$/.test(id) && id !== "." && id !== "..") {
      const candidate = path.join(liveRoot, id);
      if (readablePackage(candidate)) pkg = candidate;
    }
  }
  const manifest = pkg ? json<ManagedReviewManifest>(path.join(pkg, "manifest.json")) : null;
  const found = manifest?.target?.ref === subject;
  if (!summary && !found && !usage) return null;
  const checkedBase = found ? recordedSha(manifest.target.base) : null;
  const checkedHead = found ? recordedSha(manifest.target.head) : null;
  const items = found ? json<unknown>(path.join(pkg, "findings.json")) : null;
  const entries = found && Array.isArray(manifest.coverage) ? manifest.coverage : [];
  const research = found ? json<{ dispatch?: { selected?: string[]; skipped?: unknown[] } }>(path.join(pkg, "research.json")) : null;
  const required = research?.dispatch?.selected ?? [];
  const ran = new Set(entries.filter(entry => entry?.status === "run").map(entry => entry.reviewer));
  const accounted = hasFullCoverage(entries, found ? json<CoverageReport>(path.join(pkg, "coverage.json")) : null) &&
    Array.isArray(required) && required.every(name => ran.has(name)) && !research?.dispatch?.skipped?.length;
  const matching = checkedBase === request.baseSha && checkedHead === request.headSha;
  const closed = found && manifest.status === "closed";
  const complete = closed && matching && accounted && hasDesktopReviewerEvidence(pkg, usage) && Array.isArray(items) && (!summary || summary.status === "complete");
  const coverage = complete ? "complete" : (entries.length && Array.isArray(items)) ? "partial" : "unknown";
  const findings = Array.isArray(items) ? countFindings(items) : summary?.findings ?? countFindings(null);
  const outcome = complete ? "complete" : request.cancelled ? "cancelled" : summary?.status === "budget" ? "budget" :
    summary?.status === "floor" ? "blocked" : "incomplete";
  const reason = complete ? "Recovered a closed review package for the requested revision." : request.cancelled ? "The review stopped after cancellation." :
    !matching && closed ? "The package did not confirm the requested base and head." :
    summary?.status !== "complete" && summary?.reason ? summary.reason : "Recovered the available evidence; the full round could not be verified.";
  const report = found ? preview(path.join(pkg, "report.md")) : "";
  if (found && pkg !== stored && !existsSync(stored)) renameSync(pkg, stored);
  return { outcome, checkedBase, checkedHead, coverage, findings, reason, verdict: null, ...(usage ? { usage } : {}),
    report: report || (summary ? renderReport(summary) : null) };
}
