import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "../lib/fs";
import { completeReviewGated } from "./complete-gated";
import type { PrLookup } from "./complete-head-gate";
import { parseReviewResult, isReviewerResult } from "./ledger";
import { splitUsage } from "./dispatch-usage";
import { computeVerdict } from "./verdict";
import { hasDesktopReviewerEvidence } from "./desk-run-executor-recovery";
import { createManagedReviewPackage } from "./managed";
import type { AutonomousSummary } from "./autonomous-summary";
import type { ManagedReviewManifest } from "./types";

type Row = Record<string, unknown>;
type Ledger = { scopeReviewed: boolean; obligations: Array<{ id: string; source: string; status: string }> };
type RunStep = (args: string[]) => Promise<boolean>;

async function json<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8")) as T;
}

/** Keep each unresolved raw finding under its ledger id. Classification and
 * verification stay with the normal ingest rules; an unanswered follow-up
 * cannot be turned into a finding or marked done here. */
export async function retainUnreconciledFindings(dir: string, ledger: Ledger, findings: Row[]): Promise<Row[] | undefined> {
  if (!ledger.scopeReviewed || !Array.isArray(ledger.obligations)) return;
  const retained = [...findings];
  const raws = new Map<string, NonNullable<ReturnType<typeof parseReviewResult>>>();
  for (const item of ledger.obligations) {
    if (item.status !== "unresolved") continue;
    const file = /^raw\/([\w.-]+)\.txt$/.exec(item.source)?.[1];
    if (!file || !item.id.startsWith(file + ":") || retained.some(finding => finding.id === item.id)) return;
    let raw = raws.get(file);
    if (!raw) {
      const filePath = path.join(dir, "raw", file + ".txt");
      if (!(await lstat(filePath)).isFile()) return;
      const { body, incomplete } = splitUsage(await readFile(filePath, "utf8"));
      raw = parseReviewResult(body);
      if (incomplete || !raw || !isReviewerResult(raw)) return;
      raws.set(file, raw);
    }
    const id = item.id.slice(file.length + 1);
    if (!/^[-\w.:]+$/.test(id)) return;
    const observations = raw.findings?.filter(finding => finding.id === id) ?? [];
    if (observations.length !== 1) return;
    // Only previously ingested records may carry verification or dispositions.
    const fields = ["severity", "file", "line", "quote", "problem", "impact", "suggested_fix", "evidence", "confidence",
      "class_scope", "dedupe_key", "degradation_class", "evidence_kind", "location_class"] as const;
    const record = observations[0] as Row;
    retained.push({ ...Object.fromEntries(fields.filter(key => record[key] !== undefined).map(key => [key, record[key]])),
      id: item.id, reviewer: raw.reviewer });
  }
  return retained;
}

export async function finishAutoDesktopReview(input: {
  checkout: string; dir: string; base: string; head: string; ref: string; runnerDir: string;
  summary: AutonomousSummary; signal: AbortSignal; run: RunStep; prLookup: PrLookup;
  prFiles: NonNullable<Parameters<typeof completeReviewGated>[2]["prFiles"]>;
}): Promise<boolean> {
  const { checkout, dir, base, head, ref, runnerDir, summary, signal, run, prLookup, prFiles } = input;
  const manifest = await json<ManagedReviewManifest>(path.join(dir, "manifest.json"));
  if (manifest.target.ref !== ref || manifest.target.base !== base || manifest.target.head !== head ||
      manifest.readiness_waivers?.length || (manifest.status !== "draft" && manifest.status !== "reviewed") ||
      !hasDesktopReviewerEvidence(dir, summary.usage)) return false;

  signal.throwIfAborted();
  const ledgerFile = path.join(dir, "research.json");
  const findingsFile = path.join(dir, "findings.json");
  const reportFile = path.join(dir, "report.md");
  const ledgerArgs = ["ledger", "build", "--package", dir, "--json"];
  await run(ledgerArgs);
  const ledger = await json<Ledger>(ledgerFile);
  const original = await json<Row[]>(findingsFile);
  const findings = Array.isArray(original) ? await retainUnreconciledFindings(dir, ledger, original) : undefined;
  if (!findings) return false;
  if (manifest.status === "draft" || findings.length !== original.length) {
    const stagedFindings = path.join(runnerDir, "auto-findings.json");
    await writeFileAtomic(stagedFindings, JSON.stringify(findings, null, 2), { mode: 0o600 });
    if (!await run([...ledgerArgs, "--findings", stagedFindings])) return false;
    const reportText = [
      "# Managed Review Report", "Evidence level: static only — did not run: browser or running application",
      "", `Target: ${ref}`, `Range: \`${base}...${head}\``,
      "", "The coordinator's recorded dispositions were preserved. Additional reviewer observations were retained without independent verification.",
      "", ...findings.map(f => `### ${f.id} — ${f.severity}\n\n${f.problem ?? ""}\n\nEvidence: ${f.evidence ?? f.file ?? ""}\n`),
      ...(findings.length ? [] : ["No reviewer findings recorded."]), "",
    ].join("\n");
    signal.throwIfAborted();
    await createManagedReviewPackage({ cwd: checkout, mode: "ingest", target: { kind: "pr", ref, base, head },
      reviewId: manifest.reviewId, reportText, findings, research: await json(ledgerFile) });
  }
  if (!await run(ledgerArgs)) return false;
  signal.throwIfAborted();
  const verdict = await computeVerdict(dir);
  const report = await readFile(reportFile, "utf8");
  const updated = report.replace(/^Not verified:\s*\d+[^\n]*\n/gm, "").trimEnd() +
    (verdict.unverified ? `\n\nNot verified: ${verdict.unverified}` : "") + "\n";
  if (updated !== report) await writeFileAtomic(reportFile, updated);
  const files = await prFiles(ref);
  const pr = await prLookup(ref);
  if (!files || !pr?.exists || pr.state !== "OPEN" || pr.headSha !== head) return false;
  signal.throwIfAborted();
  await completeReviewGated(checkout, dir, { head, prLookup: async () => pr, prFiles: async () => files });
  return true;
}
