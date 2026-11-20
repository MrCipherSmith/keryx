// Project artifacts that predate Desktop have no authenticated attempt record.
// Bind to an explicit GitHub repository and PR; preserve unknown provenance.
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { artifactDirectories, readKnown } from "./project-artifacts";
import path from "node:path";
import { ingestedFindingCounts } from "./verdict";
import { countFindings, knownFindingList, type FindingCounts } from "./autonomous-summary";
import { validRunUsage, type ReviewRunUsage } from "./run-usage";
import type { DeskRun, DeskRunKey } from "./desk-run-types";

type Fields = Record<string, unknown>;
const object = (v: unknown): Fields => (v && typeof v === "object" && !Array.isArray(v) ? (v as Fields) : {});
const sha = (v: unknown) => (typeof v === "string" && /^[a-f0-9]{40}$/.test(v) ? v : "");
const stamp = (v: unknown, fallback: string) =>
  typeof v === "string" && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : fallback;

function json(file: string) {
  const input = readKnown(file, 1024 * 1024);
  if (!input) return;
  try {
    return { data: object(JSON.parse(input.text)), time: input.time };
  } catch {
    return;
  }
}
function* packages(meta: string) {
  yield* artifactDirectories(path.join(meta, "reviews"), 2048);
  for (const flow of artifactDirectories(path.join(meta, "flows"), 2048)) {
    yield* artifactDirectories(path.join(flow, "reviews"), 128);
  }
}
function stableId(key: DeskRunKey, name: string) {
  const digest = createHash("sha256")
    .update(JSON.stringify([key.repositoryId, key.viewer.toLowerCase(), key.number, name]))
    .digest("hex")
    .slice(0, 32);
  return digest.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
}
export function readExistingReviews(cwd: string, key: DeskRunKey): DeskRun[] {
  const meta = path.join(realpathSync(cwd), ".metaproject");
  const url = `https://github.com/${key.repo}/pull/${key.number}`.toLowerCase();
  function belongs(target: Fields) {
    const ref = typeof target.ref === "string" ? target.ref.replace(/\/$/, "").toLowerCase() : "";
    const repo = typeof target.repository === "string" ? target.repository.toLowerCase() : null;
    if (repo && repo !== key.repo.toLowerCase()) return false;
    if (target.number !== undefined && target.number !== key.number) return false;
    return (
      ref === url ||
      (repo === key.repo.toLowerCase() && (ref === String(key.number) || ref === "#" + key.number))
    );
  }
  const found = new Map<string, DeskRun>();
  function archive(
    data: Fields,
    target: Fields,
    id: string,
    fileTime: string,
    phase: string,
    reason: string,
    report: string,
    findings: FindingCounts | undefined,
    usage?: ReviewRunUsage,
    prior?: DeskRun,
  ) {
    const baseSha = sha(target.base),
      headSha = sha(target.head);
    const createdAt = stamp(data.createdAt ?? data.startedAt, prior?.createdAt ?? fileTime);
    found.set(id, {
      id: stableId(key, id),
      source: "existing",
      ...(usage ? { usage } : {}),
      baseSha,
      headSha,
      state: "partial",
      phase,
      reason,
      createdAt,
      startedAt: stamp(data.startedAt, prior?.startedAt ?? "") || null,
      finishedAt: stamp(data.finishedAt, prior?.finishedAt ?? "") || null,
      result: {
        reviewed: baseSha && headSha ? { baseSha, headSha } : null,
        coverage: "unknown",
        verdict: null,
        report,
        findings: findings ?? countFindings(null),
        findingsKnown: findings !== undefined,
      },
    });
  }
  const runDir = path.join(meta, "data", "review-autonomous", key.repo.replace("/", "-") + "-pr" + key.number);
  const summary = json(path.join(runDir, "summary.json"));
  if (summary) {
    const data = summary.data,
      target = object(data.target);
    if (
      target.kind === "pr" &&
      belongs(target) &&
      target.number === key.number &&
      typeof target.repository === "string" &&
      target.repository.toLowerCase() === key.repo.toLowerCase()
    ) {
      const pkg = object(data.package);
      const id =
        typeof pkg.id === "string" && pkg.id
          ? "package:" + pkg.id
          : "summary:" + String(data.startedAt ?? summary.time);
      const reason =
        typeof data.reason === "string" ? data.reason.slice(0, 4096) : "Autonomous summary available.";
      const report = readKnown(path.join(runDir, "report.md"), 256 * 1024, true)?.text ?? reason;
      const counts = countFindings(null);
      const known = (Object.keys(counts) as (keyof FindingCounts)[]).every((severity) => {
        const n = object(data.findings)[severity];
        if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) return false;
        counts[severity] = n;
        return true;
      });
      archive(
        data,
        target,
        id,
        summary.time,
        "Existing autonomous summary",
        reason + " Coverage was not verified by Desktop.",
        report,
        known && (data.findingsKnown === true || (data.findingsKnown === undefined && Object.values(counts).some(n => n > 0))) ? counts : undefined,
        validRunUsage(data.usage) ? data.usage : undefined,
      );
    }
  }
  let count = 0;
  for (const directory of packages(meta)) {
    if (++count > 4096) break;
    const item = json(path.join(directory, "manifest.json"));
    if (
      !item ||
      !belongs(object(item.data.target)) ||
      !item.data.reviewId ||
      typeof item.data.reviewId !== "string"
    )
      continue;
    const data = item.data,
      id = "package:" + data.reviewId,
      candidate = found.get(id),
      target = object(data.target);
    const previous = candidate && (!sha(target.head) || !candidate.headSha || sha(target.head) === candidate.headSha) &&
      (!sha(target.base) || !candidate.baseSha || sha(target.base) === candidate.baseSha) ? candidate : undefined;
    const report =
      readKnown(path.join(directory, "report.md"), 256 * 1024, true)?.text ?? previous?.result?.report ?? "";
    const reason = report
      ? "Managed review artifact. Historical coverage has not been verified."
      : "Managed review metadata available. Its report or coverage is missing.";
    let findings = previous?.result?.findingsKnown ? previous.result.findings : undefined;
    const file = readKnown(path.join(directory, "findings.json"), 1024 * 1024);
    if (file) {
      try {
        const rows: unknown = JSON.parse(file.text);
        if (knownFindingList(rows)) findings = ingestedFindingCounts(rows);
      } catch {
        /* Incomplete legacy evidence leaves counts unknown. */
      }
    }
    archive(data, target, id, item.time, "Existing review package", reason, report, findings, previous?.usage, previous);
  }
  return [...found.values()];
}
