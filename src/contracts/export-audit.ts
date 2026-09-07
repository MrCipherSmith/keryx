import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { detectPii } from "../security/detect/pii";
import { detectSecrets } from "../security/detect/secrets";

// ---------------------------------------------------------------------------
// AC6 / AC-M06 export audit (flow 238, phase 6, T9), scoped to this lane's own
// delivered artefacts: the agent-first-core schemas and examples under
// `docs/requirements/keryx-agent-first-core/{schemas,examples}/`. That is this
// lane's "selected difference" — file ownership boundaries in this flow keep
// every other tree (src/metrics/**, src/ctx/**, ...) with a sibling lane, so a
// repo-wide audit is out of scope here; a later lane that owns those trees can
// call `auditContentForExport` the same way over its own selection.
//
// "No private names, paths or results" (decision-traceability.md AC-M06) is
// checked with THREE signals, none invented for this task:
//
//   1. `detectSecrets` (src/security/detect/secrets.ts) — the repo's own
//      declared secret-detector rule set (specification.md §10 /
//      policies.md secrets.default). Read-only import; not modified here.
//   2. `detectPii` (src/security/detect/pii.ts) — the repo's own declared PII
//      rule set (policies.md pii.default), which is where a "private name"
//      (an email address, in these detectors) is already defined.
//   3. `PRIVATE_PATH_PATTERN` below — an absolute machine-local home-directory
//      path. Not a hand-picked username: it is the general SHAPE of the exact
//      leak this repo's own `.gitignore` already documents for `.mcp.json`
//      ("It embeds the ABSOLUTE path of the project on the machine that ran
//      the install ... committed once ... sat broken on Linux from 2026-08-13
//      until noticed"). A fixture meant to be publicly exported must be
//      portable across machines; an absolute home-rooted path is the concrete,
//      already-declared counterexample.
// ---------------------------------------------------------------------------

export type ExportAuditCategory = "secret" | "pii" | "private-path";

export interface ExportAuditFinding {
  file: string;
  category: ExportAuditCategory;
  policyId: string;
}

export interface ExportAuditResult {
  clean: boolean;
  findings: ExportAuditFinding[];
  filesScanned: string[];
}

const PRIVATE_PATH_PATTERN = /\/(?:Users|home)\/[^\s"'\\]+/;

/** Audit one file's already-read content. No I/O; pure and deterministic. */
export function auditContentForExport(file: string, content: string): ExportAuditFinding[] {
  const findings: ExportAuditFinding[] = [];
  for (const match of detectSecrets(content)) {
    findings.push({ file, category: "secret", policyId: match.policyId });
  }
  for (const match of detectPii(content)) {
    findings.push({ file, category: "pii", policyId: match.policyId });
  }
  if (PRIVATE_PATH_PATTERN.test(content)) {
    findings.push({ file, category: "private-path", policyId: "export.private-path" });
  }
  return findings;
}

/**
 * Audit every file in `files`. Refuses an empty list rather than reporting a
 * vacuous "clean" pass — this programme has repeatedly found a guard that
 * cannot fail because it was pointed at nothing (an empty/misdirected input
 * read back as "no findings"); this audit refuses that shape outright instead
 * of adding one more instance of it.
 */
export function auditPathsForExport(files: string[]): ExportAuditResult {
  if (files.length === 0) {
    throw new Error(
      "auditPathsForExport: refusing to audit an empty file list — this would report a vacuous clean pass",
    );
  }
  const findings: ExportAuditFinding[] = [];
  for (const file of files) {
    const content = readFileSync(file, "utf8");
    findings.push(...auditContentForExport(file, content));
  }
  return { clean: findings.length === 0, findings, filesScanned: [...files] };
}

/**
 * Enumerate the whole selected difference for this lane — every schema file
 * and every example/validation-cases file under the agent-first-core docpack.
 * Not a sample: every `*.schema.json` in `schemaDir` and every `*.json` in
 * `examplesDir`, read from disk each call so an added or removed file is
 * picked up without editing this list by hand.
 */
export function listAgentFirstCoreExportFiles(schemaDir: string, examplesDir: string): string[] {
  const schemaFiles = readdirSync(schemaDir)
    .filter((name) => name.endsWith(".schema.json"))
    .sort()
    .map((name) => path.join(schemaDir, name));
  const exampleFiles = readdirSync(examplesDir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => path.join(examplesDir, name));
  return [...schemaFiles, ...exampleFiles];
}
