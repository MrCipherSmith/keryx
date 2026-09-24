// `keryx agents list|show|export|verify` (flow 310, W2 §"CLI surface", T8).
//
//   keryx agents list [--stack <id>] [--json]
//   keryx agents show <name>
//   keryx agents export --runtime <claude|codex|kiro|opencode|keryx-shell> <name> [--dry-run] [--json]
//   keryx agents verify [<name>] [--json]
//
// Every read here goes through `loadAgentCatalog`/`compileAgentDefinition`/
// `verifyAgents` — this module never re-derives catalog loading, compiling,
// or verification logic itself (D-2). `export` is the one subcommand that
// writes a file; `list`/`show`/`verify` are read-only.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  compileAgentDefinition,
  loadAgentCatalog,
  type LoadedAgent,
  planAgentExport,
  writeAgentExport,
  type AgentExportPlan,
  type AgentExportRuntime,
  AGENT_EXPORT_RUNTIMES,
  verifyAgents,
  type AgentVerifyResult,
  type VerifyAgentsReport,
  generateStackAgentPair,
  type StackPackForAgentGeneration,
} from "../agents/service";
import { defaultBundledRoot } from "../gdskills/bundled-eval";
import { optionValue } from "../lib/args";
import { helpOptions, helpTitle, helpUsage } from "../lib/ui";

/** Injectable seams — every subcommand defaults to the real project root and console. */
export interface AgentsCatalogDeps {
  readonly cwd?: string;
  readonly log?: (line: string) => void;
  readonly error?: (line: string) => void;
}

function resolveDeps(deps: AgentsCatalogDeps): { cwd: string; log: (line: string) => void; error: (line: string) => void } {
  return {
    cwd: deps.cwd ?? process.cwd(),
    log: deps.log ?? ((line: string) => console.log(line)),
    error: deps.error ?? ((line: string) => console.error(line)),
  };
}

function positional(args: string[]): string | undefined {
  return args.find((arg) => !arg.startsWith("-"));
}

/** Refuse an unknown flag rather than silently ignoring it (matches neighbouring commands, e.g. `review.ts`). */
function unknownFlags(args: string[], allowed: readonly string[]): string[] {
  return args.filter((arg) => arg.startsWith("--") && !allowed.includes(arg.split("=")[0] as string));
}

function isExportRuntime(value: string | undefined): value is AgentExportRuntime {
  return value !== undefined && (AGENT_EXPORT_RUNTIMES as readonly string[]).includes(value);
}

/** `keryx agents list|show|export|verify|generate` dispatcher, called from `agents.ts`. */
export async function agentsCatalogCommand(subcommand: string, args: string[], deps: AgentsCatalogDeps = {}): Promise<void> {
  if (subcommand === "list") return listCommand(args, deps);
  if (subcommand === "show") return showCommand(args, deps);
  if (subcommand === "export") return exportCommand(args, deps);
  if (subcommand === "verify") return verifyCommand(args, deps);
  if (subcommand === "generate") return generateCommand(args, deps);
  throw new Error(`agentsCatalogCommand: unknown subcommand "${subcommand}"`);
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

function listCommand(args: string[], depsIn: AgentsCatalogDeps): void {
  const { cwd, log, error } = resolveDeps(depsIn);
  if (args.includes("--help") || args.includes("-h")) {
    printListHelp();
    return;
  }
  const bad = unknownFlags(args, ["--stack", "--json"]);
  if (bad.length > 0) {
    error(`Unknown flag(s): ${bad.join(", ")}`);
    process.exitCode = 1;
    return;
  }
  const json = args.includes("--json");
  const stack = optionValue(args, "--stack");

  const catalog = loadAgentCatalog(cwd);
  // `--stack <id>` narrows to definitions that name that stack in `stacks[]`.
  // A stack-agnostic definition (empty `stacks[]`) is NOT included under a
  // `--stack` filter — the filter answers "which agents are declared for
  // this stack", not "which agents could plausibly apply to it".
  const agents = stack === undefined ? catalog.agents : catalog.agents.filter((a) => a.definition.stacks.includes(stack));

  if (json) {
    log(
      JSON.stringify(
        {
          agents: agents.map((a) => summarize(a)),
          catalogErrors: catalog.errors,
        },
        null,
        2,
      ),
    );
    return;
  }

  log("# agents list");
  log("");
  if (agents.length === 0) {
    log(stack === undefined ? "(no agent definitions found)" : `(no agent definitions declare stack "${stack}")`);
  }
  for (const loaded of agents) {
    const d = loaded.definition;
    log(`  ${d.name}  [${d.model_tier}/${d.policy_profile}]  (${loaded.source.kind})`);
    log(`      ${d.description}`);
  }
  if (catalog.errors.length > 0) {
    log("");
    log(`${catalog.errors.length} catalog error(s) — run \`keryx agents verify\` for details.`);
  }
}

function summarize(loaded: LoadedAgent): Record<string, unknown> {
  const d = loaded.definition;
  return {
    name: d.name,
    tier: d.model_tier,
    policy: d.policy_profile,
    source: loaded.source.kind,
    description: d.description,
    stacks: d.stacks,
  };
}

function printListHelp(): void {
  helpTitle("keryx agents list", "list the agent-definitions catalog (bundled + project)");
  helpUsage(["keryx agents list [--stack <id>] [--json]"]);
  helpOptions([
    { flag: "--stack", desc: "Only definitions whose stacks[] names this stack id (stack-agnostic definitions are excluded)." },
    { flag: "--json", desc: "Emit the catalog summary as JSON." },
  ]);
}

// ---------------------------------------------------------------------------
// show
// ---------------------------------------------------------------------------

function showCommand(args: string[], depsIn: AgentsCatalogDeps): void {
  const { cwd, log, error } = resolveDeps(depsIn);
  if (args.includes("--help") || args.includes("-h")) {
    printShowHelp();
    return;
  }
  const bad = unknownFlags(args, ["--json"]);
  if (bad.length > 0) {
    error(`Unknown flag(s): ${bad.join(", ")}`);
    process.exitCode = 1;
    return;
  }
  const json = args.includes("--json");
  const name = positional(args);
  if (name === undefined) {
    error("Provide an agent name: keryx agents show <name> [--json]");
    process.exitCode = 1;
    return;
  }

  const catalog = loadAgentCatalog(cwd);
  const loaded = catalog.agents.find((a) => a.definition.name === name);
  if (loaded === undefined) {
    error(`Unknown agent "${name}". Run \`keryx agents list\` to see what is available.`);
    process.exitCode = 1;
    return;
  }

  const compiled = compileAgentDefinition(loaded.definition, "keryx-shell");
  if (!compiled.ok) {
    error(`agent "${name}" failed to compile: ${compiled.error.reason} — ${compiled.error.message}`);
    process.exitCode = 1;
    return;
  }
  const result = compiled.result;
  if (result.target !== "keryx-shell") {
    // Unreachable given target="keryx-shell" above; guards against a future
    // widening of CompiledAgent's discriminant silently changing this shape.
    error(`internal: expected a keryx-shell compile result for "${name}"`);
    process.exitCode = 1;
    return;
  }

  if (json) {
    log(JSON.stringify({ definition: loaded.definition, source: loaded.source, compiled: result }, null, 2));
    return;
  }

  const d = loaded.definition;
  log(`# ${d.name}`);
  log("");
  log(`description: ${d.description}`);
  log(`source: ${loaded.source.kind} (${loaded.source.path})`);
  log(`model_tier: ${d.model_tier}`);
  log(`policy_profile: ${d.policy_profile}`);
  log(`tools: ${d.tools.join(", ") || "(none)"}`);
  log(`skills: ${d.skills.join(", ") || "(none)"}`);
  log(`stacks: ${d.stacks.join(", ") || "(none)"}`);
  log(`isolation: ${d.isolation}`);
  log(`output_contract: ${d.output_contract}`);
  if (d.origin !== undefined) {
    log(`origin: ${d.origin.kind}${d.origin.sourceRef ? ` (${d.origin.sourceRef})` : ""}`);
  }
  log("");
  log("## compiled keryx-shell task");
  log("");
  log(result.input.task);
  log("");
  log(`mode: ${result.input.mode}  label: ${result.input.label}  model_tier: ${result.input.model_tier}`);
  log(`policy: profile=${result.policy.profile} isolation=${result.policy.isolation} toolAllowlist=[${result.policy.toolAllowlist.join(", ")}]`);
  // R1-F6: never let the sidecar read as "applied" — `enforced` is what
  // spawn_subagent actually acts on; everything else here is advisory only.
  log(`  enforced by spawn_subagent: ${result.policy.enforcement.enforced.join(", ")}`);
  log(`  advisory only (not enforced by spawn_subagent): ${result.policy.enforcement.advisory.join(", ")}`);
  log(`  ${result.policy.enforcement.note}`);
}

function printShowHelp(): void {
  helpTitle("keryx agents show", "render an agent definition's frontmatter and compiled keryx-shell task (read-only)");
  helpUsage(["keryx agents show <name> [--json]"]);
  helpOptions([{ flag: "--json", desc: "Emit the definition, source, and compiled keryx-shell result as JSON." }]);
}

// ---------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------

async function exportCommand(args: string[], depsIn: AgentsCatalogDeps): Promise<void> {
  const { cwd, log, error } = resolveDeps(depsIn);
  if (args.includes("--help") || args.includes("-h")) {
    printExportHelp();
    return;
  }
  const bad = unknownFlags(args, ["--runtime", "--dry-run", "--json", "--force"]);
  if (bad.length > 0) {
    error(`Unknown flag(s): ${bad.join(", ")}`);
    process.exitCode = 1;
    return;
  }
  const json = args.includes("--json");
  const dryRun = args.includes("--dry-run");
  // R1-F9: overwrite a managed export this exporter finds hand-edited since
  // it was written (`refuse-modified`) — never a file with no sentinel at
  // all (`refuse-unmanaged`), which `--force` does not touch.
  const force = args.includes("--force");
  const runtimeArg = optionValue(args, "--runtime");
  // Skip the value slot right after `--runtime` — plain `positional()` would
  // otherwise read the runtime id itself as the agent name.
  const name = args.find((arg, index) => !arg.startsWith("-") && args[index - 1] !== "--runtime");

  if (!isExportRuntime(runtimeArg)) {
    error(`Provide a valid --runtime (${AGENT_EXPORT_RUNTIMES.join(", ")}): keryx agents export --runtime <id> <name>`);
    process.exitCode = 1;
    return;
  }
  if (name === undefined) {
    error("Provide an agent name: keryx agents export --runtime <id> <name> [--dry-run] [--json]");
    process.exitCode = 1;
    return;
  }

  const catalog = loadAgentCatalog(cwd);
  const loaded = catalog.agents.find((a) => a.definition.name === name);
  if (loaded === undefined) {
    error(`Unknown agent "${name}". Run \`keryx agents list\` to see what is available.`);
    process.exitCode = 1;
    return;
  }

  const plan = await planAgentExport(cwd, loaded.definition, runtimeArg);
  const outcome = await writeAgentExport(cwd, plan, { dryRun, force });

  if (json) {
    log(JSON.stringify({ plan: outcome.plan, written: outcome.written, dryRun, force }, null, 2));
  } else {
    for (const line of renderExportPlan(outcome.plan, outcome.written, dryRun)) log(line);
  }

  if (outcome.plan.action === "refuse-unmanaged" || (outcome.plan.action === "refuse-modified" && !outcome.written)) {
    process.exitCode = 1;
  }
}

function renderExportPlan(plan: AgentExportPlan, written: boolean, dryRun: boolean): string[] {
  const lines = [`# agents export`, "", `agent: ${plan.name}`, `runtime: ${plan.runtime}`, `support: ${plan.supportLevel}`, `action: ${plan.action}`];
  if (plan.relativePath !== undefined) lines.push(`path: ${plan.relativePath}`);
  if (plan.reason !== undefined) lines.push(`reason: ${plan.reason}`);
  if (plan.droppedTools.length > 0) lines.push(`dropped tools: ${plan.droppedTools.join(", ")}`);
  lines.push(`written: ${written}${dryRun ? " (dry-run)" : ""}`);
  if (plan.runtime === "keryx-shell" && plan.keryxShell !== undefined) {
    lines.push("", "## compiled spawn_subagent input", "", JSON.stringify(plan.keryxShell.input, null, 2), "", "## policy", "", JSON.stringify(plan.keryxShell.policy, null, 2));
  } else if (plan.content !== undefined && dryRun) {
    lines.push("", "## content (not written — dry-run)", "", plan.content);
  }
  return lines;
}

function printExportHelp(): void {
  helpTitle("keryx agents export", "compile and write (or preview) one agent definition for one export runtime");
  helpUsage([`keryx agents export --runtime <${AGENT_EXPORT_RUNTIMES.join("|")}> <name> [--dry-run] [--force] [--json]`]);
  helpOptions([
    { flag: "--runtime", desc: `Export target: ${AGENT_EXPORT_RUNTIMES.join(", ")}.` },
    { flag: "--dry-run", desc: "Plan and print the result without writing a file." },
    { flag: "--force", desc: "Overwrite a managed export that was hand-edited since it was written (never a file with no keryx-managed sentinel at all)." },
    { flag: "--json", desc: "Emit the export plan and outcome as JSON." },
  ]);
}

// ---------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------

function verifyCommand(args: string[], depsIn: AgentsCatalogDeps): void {
  const { cwd, log, error } = resolveDeps(depsIn);
  if (args.includes("--help") || args.includes("-h")) {
    printVerifyHelp();
    return;
  }
  const bad = unknownFlags(args, ["--json"]);
  if (bad.length > 0) {
    error(`Unknown flag(s): ${bad.join(", ")}`);
    process.exitCode = 1;
    return;
  }
  const json = args.includes("--json");
  const name = positional(args);

  const report = verifyAgents(cwd, name === undefined ? {} : { name });

  if (json) {
    log(JSON.stringify(report, null, 2));
  } else {
    for (const line of renderVerifyReport(report)) log(line);
  }

  if (!report.ok) process.exitCode = 1;
}

function renderVerifyReport(report: VerifyAgentsReport): string[] {
  const lines = ["# agents verify", "", `ok: ${report.ok}`, ""];
  for (const agent of report.agents) {
    lines.push(`  ${agent.problems.length === 0 ? "●" : "✗"} ${agent.name}${agent.source ? ` (${agent.source.kind})` : ""}`);
    for (const problem of agent.problems) {
      lines.push(`      ${problem.reason}: ${problem.detail}`);
    }
  }
  if (report.catalogErrors.length > 0) {
    lines.push("", "## catalog errors");
    for (const error of report.catalogErrors) {
      lines.push(`  ${error.reason}: ${error.message}`);
    }
  }
  return lines;
}

function printVerifyHelp(): void {
  helpTitle("keryx agents verify", "verify the agent-definitions catalog against its schema, tool/skill vocabulary, and origin rules (read-only)");
  helpUsage(["keryx agents verify [<name>] [--json]"]);
  helpOptions([{ flag: "--json", desc: "Emit the full verification report as JSON." }]);
}

// ---------------------------------------------------------------------------
// generate
// ---------------------------------------------------------------------------

const STACK_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

interface GenerateFileOutcome {
  readonly fileName: string;
  readonly name: string;
  readonly changed: boolean;
  readonly existed: boolean;
}

/** Same narrowing `verify.ts`'s `defaultLoadStackPackForGeneration` uses — kept local rather than imported (that resolver is `verify.ts`-internal, not exported). */
function readStackPackForGeneration(packJsonPath: string): StackPackForAgentGeneration | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(packJsonPath, "utf8"));
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null) return undefined;
  const pack = raw as {
    id?: unknown;
    skills?: { review?: unknown; "build-fix"?: unknown };
    agentProfile?: { displayName?: unknown; auditFocus?: unknown; buildCommands?: unknown; fixGuardrails?: unknown };
  };
  if (typeof pack.id !== "string" || pack.id.length === 0) return undefined;
  const profile = pack.agentProfile;
  const isStringArray = (v: unknown): v is readonly string[] => Array.isArray(v) && v.every((i) => typeof i === "string");
  if (
    typeof profile !== "object" ||
    profile === null ||
    typeof profile.displayName !== "string" ||
    !isStringArray(profile.auditFocus) ||
    !isStringArray(profile.buildCommands) ||
    !isStringArray(profile.fixGuardrails)
  ) {
    return undefined;
  }
  const review = pack.skills?.review;
  const buildFix = pack.skills?.["build-fix"];
  return {
    id: pack.id,
    skills: {
      ...(isStringArray(review) ? { review } : {}),
      ...(isStringArray(buildFix) ? { "build-fix": buildFix } : {}),
    },
    agentProfile: {
      displayName: profile.displayName,
      auditFocus: profile.auditFocus,
      buildCommands: profile.buildCommands,
      fixGuardrails: profile.fixGuardrails,
    },
  };
}

function generateCommand(args: string[], depsIn: AgentsCatalogDeps): void {
  const { log, error } = resolveDeps(depsIn);
  if (args.includes("--help") || args.includes("-h")) {
    printGenerateHelp();
    return;
  }
  const bad = unknownFlags(args, ["--stack", "--check", "--json"]);
  if (bad.length > 0) {
    error(`Unknown flag(s): ${bad.join(", ")}`);
    process.exitCode = 1;
    return;
  }
  const json = args.includes("--json");
  const check = args.includes("--check");
  const stackId = optionValue(args, "--stack");

  if (stackId === undefined || !STACK_ID_PATTERN.test(stackId)) {
    error(
      `Provide a valid --stack id (${STACK_ID_PATTERN.source}): keryx agents generate --stack <id> [--check] [--json]`,
    );
    process.exitCode = 1;
    return;
  }

  const bundledAgentsRoot = path.join(defaultBundledRoot(), "agents");
  const stacksRoot = path.join(bundledAgentsRoot, "..", "stacks");
  const packDir = path.join(stacksRoot, stackId);
  const packJsonPath = path.join(packDir, "pack.json");

  if (!existsSync(packJsonPath)) {
    error(`No stack pack "${stackId}" found at ${packJsonPath}.`);
    process.exitCode = 1;
    return;
  }

  const pack = readStackPackForGeneration(packJsonPath);
  if (pack === undefined) {
    error(`Stack pack "${stackId}" has no usable agentProfile in ${packJsonPath} — cannot generate an agent pair.`);
    process.exitCode = 1;
    return;
  }

  const pair = generateStackAgentPair(pack);
  const outcomes: GenerateFileOutcome[] = [];

  for (const file of [pair.auditor, pair.fixer]) {
    const filePath = path.join(bundledAgentsRoot, file.fileName);
    const existed = existsSync(filePath);
    const previous = existed ? readFileSync(filePath, "utf8") : undefined;
    const changed = previous !== file.content;

    if (!check && changed) {
      writeFileSync(filePath, file.content, "utf8");
    }
    outcomes.push({ fileName: file.fileName, name: file.name, changed, existed });
  }

  if (json) {
    log(JSON.stringify({ stack: stackId, check, files: outcomes }, null, 2));
  } else {
    log(`# agents generate --stack ${stackId}${check ? " --check" : ""}`);
    log("");
    for (const outcome of outcomes) {
      const state = !outcome.existed ? "new" : outcome.changed ? "drifted" : "unchanged";
      const action = check ? state : outcome.changed ? (outcome.existed ? "updated" : "written") : "unchanged";
      log(`  ${outcome.fileName}  ${action}`);
    }
  }

  if (check && outcomes.some((o) => o.changed)) {
    process.exitCode = 1;
  }
}

function printGenerateHelp(): void {
  helpTitle("keryx agents generate", "regenerate a stack pack's <id>-code-auditor/<id>-build-fixer agent pair from its pack.json");
  helpUsage(["keryx agents generate --stack <id> [--check] [--json]"]);
  helpOptions([
    { flag: "--stack", desc: "Stack pack id (its directory name under the bundled stacks tree)." },
    { flag: "--check", desc: "Report drift without writing; exits 1 if either generated file differs from what is on disk." },
    { flag: "--json", desc: "Emit the per-file outcome as JSON." },
  ]);
}

// Re-exported for CLI help composition in `agents.ts`.
export { printListHelp, printShowHelp, printExportHelp, printVerifyHelp, printGenerateHelp };
export type { AgentVerifyResult };
