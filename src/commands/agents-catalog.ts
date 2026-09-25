// `keryx agents list|show|export|verify` (flow 310, W2 §"CLI surface", T8).
//
//   keryx agents list [--stack <id>] [--json]
//   keryx agents show <name>
//   keryx agents export --runtime <claude|codex|kiro|opencode|keryx-shell> <name> [--dry-run] [--force] [--json]
//   keryx agents verify [<name>] [--json]
//
// Every read here goes through `loadAgentCatalog`/`compileAgentDefinition`/
// `verifyAgents` — this module never re-derives catalog loading, compiling,
// or verification logic itself (D-2). `export` is the one subcommand that
// writes a file; `list`/`show`/`verify` are read-only.

import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
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
  checkStackPackGateCleared,
} from "../agents/service";
import { defaultBundledRoot } from "../gdskills/bundled-eval";
import { optionValue } from "../lib/args";
import { helpOptions, helpTitle, helpUsage } from "../lib/ui";

/** Injectable seams — every subcommand defaults to the real project root and console. */
export interface AgentsCatalogDeps {
  readonly cwd?: string;
  readonly log?: (line: string) => void;
  readonly error?: (line: string) => void;
  /**
   * Flow 314 T13a: `generate`-only seam mirroring `verifyAgents`'s own
   * `bundledRoot` option (`verify.ts`) — overrides `defaultBundledRoot()` so
   * a test can point `generate` at an isolated fixture `<root>/agents` +
   * `<root>/stacks/<id>` tree instead of the real shipped one. Every other
   * subcommand ignores this field.
   */
  readonly bundledRoot?: string;
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

/**
 * Same narrowing `verify.ts`'s `defaultLoadStackPackForGeneration` uses —
 * kept local rather than imported (that resolver is `verify.ts`-internal,
 * not exported).
 *
 * R1-6 (review round 1, PR #692): `pack.json`'s `id` field is untrusted —
 * nothing previously checked it equalled the `--stack`/directory name it was
 * read from, so a mismatched or path-traversal `id` could make
 * `generateStackAgentPair` derive a file name that escapes the bundled
 * agents directory. `stackId` (the directory name, already matched against
 * `STACK_ID_PATTERN` by the caller) is now REQUIRED to equal `pack.id`, and
 * `pack.id` is independently re-checked against the same pattern rather than
 * trusting the caller's check transitively.
 */
function readStackPackForGeneration(packJsonPath: string, stackId: string): StackPackForAgentGeneration | undefined {
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
  if (!STACK_ID_PATTERN.test(pack.id) || pack.id !== stackId) return undefined;
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

  const bundledAgentsRoot = path.join(depsIn.bundledRoot ?? defaultBundledRoot(), "agents");
  const stacksRoot = path.join(bundledAgentsRoot, "..", "stacks");
  const packDir = path.join(stacksRoot, stackId);
  const packJsonPath = path.join(packDir, "pack.json");

  if (!existsSync(packJsonPath)) {
    error(`No stack pack "${stackId}" found at ${packJsonPath}.`);
    process.exitCode = 1;
    return;
  }

  // Flow 314 T13a (W2 "Per-stack pairs" + AC6): generation is refused for a
  // pack that is not gate-cleared — same definition `agents verify` uses via
  // the shared `checkStackPackGateCleared` (stability "stable" AND
  // `checkStablePackGate(packDir, "stable").status === "pass"`). `packDir`
  // itself is path-safe by construction here (built from a `--stack` value
  // already matched against `STACK_ID_PATTERN`, joined under the fixed
  // `stacksRoot`), but mirror `verify.ts`'s `defaultStackPackGateCleared`
  // defense-in-depth: refuse a symlinked or non-directory `packDir` before
  // ever reading `pack.json` through it.
  //
  // Deliberate choice for `--check`: refusal applies BEFORE the `--check`
  // branch is reached, so `--check` on a non-cleared pack refuses the same
  // way the write path does (named `stack-pack-not-gate-cleared` error, exit
  // 1) rather than reporting "no generated pair expected" and passing. A
  // gate-cleared/not-cleared distinction is a precondition for generation
  // existing at all, not a drift question `--check` is meant to answer — so
  // there is exactly one refusal path for both modes, and nothing is ever
  // written or compared for an ungated pack.
  let packDirStats: ReturnType<typeof lstatSync>;
  try {
    packDirStats = lstatSync(packDir);
  } catch {
    error(`No stack pack "${stackId}" found at ${packDir}.`);
    process.exitCode = 1;
    return;
  }
  if (!packDirStats.isDirectory() || packDirStats.isSymbolicLink()) {
    error(`stack-pack-not-gate-cleared: pack directory "${stackId}" is not a real directory`);
    process.exitCode = 1;
    return;
  }
  const gate = checkStackPackGateCleared(packDir);
  if (!gate.cleared) {
    error(`stack-pack-not-gate-cleared: ${gate.reason ?? `stack pack "${stackId}" is not gate-cleared`}`);
    process.exitCode = 1;
    return;
  }

  const pack = readStackPackForGeneration(packJsonPath, stackId);
  if (pack === undefined) {
    error(
      `Stack pack "${stackId}" has no usable agentProfile in ${packJsonPath}, or its pack.json "id" is missing/invalid/does not match the "${stackId}" directory — cannot generate an agent pair.`,
    );
    process.exitCode = 1;
    return;
  }

  // R1-7: `generateStackAgentPair` now validates `pack.id` and every
  // review/build-fix skill name (plus rejects control characters in
  // body-interpolated fields) and THROWS on a hostile value, rather than
  // trusting the caller to have pre-validated it. That must never crash this
  // CLI command — surface it as the same kind of named, exit-1 refusal every
  // other bad-input path here already uses.
  let pair: ReturnType<typeof generateStackAgentPair>;
  try {
    pair = generateStackAgentPair(pack);
  } catch (cause) {
    error(`Stack pack "${stackId}" cannot be generated: ${cause instanceof Error ? cause.message : String(cause)}`);
    process.exitCode = 1;
    return;
  }
  // R2-3: validate BOTH targets in a first pass before writing either one.
  // The containment and lstat checks used to run inside the write loop, so a
  // refusal on the fixer's target (e.g. a planted symlink) left the auditor
  // already written to disk — a half-written pair with exit 1. Now nothing
  // is written until both targets have cleared every check.
  const prepared: { file: typeof pair.auditor; filePath: string; existed: boolean }[] = [];
  for (const file of [pair.auditor, pair.fixer]) {
    const filePath = path.join(bundledAgentsRoot, file.fileName);

    // R1-6: `file.fileName` is derived from `pack.id`, which is now checked
    // (above) to equal `stackId` and to match `STACK_ID_PATTERN` — but this
    // containment check is a second, independent layer that does not rely on
    // that upstream validation staying correct. Refuse to write anywhere the
    // resolved path is not actually inside `bundledAgentsRoot`, and refuse to
    // write through a symlinked or otherwise non-regular target (an
    // attacker-planted symlink, device file, FIFO, etc. at the destination
    // name pointing elsewhere).
    const relative = path.relative(bundledAgentsRoot, filePath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      error(`Refusing to write "${file.fileName}": it resolves outside the bundled agents directory.`);
      process.exitCode = 1;
      return;
    }
    let existed: boolean;
    try {
      const targetStats = lstatSync(filePath);
      existed = true;
      if (targetStats.isSymbolicLink() || !targetStats.isFile()) {
        error(`Refusing to write "${file.fileName}": the target is a symlink or not a regular file.`);
        process.exitCode = 1;
        return;
      }
    } catch {
      existed = false;
    }
    prepared.push({ file, filePath, existed });
  }

  const outcomes: GenerateFileOutcome[] = [];
  for (const { file, filePath, existed } of prepared) {
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
