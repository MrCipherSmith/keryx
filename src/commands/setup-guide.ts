// Metaproject setup guide (read-only).
//
// One source for `keryx setup` and the shell's `/setup` modal. It prints the
// three scenarios an operator needs (from scratch, after a pull, and when
// something is stale), marks every step required or optional with its reason,
// and generates the prompt that asks a coding agent to run that scenario. The
// prompt is built from the steps, so it cannot drift from the list. This module
// never runs a command. The modal's Run button hands the prompt to an external
// agent after an explicit confirmation; wiki prose enrichment is a later swarm
// step and is not claimed to exist here.

import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

export const SETUP_SCENARIO_IDS = ["init", "refresh", "repair"] as const;

export type SetupScenarioId = (typeof SETUP_SCENARIO_IDS)[number];

export interface SetupStep {
  readonly title: string;
  /** Exactly one keryx command (no chain, pipe or sequence). Display only. */
  readonly cli: string;
  /** A required step must pass; an optional one is skipped unless the operator asks for it. */
  readonly required: boolean;
  /** One sentence: why this step is in the plan. */
  readonly why: string;
  readonly note: string;
}

export interface SetupScenario {
  readonly id: SetupScenarioId;
  /** Short tab label. */
  readonly tab: string;
  readonly title: string;
  readonly when: string;
  /** What the agent is asked to achieve; the head of the generated prompt. */
  readonly goal: string;
  readonly steps: readonly SetupStep[];
  /**
   * The generated prompt for the required steps, with a placeholder project root.
   * Kept so a caller that only holds a scenario has something to paste; the shell and
   * `keryx setup` build the real one with {@link buildSetupAgentPrompt}.
   */
  readonly agentPrompt: string;
}

export interface SetupPromptOptions {
  /** The project the agent works in; printed once. */
  readonly projectRoot: string;
  /** List the optional steps too. Required steps are in the prompt either way. */
  readonly includeOptional: boolean;
}

/** Where the prompt tells the agent to start reading. Project-relative on purpose. */
const INDEX_PATH = ".metaproject/index.md";

const PROMPT_RULES: readonly string[] = [
  "Run the steps in order and stop at the first failed required step, then report which step failed and its output.",
  "If keryx update reports that files diverge (a version divergence), stop and ask; do not choose --accept-version or --keep-existing yourself.",
  "Do not delete .metaproject, accepted or user-authored wiki pages, memory, flows, or project skills.",
  "Do not use --force or any flag that a listed command does not already carry.",
  "Do not enrich wiki prose in this pass.",
  "Do not commit or push.",
  "When you are done, report each step as passed, failed or skipped.",
];

/**
 * The agent prompt for one scenario, generated from its steps so the list the
 * operator sees and the list the agent runs are the same list. Pure.
 */
export function buildSetupAgentPrompt(
  scenario: Pick<SetupScenario, "title" | "goal" | "steps">,
  options: SetupPromptOptions,
): string {
  const required = scenario.steps.filter((step) => step.required);
  const lines: string[] = [
    scenario.goal,
    "",
    `Project root: ${options.projectRoot}`,
    `Read ${INDEX_PATH} first, then run the steps below from the project root.`,
    "",
    "REQUIRED steps, in order:",
    ...required.map((step, index) => `${index + 1}. ${step.cli} — ${step.why}`),
  ];
  if (options.includeOptional) {
    lines.push(
      "",
      "OPTIONAL steps. Run each one right after the REQUIRED step named in brackets ([start] means before the first). Skip one that does not apply, and a skipped optional step is not a failure:",
    );
    let requiredSoFar = 0;
    for (const step of scenario.steps) {
      if (step.required) {
        requiredSoFar += 1;
      } else {
        lines.push(`- ${step.cli} — ${step.why} [${requiredSoFar === 0 ? "start" : `after ${requiredSoFar}`}]`);
      }
    }
  }
  lines.push("", "Rules:", ...PROMPT_RULES.map((rule) => `- ${rule}`));
  return lines.join("\n");
}

const SCENARIO_DEFINITIONS: readonly Omit<SetupScenario, "agentPrompt">[] = [
  {
    id: "init",
    tab: "Init",
    title: "From scratch",
    when: "No .metaproject yet. If one already exists, use refresh or repair instead: init rewrites the scaffold.",
    goal:
      "Initialize and configure keryx in this repository using recommended defaults. " +
      "Report every enabled module and any failed gate.",
    steps: [
      {
        title: "Scaffold the workspace",
        cli: "keryx init --yes",
        required: true,
        why: "Creates .metaproject and enables the default modules; every later step needs it.",
        note: "Enables the default modules. Does not download optional grammars or wire MCP.",
      },
      {
        title: "Build the code graph",
        cli: "keryx gdgraph build",
        required: true,
        why: "Graph answers come from this build, not from the working tree.",
        note: "Later graph answers come from this build, not from the working tree.",
      },
      {
        title: "Check the Metaproject Standard",
        cli: "keryx standard validate",
        required: true,
        why: "Confirms the new workspace matches the Standard.",
        note: "Setup is not done while a required gate fails and the failure is unrecorded.",
      },
      {
        title: "Check the security policy",
        cli: "keryx security policy validate",
        required: true,
        why: "Confirms the security policy file is well formed before the agent works on the project.",
        note: "Setup is not done while a required gate fails and the failure is unrecorded.",
      },
      {
        title: "Detect the test stack",
        cli: "keryx test analyze",
        required: false,
        why: "init already ran it; run it again only after the test setup changed.",
        note: "Writes testing context. Does not run the suite.",
      },
      {
        title: "Draft the wiki",
        cli: "keryx wiki collect --force",
        required: false,
        why: "Seeds CLI-owned wiki drafts; the project works without them.",
        note: "Collect writes CLI-owned drafts. It does not write accepted prose.",
      },
      {
        title: "Index the wiki",
        cli: "keryx wiki index",
        required: false,
        why: "Builds the wiki index, only useful once drafts exist.",
        note: "Index and links only. Prose enrichment is a separate step.",
      },
      {
        title: "Check wiki links",
        cli: "keryx wiki check-links",
        required: false,
        why: "Finds broken links in the drafted wiki.",
        note: "Index and links only. Prose enrichment is a separate step.",
      },
      {
        title: "Validate the wiki",
        cli: "keryx wiki validate",
        required: false,
        why: "Checks the drafted wiki against its schema.",
        note: "Index and links only. Prose enrichment is a separate step.",
      },
      {
        title: "Index memory",
        cli: "keryx memory index",
        required: false,
        why: "Builds the memory index so searches find recorded decisions.",
        note: "Index does not invent decisions. New entries stay draft until a person accepts them.",
      },
      {
        title: "Check memory",
        cli: "keryx memory check",
        required: false,
        why: "Finds memory entries that are malformed or stale.",
        note: "Index does not invent decisions. New entries stay draft until a person accepts them.",
      },
      {
        title: "Run Code Health",
        cli: "keryx health run --strict",
        required: false,
        why: "Aggregates the configured quality sources; slow on a large project.",
        note: "A missing source is a gap, not a pass.",
      },
      {
        title: "Check flows",
        cli: "keryx flow check",
        required: false,
        why: "Validates managed-work flows; a new project has none yet.",
        note: "Setup is not done while a required gate fails and the failure is unrecorded.",
      },
      {
        title: "Wire an editor",
        cli: "keryx integrate <editor>",
        required: false,
        why: "Connects one editor or agent runtime (cursor, claude, opencode, vscode, generic or all); pick the one the team uses.",
        note: "Writes the editor's own config files. Replace <editor> with one name.",
      },
      {
        title: "Install the sync hooks",
        cli: "keryx sync install-hooks",
        required: false,
        why: "Keeps the layers fresh after each git operation; it changes .git/hooks.",
        note: "Writes into .git/hooks. Remove again with keryx sync uninstall-hooks.",
      },
    ],
  },
  {
    id: "refresh",
    tab: "Refresh",
    title: "After a pull",
    when: ".metaproject already exists. Refresh managed files and rebuild only what drifted.",
    goal:
      "Refresh the existing Metaproject service files without replacing project data. " +
      "Preserve all user-authored wiki, memory, and flow content. Summarize only material changes and blockers.",
    steps: [
      {
        title: "Preview the update",
        cli: "keryx update --preview",
        required: false,
        why: "Read-only: shows what the update would create, change or leave divergent.",
        note: "Prints the lifecycle plan and writes nothing.",
      },
      {
        title: "Refresh service files",
        cli: "keryx update --skip-runtime --yes",
        required: true,
        why: "Brings the managed service files up to this keryx version without touching project data.",
        note: "Does not replace project data and does not fetch a new runtime.",
      },
      {
        title: "Refresh with the runtime",
        cli: "keryx update --yes",
        required: false,
        why: "Also fetches the managed runtime over the network; the required update above skips it.",
        note: "Needs network access.",
      },
      {
        title: "Rebuild stale layers",
        cli: "keryx sync --apply",
        required: true,
        why: "Rebuilds the graph, wiki and memory layers that drifted since the last run.",
        note: "Incremental graph, wiki, and memory refresh from recorded provenance. Does not delete accepted pages.",
      },
      {
        title: "Re-index the wiki",
        cli: "keryx wiki index",
        required: true,
        why: "Keeps the wiki index in step with the pages.",
        note: "Index and links only. Prose enrichment is a separate step.",
      },
      {
        title: "Check wiki links",
        cli: "keryx wiki check-links",
        required: true,
        why: "Catches links the pull broke.",
        note: "Index and links only. Prose enrichment is a separate step.",
      },
      {
        title: "Validate the wiki",
        cli: "keryx wiki validate",
        required: true,
        why: "Confirms the wiki still passes its schema.",
        note: "Index and links only. Prose enrichment is a separate step.",
      },
      {
        title: "Check the Metaproject Standard",
        cli: "keryx standard validate",
        required: true,
        why: "Confirms the workspace still matches the Standard after the refresh.",
        note: "Confirm the workspace still matches the Metaproject Standard.",
      },
      {
        title: "Check memory",
        cli: "keryx memory check",
        required: false,
        why: "Finds memory entries the pull left malformed or stale.",
        note: "New entries stay draft until a person accepts them.",
      },
      {
        title: "Run Code Health",
        cli: "keryx health run",
        required: false,
        why: "Re-runs the configured quality sources; slow on a large project.",
        note: "A missing source is a gap, not a pass.",
      },
      {
        title: "Run post-update hooks",
        cli: "keryx update --hooks --skip-runtime --yes",
        required: false,
        why: "Runs the project's own post-update hooks, which can execute project scripts.",
        note: "Runs executable files in .metaproject/hooks/post-update.d.",
      },
    ],
  },
  {
    id: "repair",
    tab: "Repair",
    title: "Partial or stale",
    when: "A module, hook, or artifact is missing or the last report no longer matches the tree.",
    goal:
      "Repair the existing keryx installation. Record the current manifest and working-tree state first, " +
      "read the diagnostics, then apply only the idempotent repairs they suggest.",
    steps: [
      {
        title: "Diagnose the Standard",
        cli: "keryx standard doctor",
        required: true,
        why: "Names what is missing or out of date; every repair below follows from it.",
        note: "Apply only the idempotent repairs the diagnosis names.",
      },
      {
        title: "Read the status",
        cli: "keryx status",
        required: true,
        why: "Shows the manifest and the state of each layer.",
        note: "Read-only.",
      },
      {
        title: "Read the module state",
        cli: "keryx modules status",
        required: true,
        why: "Shows which modules are enabled and which are missing.",
        note: "Read-only.",
      },
      {
        title: "Run the full diagnosis",
        cli: "keryx doctor",
        required: false,
        why: "One page on version, tools, providers, integrations, worktrees and freshness; use it when the three reads above do not explain the fault.",
        note: "Read-only.",
      },
      {
        title: "Enable a missing module",
        cli: "keryx modules enable <name>",
        required: false,
        why: "Only when the module status shows a module as missing; replace <name> with that module.",
        note: "Enables one module and writes its files.",
      },
      {
        title: "Reconcile managed files",
        cli: "keryx update --skip-runtime --yes",
        required: true,
        why: "Restores missing or outdated service files without touching project data.",
        note: "Does not delete accepted or hand-edited pages.",
      },
      {
        title: "Rebuild stale layers",
        cli: "keryx sync --apply",
        required: true,
        why: "Rebuilds the graph, wiki and memory layers that went stale.",
        note: "Rebuilds stale graph, wiki, and memory layers. Does not delete accepted or hand-edited pages.",
      },
      {
        title: "Install the security hooks",
        cli: "keryx security hooks install --runtime claude",
        required: false,
        why: "Only when the diagnosis reports the Claude security hooks as missing.",
        note: "Writes the Claude hook entries.",
      },
      {
        title: "Install the sync hooks",
        cli: "keryx sync install-hooks",
        required: false,
        why: "Only when the diagnosis reports the git hooks as missing; it changes .git/hooks.",
        note: "Writes into .git/hooks. Remove again with keryx sync uninstall-hooks.",
      },
      {
        title: "Check wiki links",
        cli: "keryx wiki check-links",
        required: true,
        why: "Gate: no broken wiki links.",
        note: "A required failure stays a failure until it is fixed or written down.",
      },
      {
        title: "Validate the wiki",
        cli: "keryx wiki validate",
        required: true,
        why: "Gate: the wiki passes its schema.",
        note: "A required failure stays a failure until it is fixed or written down.",
      },
      {
        title: "Check memory",
        cli: "keryx memory check",
        required: true,
        why: "Gate: no malformed memory entries.",
        note: "A required failure stays a failure until it is fixed or written down.",
      },
      {
        title: "Check flows",
        cli: "keryx flow check",
        required: true,
        why: "Gate: managed-work flows are consistent.",
        note: "A required failure stays a failure until it is fixed or written down.",
      },
      {
        title: "Check the Metaproject Standard",
        cli: "keryx standard validate",
        required: true,
        why: "Gate: the workspace matches the Standard.",
        note: "A required failure stays a failure until it is fixed or written down.",
      },
      {
        title: "Check the security policy",
        cli: "keryx security policy validate",
        required: true,
        why: "Gate: the security policy file is well formed.",
        note: "A required failure stays a failure until it is fixed or written down.",
      },
    ],
  },
];

/** Stands in for the root in {@link SetupScenario.agentPrompt}; the real prompt names the project. */
const PROMPT_ROOT_PLACEHOLDER = "<project root>";

export const SETUP_SCENARIOS: readonly SetupScenario[] = SCENARIO_DEFINITIONS.map((definition) => ({
  ...definition,
  agentPrompt: buildSetupAgentPrompt(definition, { projectRoot: PROMPT_ROOT_PLACEHOLDER, includeOptional: false }),
}));

function hasEntries(dir: string): boolean {
  try {
    return readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

/**
 * Which scenario fits `root`: no `.metaproject/index.md` is init; the index with a
 * manifest and a module directory is refresh; any other combination is repair.
 * Reads the file system only, synchronously, so the modal can pick its tab on open.
 */
export function detectSetupScenario(root: string): SetupScenarioId {
  const base = path.join(root, ".metaproject");
  if (!existsSync(path.join(base, "index.md"))) return "init";
  const complete = existsSync(path.join(base, "metaproject.json")) && hasEntries(path.join(base, "modules"));
  return complete ? "refresh" : "repair";
}

export function setupScenario(id: string): SetupScenario | undefined {
  return SETUP_SCENARIOS.find((scenario) => scenario.id === id);
}

export type SetupRequest =
  | { readonly kind: "all" }
  | { readonly kind: "scenario"; readonly scenario: SetupScenario }
  | { readonly kind: "error"; readonly message: string };

/**
 * One reading of `setup [init|refresh|repair]` for the CLI and every shell
 * surface, so an unknown or extra argument is an error everywhere rather than
 * a silent fallback to the full guide in the shell.
 */
export function parseSetupArgs(args: readonly string[]): SetupRequest {
  const words = args.flatMap((arg) => arg.split(/\s+/)).filter(Boolean);
  if (words.length === 0) return { kind: "all" };
  const choices = `Choose one of: ${SETUP_SCENARIO_IDS.join(", ")}`;
  if (words.length > 1) {
    return { kind: "error", message: `setup takes one scenario, got: ${words.join(" ")}\n${choices}` };
  }
  const scenario = setupScenario(words[0]!);
  if (scenario === undefined) {
    return { kind: "error", message: `Unknown setup scenario: ${words[0]}\n${choices}` };
  }
  return { kind: "scenario", scenario };
}

/** Readline and agent-REPL text for `/setup [id]`. */
export function renderSetupSlash(argument: string): string {
  const request = parseSetupArgs([argument]);
  if (request.kind === "error") return `${request.message}\n`;
  return `${request.kind === "all" ? renderSetupGuide() : renderSetupScenario(request.scenario)}\n`;
}

function rule(width: number): string {
  return "─".repeat(Math.max(8, width));
}

/** Greedy word wrap. A word longer than the budget stays whole; the budget never drops under 16. */
export function wrapSetupText(text: string, width: number): string[] {
  const budget = Math.max(16, width);
  const out: string[] = [];
  let cur = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (cur.length > 0 && cur.length + 1 + word.length > budget) {
      out.push(cur);
      cur = word;
    } else {
      cur = cur.length > 0 ? `${cur} ${word}` : word;
    }
  }
  if (cur.length > 0) out.push(cur);
  return out.length > 0 ? out : [""];
}

/** The mark printed after a step title, in the CLI and the modal alike. */
export function setupStepMark(step: Pick<SetupStep, "required">): "[required]" | "[optional]" {
  return step.required ? "[required]" : "[optional]";
}

export interface SetupRenderOptions {
  /** Project named in the printed prompt. Default: the current directory. */
  readonly projectRoot?: string;
}

/**
 * One scenario, plain text. `width` wraps prose; a CLI line is never split. Every step carries
 * its required or optional mark and its reason, and the generated prompt (optional steps
 * included) closes the guide.
 */
export function renderSetupScenario(
  scenario: SetupScenario,
  width: number = 78,
  options: SetupRenderOptions = {},
): string {
  const lines: string[] = [
    scenario.title,
    rule(Math.min(width, scenario.title.length + 8)),
    ...wrapSetupText(scenario.when, width),
    "",
  ];
  scenario.steps.forEach((step, index) => {
    lines.push(`${index + 1}. ${step.title} ${setupStepMark(step)}`);
    lines.push(`   $ ${step.cli}`);
    for (const reason of wrapSetupText(step.why, width - 5)) {
      lines.push(`     ${reason}`);
    }
    for (const note of wrapSetupText(step.note, width - 5)) {
      lines.push(`     ${note}`);
    }
    lines.push("");
  });
  const prompt = buildSetupAgentPrompt(scenario, {
    projectRoot: options.projectRoot ?? process.cwd(),
    includeOptional: true,
  });
  lines.push("Ask the agent:", rule(14));
  for (const promptLine of prompt.split("\n")) {
    for (const line of wrapSetupText(promptLine, width - 2)) {
      lines.push(line.length > 0 ? `  ${line}` : "");
    }
  }
  lines.push("", "This guide only prints the steps. It does not run them.");
  return lines.join("\n");
}

/** All three scenarios, in init, refresh, repair order. */
export function renderSetupGuide(width: number = 78, options: SetupRenderOptions = {}): string {
  const head = ["keryx setup", "Prepare a Metaproject. Pick one scenario; nothing here runs by itself.", ""];
  return [...head, ...SETUP_SCENARIOS.map((scenario) => renderSetupScenario(scenario, width, options))].join("\n\n");
}

export function renderSetupUsage(): string {
  return [
    "keryx setup [init|refresh|repair]",
    "",
    "Print the Metaproject preparation guide. Does not run init, update, or sync.",
    "",
    "  init      From scratch: scaffold, graph, gates; wiki, memory and hooks as optional steps.",
    "  refresh   After a pull: update service files and rebuild stale layers.",
    "  repair    Partial or stale: diagnose first, then idempotent rebuild.",
    "",
    "Each step is marked [required] or [optional] with its reason, and the guide ends with the",
    "prompt that asks a coding agent to run the scenario in this directory.",
    "",
    "No argument prints all three. In keryx shell, /setup opens the same guide on the tab that",
    "fits the project; there c copies the prompt, o shows the optional steps, and r runs the",
    "prompt through an external agent after you confirm it.",
    "",
  ].join("\n");
}
