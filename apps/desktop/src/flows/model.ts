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

/** The composer text for "Work on this flow": names the package when it has a safe reference. */
export function workPrompt(card: FlowCard): string {
  const ref = flowRef(card);
  return `Continue flow #${card.id} "${card.title}"${ref ? ` (package ${ref})` : ""}: take the next task.`;
}

/** A keryx flow package directory: three digits, a dash, then the slug charset (the Rust core's rule). */
const PACKAGE_DIR = /^\d{3}-[a-z0-9-]{0,196}$/;

/**
 * The only thing a terminal command may name: the package directory, and only when it is a keryx
 * package name and the backend found the flow's id command-safe (`idValid`). Ids are shared across
 * packages, so a bare id is never offered. `null`: no command is offered.
 */
export function flowRef(card: FlowCard): string | null {
  return card.idValid && PACKAGE_DIR.test(card.dir) ? card.dir : null;
}

/**
 * Commands the board does not run; offered as copyable terminal commands. What only the user can
 * supply is an unquoted `<placeholder>`: the shell refuses the command until it is replaced.
 */
export function terminalCommands(card: FlowCard): Array<{ label: string; command: string }> {
  const ref = flowRef(card);
  if (ref === null) return [];
  return [
    { label: "Mark implemented", command: `keryx flow implemented ${ref} --pr <draft-PR-url>` },
    { label: "Confirm a criterion", command: `keryx flow ac confirm ${ref} <ACn> --note <evidence>` },
    { label: "Confirm completion", command: `keryx flow confirm ${ref}` },
    { label: "Complete", command: `keryx flow complete ${ref}` },
    { label: "Recover", command: `keryx flow recover ${ref} --reason <why>` },
    { label: "Update criteria", command: `keryx flow ac update ${ref} --reason <why>` },
    { label: "Reseal criteria", command: `keryx flow ac reseal ${ref} --reason <why>` },
  ];
}
