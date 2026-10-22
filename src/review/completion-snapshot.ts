import { readFile } from "node:fs/promises";
import path from "node:path";

/** Include absent inputs: creating a coverage source also invalidates an operator's answer. */
export const COMPLETION_INPUTS = [
  "manifest.json", "report.md", "research.json", "findings.json", "decisions.md",
  "coverage.md", "coverage.json", "scope-files.json", "slices-manifest.json",
  "slice-manifest.json", "slices/manifest.json", "blast-radius.json", "chunks.json",
  "chunk-state.json", "chunk-pass.json", "retry-state.json", "round-depth.json",
  "research-evidence/premises.json", "operator-decisions.json", "run-profile.json",
] as const;

export async function completionSnapshot(packageDir: string): Promise<string> {
  const entries = await Promise.all(COMPLETION_INPUTS.map(async (name) => {
    try { return [name, await readFile(path.join(packageDir, name), "utf8")] as const; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return [name, null] as const;
    }
  }));
  const values: Record<string, string | null> = Object.fromEntries(entries);
  let research: { dispatch?: { runs?: Array<{ rawEvidence?: unknown }> } } = {};
  try { research = JSON.parse(values["research.json"] ?? "{}") as typeof research; }
  catch (error) { if (!(error instanceof SyntaxError)) throw error; }
  for (const run of research?.dispatch?.runs ?? []) {
    if (typeof run.rawEvidence !== "string") continue;
    const name = run.rawEvidence.split("#")[0];
    if (!name) continue;
    const file = path.resolve(packageDir, name);
    const relative = path.relative(path.resolve(packageDir), file);
    if (relative.startsWith("../") || path.isAbsolute(relative)) throw new Error("Review evidence must stay inside its package");
    try { values[name] = await readFile(file, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      values[name] = null;
    }
  }
  return JSON.stringify(values);
}
