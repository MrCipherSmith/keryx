// `keryx learn` (flow 312, W3 self-learning loop, T8) — the consent CLI over
// `src/learning/`: observe (manual trigger / host-hook adapter), extract,
// list, review, accept, reject, apply, promote, graduate, prune.
//
//   observe [--hook claude]         flush/adapt one host-hook payload, or report today's file
//   extract [--domain] [--since]    run the deterministic (+ optional model) signals
//   list [--status] [--domain] [--scope] [--json]
//   review [<id>] [--scope]         print a candidate (or all candidates) with its evidence
//   accept <id> [--scope user] [--refresh]     candidate -> accepted (TTY only)
//   reject <id> [--scope user]                 candidate -> rejected
//   apply <id> --skill <module/name> [--dry-run]
//   promote <id>                    project accepted -> user candidate (TTY + typed confirm)
//   graduate [--domain] | graduate apply <proposal-id>
//   prune [--dry-run] [--json]
//
// `accept`, `promote` and `graduate apply` never take a `--yes`/`--force`/
// `--non-interactive` flag — each refuses outside a real terminal with a
// named reason and no bypass (W3 spec "Promotion rule" #2; plan D2). None of
// the three is agent-invocable through MCP: `src/mcp/tools.ts` is a hand-
// curated allowlist of tool entries, and this file adds none there.
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { readStdinBounded } from "../lib/bounded-stdin";
import { optionValue } from "../lib/args";
import {
  acceptPattern,
  applyGraduation,
  applyLearnedPattern,
  auditAcceptedRecords,
  LearningAcceptError,
  LearningApplyError,
  LearningGraduateError,
  LearningPromoteError,
  listPatterns,
  observationFilePath,
  observeHostHookPayload,
  promotePattern,
  pruneLearning,
  readPattern,
  rejectPattern,
  runExtract,
  runGraduate,
  type LearnedPattern,
  type LearningDomain,
  type LearningScope,
  type LearningStatus,
} from "../learning";

const STDIN_DEADLINE_MS = 2_000;

const STATUSES: readonly LearningStatus[] = ["candidate", "accepted", "rejected", "superseded", "expired"];
const SCOPES: readonly LearningScope[] = ["project", "user"];
const DOMAINS: readonly LearningDomain[] = [
  "code-style",
  "architecture",
  "testing",
  "security",
  "review-conventions",
  "workflow",
  "documentation",
  "performance",
  "tooling",
  "other",
];

/** Injectable seams for tests. Production passes none. */
export interface LearnCommandDeps {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  now?: () => Date;
  /** Both stdin and stdout are terminals. Default: `process.stdin.isTTY && process.stdout.isTTY`. */
  isTerminal?: boolean;
  /** Prompt on the terminal and return the typed line. Defaults to a real `node:readline/promises` prompt on stdin/stdout. */
  readLine?: (prompt: string) => Promise<string>;
  /** `observe --hook`'s stdin source. Defaults to the real bounded stdin reader (`readStdinBounded`, shared with `keryx ctx hook`). Test seam. */
  readStdin?: () => Promise<string | null>;
}

function resolveRoot(deps: LearnCommandDeps): string {
  return deps.cwd ?? process.cwd();
}

function resolveEnv(deps: LearnCommandDeps): NodeJS.ProcessEnv {
  return deps.env ?? process.env;
}

function resolveTerminal(deps: LearnCommandDeps): boolean {
  return deps.isTerminal ?? (process.stdin.isTTY === true && process.stdout.isTTY === true);
}

function resolveNow(deps: LearnCommandDeps): Date {
  return (deps.now ?? ((): Date => new Date()))();
}

/** Refuse an unknown flag rather than silently ignoring it (matches `agents-catalog.ts`/`review.ts`). */
function unknownFlags(args: readonly string[], allowed: readonly string[]): string[] {
  return args.filter((arg) => arg.startsWith("--") && !allowed.includes(arg.split("=")[0] as string));
}

function positional(args: readonly string[]): string | undefined {
  return args.find((arg) => !arg.startsWith("-"));
}

function fail(message: string): void {
  console.error(`keryx learn: ${message}`);
  process.exitCode = 1;
}

function reportError(error: unknown): void {
  const reason =
    error instanceof LearningAcceptError ||
    error instanceof LearningApplyError ||
    error instanceof LearningPromoteError ||
    error instanceof LearningGraduateError
      ? ` [${error.reason}]`
      : "";
  console.error(`keryx learn: ${error instanceof Error ? error.message : String(error)}${reason}`);
  process.exitCode = 1;
}

async function defaultReadLine(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}

/** `confirm: () => Promise<boolean>` (the shape `promotePattern`/`applyGraduation` expect): prompts the operator to type `id` back exactly. */
function makeTypedIdConfirm(id: string, label: string, deps: LearnCommandDeps): () => Promise<boolean> {
  return async () => {
    const readLine = deps.readLine ?? defaultReadLine;
    const answer = await readLine(`Type the ${label} id "${id}" to confirm: `);
    return answer.trim() === id;
  };
}

function parseEnumFlag<T extends string>(args: readonly string[], flag: string, allowed: readonly T[]): T | undefined {
  const value = optionValue([...args], flag);
  if (value === undefined) return undefined;
  if (!allowed.includes(value as T)) {
    throw new Error(`${flag} must be one of ${allowed.join(", ")}, not "${value}"`);
  }
  return value as T;
}

function storeOptionsOf(deps: LearnCommandDeps): { env?: NodeJS.ProcessEnv; homeDir?: string } {
  return {
    ...(deps.env !== undefined ? { env: deps.env } : {}),
    ...(deps.homeDir !== undefined ? { homeDir: deps.homeDir } : {}),
  };
}

// ---------------------------------------------------------------------------
// observe
// ---------------------------------------------------------------------------

async function runObserveHook(deps: LearnCommandDeps): Promise<void> {
  // Always exits 0 and prints nothing on stdout (W3 spec "Observe"; D5: the
  // host observer never blocks or signals a decision). Every failure —
  // unreadable stdin, invalid JSON, a redaction/disk error inside
  // `observeHostHookPayload` itself — is swallowed here, never thrown.
  process.exitCode = 0;
  try {
    const readStdin = deps.readStdin ?? ((): Promise<string | null> => readStdinBounded(STDIN_DEADLINE_MS));
    const raw = await readStdin();
    if (raw === null || raw.trim().length === 0) return;
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      return; // invalid JSON: no line written, still exit 0.
    }
    const root = resolveRoot(deps);
    await observeHostHookPayload(root, "claude", payload, {
      ...storeOptionsOf(deps),
      now: () => resolveNow(deps).toISOString(),
    });
  } catch {
    // Never throw into the hook runtime.
  }
}

async function countObservationLines(filePath: string): Promise<number> {
  try {
    const raw = await readFile(filePath, "utf8");
    return raw.split("\n").filter((line) => line.length > 0).length;
  } catch {
    return 0;
  }
}

async function runObserveManual(deps: LearnCommandDeps): Promise<void> {
  const root = resolveRoot(deps);
  const today = resolveNow(deps).toISOString().slice(0, 10);
  const lines = await countObservationLines(observationFilePath(root, today));
  console.log(`keryx learn observe: ${lines} line(s) in today's observation file (${today}.jsonl).`);
  console.log("writer is unbuffered; nothing to flush.");
}

async function runObserve(args: readonly string[], deps: LearnCommandDeps): Promise<void> {
  const bad = unknownFlags(args, ["--hook"]);
  if (bad.length > 0) return fail(`unknown flag(s): ${bad.join(", ")}`);
  const hook = optionValue([...args], "--hook");
  if (hook !== undefined && hook !== "claude") return fail(`--hook must be "claude", not "${hook}"`);
  if (hook === "claude") {
    await runObserveHook(deps);
    return;
  }
  await runObserveManual(deps);
}

// ---------------------------------------------------------------------------
// extract
// ---------------------------------------------------------------------------

async function runExtractCommand(args: readonly string[], deps: LearnCommandDeps): Promise<void> {
  const bad = unknownFlags(args, ["--domain", "--since", "--json"]);
  if (bad.length > 0) return fail(`unknown flag(s): ${bad.join(", ")}`);
  try {
    const domain = parseEnumFlag(args, "--domain", DOMAINS);
    const since = optionValue([...args], "--since");
    const root = resolveRoot(deps);
    const report = await runExtract(root, {
      ...(domain !== undefined ? { domain } : {}),
      ...(since !== undefined ? { since } : {}),
      now: resolveNow(deps),
      ...storeOptionsOf(deps),
    });
    if (args.includes("--json")) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(
      `keryx learn extract: created ${report.created.length}, reinforced ${report.reinforced.length}, decayed ${report.decayed.length}, refused ${report.refused.length}, skipped (already decided) ${report.skippedDecided.length}.`,
    );
    for (const [signal, count] of Object.entries(report.signals)) {
      console.log(`  ${signal}: ${count}`);
    }
    for (const id of report.created) console.log(`  + ${id}`);
    for (const id of report.reinforced) console.log(`  ~ ${id}`);
    for (const refusal of report.refused) console.log(`  refused (${refusal.signal}): ${refusal.categories.join(", ")}`);
  } catch (error) {
    reportError(error);
  }
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

function formatRecordRow(record: LearnedPattern): string {
  const level = record.confidenceLevel !== undefined ? ` (${record.confidenceLevel})` : "";
  return `${record.id}  status=${record.status} scope=${record.scope} domain=${record.domain} confidence=${record.confidence}${level}`;
}

async function runList(args: readonly string[], deps: LearnCommandDeps): Promise<void> {
  const bad = unknownFlags(args, ["--status", "--domain", "--scope", "--json"]);
  if (bad.length > 0) return fail(`unknown flag(s): ${bad.join(", ")}`);
  try {
    const status = parseEnumFlag(args, "--status", STATUSES);
    const domain = parseEnumFlag(args, "--domain", DOMAINS);
    const scope = parseEnumFlag(args, "--scope", SCOPES);
    const root = resolveRoot(deps);
    const storeOptions = storeOptionsOf(deps);
    const records = await listPatterns(
      root,
      {
        ...(status !== undefined ? { status } : {}),
        ...(domain !== undefined ? { domain } : {}),
        ...(scope !== undefined ? { scope } : {}),
      },
      storeOptions,
    );

    if (args.includes("--json")) {
      console.log(JSON.stringify(records, null, 2));
    } else if (records.length === 0) {
      console.log("keryx learn list: no records match.");
    } else {
      for (const record of records) console.log(formatRecordRow(record));
    }

    const flagged = await auditAcceptedRecords(root, storeOptions);
    for (const entry of flagged) {
      console.error(
        `keryx learn list: WARNING — accepted record "${entry.id}" (${entry.scope}) has no matching accept decision recorded (integrity check).`,
      );
    }
  } catch (error) {
    reportError(error);
  }
}

// ---------------------------------------------------------------------------
// review
// ---------------------------------------------------------------------------

function printRecordDetail(record: LearnedPattern): void {
  console.log(`${record.id}  [${record.status}, ${record.scope}]`);
  console.log(`  domain: ${record.domain}`);
  console.log(`  trigger: ${record.trigger}`);
  console.log(`  action: ${record.action}`);
  console.log(`  confidence: ${record.confidence}${record.confidenceLevel !== undefined ? ` (${record.confidenceLevel})` : ""}`);
  console.log("  evidence:");
  for (const item of record.evidence) {
    console.log(`    - ${item.kind}/${item.sourceType} ${item.sourceRef} @ ${item.observedAt}`);
  }
}

async function findById(
  root: string,
  id: string,
  scope: LearningScope | undefined,
  storeOptions: { env?: NodeJS.ProcessEnv; homeDir?: string },
): Promise<LearnedPattern | undefined> {
  if (scope !== undefined) return readPattern(root, id, scope, storeOptions);
  const project = await readPattern(root, id, "project", storeOptions);
  if (project !== undefined) return project;
  return readPattern(root, id, "user", storeOptions);
}

async function runReview(args: readonly string[], deps: LearnCommandDeps): Promise<void> {
  const bad = unknownFlags(args, ["--scope"]);
  if (bad.length > 0) return fail(`unknown flag(s): ${bad.join(", ")}`);
  try {
    const scope = parseEnumFlag(args, "--scope", SCOPES);
    const root = resolveRoot(deps);
    const storeOptions = storeOptionsOf(deps);
    const id = positional(args);

    if (id !== undefined) {
      const record = await findById(root, id, scope, storeOptions);
      if (record === undefined) return fail(`no learned-pattern record "${id}"`);
      printRecordDetail(record);
      return;
    }

    const candidates = await listPatterns(root, { status: "candidate", ...(scope !== undefined ? { scope } : {}) }, storeOptions);
    if (candidates.length === 0) {
      console.log("keryx learn review: no candidates.");
      return;
    }
    candidates.forEach((record, index) => {
      if (index > 0) console.log("");
      printRecordDetail(record);
    });
  } catch (error) {
    reportError(error);
  }
}

// ---------------------------------------------------------------------------
// accept / reject
// ---------------------------------------------------------------------------

async function runAccept(args: readonly string[], deps: LearnCommandDeps): Promise<void> {
  const bad = unknownFlags(args, ["--scope", "--refresh"]);
  if (bad.length > 0) return fail(`unknown flag(s): ${bad.join(", ")}`);
  const id = positional(args);
  if (id === undefined) return fail("usage: keryx learn accept <id> [--scope user] [--refresh]");
  try {
    const scope = parseEnumFlag(args, "--scope", SCOPES);
    const root = resolveRoot(deps);
    const result = await acceptPattern(root, id, {
      ...(scope !== undefined ? { scope } : {}),
      refresh: args.includes("--refresh"),
      isTerminal: resolveTerminal(deps),
      now: () => resolveNow(deps),
      ...storeOptionsOf(deps),
    });
    console.log(
      `keryx learn accept: "${result.id}" (${result.scope}) is now accepted.${result.indexUpdated ? " Index entry written/refreshed." : ""}`,
    );
  } catch (error) {
    reportError(error);
  }
}

async function runReject(args: readonly string[], deps: LearnCommandDeps): Promise<void> {
  const bad = unknownFlags(args, ["--scope"]);
  if (bad.length > 0) return fail(`unknown flag(s): ${bad.join(", ")}`);
  const id = positional(args);
  if (id === undefined) return fail("usage: keryx learn reject <id> [--scope user]");
  try {
    const scope = parseEnumFlag(args, "--scope", SCOPES);
    const root = resolveRoot(deps);
    const result = await rejectPattern(root, id, {
      ...(scope !== undefined ? { scope } : {}),
      now: () => resolveNow(deps),
      ...storeOptionsOf(deps),
    });
    console.log(`keryx learn reject: "${result.id}" (${result.scope}) is now rejected.`);
  } catch (error) {
    reportError(error);
  }
}

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

async function runApply(args: readonly string[], deps: LearnCommandDeps): Promise<void> {
  const bad = unknownFlags(args, ["--skill", "--dry-run"]);
  if (bad.length > 0) return fail(`unknown flag(s): ${bad.join(", ")}`);
  const id = positional(args);
  if (id === undefined) return fail("usage: keryx learn apply <id> --skill <module/name> [--dry-run]");
  const skill = optionValue([...args], "--skill");
  if (skill === undefined) return fail("--skill <module/name> is required");
  try {
    const root = resolveRoot(deps);
    await applyLearnedPattern(root, id, { skill, dryRun: args.includes("--dry-run"), ...storeOptionsOf(deps) });
  } catch (error) {
    reportError(error);
  }
}

// ---------------------------------------------------------------------------
// promote
// ---------------------------------------------------------------------------

async function runPromote(args: readonly string[], deps: LearnCommandDeps): Promise<void> {
  // No flags at all — in particular, no --yes/--force/--non-interactive (W3
  // spec "Promotion rule" #2). Any flag here is refused, not just an unknown one.
  const bad = unknownFlags(args, []);
  if (bad.length > 0) return fail(`unknown flag(s): ${bad.join(", ")} — promote takes no flags (no bypass exists)`);
  const id = positional(args);
  if (id === undefined) return fail("usage: keryx learn promote <id>");
  const terminal = resolveTerminal(deps);
  if (!terminal) {
    fail(
      "promote needs an interactive terminal on both stdin and stdout, and refuses to run from a pipe, an agent's shell, " +
        "an MCP or ACP client, or an unattended run. Run it yourself, in a terminal. [promote-requires-terminal]",
    );
    return;
  }
  try {
    const root = resolveRoot(deps);
    await promotePattern(root, id, {
      isTerminal: terminal,
      confirm: makeTypedIdConfirm(id, "pattern", deps),
      now: resolveNow(deps),
      ...storeOptionsOf(deps),
    });
  } catch (error) {
    reportError(error);
  }
}

// ---------------------------------------------------------------------------
// graduate / graduate apply
// ---------------------------------------------------------------------------

async function runGraduateRun(args: readonly string[], deps: LearnCommandDeps): Promise<void> {
  const bad = unknownFlags(args, ["--domain"]);
  if (bad.length > 0) return fail(`unknown flag(s): ${bad.join(", ")}`);
  try {
    const domain = parseEnumFlag(args, "--domain", DOMAINS);
    const root = resolveRoot(deps);
    await runGraduate(root, { ...(domain !== undefined ? { domain } : {}), now: resolveNow(deps), ...storeOptionsOf(deps) });
  } catch (error) {
    reportError(error);
  }
}

async function runGraduateApply(args: readonly string[], deps: LearnCommandDeps): Promise<void> {
  // Same "no flags at all" rule as promote — no bypass exists for graduate apply either.
  const bad = unknownFlags(args, []);
  if (bad.length > 0) return fail(`unknown flag(s): ${bad.join(", ")} — graduate apply takes no flags (no bypass exists)`);
  const proposalId = positional(args);
  if (proposalId === undefined) return fail("usage: keryx learn graduate apply <proposal-id>");
  const terminal = resolveTerminal(deps);
  if (!terminal) {
    fail(
      "graduate apply needs an interactive terminal on both stdin and stdout, and refuses to run from a pipe, an agent's " +
        "shell, an MCP or ACP client, or an unattended run. Run it yourself, in a terminal. [graduate-apply-requires-terminal]",
    );
    return;
  }
  try {
    const root = resolveRoot(deps);
    await applyGraduation(root, proposalId, {
      isTerminal: terminal,
      confirm: makeTypedIdConfirm(proposalId, "proposal", deps),
      now: resolveNow(deps),
      ...storeOptionsOf(deps),
    });
  } catch (error) {
    reportError(error);
  }
}

async function runGraduateCommand(args: readonly string[], deps: LearnCommandDeps): Promise<void> {
  if (args[0] === "apply") {
    await runGraduateApply(args.slice(1), deps);
    return;
  }
  await runGraduateRun(args, deps);
}

// ---------------------------------------------------------------------------
// prune
// ---------------------------------------------------------------------------

async function runPrune(args: readonly string[], deps: LearnCommandDeps): Promise<void> {
  const bad = unknownFlags(args, ["--dry-run", "--json"]);
  if (bad.length > 0) return fail(`unknown flag(s): ${bad.join(", ")}`);
  try {
    const root = resolveRoot(deps);
    const report = await pruneLearning(root, { now: resolveNow(deps), dryRun: args.includes("--dry-run"), ...storeOptionsOf(deps) });
    if (args.includes("--json")) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(
      `keryx learn prune: deleted ${report.deletedObservationFiles.length} observation file(s), expired ${report.expired.length} candidate(s).`,
    );
    for (const file of report.deletedObservationFiles) console.log(`  - observations/${file}`);
    for (const entry of report.expired) console.log(`  - ${entry.id} (${entry.scope})`);
  } catch (error) {
    reportError(error);
  }
}

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

export async function learnCommand(args: string[] = [], deps: LearnCommandDeps = {}): Promise<void> {
  const [command, ...rest] = args;
  if (command === undefined || command === "--help" || command === "-h") {
    printLearnHelp();
    return;
  }
  const env = resolveEnv(deps);
  const resolvedDeps: LearnCommandDeps = { ...deps, env };

  if (command === "observe") return runObserve(rest, resolvedDeps);
  if (command === "extract") return runExtractCommand(rest, resolvedDeps);
  if (command === "list") return runList(rest, resolvedDeps);
  if (command === "review") return runReview(rest, resolvedDeps);
  if (command === "accept") return runAccept(rest, resolvedDeps);
  if (command === "reject") return runReject(rest, resolvedDeps);
  if (command === "apply") return runApply(rest, resolvedDeps);
  if (command === "promote") return runPromote(rest, resolvedDeps);
  if (command === "graduate") return runGraduateCommand(rest, resolvedDeps);
  if (command === "prune") return runPrune(rest, resolvedDeps);

  fail(`unknown subcommand "${command}". See \`keryx learn --help\`.`);
  printLearnHelp();
}

export function printLearnHelp(): void {
  console.log(`keryx learn — the self-learning loop's consent CLI (observe, extract, review, accept, apply, promote, graduate, prune)

Usage:
  keryx learn observe [--hook claude]
  keryx learn extract [--domain <d>] [--since <YYYY-MM-DD>] [--json]
  keryx learn list [--status <s>] [--domain <d>] [--scope <s>] [--json]
  keryx learn review [<id>] [--scope <s>]
  keryx learn accept <id> [--scope user] [--refresh]
  keryx learn reject <id> [--scope user]
  keryx learn apply <id> --skill <module/name> [--dry-run]
  keryx learn promote <id>
  keryx learn graduate [--domain <d>]
  keryx learn graduate apply <proposal-id>
  keryx learn prune [--dry-run] [--json]

\`observe --hook claude\` reads one host-hook payload from stdin, always exits 0 and
prints nothing to stdout — it is the command an opt-in Claude Code hook runs. Without
--hook it reports today's observation file line count for manual/offline use.

\`accept\`, \`promote\` and \`graduate apply\` never take a --yes/--force/--non-interactive
flag: each refuses outside a real interactive terminal, with a named reason and no
bypass. \`promote\`/\`graduate apply\` additionally prompt you to type the pattern's (or
proposal's) id back to confirm. None of the three is reachable through MCP.

Status values: ${STATUSES.join(", ")}
Scope values: ${SCOPES.join(", ")}
Domain values: ${DOMAINS.join(", ")}
`);
}
