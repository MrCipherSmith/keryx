// The unattended posture: a run that finishes with no operator at the keyboard
// (flow 137 / defect D2).
//
// WHAT THIS IS NOT, and why that is the whole design.
//
// Three review rounds inside PR #253 tried to build an unattended mode that
// KEEPS `shell_exec` and decides, per command, which invocations are safe.
//
//   round 1  a destructive-command classifier      → 16 dangerous commands ran,
//                                                    `git clean -fdx` among them
//   round 2  an operator argv allowlist            → `--unattended-allow "*"` was
//                                                    accepted; so were `bash -c *`
//                                                    and `keryx *`
//   round 3  a literal command word, wildcards
//            banned after wrapper words            → `timeout *`, `setsid *`,
//                                                    `stdbuf *`, `flock *`,
//                                                    `busybox *` and eleven more
//                                                    launched; `psql -c '\! …'`,
//                                                    `sqlite3 '.shell …'` and
//                                                    `tar --to-command` escaped
//                                                    through accepted programs
//
// Each round's RULE was better than the last. Each round's VOCABULARY was behind.
// The constraint that came out of it is settled and is not re-derived here:
//
//   **Containment may not be a list of forbidden command words.**
//
// A mechanism satisfies it when the answer to "why can this run not do X?" is a
// property of the mechanism — the tool was never granted, the path is not inside
// the root, the operand cannot change meaning — rather than an entry in a table.
//
// So this module contains NO command vocabulary at all. It never reads a command
// string, never classifies one, and never compares one to anything. It selects a
// TOOL SET, by each tool's own declared risk class, and the mutating tools are
// simply not in it. There is no wrapper to miss when nothing can be wrapped.
//
// The two mechanisms deliberately NOT chosen for this release are documented as
// the widening path in `docs/docs/harness.md`, not silently dropped: the OS
// sandbox as the boundary (strongest, but its Linux side fails closed today), and
// a literal wildcard-free argv allowlist (round 3 reached it and the
// wildcard-free case held; what defeated it was permitting wildcards at all).
//
// Pure and side-effect-free: no filesystem, no process, no clock, no network.

import type { InteractiveTool } from "../tool/builtin/interactive-tools";
import type { ToolRisk } from "../tool/types";

/**
 * The posture profiles this build implements.
 *
 * This IS a list, and it is worth being precise about which kind. It enumerates
 * keryx's OWN profiles — the ones that exist in this binary — not a guess about
 * the outside world, so it cannot be "behind" the way a list of dangerous
 * programs is behind: a profile that is not in it is a profile that has not been
 * written. An unrecognised value is refused at launch rather than defaulted.
 */
export const UNATTENDED_PROFILES = ["read-only"] as const;

export type UnattendedProfile = (typeof UNATTENDED_PROFILES)[number];

/** The profile selected when `--unattended` is given with no `=<profile>`. */
export const DEFAULT_UNATTENDED_PROFILE: UnattendedProfile = "read-only";

/** A resolved posture. `undefined` everywhere else means "supervised, as before". */
export interface UnattendedPosture {
  profile: UnattendedProfile;
  /** Stable identifier for the header and the run record. */
  label: string;
}

/** Build the posture value for a profile. */
export function unattendedPosture(profile: UnattendedProfile): UnattendedPosture {
  return { profile, label: `unattended:${profile}` };
}

/** Outcome of reading the `--unattended[=<profile>]` argument. */
export type UnattendedFlagParse =
  | { ok: true; posture: UnattendedPosture }
  | { ok: false; error: string };

/**
 * Resolve the `=<profile>` part of `--unattended`.
 *
 * `raw` is whatever followed the `=`, or `undefined` for a bare `--unattended`.
 * Anything that is not exactly a profile name is an ERROR, never a fallback: a
 * typo that silently selected the widest profile would be the same class of
 * defect as an allowlist entry nobody read.
 *
 * Note what this function cannot be handed: there is no grant, pattern, or
 * command argument anywhere in the flag's grammar. Corpus C-2 — the 60-odd grant
 * patterns three review rounds accepted — has nothing to bind to here, which is
 * why every one of them is refused at launch rather than judged.
 */
export function parseUnattendedProfile(raw: string | undefined): UnattendedFlagParse {
  if (raw === undefined) {
    return { ok: true, posture: unattendedPosture(DEFAULT_UNATTENDED_PROFILE) };
  }
  const candidate = raw.trim();
  const match = UNATTENDED_PROFILES.find((profile) => profile === candidate);
  if (match === undefined) {
    return {
      ok: false,
      error:
        `keryx shell: unknown unattended profile "${raw}". ` +
        `Known profiles: ${UNATTENDED_PROFILES.join(", ")}. ` +
        "`--unattended` selects a tool set, not an approval policy: it takes a profile " +
        "name and accepts no command, pattern, or grant argument.",
    };
  }
  return { ok: true, posture: unattendedPosture(match) };
}

/**
 * The risk class the posture grants. One class, and it is the only one whose
 * tools can be run without anyone deciding anything at call time.
 */
export const UNATTENDED_GRANTED_RISK: ToolRisk = "read";

/**
 * Whether a tool may be registered for an unattended run.
 *
 * TWO properties, both declared BY THE TOOL about itself:
 *
 *  1. `definition.risk === "read"`. `shell_exec` is `shell`, `spawn_subagent` is
 *     `delegate`; neither is read, so neither is granted. Nothing here looks at
 *     what a tool would be asked to DO — a tool's risk class is a property it
 *     carries, and the check is against that class, not against a name.
 *
 *  2. `requiresApprover !== true`. `ask_user` is `risk: "read"` and is still
 *     wrong here: it blocks the turn until a person answers. It says so about
 *     itself rather than appearing in a list kept somewhere else, which is the
 *     same reason (1) is a risk class and not a name.
 *
 * This is the ONE decision that determines the unattended tool set, and both
 * inputs are the tool's own self-description.
 *
 * `NormalizedToolDefinition.risk` is OPTIONAL, so a tool that declares no risk at
 * all is `undefined` here and fails the equality — a new tool is excluded until
 * someone says what it is, rather than admitted until someone notices.
 */
export function isUnattendedEligible(tool: InteractiveTool): boolean {
  return tool.definition.risk === UNATTENDED_GRANTED_RISK && tool.requiresApprover !== true;
}

/**
 * The tool array an unattended run registers, from the array a supervised run
 * would.
 *
 * Filtering the full array rather than assembling a second one is deliberate: a
 * separate builder is a second description of the surface, and a tool added to
 * one and not the other is exactly the drift the shared tool-surface derivation
 * exists to prevent. A new tool lands here automatically, and lands on the right
 * side of the filter by declaring its own risk.
 */
export function restrictToUnattendedToolSet(tools: readonly InteractiveTool[]): InteractiveTool[] {
  return tools.filter((tool) => isUnattendedEligible(tool));
}

/**
 * Why a named tool was refused under the posture.
 *
 * Reached only when a tool that is not eligible is nonetheless present in the
 * registered array — which the tool-set restriction already prevents. It is the
 * second seam, and it is here so that widening the posture later cannot quietly
 * turn "not registered" into "registered and invoked": a caller that adds a
 * mutating tool to an unattended array gets a refusal at the invocation seam
 * rather than an execution.
 */
export function unattendedToolRefusal(name: string, risk: string | undefined): string {
  return (
    `tool "${name}" (risk ${risk ?? "undeclared"}) is not granted in the unattended read-only ` +
    "posture: this run has no approver, and only read-risk tools are registered"
  );
}

/**
 * The approver an unattended run installs.
 *
 * An `ask` with no approver must resolve to `deny`, never to a silent allow. The
 * driver already default-denies when `requestApproval` is absent; this makes the
 * denial an installed, observable decision instead of a consequence of omission,
 * so a future caller that wires an approver by habit does not accidentally hand
 * an unattended run a live one.
 *
 * It takes the tool name and input and looks at neither. There is nothing it
 * could look at that would make it say yes.
 */
export function unattendedApprover(): Promise<false> {
  return Promise.resolve(false);
}

/**
 * The header segment that marks a run as unattended, `""` when supervised.
 *
 * Empty rather than `" · supervised"` on purpose: the unflagged header must stay
 * byte-identical to what it printed before this flow existed (AC6), and the
 * cheapest way to fail that is to make the default say something new.
 */
export function postureHeaderSegment(posture: UnattendedPosture | undefined): string {
  return posture === undefined ? "" : ` · ${posture.label}`;
}

/**
 * The posture fields a run record carries.
 *
 * Both optional, and both ABSENT for a supervised run, so the summary a default
 * `keryx shell` writes is byte-for-byte the summary it wrote before.
 */
export interface RunPostureRecord {
  /** e.g. `unattended:read-only`. Absent ⇒ supervised. */
  posture?: string;
  /** Times a person was asked to decide something. `0` under the posture. */
  humanInterventions?: number;
}

/**
 * Build the run-record posture stamp.
 *
 * `humanInterventions` is recorded only alongside a posture. On the supervised
 * path the count is real but the field's absence is what keeps the default
 * record unchanged, and a supervised run's interventions are visible in its
 * transcript anyway.
 */
export function runPostureRecord(
  posture: UnattendedPosture | undefined,
  humanInterventions: number,
): RunPostureRecord {
  if (posture === undefined) {
    return {};
  }
  return { posture: posture.label, humanInterventions };
}

/** Why `--unattended` and `--chat` cannot be combined. */
export const UNATTENDED_CHAT_CONFLICT =
  "keryx shell: --unattended cannot be combined with --chat. Chat mode registers no tools at " +
  "all, so an unattended chat run can only answer from the prompt; the posture exists to let a " +
  "run inspect the project without an operator. Drop --chat.";

/** Why an unattended run refuses to start without a resolvable provider/model. */
export const UNATTENDED_NO_SELECTION =
  "keryx shell: --unattended needs a provider and model it can resolve without asking. " +
  "Pass --provider <name> [--model <id>], or run `keryx shell` once interactively so the " +
  "selection is saved. The posture never opens a picker: a run that stops to be chosen for " +
  "is the stall this flag exists to remove.";
