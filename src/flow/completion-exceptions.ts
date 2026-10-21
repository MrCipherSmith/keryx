import type { GateOutcome } from "./types";

export type CompletionExceptionSelection = {
  gate: GateOutcome["name"];
  condition?: string;
  detail: string;
  reason: string;
};

export function formatCompletionException(item: CompletionExceptionSelection): string {
  return `${item.gate}${item.condition ? `:${item.condition}` : ""}: ${item.detail}; reason: ${item.reason}`;
}

const ACCEPTABLE = new Set<GateOutcome["name"]>([
  "pull-request", "main-merge", "health", "security", "base-branch",
]);

/** Failed gates retain their original status. Only explicit selections are covered. */
function failures(gates: readonly GateOutcome[]): Map<string, GateOutcome> {
  const result = new Map<string, GateOutcome>();
  for (const gate of gates) {
    if (gate.status !== "fail") continue;
    if (gate.name === "review" && gate.conditions?.length) {
      for (const condition of gate.conditions) {
        if (condition.status !== "pass") {
          result.set(`review:${condition.id}`, { ...gate, detail: condition.detail });
        }
      }
    } else {
      result.set(gate.name, gate);
    }
  }
  return result;
}

export function selectCompletionExceptions(
  gates: readonly GateOutcome[],
  requested: readonly string[],
  reason: string | undefined,
): { ok: true; exceptions: CompletionExceptionSelection[]; remaining: string[] } | { ok: false; error: string } {
  const failed = failures(gates);
  if (requested.length && (!reason?.trim() || [...reason].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127))) {
    return { ok: false, error: "Accepted gates require a nonempty single-line --reason." };
  }
  const exceptions: CompletionExceptionSelection[] = [];
  for (const key of new Set(requested)) {
    const gate = failed.get(key);
    if (!gate) return { ok: false, error: `Gate ${key} is not currently failing.` };
    const condition = key.startsWith("review:") ? key.slice(7) : undefined;
    if (!(condition && gate.name === "review") && !ACCEPTABLE.has(gate.name)) {
      return { ok: false, error: `Gate ${key} cannot be accepted; review requires an individual condition.` };
    }
    exceptions.push({
      gate: gate.name,
      ...(condition ? { condition } : {}),
      detail: gate.detail,
      reason: reason!,
    });
    failed.delete(key);
  }
  return { ok: true, exceptions, remaining: [...failed.keys()] };
}
