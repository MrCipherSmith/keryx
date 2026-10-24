import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { assertWritableContained, removeContained } from "../lib/contained-write";
import { isLockHeld, isNotFound, withFileLock } from "../lib/fs";
import { assertValidLearningId } from "./paths";
import { validateProbeCheckpoint, validateProbePlan } from "./probe-schema";
import type { ProbeCheckpoint, ProbePlan } from "./probe-schema";

interface RetentionCandidate { id: string; updatedAt: string }

/** Only transcript directories are disposable; audit JSON is never rewritten. */
export async function retainProbeRuns(root: string, patternId: string, retain: number): Promise<string[]> {
  assertValidLearningId(patternId);
  if (!Number.isSafeInteger(retain) || retain < 0) throw new RangeError("invalid probe retention count");
  const base = `.metaproject/data/learning/probes/${patternId}`;
  await assertWritableContained(root, base, "directory");
  let entries;
  try { entries = await readdir(path.join(root, base), { withFileTypes: true }); }
  catch (error) { if (isNotFound(error)) return []; throw error; }
  const candidates: RetentionCandidate[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-f0-9]{12}$/.test(entry.name)) continue;
    const rel = `${base}/${entry.name}`;
    if (await isLockHeld(path.join(root, rel, "probe.lock"))) continue;
    const cp = await finalized(root, rel, entry.name, patternId);
    if (!cp) continue;
    const children = await readdir(path.join(root, rel), { withFileTypes: true });
    if (children.some((child) => child.name === "runs" && child.isDirectory()))
      candidates.push({ id: entry.name, updatedAt: cp.updatedAt });
  }
  candidates.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id));
  const removed: string[] = [];
  for (const candidate of candidates.slice(0, Math.max(0, candidates.length - retain))) {
    const rel = `${base}/${candidate.id}`;
    const lock = path.join(root, rel, "probe.lock");
    await assertWritableContained(root, `${rel}/probe.lock`, "directory");
    if (await isLockHeld(lock)) continue;
    try {
      await withFileLock(lock, async () => {
        if (!(await finalized(root, rel, candidate.id, patternId))) return;
        if (await removeContained(root, `${rel}/runs`)) removed.push(candidate.id);
      }, { timeoutMs: 0 });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Timed out waiting for lock:")) continue;
      throw error;
    }
  }
  return removed;
}

async function finalized(root: string, rel: string, probeId: string, patternId: string): Promise<ProbeCheckpoint | undefined> {
  for (const file of ["plan.json", "checkpoint.json"]) await assertWritableContained(root, `${rel}/${file}`);
  try {
    const planBytes = await readFile(path.join(root, rel, "plan.json"), "utf8");
    const plan = JSON.parse(planBytes) as ProbePlan;
    const cp = JSON.parse(await readFile(path.join(root, rel, "checkpoint.json"), "utf8")) as ProbeCheckpoint;
    if (validateProbePlan(plan, { persisted: true }).ok && validateProbeCheckpoint(cp).ok
      && plan.probeId === probeId && plan.patternId === patternId && cp.probeId === probeId
      && cp.planDigest === createHash("sha256").update(planBytes).digest("hex") && cp.phase === "finalized") return cp;
    return undefined;
  } catch (error) {
    if (isNotFound(error) || error instanceof SyntaxError) return undefined;
    throw error;
  }
}
