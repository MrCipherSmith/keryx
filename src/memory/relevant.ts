import { collectEntries } from "./store";
import { jaccard, tokenSet } from "./text";
import { memoryClassOf } from "./types";
import { currentDay, isCurrentAt } from "./temporal";
import { MAX_AGENT_EXCERPT_BYTES, MAX_AUTOMATIC_RESULTS } from "./validation";
import type { MemoryClass, MemoryEntry, SearchFilters } from "./types";

export type SkillScope = {
  module?: string | null;
  target?: string | null;
  files?: string[];
};

const AUTHORITATIVE_TYPES = new Set(["decision", "constraint", "known-mistake"]);
export const MAX_AUTOMATIC_RECALL_RESULTS = 10;
export const MAX_AUTOMATIC_RECALL_EXCERPT_BYTES = 400;

function boundedLimit(limit: number): number {
  return Math.min(MAX_AUTOMATIC_RESULTS, Math.max(1, Math.floor(limit)));
}

/** Shared accepted/current boundary for automatic agent-facing recall. */
export function acceptedCurrentSearchFilters(
  now: Date,
  filters: Pick<SearchFilters, "module" | "entity" | "class" | "status" | "limit"> = {},
): SearchFilters {
  return {
    ...filters,
    status: filters.status ?? "accepted",
    asOf: currentDay(now),
    limit: boundedLimit(filters.limit ?? MAX_AUTOMATIC_RECALL_RESULTS),
  };
}

/** Current means Valid-From has arrived, Valid-To is exclusive, and no supersession exists. */
export function isCurrentMemory(entry: MemoryEntry, now: Date): boolean {
  return isCurrentAt(entry, now);
}

export function clipAutomaticRecallText(text: string, maxBytes = MAX_AUTOMATIC_RECALL_EXCERPT_BYTES): string {
  const boundedBytes = Math.min(MAX_AGENT_EXCERPT_BYTES, Math.max(1, Math.floor(maxBytes)));
  if (Buffer.byteLength(text, "utf8") <= boundedBytes) {
    return text;
  }
  const suffix = "…";
  let output = "";
  for (const character of text) {
    if (Buffer.byteLength(`${output}${character}${suffix}`, "utf8") > boundedBytes) {
      break;
    }
    output += character;
  }
  return `${output}${suffix}`;
}

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

// Accepted decisions/constraints/known-mistakes that apply to a skill's scope.
// Used by skill-verify-skill to surface memory the skill must not contradict.
export async function relevantAcceptedMemory(
  cwd: string,
  scope: SkillScope,
  limit = 10,
  now: Date = new Date(),
): Promise<MemoryEntry[]> {
  const entries = await collectEntries(cwd);
  const accepted = entries.filter(
    (entry) => entry.status === "accepted" && AUTHORITATIVE_TYPES.has(entry.type) && isCurrentMemory(entry, now),
  );

  return accepted.filter((entry) => inScope(entry, scope)).slice(0, boundedLimit(limit));
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
  const allowed = new Set(classes);
  const entries = await collectEntries(cwd);

  return entries
    .filter(
      (entry) =>
        entry.status === "accepted" &&
        allowed.has(memoryClassOf(entry)) &&
        isCurrentMemory(entry, now) &&
        inScope(entry, scope),
    )
    .slice(0, boundedLimit(limit));
}
