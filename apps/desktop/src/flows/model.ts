import type { FlowCard } from "../platform/commands";

export const LANES = [
  { id: "initializing", label: "Initializing" },
  { id: "ready", label: "Ready" },
  { id: "in-progress", label: "In progress" },
  { id: "implemented", label: "Implemented" },
  { id: "completing", label: "Completing" },
  { id: "done", label: "Done" },
] as const;

export type LaneId = (typeof LANES)[number]["id"] | "other";

export const STATUS_LABEL: Record<string, string> = {
  initializing: "Initializing",
  ready: "Ready",
  "in-progress": "In progress",
  implemented: "Implemented",
  completing: "Completing",
  done: "Done",
  blocked: "Blocked",
};

const LANE_IDS = new Set<string>(LANES.map((l) => l.id));

/** Blocked flows sit in the lane they were blocked from. */
export function laneOf(card: FlowCard): LaneId {
  const status = card.blocked || card.status === "blocked" ? (card.previousStatus ?? "in-progress") : card.status;
  return LANE_IDS.has(status) ? (status as LaneId) : "other";
}

export function byUpdatedDesc(a: FlowCard, b: FlowCard): number {
  return (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") || Number(b.id) - Number(a.id);
}

export function matches(card: FlowCard, q: string): boolean {
  if (!q) return true;
  const needle = q.trim().toLowerCase().replace(/^#/, "");
  return card.id.includes(needle) || card.title.toLowerCase().includes(needle);
}

/** Free-text CLI argument rules (the Rust core refuses the same). */
export function validateArg(label: string, v: string): string | null {
  if (v.trim() === "") return `${label} is required.`;
  if (v.startsWith("-")) return `${label} must not start with "-".`;
  if (v.length > 4000) return `${label} is longer than 4000 characters.`;
  return null;
}

export function workPrompt(card: FlowCard): string {
  return `Continue flow #${card.id} "${card.title}": take the next task.`;
}

/** Commands the board does not run; offered as copyable terminal commands. */
export function terminalCommands(card: FlowCard): Array<{ label: string; command: string }> {
  return [
    { label: "Complete", command: `keryx flow complete ${card.id}` },
    { label: "Confirm a criterion", command: `keryx flow ac confirm ${card.id} AC1` },
    { label: "Mark implemented", command: `keryx flow implemented ${card.id}` },
    { label: "Recover", command: `keryx flow recover ${card.id}` },
    { label: "Update criteria", command: `keryx flow ac update ${card.id}` },
    { label: "Reseal criteria", command: `keryx flow ac reseal ${card.id}` },
  ];
}
