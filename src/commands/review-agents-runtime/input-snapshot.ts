import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentCatalog } from "../../agents/catalog";
import type { ReviewAgentAdapter, ReviewAgentRegisteredPlan } from "../../review/agents/types";

export interface RunInputSnapshot {
  readonly schemaVersion: 1;
  readonly revision: string;
  readonly catalog: AgentCatalog;
  readonly skills: Readonly<Record<string, string>>;
  readonly sourceDigest: string;
  readonly digest: string;
}
type Outcome<T> = { ok: true; value: T } | { ok: false; error: Error };
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const digest = (value: unknown) => hash(JSON.stringify(value));
function failure(error: unknown): { ok: false; error: Error } {
  return { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
}
async function sourceDigest(root: string): Promise<string> {
  const entries: [string, string][] = [];
  async function visit(relative: string): Promise<void> {
    const file = path.join(root, relative);
    const stat = await lstat(file);
    if (stat.isSymbolicLink()) throw new Error(`Input source symlink is not supported: ${relative}`);
    if (stat.isDirectory()) {
      for (const name of (await readdir(file)).sort()) await visit(path.join(relative, name));
    } else if (stat.isFile()) entries.push([relative.split(path.sep).join("/"), hash(await readFile(file))]);
    else throw new Error(`Unsupported input source entry: ${relative}`);
  }
  await visit("");
  return digest(entries);
}

/** Written before publishing the run directory; never regenerated when reopening a run. */
export async function captureRunInputs(directory: string, revision: string, catalog: AgentCatalog,
  readSkill: (ref: string) => Promise<string>): Promise<Outcome<RunInputSnapshot>> {
  try {
    if (catalog.errors.length) throw new Error("Cannot snapshot an invalid agent catalog");
    const skills: Record<string, string> = {};
    const reviewAgents = catalog.agents.filter((agent) => agent.definition.name.startsWith("review-"));
    for (const ref of [...new Set(reviewAgents.flatMap((agent) => agent.definition.skills))].sort()) skills[ref] = await readSkill(ref);
    const body = { schemaVersion: 1 as const, revision, catalog: structuredClone(catalog), skills,
      sourceDigest: await sourceDigest(path.join(directory, "source")) };
    const value = { ...body, digest: digest(body) };
    await writeFile(path.join(directory, "input-snapshot.json"), JSON.stringify(value), { flag: "wx", mode: 0o600 });
    return { ok: true, value };
  } catch (error) { return failure(error); }
}

export async function loadRunInputs(directory: string): Promise<Outcome<RunInputSnapshot>> {
  try {
    const parsed = JSON.parse(await readFile(path.join(directory, "input-snapshot.json"), "utf8")) as RunInputSnapshot;
    const { digest: expected, ...body } = parsed;
    if (parsed.schemaVersion !== 1 || typeof parsed.revision !== "string" || !Array.isArray(parsed.catalog?.agents)
      || parsed.catalog.errors.length !== 0 || typeof parsed.skills !== "object" || parsed.skills === null
      || typeof parsed.sourceDigest !== "string" || expected !== digest(body)) throw new Error("Invalid input snapshot manifest");
    if (await sourceDigest(path.join(directory, "source")) !== parsed.sourceDigest) throw new Error("Input source snapshot has changed");
    return { ok: true, value: parsed };
  } catch (error) { return failure(error); }
}

/** Both adapters receive precisely the same persisted, identity-bound input packet. */
export function bindSnapshotAdapter(adapter: ReviewAgentAdapter, directory: string, captured: RunInputSnapshot,
  getPlan: () => Promise<ReviewAgentRegisteredPlan | null>): ReviewAgentAdapter {
  // Do not retain caller-owned mutable catalog or skills as trusted input.
  const snapshot = structuredClone(captured);
  return { ...adapter, async execute(request, context) {
    if (request.revision !== snapshot.revision) throw new Error("Input snapshot revision mismatch");
    const loaded = await loadRunInputs(directory);
    if (!loaded.ok) throw loaded.error;
    if (loaded.value.digest !== snapshot.digest) throw new Error("Input snapshot manifest has changed");
    const plan = await getPlan();
    let binding;
    if (request.planHash !== undefined) {
      if (!plan || plan.revision !== request.revision || plan.planHash !== request.planHash || plan.planVersion !== request.planVersion)
        throw new Error("Input snapshot plan mismatch");
      binding = plan.assignments[request.taskId];
      if (binding && (binding.entity !== request.entity || binding.role !== request.role)) throw new Error("Input snapshot plan entity mismatch");
      const allowed = binding?.scopeIds ?? Object.values(plan.assignments).filter((item) => item.allowDynamicChildren).flatMap((item) => item.scopeIds);
      if (request.scopeIds.some((scope) => !allowed.includes(scope))) throw new Error("Input snapshot scope mismatch");
    } else if (request.planVersion !== undefined || plan !== null) throw new Error("Input snapshot plan binding is missing");
    const entity = snapshot.catalog.agents.find((agent) => agent.definition.name === request.entity)?.definition;
    if (!entity) throw new Error("Input snapshot entity is missing");
    const skill = request.skillRef === undefined ? undefined : snapshot.skills[request.skillRef];
    if (request.skillRef !== undefined && (skill === undefined || !entity.skills.includes(request.skillRef))) throw new Error("Input snapshot skill is missing or denied");
    const packet = { schemaVersion: 1, runId: request.runId, dispatchId: request.dispatchId,
      taskId: request.taskId, attempt: request.attempt, task: request.task, revision: request.revision,
      snapshotHash: snapshot.digest, sourceDigest: snapshot.sourceDigest, entity: request.entity,
      role: request.role, skillRef: request.skillRef, scopeIds: request.scopeIds,
      planHash: request.planHash, planVersion: request.planVersion,
      coverage: binding?.coverage ?? [], plan: request.planHash === undefined ? null : plan };
    const serialized = JSON.stringify(packet);
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(request.dispatchId)) throw new Error("Invalid input packet dispatch id");
    const inputs = path.join(directory, "inputs");
    await mkdir(inputs, { recursive: true });
    const file = path.join(inputs, `${request.dispatchId}.json`);
    try { await writeFile(file, serialized, { flag: "wx", mode: 0o600 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await readFile(file, "utf8") !== serialized) throw new Error("Persisted input packet mismatch", { cause: error });
    }
    const result = await adapter.execute({ ...request,
      task: `${request.task}\n\nHost-pinned review input packet (source is the run-local revision snapshot; never substitute the live project):\n${serialized}` }, context);
    return { ...result, metadata: { ...result.metadata, inputSnapshotHash: digest(packet), runInputSnapshotHash: snapshot.digest } };
  } };
}
