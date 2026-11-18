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

export type StateActionId = "freeze" | "start" | "block" | "unblock" | "next";

export interface StateAction {
  id: StateActionId;
  label: string;
  enabled: boolean;
  /** Why it is off, or what it does when on: the button's tooltip. */
  hint: string;
}

/**
 * The flow's state buttons, in lifecycle order, with keryx's own transition rules
 * (`src/flow/machine.ts`): freeze moves initializing → ready (it needs at least one
 * real criterion), start moves ready → in-progress, a blocked flow takes only
 * unblock, and a done flow takes nothing. Every button is listed; the ones keryx
 * would refuse are off and say why, so the next step is visible.
 */
export function stateActions(card: Pick<FlowCard, "status" | "blocked">, criteriaCount: number): StateAction[] {
  const blocked = card.blocked || card.status === "blocked";
  const done = card.status === "done";
  const initializing = card.status === "initializing";

  const freeze: StateAction = blocked
    ? { id: "freeze", label: "Freeze criteria…", enabled: false, hint: "Unblock the flow first." }
    : !initializing
      ? { id: "freeze", label: "Criteria frozen", enabled: false, hint: "The acceptance criteria are already frozen." }
      : criteriaCount === 0
        ? { id: "freeze", label: "Freeze criteria…", enabled: false, hint: "Add at least one real criterion (ACn) to acceptance-criteria.md first." }
        : { id: "freeze", label: "Freeze criteria…", enabled: true, hint: "Seal the acceptance criteria; the flow moves to Ready." };

  const start: StateAction = blocked
    ? { id: "start", label: "Start", enabled: false, hint: "Unblock the flow first." }
    : initializing
      ? { id: "start", label: "Start", enabled: false, hint: "Freeze the criteria first; then the flow can start." }
      : card.status === "ready"
        ? { id: "start", label: "Start", enabled: true, hint: "Move the flow to In progress." }
        : { id: "start", label: "Start", enabled: false, hint: done ? "The flow is done." : "The flow has already started." };

  const blocking: StateAction = blocked
    ? { id: "unblock", label: "Unblock", enabled: true, hint: "Return the flow to the state it was blocked from." }
    : done
      ? { id: "block", label: "Block…", enabled: false, hint: "A done flow cannot be blocked." }
      : { id: "block", label: "Block…", enabled: true, hint: "Mark the flow blocked, with a reason." };

  const next: StateAction = done
    ? { id: "next", label: "Next task", enabled: false, hint: "The flow is done." }
    : { id: "next", label: "Next task", enabled: true, hint: "Show which task keryx would take next (read-only)." };

  return [freeze, start, blocking, next];
}

/** The one-line next step the action bar shows under the buttons, or null when nothing is pending. */
export function nextStepHint(card: Pick<FlowCard, "status" | "blocked">, criteriaCount: number): string | null {
  if (card.blocked || card.status === "blocked") return "Blocked: unblock the flow to continue.";
  if (card.status === "initializing") {
    return criteriaCount === 0 ? "Next: write the acceptance criteria, then freeze them." : "Next: freeze the criteria, then start the flow.";
  }
  if (card.status === "ready") return "Next: start the flow.";
  return null;
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

/**
 * The only thing a terminal command may name: the package directory, as the core vouches for it
 * (`commandRef`: set only when the name is safe to paste into a shell). The rule lives in the core, not
 * here. Ids are shared across packages, so a bare id is never offered. `null`: no command is offered.
 */
export function flowRef(card: FlowCard): string | null {
  return card.commandRef;
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
