import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { runCommand, toolVersion } from "../util";
import { NoImportError, makeFinding, resolveBin } from "./helpers";
import type { Finding, HealthContext, RawSourceResult, SourceAdapter, SourceStatus } from "../types";

const CONFIG_FILES = [".oxlintrc.json", ".oxlintrc.jsonc"];

export const OXLINT_FORMAT = "json";
export const OXLINT_PARSE_ERROR = "oxlint JSON format was not recognized";

function hasConfigFile(cwd: string): boolean {
  if (CONFIG_FILES.some((file) => existsSync(path.join(cwd, file)))) return true;
  return [".oxlintrc.js", ".oxlintrc.cjs", ".oxlintrc.mjs", ".oxlintrc.ts"].some((file) => existsSync(path.join(cwd, file)));
}

function packageNamesOxlint(cwd: string): boolean {
  const file = path.join(cwd, "package.json");
  if (!existsSync(file)) return false;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    return Boolean(parsed.dependencies?.oxlint || parsed.devDependencies?.oxlint);
  } catch {
    return false;
  }
}

export function oxlintConfigured(cwd: string): boolean {
  return hasConfigFile(cwd) || packageNamesOxlint(cwd);
}

type OxlintMessage = { ruleId?: string | null; severity?: number | string; message?: string; line?: number };
type OxlintFile = { filePath?: string; filename?: string; messages?: OxlintMessage[] };

export function parseOxlintJson(content: string): OxlintFile[] | null {
  let data: unknown;
  try { data = JSON.parse(content); } catch { return null; }
  if (Array.isArray(data)) return data as OxlintFile[];
  if (data !== null && typeof data === "object" && Array.isArray((data as { diagnostics?: unknown }).diagnostics)) {
    return (data as { diagnostics: OxlintFile[] }).diagnostics;
  }
  return null;
}

export const oxlintAdapter: SourceAdapter = {
  id: "oxlint",
  // Same two-question shape as the eslint adapter: the project's OWN config (a
  // config file, or oxlint named in package.json) is the intent signal, and the
  // binary only decides whether that intent can be carried out. A binary alone
  // must NOT enable this source -- oxlint arrives as a transitive dependency in
  // repositories that lint with ESLint, and running it there would invent a
  // second, unrequested lint verdict over the same files.
  async detect(ctx: HealthContext): Promise<SourceStatus> {
    if (!oxlintConfigured(ctx.cwd)) return "skipped";
    return resolveBin(ctx.cwd, "oxlint") ? "available" : "missing";
  },
  async run(ctx: HealthContext): Promise<RawSourceResult> {
    const bin = resolveBin(ctx.cwd, "oxlint") ?? "oxlint";
    const command = [bin, ".", "--format", OXLINT_FORMAT];
    const result = await runCommand(command, ctx.cwd);
    return { source: "oxlint", command: command.join(" "), toolVersion: await toolVersion([bin, "--version"], ctx.cwd), exitCode: result.exitCode, rawPath: "", content: result.stdout || result.combined, imported: false };
  },
  async import(): Promise<RawSourceResult> { throw new NoImportError("oxlint has no import format"); },
  parse(raw: RawSourceResult, ctx: HealthContext): Finding[] {
    const data = parseOxlintJson(raw.content);
    if (data === null) return [];
    const findings: Finding[] = [];
    for (const file of data) {
      const filePath = file.filePath ?? file.filename ?? "";
      const relative = filePath && path.isAbsolute(filePath) ? path.relative(ctx.cwd, filePath) : filePath;
      for (const message of file.messages ?? []) {
        const isError = message.severity === 2 || message.severity === "error";
        findings.push(makeFinding({ source: "oxlint", severity: isError ? "error" : "warning", priority: isError ? "P1" : "P2", category: "lint", message: message.message ?? "", ruleKey: message.ruleId ?? "oxlint", file: relative || null, line: message.line ?? null, command: raw.command, toolVersion: raw.toolVersion, rawLog: raw.rawPath }));
      }
    }
    return findings;
  },
  validate(raw: RawSourceResult) {
    return parseOxlintJson(raw.content) === null ? { valid: false, error: OXLINT_PARSE_ERROR } : { valid: true, format: "oxlint-json" };
  },
};
