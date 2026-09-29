// Metaproject setup guide (read-only).
//
// One source for `keryx setup` and the shell's `/setup` modal. It prints the
// three scenarios an operator needs — from scratch, after a pull, and when
// something is stale — plus the agent prompt that asks a coding agent to run
// that scenario. It never runs those commands. Wiki prose enrichment is a
// later swarm step and is not claimed to exist here.

export const SETUP_SCENARIO_IDS = ["init", "refresh", "repair"] as const;

export type SetupScenarioId = (typeof SETUP_SCENARIO_IDS)[number];

export interface SetupStep {
  readonly title: string;
  /** The exact command an operator (or the agent) runs. Display only. */
  readonly cli: string;
  readonly note: string;
}

export interface SetupScenario {
  readonly id: SetupScenarioId;
  /** Short tab label. */
  readonly tab: string;
  readonly title: string;
  readonly when: string;
  readonly steps: readonly SetupStep[];
  /** Paste into a coding agent. The agent runs the commands; this guide does not. */
  readonly agentPrompt: string;
}

export const SETUP_SCENARIOS: readonly SetupScenario[] = [
  {
    id: "init",
    tab: "Init",
    title: "From scratch",
    when: "No .metaproject yet. If one already exists, use refresh or repair instead: init rewrites the scaffold.",
    steps: [
      {
        title: "Scaffold the workspace",
        cli: "keryx init --yes",
        note: "Enables the default modules. Does not download optional grammars or wire MCP.",
      },
      {
        title: "Build the code graph",
        cli: "keryx gdgraph build",
        note: "Later graph answers come from this build, not from the working tree.",
      },
      {
        title: "Detect the test stack",
        cli: "keryx test analyze",
        note: "Writes testing context. Does not run the suite.",
      },
      {
        title: "Run Code Health",
        cli: "keryx health run --strict",
        note: "Aggregates configured quality sources. A missing source is a gap, not a pass.",
      },
      {
        title: "Draft the wiki, then check it",
        cli: "keryx wiki collect --force && keryx wiki index && keryx wiki check-links && keryx wiki validate",
        note: "Collect writes CLI-owned drafts. It does not write accepted prose.",
      },
      {
        title: "Index memory",
        cli: "keryx memory index && keryx memory check",
        note: "Index does not invent decisions. New entries stay draft until a person accepts them.",
      },
      {
        title: "Dashboard and gates",
        cli: "keryx dashboard build && keryx standard validate && keryx security policy validate && keryx flow check",
        note: "Setup is not done while a required gate fails and the failure is unrecorded.",
      },
    ],
    agentPrompt:
      "Initialize and fully configure keryx in this repository using recommended defaults. " +
      "Read .metaproject/index.md immediately after initialization. Build the graph, analyze the test stack, " +
      "run strict Code Health, collect and validate the wiki, index and check memory, build the dashboard, " +
      "and run Standard, security-policy, and flow validation. Report every enabled module and any failed gate. " +
      "Do not enrich wiki prose in this pass, and do not commit or push.",
  },
  {
    id: "refresh",
    tab: "Refresh",
    title: "After a pull",
    when: ".metaproject already exists. Refresh managed files and rebuild only what drifted.",
    steps: [
      {
        title: "Refresh service files",
        cli: "keryx update --skip-runtime",
        note: "Does not replace project data and does not fetch a new runtime.",
      },
      {
        title: "Rebuild stale layers",
        cli: "keryx sync --apply",
        note: "Incremental graph, wiki, and memory refresh from recorded provenance. Does not delete accepted pages.",
      },
      {
        title: "Re-check the wiki",
        cli: "keryx wiki index && keryx wiki check-links && keryx wiki validate",
        note: "Index and links only. Prose enrichment is a separate step.",
      },
      {
        title: "Dashboard and conformance",
        cli: "keryx dashboard build && keryx standard validate",
        note: "Confirm the workspace still matches the Metaproject Standard.",
      },
    ],
    agentPrompt:
      "Refresh the existing Metaproject service files without replacing project data. " +
      "Run keryx update --skip-runtime, then keryx sync --apply, then rebuild the wiki index, " +
      "check wiki links, validate the wiki, rebuild the dashboard, and run keryx standard validate. " +
      "Preserve all user-authored wiki, memory, and flow content. " +
      "Summarize only material changes and blockers. Do not commit or push.",
  },
  {
    id: "repair",
    tab: "Repair",
    title: "Partial or stale",
    when: "A module, hook, or artifact is missing or the last report no longer matches the tree.",
    steps: [
      {
        title: "Read the diagnosis first",
        cli: "keryx standard doctor && keryx status && keryx modules status",
        note: "Apply only the idempotent repairs the diagnosis names.",
      },
      {
        title: "Reconcile managed files",
        cli: "keryx update --skip-runtime && keryx sync --apply",
        note: "Rebuilds stale graph, wiki, and memory layers. Does not delete accepted or hand-edited pages.",
      },
      {
        title: "Re-run the completion gates",
        cli: "keryx wiki check-links && keryx wiki validate && keryx memory check && keryx flow check && keryx standard validate && keryx security policy validate",
        note: "A required failure stays a failure until it is fixed or written down.",
      },
    ],
    agentPrompt:
      "Repair the existing keryx installation. Record the current manifest and working-tree state, " +
      "run keryx standard doctor, keryx status, and keryx modules status, then apply only idempotent " +
      "repairs those diagnostics suggest. Run keryx update --skip-runtime and keryx sync --apply, then " +
      "rerun wiki, memory, flow, Standard, and security-policy validation. " +
      "Do not delete .metaproject, accepted or user-authored wiki pages, memory, flows, or project skills. " +
      "Do not commit or push.",
  },
];

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

function wrap(text: string, width: number): string[] {
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

/** One scenario, plain text. `width` wraps prose; a CLI line is never split. */
export function renderSetupScenario(scenario: SetupScenario, width: number = 78): string {
  const lines: string[] = [scenario.title, rule(Math.min(width, scenario.title.length + 8)), ...wrap(scenario.when, width), ""];
  scenario.steps.forEach((step, index) => {
    lines.push(`${index + 1}. ${step.title}`);
    lines.push(`   $ ${step.cli}`);
    for (const note of wrap(step.note, width - 5)) {
      lines.push(`     ${note}`);
    }
    lines.push("");
  });
  lines.push("Ask the agent:", rule(14));
  for (const line of wrap(scenario.agentPrompt, width)) {
    lines.push(`  ${line}`);
  }
  lines.push("", "This guide only prints the steps. It does not run them.");
  return lines.join("\n");
}

/** All three scenarios, in init, refresh, repair order. */
export function renderSetupGuide(width: number = 78): string {
  const head = ["keryx setup", "Prepare a Metaproject. Pick one scenario; nothing here runs by itself.", ""];
  return [...head, ...SETUP_SCENARIOS.map((scenario) => renderSetupScenario(scenario, width))].join("\n\n");
}

export function renderSetupUsage(): string {
  return [
    "keryx setup [init|refresh|repair]",
    "",
    "Print the Metaproject preparation guide. Does not run init, update, or sync.",
    "",
    "  init      From scratch: scaffold, graph, health, wiki drafts, gates.",
    "  refresh   After a pull: update service files and rebuild stale layers.",
    "  repair    Partial or stale: doctor first, then idempotent rebuild.",
    "",
    "No argument prints all three. In keryx shell, /setup opens the same guide.",
    "",
  ].join("\n");
}
