import { existsSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { packageScopeFiles } from "./coverage";
import { EVIDENCE_DIR, type MutantResult, type MutationRecord } from "./mutate";

export const UNPROVEN = "unproven";

export type SeverityAuditNote = { from: string; to: string; evidence: string };

/**
 * Written instead of a raise when the only survivors are presentation mutants: the severity stays, and the
 * note names the mutant so a reader of the report sees why a survivor did not move it.
 */
export type SeverityAuditHeld = { severity: string; mutant: string; kind: "presentation"; evidence: string; reason: string };

export type AuditChange = {
  id: string;
  from: string;
  to: string;
  evidence?: string | undefined;
  label?: string | undefined;
  /** Set when the severity was deliberately left alone; `from` and `to` are then equal. */
  held?: boolean | undefined;
  reason: string;
};

export type NamedMutationRecord = { name: string; record: MutationRecord };

type Finding = Record<string, unknown>;

const CITATION = /\bmutant:([A-Za-z0-9_.-]+)/g;
const RAISE_FROM = new Set(["minor", "nit", "info", "low"]);

function cited(finding: Finding): string[] {
  const evidence = typeof finding.evidence === "string" ? finding.evidence : "";
  return [...new Set([...evidence.matchAll(CITATION)].map((m) => m[1]!))];
}

/** The latest recorded pass that actually ran the mutant; an invalid mutant was never executed. */
function executed(id: string, records: readonly NamedMutationRecord[]): { result: MutantResult; name: string } | undefined {
  for (const { name, record } of [...records].reverse()) {
    const result = record.mutants.find((m) => m.id === id && m.status !== "invalid");
    if (result) return { result, name };
  }
  return undefined;
}

function withLabel(finding: Finding, label: string): string[] {
  const labels = Array.isArray(finding.labels) ? finding.labels.filter((l): l is string => typeof l === "string") : [];
  return labels.includes(label) ? labels : [...labels, label];
}

/**
 * Raises a finding's severity only on evidence the finding itself cites (`mutant:<id>`) and a recorded
 * run confirms. It never deletes, never touches a blocker, and never lowers a finding other than capping
 * an unproven major at minor. It is a separate pass from the verifier, which can only delete.
 */
export function auditSeverity(
  findings: readonly Finding[],
  records: readonly NamedMutationRecord[],
  options: { changedFiles?: readonly string[] | undefined } = {},
): { findings: Finding[]; changes: AuditChange[] } {
  const changes: AuditChange[] = [];
  const changed = options.changedFiles === undefined ? undefined : new Set(options.changedFiles);
  const audited = findings.map((finding) => {
    const ids = cited(finding);
    const severity = typeof finding.severity === "string" ? finding.severity : "";
    const label = String(finding.id ?? finding.global_id ?? "?");
    if (ids.length === 0 || severity === "blocker") return finding;

    const runs = ids.map((id) => ({ id, run: executed(id, records) }));
    const survivors = runs.filter((r) => r.run?.result.status === "survived" && (changed === undefined || changed.has(r.run.result.file)));
    if (survivors.length > 0) {
      if (!RAISE_FROM.has(severity)) return finding;
      // A record written before `kind` existed has none, and reads as `behavior`: it raises as it always did.
      const behavioral = survivors.filter((r) => r.run!.result.kind !== "presentation");
      if (behavioral.length === 0) {
        const first = survivors[0]!;
        const evidence = `${first.run!.name}#${first.id}`;
        const reason = `mutant ${first.id} survived but only changes presentation: severity held`;
        changes.push({ id: label, from: severity, to: severity, evidence, held: true, reason });
        const held = { severity, mutant: first.id, kind: "presentation", evidence, reason } satisfies SeverityAuditHeld;
        return { ...finding, severity_audit: { held } };
      }
      const first = behavioral[0]!;
      const evidence = `${first.run!.name}#${first.id}`;
      changes.push({ id: label, from: severity, to: "major", evidence, reason: `mutant ${first.id} survived: no assertion pins the changed behaviour` });
      return { ...finding, severity: "major", severity_audit: { from: severity, to: "major", evidence } satisfies SeverityAuditNote };
    }
    if (runs.every((r) => r.run === undefined)) {
      const to = severity === "major" ? "minor" : severity;
      changes.push({ id: label, from: severity, to, label: UNPROVEN, reason: "the finding cites a mutant no recorded run executed" });
      return { ...finding, severity: to, labels: withLabel(finding, UNPROVEN) };
    }
    return finding;
  });
  return { findings: audited, changes };
}

export async function loadMutationRecords(packageDir: string): Promise<NamedMutationRecord[]> {
  const dir = path.join(packageDir, EVIDENCE_DIR);
  if (!existsSync(dir)) return [];
  const names = (await readdir(dir)).filter((n) => /^mutation-\d+\.json$/.test(n)).sort((a, b) => Number(/\d+/.exec(a)![0]) - Number(/\d+/.exec(b)![0]));
  const out: NamedMutationRecord[] = [];
  for (const name of names) {
    try {
      out.push({ name, record: JSON.parse(await readFile(path.join(dir, name), "utf8")) as MutationRecord });
    } catch {
      continue;
    }
  }
  return out;
}

/** Audits `<package>/findings.json` in place; with `dryRun` nothing is written. */
export async function auditPackage(packageDir: string, options: { dryRun?: boolean | undefined } = {}): Promise<{ changes: AuditChange[]; findings: number; written: boolean }> {
  const file = path.join(packageDir, "findings.json");
  const raw: unknown = JSON.parse(await readFile(file, "utf8"));
  if (!Array.isArray(raw)) throw new Error(`${file} must hold an array of findings`);
  const { findings, changes } = auditSeverity(raw as Finding[], await loadMutationRecords(packageDir), { changedFiles: await packageScopeFiles(packageDir) });
  const write = options.dryRun !== true && changes.length > 0;
  if (write) await writeFile(file, `${JSON.stringify(findings, null, 2)}\n`, "utf8");
  return { changes, findings: raw.length, written: write };
}
