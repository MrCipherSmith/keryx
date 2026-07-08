import { collectEntries } from "./store";
import { jaccard, tokenSet } from "./text";
import { memoryClassOf } from "./types";
import type { MemoryClass, MemoryEntry } from "./types";

export type SkillScope = {
  module?: string | null;
  target?: string | null;
  files?: string[];
};

const AUTHORITATIVE_TYPES = new Set(["decision", "constraint", "known-mistake"]);

// True when an accepted entry applies to a skill/task scope: same module (by
// scope or tag), a shared file, or a target-title token overlap. Shared by the
// authoritative-memory and procedural-memory selectors.
function inScope(entry: MemoryEntry, scope: SkillScope): boolean {
  const module = scope.module?.toLowerCase() ?? null;
  const files = new Set(scope.files ?? []);
  const targetTokens = tokenSet(scope.target ?? "");

  if (
    module &&
    (entry.scopes.module?.toLowerCase() === module ||
      entry.tags.map((t) => t.toLowerCase()).includes(module))
  ) {
    return true;
  }
  if (entry.scopes.files.some((file) => files.has(file))) {
    return true;
  }
  if (
    targetTokens.size > 0 &&
    jaccard(
      targetTokens,
      tokenSet(`${entry.title} ${entry.summary} ${entry.tags.join(" ")}`),
    ) >= 0.15
  ) {
    return true;
  }
  return false;
}

// C2: a "current" entry is one that has not been superseded and whose validity
// interval is still open (no past Valid-To). Deterministic string comparison.
function isCurrent(entry: MemoryEntry, today: string): boolean {
  if (entry.supersededBy) {
    return false;
  }
  if (entry.validTo && entry.validTo < today) {
    return false;
  }
  return true;
}

// Accepted decisions/constraints/known-mistakes that apply to a skill's scope.
// Used by skill-verify-skill to surface memory the skill must not contradict.
export async function relevantAcceptedMemory(
  cwd: string,
  scope: SkillScope,
  limit = 10,
): Promise<MemoryEntry[]> {
  const entries = await collectEntries(cwd);
  const accepted = entries.filter(
    (entry) => entry.status === "accepted" && AUTHORITATIVE_TYPES.has(entry.type),
  );

  return accepted.filter((entry) => inScope(entry, scope)).slice(0, limit);
}

// C3/C5: accepted, CURRENT, procedural-class memory that applies to a task
// scope — the entries eligible for injection into a flow / task-implementer
// prompt. `classes` defaults to ["procedural"] (the injection allowlist).
export async function proceduralMemoryForScope(
  cwd: string,
  scope: SkillScope,
  limit = 10,
  classes: MemoryClass[] = ["procedural"],
  now: Date = new Date(),
): Promise<MemoryEntry[]> {
  const today = now.toISOString().slice(0, 10);
  const allowed = new Set(classes);
  const entries = await collectEntries(cwd);

  return entries
    .filter(
      (entry) =>
        entry.status === "accepted" &&
        allowed.has(memoryClassOf(entry)) &&
        isCurrent(entry, today) &&
        inScope(entry, scope),
    )
    .slice(0, limit);
}
