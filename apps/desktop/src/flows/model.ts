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

/** One path component, letters/digits/`._-`, no leading `-` (mirrors the Rust `validate_flow_dir`). */
const SAFE_DIR = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const SAFE_ID = /^\d{1,9}$/;

/**
 * The only thing a terminal command may name: the package directory (ids are
 * shared across packages, so it is the unambiguous reference), or the id when
 * it is plain digits. `null` when neither is safe: no command is offered.
 */
export function flowRef(card: FlowCard): string | null {
  if (SAFE_DIR.test(card.dir)) return card.dir;
  if (SAFE_ID.test(card.id)) return card.id;
  return null;
}

/** Commands the board does not run; offered as copyable terminal commands. */
export function terminalCommands(card: FlowCard): Array<{ label: string; command: string }> {
  const ref = flowRef(card);
  if (ref === null) return [];
  return [
    { label: "Complete", command: `keryx flow complete ${ref}` },
    { label: "Confirm a criterion", command: `keryx flow ac confirm ${ref} AC1` },
    { label: "Mark implemented", command: `keryx flow implemented ${ref}` },
    { label: "Recover", command: `keryx flow recover ${ref}` },
    { label: "Update criteria", command: `keryx flow ac update ${ref}` },
    { label: "Reseal criteria", command: `keryx flow ac reseal ${ref}` },
  ];
}
