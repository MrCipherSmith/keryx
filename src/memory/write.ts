import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { formatGuardWarning, guardOutput } from "../security/guard";
import { memoryRoot } from "./store";
import { MEMORY_TYPES, type MemoryStatus } from "./types";

export type CanonicalWriteError = {
  code: "path-outside-memory" | "invalid-entry" | "persistence-failed";
  message: string;
};
export type CanonicalWriteResult =
  | { status: "written"; path: string; warnings: string[] }
  | { status: "skipped"; path: string; reason: string; warnings: string[] }
  | { status: "error"; path: string; error: CanonicalWriteError; warnings: string[] };
export type CanonicalEntryWrite = { relativePath: string; content: string };
export type CanonicalPairWriteResult =
  | { status: "written"; paths: string[]; warnings: string[] }
  | { status: "skipped"; paths: string[]; reason: string; warnings: string[] }
  | { status: "error"; paths: string[]; error: CanonicalWriteError; warnings: string[] };

type PreparedWrite = { relativePath: string; absolutePath: string; content: string; warnings: string[] };

export async function resolveCanonicalEntryPath(cwd: string, relativePath: string): Promise<{ absolutePath: string; relativePath: string } | null> {
  const root = path.resolve(memoryRoot(cwd));
  const absolutePath = path.resolve(root, relativePath);
  const normalized = toPosix(path.relative(root, absolutePath));
  if (!normalized || normalized.startsWith("../") || path.isAbsolute(normalized) || !normalized.endsWith(".md")) {
    return null;
  }
  return { absolutePath, relativePath: normalized };
}

export async function writeCanonicalEntry(input: { cwd: string; relativePath: string; content: string }): Promise<CanonicalWriteResult> {
  const prepared = await prepare(input.cwd, input);
  if ("result" in prepared) return prepared.result;
  const guarded = await guardPrepared(input.cwd, prepared.value);
  if ("result" in guarded) return guarded.result;
  try {
    await replaceAtomically(guarded.value.absolutePath, guarded.value.content);
    return { status: "written", path: guarded.value.relativePath, warnings: guarded.value.warnings };
  } catch (cause) {
    return persistenceError(guarded.value.relativePath, cause, guarded.value.warnings);
  }
}

export async function writeCanonicalPair(input: { cwd: string; entries: [CanonicalEntryWrite, CanonicalEntryWrite]; failReplaceAt?: number }): Promise<CanonicalPairWriteResult> {
  const [firstEntry, secondEntry] = input.entries;
  const first = await prepare(input.cwd, firstEntry);
  if ("result" in first) return asPair(first.result, []);
  const second = await prepare(input.cwd, secondEntry);
  if ("result" in second) return asPair(second.result, [first.value.relativePath]);
  // Validate *both* future canonical values before either security evaluation or
  // persistence, so invalid pair inputs cannot produce an observable half-step.
  const firstGuard = await guardPrepared(input.cwd, first.value);
  if ("result" in firstGuard) return asPair(firstGuard.result, []);
  const secondGuard = await guardPrepared(input.cwd, second.value);
  if ("result" in secondGuard) return asPair(secondGuard.result, [first.value.relativePath]);
  const prepared: [PreparedWrite, PreparedWrite] = [firstGuard.value, secondGuard.value];
  const warnings = prepared.flatMap((entry) => entry.warnings);
  const [originalFirst, originalSecond] = await Promise.all(
    prepared.map((entry) => readFile(entry.absolutePath, "utf8")),
  );
  try {
    await replaceAtomically(prepared[0].absolutePath, prepared[0].content);
    if (input.failReplaceAt === 2) throw new Error("simulated second replacement failure");
    await replaceAtomically(prepared[1].absolutePath, prepared[1].content);
    return { status: "written", paths: prepared.map((entry) => entry.relativePath), warnings };
  } catch (cause) {
    try {
      await replaceAtomically(prepared[0].absolutePath, originalFirst!);
      await replaceAtomically(prepared[1].absolutePath, originalSecond!);
    } catch (rollbackCause) {
      return {
        status: "error",
        paths: prepared.map((entry) => entry.relativePath),
        warnings,
        error: { code: "persistence-failed", message: `pair persistence and rollback failed: ${message(rollbackCause)}` },
      };
    }
    return {
      status: "error",
      paths: prepared.map((entry) => entry.relativePath),
      warnings,
      error: { code: "persistence-failed", message: `pair persistence failed: ${message(cause)}` },
    };
  }
}

async function prepare(cwd: string, entry: CanonicalEntryWrite): Promise<{ value: PreparedWrite } | { result: CanonicalWriteResult }> {
  const resolved = await resolveCanonicalEntryPath(cwd, entry.relativePath);
  if (!resolved) return { result: { status: "error", path: entry.relativePath, warnings: [], error: { code: "path-outside-memory", message: "Memory entry path must be a confined typed Markdown path." } } };
  const validation = validateNextEntry(resolved.relativePath, entry.content);
  if (validation) return { result: { status: "error", path: resolved.relativePath, warnings: [], error: { code: "invalid-entry", message: validation } } };
  return { value: { ...resolved, content: entry.content, warnings: [] } };
}

async function guardPrepared(cwd: string, prepared: PreparedWrite): Promise<{ value: PreparedWrite } | { result: CanonicalWriteResult }> {
  const guard = await guardOutput({ cwd, content: prepared.content, target: "memory", source: "tool-output", path: prepared.relativePath });
  const warning = formatGuardWarning(guard.decision, "memory");
  const warnings = warning ? [warning] : [];
  if (!guard.allowed) return { result: { status: "skipped", path: prepared.relativePath, warnings, reason: guard.reason ?? "security gate blocked" } };
  return { value: { ...prepared, warnings } };
}

function validateNextEntry(relativePath: string, content: string): string | null {
  if (!content.startsWith("# ")) return "Memory entry must begin with a Markdown title.";
  const type = header(content, "Type");
  const status = header(content, "Status") as MemoryStatus | null;
  const folder = relativePath.split("/")[0];
  const typeConfig = MEMORY_TYPES.find((candidate) => candidate.type === type && candidate.folder === folder);
  if (!typeConfig) return "Memory entry Type must match its configured typed folder.";
  if (!status || !["draft", "accepted", "deprecated", "conflict", "superseded"].includes(status)) return "Memory entry Status is invalid.";
  if (!/^##\s+Summary\s*$/m.test(content) || !/^##\s+Provenance\s*$/m.test(content)) return "Memory entry requires Summary and Provenance sections.";
  return null;
}

async function replaceAtomically(target: string, content: string): Promise<void> {
  const dir = path.dirname(target);
  await mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(target)}.keryx-tmp-${process.pid}-${Math.random().toString(16).slice(2)}`);
  try {
    await writeFile(tmp, content, "utf8");
    const file = await open(tmp, "r");
    try { await file.sync(); } finally { await file.close(); }
    await rename(tmp, target);
    try { const directory = await open(dir, "r"); try { await directory.sync(); } finally { await directory.close(); } } catch { /* unsupported directory fsync */ }
  } finally {
    await rm(tmp, { force: true });
  }
}

function asPair(result: CanonicalWriteResult, prior: string[]): CanonicalPairWriteResult {
  if (result.status === "written") return { status: "written", paths: [...prior, result.path], warnings: result.warnings };
  if (result.status === "skipped") return { status: "skipped", paths: [...prior, result.path], warnings: result.warnings, reason: result.reason };
  return { status: "error", paths: [...prior, result.path], warnings: result.warnings, error: result.error };
}
function persistenceError(path: string, cause: unknown, warnings: string[]): CanonicalWriteResult {
  return { status: "error", path, warnings, error: { code: "persistence-failed", message: message(cause) } };
}
function header(content: string, name: string): string | null { return content.match(new RegExp(`^${name}:\\s*(.+)$`, "mi"))?.[1]?.trim() ?? null; }
function toPosix(value: string): string { return value.split(path.sep).join("/"); }
function message(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause); }
