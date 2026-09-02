import { TRIGGER_BASE, TRIGGER_PER_TOKEN, rankSkillsForQuery } from "../commands/skills";

export interface RoutedSkill {
  readonly name: string;
  readonly category: string;
  readonly score: number;
  readonly path: string;
}

/**
 * The floor below which nothing is said: the score of a one-word trigger.
 *
 * A router that answers every prompt is one the agent learns to ignore, and a
 * confident wrong name costs more than silence.
 *
 * Note what this does NOT promise. An earlier version of this comment claimed
 * the floor "requires a real trigger match"; it does not, and never did — six
 * overlapping tokens score 60 and clear it with no trigger at all. The floor is
 * a score threshold, and `requireTrigger` below is what actually makes a trigger
 * necessary. Derived from the scoring constants rather than restated, so
 * retuning them cannot silently change what this means.
 */
export const ROUTING_FLOOR = TRIGGER_BASE + TRIGGER_PER_TOKEN;

export async function routePrompt(prompt: string): Promise<RoutedSkill[]> {
  const ranked = await rankSkillsForQuery(prompt);
  return ranked
    // Both conditions, because the floor alone is a score and vocabulary overlap
    // can reach it: naming a skill off shared words is the "confident wrong
    // name" this is supposed to prevent.
    .filter((match) => match.score >= ROUTING_FLOOR && match.reasons.includes("trigger"))
    .slice(0, 2)
    .map((match) => ({
      name: match.name,
      category: match.module,
      score: match.score,
      path: match.path,
    }));
}

/** Empty string when nothing cleared the floor — silence, not a guess. */
export function formatRoutingBlock(prompt: string, matches: readonly RoutedSkill[]): string {
  const top = matches[0];
  if (!top) {
    return "";
  }
  const lines = [
    "",
    "## Routing for THIS request",
    "",
    `Request: ${JSON.stringify(truncate(prompt, 160))}`,
    `→ ${top.name} (${top.score})`,
    `  Load ${top.path}`,
  ];
  const runnerUp = matches[1];
  if (runnerUp) {
    lines.push(
      "",
      `Runner-up: ${runnerUp.name} (${runnerUp.score}) — if the narrower skill is what was meant.`,
    );
  }
  lines.push("", "This is a suggestion, not a gate. Say why if you route elsewhere.");
  return `${lines.join("\n")}\n`;
}

function truncate(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
