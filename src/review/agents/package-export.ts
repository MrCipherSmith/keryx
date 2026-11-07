import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { reviewAgentResultStatus, validatedReviewAgentResult } from "./result-validation";

export class ReviewAgentExportError extends Error {
  readonly code = "review_agent_export_failed";
  constructor(message: string, cause?: unknown) { super(message, { cause }); }
}
type ExportPaths = { raw: string; driver: string };
type ExportResult = { ok: true; value: ExportPaths } | { ok: false; error: ReviewAgentExportError };
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ReviewAgentExportError("Expected stored result object");
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new ReviewAgentExportError("Missing stored result identity");
  return value;
}
async function artifactDirectory(root: string, name: string): Promise<void> {
  const dir = path.join(root, name);
  await mkdir(dir, { recursive: true });
  if (!(await lstat(dir)).isDirectory() || await realpath(dir) !== dir) throw new ReviewAgentExportError(`Unsafe artifact directory: ${name}`);
}
/** Exclusive, immutable publication. Retries can complete a partial export but cannot replace earlier data. */
async function publish(file: string, content: string): Promise<void> {
  try { await writeFile(file, content, { flag: "wx" }); }
  catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
    if (!(await lstat(file)).isFile() || await readFile(file, "utf8") !== content) throw new ReviewAgentExportError(`Conflicting artifact: ${file}`, cause);
  }
}

/** Export only authorized controller results. Scopes must be existing package slice IDs; no coverage is invented. */
export async function exportReviewAgentResult(packageDir: string, input: unknown): Promise<ExportResult> {
  try {
    const stored = object(input);
    const runId = text(stored.runId), dispatchId = text(stored.dispatchId);
    text(stored.resultId);
    const revision = text(stored.revision);
    if (reviewAgentResultStatus(stored.content) !== "completed") throw new ReviewAgentExportError("Blocked result cannot be exported as completed");
    const reply = validatedReviewAgentResult(stored.content);
    const reviewer = text(reply.reviewer);
    if (reviewer !== text(stored.skillRef)) throw new ReviewAgentExportError("Result reviewer differs from assigned skill");
    const root = await realpath(packageDir);
    const manifest = object(JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8")));
    if (object(manifest.target).head !== revision) throw new ReviewAgentExportError("Package and result revisions differ");
    const slices = object(JSON.parse(await readFile(path.join(root, "slices", "manifest.json"), "utf8"))).slices;
    if (!Array.isArray(slices)) throw new ReviewAgentExportError("Missing package slices");
    const ids = new Set(slices.map((slice) => text(object(slice).id)));
    if (!Array.isArray(stored.scopeIds) || stored.scopeIds.length === 0 || stored.scopeIds.some((id) => typeof id !== "string" || !ids.has(id))) throw new ReviewAgentExportError("Result scopes must name existing package slices");
    const name = `hierarchical-${createHash("sha256").update(JSON.stringify([runId, dispatchId])).digest("hex")}`;
    const paths = { raw: `raw/${name}.txt`, driver: `drivers/${name}.json` };
    const raw = `${JSON.stringify(reply, null, 2)}\n`;
    const driver = `${JSON.stringify({ reviewer, slices: stored.scopeIds, result: paths.raw, hierarchical: stored }, null, 2)}\n`;
    await artifactDirectory(root, "raw");
    await artifactDirectory(root, "drivers");
    // Driver is last: readers never observe an assignment before its raw reply exists.
    await publish(path.join(root, paths.raw), raw);
    await publish(path.join(root, paths.driver), driver);
    return { ok: true, value: paths };
  } catch (cause) {
    return { ok: false, error: cause instanceof ReviewAgentExportError ? cause : new ReviewAgentExportError("Could not export hierarchical result", cause) };
  }
}
