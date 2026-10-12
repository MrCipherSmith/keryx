// Pinned evidence only: no live Slate, git, Course or model lookup.
import { createHash } from "node:crypto";
import { writeContained } from "../lib/contained-write";
import { readPreservation } from "../session/preservation";
import { applyEvidenceRedactionFloor, REDACTION_NOTICE_KIND } from "./wrap-up-evidence";
import type { TrustedWrapUpResolution, WrapUpEvidence } from "./trusted-wrap-up";
export async function resolvePreservedWrapUp(input: {
  cwd: string; dir: string; snapshot: string; workspaceId: string; now?: () => Date; signal?: AbortSignal;
}): Promise<TrustedWrapUpResolution> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(input.workspaceId)) throw new Error("invalid workspace identity");
  const snapshot = readPreservation(input.dir, input.snapshot);
  if (!snapshot) throw new Error("preserved snapshot missing");
  const rawSlate = snapshot.files["slate.json"];
  if (rawSlate === undefined) throw new Error("preserved Slate missing");
  const slate: unknown = JSON.parse(rawSlate);
  if (!slate || typeof slate !== "object" || Array.isArray(slate)) throw new Error("invalid preserved Slate");
  if ((slate as { workspaceId?: unknown }).workspaceId !== input.workspaceId) throw new Error("snapshot workspace mismatch");
  const evidenceDir = `.metaproject/workspaces/${input.workspaceId}/preserved-evidence`;
  const base = `${evidenceDir}/${input.snapshot}`;
  // A fence longer than any backtick run in the captured Slate cannot be closed from inside it.
  const fence = "`".repeat(Math.max(3, ...(rawSlate.match(/`+/g) ?? []).map((run) => run.length + 1)));
  await writeContained(input.cwd, `${evidenceDir}/.gitignore`, "*\n", { mode: 0o600, ...(input.signal ? { signal: input.signal } : {}) });
  const bodies = [
    { name: "wrap-up.md", path: `${base}/wrap-up.md`, source: "generated" as const,
      content: ["# Preserved session evidence", `Snapshot: ${input.snapshot}`,
        "Review evidence, not accepted memory. Notes are not Seeds.",
        "Working-tree diff: NOT MEASURED in this capture.",
        "Current Course status: NOT MEASURED; only the captured reference is retained.",
        "## Captured Slate (Notes, Trail, Course, Seeds)", `${fence}json`, rawSlate, fence, ""].join("\n") },
    { name: "archive.jsonl", path: `${base}/archive.jsonl`, source: "tool-output" as const,
      content: snapshot.files["archive.jsonl"] ?? "Transcript NOT CAPTURED\n" },
  ];
  const floor = await applyEvidenceRedactionFloor(input.cwd, bodies);
  if (!floor.ok) throw new Error("preserved evidence security denied");
  const observedAt = (input.now ?? (() => new Date()))().toISOString();
  const evidence: WrapUpEvidence[] = [];
  for (const [i, body] of floor.bodies.entries()) {
    // Policy changes must not overwrite evidence referenced by old proposals.
    const revision = createHash("sha256").update(body.content).digest("hex");
    const rel = `${base}/${revision}.${bodies[i]!.name}`;
    await writeContained(input.cwd, rel, body.content, { mode: 0o600, ...(input.signal ? { signal: input.signal } : {}) });
    evidence.push({ kind: i === 0 ? "wrap-up" : "session", uri: `./${rel}`, revision, observedAt });
  }
  if (floor.notice !== undefined) {
    const revision = createHash("sha256").update(floor.notice).digest("hex");
    const rel = `${base}/${revision}.redaction.md`;
    await writeContained(input.cwd, rel, floor.notice, { mode: 0o600, ...(input.signal ? { signal: input.signal } : {}) });
    evidence.push({ kind: REDACTION_NOTICE_KIND, uri: `./${rel}`, revision, observedAt });
  }
  return { workspaceId: input.workspaceId, sourceRevision: input.snapshot,
    summary: "Preserved session evidence requiring human review; no automatic acceptance.", evidence,
    expiresAt: new Date(new Date(observedAt).getTime() + 3_600_000).toISOString() };
}
