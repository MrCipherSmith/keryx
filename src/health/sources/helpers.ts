import path from "node:path";
import { existsSync } from "node:fs";
import { moduleOfFile } from "../util";
import type { Finding, Priority, Severity } from "../types";

export class NoImportError extends Error {}

export function resolveBin(cwd: string, name: string): string | null {
  const local = path.join(cwd, "node_modules", ".bin", name);
  if (existsSync(local)) {
    return local;
  }
  return Bun.which(name);
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function makeFinding(input: {
  source: string;
  severity: Severity;
  priority: Priority;
  category: string;
  message: string;
  file: string | null;
  line: number | null;
  symbol?: string | null;
  suggestedAction?: string | null;
  ruleKey?: string;
  command: string | null;
  toolVersion: string | null;
  rawLog: string | null;
}): Finding {
  const file = input.file ? normalizePath(input.file) : null;
  const key = slugify(input.ruleKey ?? input.message).slice(0, 48) || "issue";
  const id = [
    "health",
    input.source,
    key,
    file ? slugify(file) : "project",
    input.line ?? 0,
  ].join("-");

  return {
    schemaVersion: 1,
    id,
    source: input.source,
    severity: input.severity,
    priority: input.priority,
    category: input.category,
    message: input.message,
    file,
    line: input.line,
    symbol: input.symbol ?? null,
    scope: {
      project: "current",
      module: file ? moduleOfFile(file) : null,
      file,
      entity: null,
      skill: null,
    },
    suggestedAction: input.suggestedAction ?? null,
    provenance: {
      command: input.command,
      toolVersion: input.toolVersion,
      rawLog: input.rawLog,
    },
  };
}

export function normalizePath(file: string): string {
  return file.replace(/\\/g, "/").replace(/^\.\//, "");
}
