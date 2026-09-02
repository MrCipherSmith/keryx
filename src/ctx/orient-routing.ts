import { BUNDLED_GDSKILLS } from "../gdskills/catalog";
import { scoreBundledSkillRoute } from "../commands/skills";

export interface RoutedSkill {
  readonly name: string;
  readonly category: string;
  readonly score: number;
  readonly path: string;
}

/**
 * The floor below which nothing is said.
 *
 * A router that answers every prompt is a router the agent learns to ignore, and
 * a confident wrong name costs more than silence. A bare token overlap scores 10
 * per token and carries no trigger; requiring a real trigger match (>= 55) means
 * the block appears when the request actually looks like one of these skills.
 */
export const ROUTING_FLOOR = 55;

export function routePrompt(prompt: string): RoutedSkill[] {
  return BUNDLED_GDSKILLS.map((entry) => scoreBundledSkillRoute(entry, prompt))
    .filter((match) => match.score >= ROUTING_FLOOR)
    .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name))
    .slice(0, 2)
    .map((match) => ({
      name: match.entry.name,
      category: match.entry.category,
      score: match.score,
      path: `.metaproject/skills/gdskills/${match.entry.category}/${match.entry.name}/SKILL.md`,
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
