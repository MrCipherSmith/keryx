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

export const OXLINT_MISSING_CONFIG = "oxlint config found, binary not found (node_modules/.bin/oxlint and PATH)";
export const OXLINT_MISSING_PACKAGE = "oxlint named in package.json, binary not found (node_modules/.bin/oxlint and PATH)";

/** Why a `missing` oxlint is missing, naming the intent signal that actually fired. */
export function oxlintMissingReason(cwd: string): string {
  return hasConfigFile(cwd) ? OXLINT_MISSING_CONFIG : OXLINT_MISSING_PACKAGE;
}

// `oxlint --format json` (1.x): one FLAT record per diagnostic under
// `diagnostics`, not ESLint's per-file `messages[]`. Shape captured from
// oxlint 1.81.0; the regression fixture in oxlint.test.ts is that output
// verbatim, because a hand-written ESLint-shaped fixture is how this parser
// once passed its tests while dropping every real diagnostic.
type OxlintDiagnostic = {
  message: string;
  code?: string;
  severity?: string;
  filename?: string;
  labels?: Array<{ span?: { line?: number } }>;
};

function isDiagnostic(item: unknown): item is OxlintDiagnostic {
  return item !== null && typeof item === "object" && typeof (item as { message?: unknown }).message === "string";
}

/** `null` when the output is not oxlint JSON, including a record that is not a diagnostic. */
export function parseOxlintJson(content: string): OxlintDiagnostic[] | null {
  let data: unknown;
  try { data = JSON.parse(content); } catch { return null; }
  if (data === null || typeof data !== "object") return null;
  const diagnostics = (data as { diagnostics?: unknown }).diagnostics;
  if (!Array.isArray(diagnostics) || !diagnostics.every(isDiagnostic)) return null;
  return diagnostics;
}

export const oxlintAdapter: SourceAdapter = {
  id: "oxlint",
  capability: "lint",
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
    return data.map((diagnostic) => {
      const filePath = diagnostic.filename ?? "";
      const relative = filePath && path.isAbsolute(filePath) ? path.relative(ctx.cwd, filePath) : filePath;
      const isError = diagnostic.severity === "error";
      return makeFinding({
        source: "oxlint",
        severity: isError ? "error" : "warning",
        priority: isError ? "P1" : "P2",
        category: "lint",
        message: diagnostic.message,
        ruleKey: diagnostic.code ?? "oxlint",
        file: relative || null,
        line: diagnostic.labels?.[0]?.span?.line ?? null,
        command: raw.command,
        toolVersion: raw.toolVersion,
        rawLog: raw.rawPath,
      });
    });
  },
  validate(raw: RawSourceResult) {
    return parseOxlintJson(raw.content) === null ? { valid: false, error: OXLINT_PARSE_ERROR } : { valid: true, format: "oxlint-json" };
  },
};
