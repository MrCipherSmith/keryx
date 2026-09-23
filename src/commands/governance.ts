// `keryx governance report` (flow 291) — one report over what is already
// recorded: spend per flow and per project, who confirmed and signed what
// (with identity basis), and every `flow complete` attempt's gate outcomes.
// Read-only: it never re-runs a gate, never calls a model or a network
// service, and the only files it writes are its own report artifacts.

import { optionValue } from "../lib/args";
import {
  buildGovernanceReport,
  readLatestGovernanceReport,
  renderGovernanceMarkdown,
  writeGovernanceArtifacts,
  type GovernanceFilters,
} from "../governance/service";

const REPORT_FLAGS = ["--flow", "--owner", "--since", "--until", "--all-projects", "--json"] as const;

function rejectUnknownFlags(args: readonly string[]): void {
  const unknown = args
    .filter((argument) => argument.startsWith("--"))
    .map((argument) => argument.split("=")[0] as string)
    .filter((name) => !REPORT_FLAGS.includes(name as (typeof REPORT_FLAGS)[number]));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown option${unknown.length > 1 ? "s" : ""} for \`keryx governance report\`: ${[...new Set(unknown)].join(
        ", ",
      )}. Accepted: ${REPORT_FLAGS.join(", ")}.`,
    );
  }
}

function parseFilters(args: readonly string[]): GovernanceFilters {
  return {
    flow: optionValue(args as string[], "--flow"),
    owner: optionValue(args as string[], "--owner"),
    since: optionValue(args as string[], "--since"),
    until: optionValue(args as string[], "--until"),
  };
}

async function runReport(args: string[]): Promise<void> {
  rejectUnknownFlags(args);
  const filters = parseFilters(args);
  const allProjects = args.includes("--all-projects");
  const asJson = args.includes("--json");
  const cwd = process.cwd();

  const report = await buildGovernanceReport({ cwd, filters, allProjects, now: () => new Date() });
  const written = await writeGovernanceArtifacts(cwd, report);

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(renderGovernanceMarkdown(report).trimEnd());
    console.log("");
    console.log(`Written: ${written.markdownPath}`);
    console.log(`Written: ${written.jsonPath}`);
  }
}

async function runShow(args: string[]): Promise<void> {
  const asJson = args.includes("--json");
  const cwd = process.cwd();
  const read = await readLatestGovernanceReport(cwd);
  if (read.state === "absent") {
    console.log("No governance report yet. Run `keryx governance report` first.");
    return;
  }
  if (read.state === "malformed") {
    console.log(`Stored governance report is unreadable (${read.reason}). Run \`keryx governance report\` to rewrite it.`);
    return;
  }
  if (asJson) {
    console.log(JSON.stringify(read.report, null, 2));
    return;
  }
  console.log(renderGovernanceMarkdown(read.report).trimEnd());
}

export async function governanceCommand(args: string[] = []): Promise<void> {
  const command = args[0];
  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return;
  }
  if (command === "report") {
    await runReport(args.slice(1));
    return;
  }
  if (command === "show") {
    await runShow(args.slice(1));
    return;
  }
  console.error(`Unknown governance subcommand: ${command}`);
  printHelp();
  process.exitCode = 1;
}

/**
 * The single source of truth for `keryx governance`'s own help — also called
 * directly by `src/cli.ts` for the top-level `keryx governance --help` (AC5,
 * flow 294): the static `USAGE_BODY` slice `groupUsage` used to intercept with
 * dropped every paragraph below the two usage lines (what is read, what
 * `report` writes, `--all-projects` semantics) — a second, thinner copy of
 * this same text.
 */
export function printGovernanceHelp(): void {
  printHelp();
}

function printHelp(): void {
  console.log(`keryx governance — spend, confirmations, signatures and gate outcomes, unified

Usage:
  keryx governance report [--flow <id>] [--owner <name>] [--since <iso>] [--until <iso>] [--all-projects] [--json]
  keryx governance show [--json]

Reads what is already recorded — flow.json (owner, signatures, acConfirmed,
completionAttempts), review package manifests (cost), and the trigger run
ledger (.metaproject/data/trigger/runs.jsonl). Never re-runs a gate, never
calls a model or a network service. A figure nobody recorded is reported as
"not recorded", never as zero.

\`report\` writes .metaproject/data/governance/artifacts/latest.md and
latest.json (schema-versioned), then prints the report. \`show\` reprints the
most recently written report without regenerating it.

--all-projects also covers every project in the user-global registry
(\`keryx projects\`); a registered project whose path is missing or unreadable
is listed with a reason instead of failing the whole report.
`);
}
