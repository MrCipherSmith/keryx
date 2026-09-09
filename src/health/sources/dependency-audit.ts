import { existsSync } from "node:fs";
import path from "node:path";
import { runCommand, toolVersion } from "../util";
import { NoImportError, makeFinding, resolveBin } from "./helpers";
import type { Finding, HealthContext, Priority, RawSourceResult, SourceAdapter, SourceStatus } from "../types";

function auditSeverityToPriority(severity: string): Priority {
  if (severity === "critical" || severity === "high") return "P0";
  if (severity === "moderate") return "P1";
  return "P2";
}

type AuditAdvisory = { id: string; packageName: string; title: string; severity: string };
type AuditDecode =
  | { valid: true; format: "bun" | "npm-modern" | "npm-legacy"; advisories: AuditAdvisory[] }
  | { valid: false; error: string; advisories: AuditAdvisory[] };

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}
function knownSeverity(value: unknown): value is string {
  return typeof value === "string" && ["critical", "high", "moderate", "low", "info"].includes(value);
}
function invalidAudit(advisories: AuditAdvisory[] = []): AuditDecode {
  return { valid: false, error: "dependency audit JSON contains an invalid or unsupported entry", advisories };
}

function decodeAudit(content: string): AuditDecode {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { valid: false, error: "dependency audit JSON parse failed", advisories: [] };
  }
  const data = record(parsed);
  if (!data) return invalidAudit();
  const advisories: AuditAdvisory[] = [];
  let malformed = false;
  if (Object.hasOwn(data, "vulnerabilities")) {
    const modern = record(data.vulnerabilities);
    if (!modern) return invalidAudit();
    for (const [packageName, value] of Object.entries(modern)) {
      const vulnerability = record(value);
      if (!vulnerability) { malformed = true; continue; }
      const parentSeverity = vulnerability.severity;
      if (!knownSeverity(parentSeverity)) malformed = true;
      const via = vulnerability.via === undefined ? [] : vulnerability.via;
      if (!Array.isArray(via)) malformed = true;
      const countBefore = advisories.length;
      for (const [index, entry] of (Array.isArray(via) ? via : []).entries()) {
        // npm represents inherited advisories by the vulnerable package name.
        if (typeof entry === "string" && entry.length > 0) continue;
        const advisory = record(entry);
        if (!advisory) { malformed = true; continue; }
        const severity = advisory.severity ?? parentSeverity;
        if (!knownSeverity(severity)) { malformed = true; continue; }
        advisories.push({
          id: String(advisory.source ?? advisory.id ?? `${packageName}-${index}`),
          packageName,
          title: stringValue(advisory.title, `vulnerability in ${packageName}`),
          severity,
        });
      }
      if (advisories.length === countBefore && knownSeverity(parentSeverity)) {
        advisories.push({ id: packageName, packageName,
          title: stringValue(vulnerability.title, `vulnerability in ${packageName}`), severity: parentSeverity });
      }
    }
    return malformed ? invalidAudit(advisories) : { valid: true, format: "npm-modern", advisories };
  }
  if (Object.hasOwn(data, "advisories")) {
    const legacy = record(data.advisories);
    if (!legacy) return invalidAudit();
    for (const [id, value] of Object.entries(legacy)) {
      const advisory = record(value);
      if (!advisory || !knownSeverity(advisory.severity)) { malformed = true; continue; }
      const packageName = stringValue(advisory.module_name, "unknown-package");
      advisories.push({ id, packageName, title: stringValue(advisory.title, id), severity: advisory.severity });
    }
    return malformed ? invalidAudit(advisories) : { valid: true, format: "npm-legacy", advisories };
  }
  const entries = Object.entries(data);
  if (entries.length === 0 || entries.every(([, value]) => Array.isArray(value))) {
    for (const [packageName, value] of entries) {
      for (const [index, entry] of (value as unknown[]).entries()) {
        const advisory = record(entry);
        if (!advisory || !knownSeverity(advisory.severity)) { malformed = true; continue; }
        const id = String(advisory.id ?? advisory.source ?? `${packageName}-${index}`);
        advisories.push({ id, packageName, title: stringValue(advisory.title, id), severity: advisory.severity });
      }
    }
    return malformed ? invalidAudit(advisories) : { valid: true, format: "bun", advisories };
  }
  return { valid: false, error: "dependency audit JSON format was not recognized", advisories };
}

/**
 * Which audit to run, decided by the LOCKFILE and only then by which binary
 * happens to be installed.
 *
 * F-240-02's sibling in production code (flow 240 T6). This used to be
 * `resolveBin(cwd, "bun") ? bun audit : npm audit` -- binary presence, not
 * project shape. On a developer machine with Bun installed, an npm project
 * therefore got `bun audit`, which has no `bun.lock` to resolve and fails; the
 * inverse of the shipped skill's defect, from the same confusion between "this
 * tool exists" and "this tool can audit THIS project".
 *
 * Bun's lockfile is `bun.lock` since 1.2 and `bun.lockb` before it. Both are
 * checked: a repository pinned to Bun < 1.2, or one that has not re-run `bun
 * install` since upgrading, still carries the old name.
 *
 * When no lockfile is recognised, the previous binary-based choice is kept
 * rather than refusing to run: the adapter cannot know that a project without a
 * root lockfile has nothing to audit (workspaces, vendored manifests), and the
 * honest outcome for a command that then produces no vulnerability data is
 * already handled -- `runAdapter` folds it to `configured-but-failed`, which is
 * a WARN and, since T7, also makes `gate.coverage` `partial`. What must never
 * happen is that path reporting zero advisories, and `decodeAudit` below refuses
 * to read npm's `{"error":{"code":"ENOLOCK"}}` envelope as an empty result.
 */
const LOCKFILE_COMMANDS: ReadonlyArray<{ lockfiles: readonly string[]; bin: string; argv: readonly string[] }> = [
  { lockfiles: ["bun.lock", "bun.lockb"], bin: "bun", argv: ["audit", "--json"] },
  { lockfiles: ["package-lock.json", "npm-shrinkwrap.json"], bin: "npm", argv: ["audit", "--json"] },
  { lockfiles: ["pnpm-lock.yaml"], bin: "pnpm", argv: ["audit", "--json"] },
];

export function auditCommand(cwd: string): string[] {
  for (const entry of LOCKFILE_COMMANDS) {
    if (!entry.lockfiles.some((name) => existsSync(path.join(cwd, name)))) continue;
    const bin = resolveBin(cwd, entry.bin);
    if (bin) return [bin, ...entry.argv];
  }
  const bun = resolveBin(cwd, "bun");
  return bun
    ? [bun, "audit", "--json"]
    : [resolveBin(cwd, "npm") ?? "npm", "audit", "--json"];
}

export const dependencyAuditAdapter: SourceAdapter = {
  id: "dependencyAudit",
  async detect(ctx: HealthContext): Promise<SourceStatus> {
    return resolveBin(ctx.cwd, "bun") || resolveBin(ctx.cwd, "npm") ? "available" : "missing";
  },
  async run(ctx: HealthContext): Promise<RawSourceResult> {
    const command = auditCommand(ctx.cwd);
    const result = await runCommand(command, ctx.cwd);
    return {
      source: "dependencyAudit",
      command: command.join(" "),
      toolVersion: await toolVersion([command[0] ?? "bun", "--version"], ctx.cwd),
      exitCode: result.exitCode,
      rawPath: "",
      content: result.stdout || result.combined,
      imported: false,
    };
  },
  async import(): Promise<RawSourceResult> {
    throw new NoImportError("dependency audit has no import format in v1");
  },
  parse(raw: RawSourceResult): Finding[] {
    const decoded = decodeAudit(raw.content);
    return decoded.advisories.map((advisory) => {
      const severity = advisory.severity.toLowerCase();
      return makeFinding({
        source: "dependencyAudit",
        severity: severity === "low" ? "warning" : "error",
        priority: auditSeverityToPriority(severity),
        category: "dependency",
        message: `${severity}: ${advisory.title} (${advisory.packageName})`,
        ruleKey: `advisory-${advisory.id}`,
        file: "package.json",
        line: null,
        symbol: advisory.packageName,
        suggestedAction: "Update or replace the vulnerable dependency.",
        command: raw.command,
        toolVersion: raw.toolVersion,
        rawLog: raw.rawPath,
      });
    });
  },
  validate(raw: RawSourceResult) {
    const decoded = decodeAudit(raw.content);
    return decoded.valid ? { valid: true, format: decoded.format } : { valid: false, error: decoded.error };
  },
};
