import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/** Canonical Context Operations bounded assembly/trace contract. */
export type ContextCandidate = Readonly<{ id: string; required: boolean; tokens: number }>;
export type ContextAssembly = Readonly<{ traceRef: string; configurationRevision: string; policyRef: string; policyRevision: string; selected: string[]; omittedOptional: string[]; partial: boolean }>;
export type ContextOverflow = Readonly<{ code: "context_overflow"; requiredId: string }>;
export function assembleContext(input: { candidates: readonly ContextCandidate[]; maxItems: number; maxTokens: number; traceRef: string; configurationRevision: string; policyRef: string; policyRevision: string; omittedOptional?: readonly string[] }): ContextAssembly | ContextOverflow {
  let items = 0; let tokens = 0; const selected: string[] = []; const omittedOptional: string[] = [...(input.omittedOptional ?? [])];
  for (const candidate of input.candidates) { const fits = items < input.maxItems && tokens + candidate.tokens <= input.maxTokens; if (!fits && candidate.required) return { code: "context_overflow", requiredId: candidate.id }; if (!fits) { omittedOptional.push(candidate.id); continue; } selected.push(candidate.id); items++; tokens += candidate.tokens; }
  return { traceRef: input.traceRef, configurationRevision: input.configurationRevision, policyRef: input.policyRef, policyRevision: input.policyRevision, selected, omittedOptional, partial: omittedOptional.length > 0 };
}

/** Persist a metadata-only canonical trace; SAC receipts refer to this record. */
export async function assembleAndRecordContext(input: {
  workspaceRoot: string; correlationId: string; candidates: readonly ContextCandidate[];
  maxItems: number; maxTokens: number; configurationRevision: string; policyRef: string; policyRevision: string; omittedOptional?: readonly string[];
}): Promise<ContextAssembly | ContextOverflow> {
  const traceId = createHash("sha256").update(input.correlationId).digest("hex").slice(0, 24);
  const traceRef = `./.metaproject/context-operations/traces/${traceId}.json`;
  const assembly = assembleContext({ ...input, traceRef });
  if ("code" in assembly) return assembly;
  const directory = path.join(input.workspaceRoot, ".metaproject", "context-operations", "traces");
  await mkdir(directory, { recursive: true });
  const target = path.join(directory, `${traceId}.json`); const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ schemaVersion: "1.0", correlationId: input.correlationId, configurationRevision: assembly.configurationRevision, policy: { ref: assembly.policyRef, revision: assembly.policyRevision }, selected: assembly.selected, omittedOptional: assembly.omittedOptional, partial: assembly.partial })}\n`, { mode: 0o600 });
  await rename(temporary, target);
  return assembly;
}
