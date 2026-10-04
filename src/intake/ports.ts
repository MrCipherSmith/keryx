// Flow 403: the three things a decision reaches outside intake for. Each is a port with a fake in the tests, so no
// test starts keryx, reads the operator's project registry or touches a network:
//   - the FLOW port creates a flow with `keryx flow init` in the project a repository belongs to;
//   - the CI-TRIAGE port runs the advisory `keryx review ci-triage` on one failed run;
//   - `projectFor` finds that project from `owner/name`, through the user's project registry.
// The real ports start processes, so they live in src/commands/intake-ports.ts and serve installs them here.

export type IntakeFlowInit = { readonly ok: true; readonly flowId: string; readonly dir: string } | { readonly ok: false; readonly reason: string };

export interface IntakeFlowInput {
  /** `keryx flow init --issue <url>`: the flow is made from this ticket. */
  readonly issueUrl?: string;
  /** `keryx flow init --title <title>`: a flow with no ticket (a review flow). */
  readonly title?: string;
  /** Recorded as the origin source, so a flow made for a card can be found again from the card id. */
  readonly source: string;
}

export interface IntakeFlowPort {
  /** Create a flow in `initializing`. On failure no partial flow is left behind. */
  init(projectRoot: string, input: IntakeFlowInput): Promise<IntakeFlowInit>;
  /** The flow an earlier press already made for this card, if any. */
  findByCard(projectRoot: string, cardId: string): Promise<{ readonly flowId: string; readonly dir: string } | undefined>;
  journal(projectRoot: string, dir: string, at: string, line: string): Promise<void>;
  /** Add a line to the new flow's description.md (the pull request link of a review flow). */
  appendDescription(projectRoot: string, dir: string, text: string): Promise<void>;
}

export interface IntakeCiTriageInput {
  readonly repo: string;
  readonly runId: string;
  readonly timeoutMs: number;
  readonly maxBytes: number;
}

export type IntakeCiTriageResult = { readonly ok: true; readonly output: string } | { readonly ok: false; readonly reason: string };

export interface IntakeCiTriagePort {
  run(projectRoot: string, input: IntakeCiTriageInput): Promise<IntakeCiTriageResult>;
}

export type IntakeProjectFinder = (repo: string) => Promise<string | undefined> | string | undefined;

export interface IntakeDefaultPorts {
  flows(): IntakeFlowPort;
  ciTriage(): IntakeCiTriagePort;
  projectFor(intakeRoot: string): IntakeProjectFinder;
}

let installed: IntakeDefaultPorts | undefined;

export function installIntakeDefaultPorts(ports: IntakeDefaultPorts | undefined): void {
  installed = ports;
}

/** The ports a decision uses when none are injected. Nothing is installed in a test, so a missing injection fails loudly. */
export function intakeDefaultPorts(): IntakeDefaultPorts {
  if (installed === undefined) throw new Error("intake: no default ports installed; serve installs them and tests inject fakes");
  return installed;
}
