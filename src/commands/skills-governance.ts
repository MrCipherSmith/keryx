// Flow 309, W1 Lane C — `keryx skills scout|eval|stocktake`, the three
// governance gates (W1's "Governance gates: scout, eval, stocktake"
// section). A separate module, dispatched from `src/commands/skills.ts` with
// a small hook, because Lane B (install/doctor/uninstall) edits that same
// file concurrently — see the flow dispatch's shared-file note.
//
// Flow 316, T6: `--judge <provider>[:<model>]` on `eval`, and the new
// `judge-check` subcommand — both live in this same file (not a fourth
// dispatcher module) since they extend `eval`'s own flag surface and share
// its scope/catalog-loading plumbing directly.

import path from "node:path";
import { loadSkillCatalog, loadSkillCatalogWithDiagnostics, type CatalogScope } from "../gdskills/governance/catalog-index";
import {
  evalSkill,
  readSkillEvalSpec,
  reverifyPackSample,
  RUNNER_PROMPT_VERSION,
  type EvalSpecFile,
} from "../gdskills/governance/eval";
import {
  antiGamingAnswers,
  gradeScenarioAnswer,
  judgeRequestDigest,
  JUDGE_PROMPT_VERSION,
  type AntiGamingKind,
  type JudgeExpectation,
} from "../gdskills/governance/judge";
import { writeJudgeRecording, type JudgeRecordingEntry, type JudgeRecordingSample } from "../gdskills/governance/judge-recordings";
import { recordScout, scoutImports, scoutSkill, scoutVetCandidate } from "../gdskills/governance/scout";
import { runStocktake } from "../gdskills/governance/stocktake";
import { defaultModelFor } from "../harness/provider/single-turn";
import { optionValue } from "../lib/args";
import { buildEvalJudge, JudgeBuildError } from "./model-eval-judge";
import { buildEvalRunner, RunnerBuildError, splitRunnerSpec } from "./model-eval-runner";

/** Whether `name` was given at all, in either `--name value` or `--name=value` spelling — distinct from `optionValue`'s `undefined`, which also means "given with no usable value" (R2-8, flow 309 review round 2). */
function flagGiven(args: readonly string[], name: string): boolean {
  return args.includes(name) || args.some((arg) => arg.startsWith(`${name}=`));
}

/**
 * `optionValue`, but tells "not given" apart from "given with no usable
 * value" (R2-8, flow 309 review round 2 — same class as F3/F9/F13: a
 * malformed flag must be refused, not silently treated as absent and fallen
 * back to a default). A trailing `--flag`, `--flag --other-flag`, or
 * `--flag=` (empty) all answer `"missing-value"`; a flag not present at all
 * answers `undefined`, same as before.
 */
function stringFlag(args: readonly string[], name: string): string | undefined | "missing-value" {
  if (!flagGiven(args, name)) return undefined;
  const raw = optionValue([...args], name);
  return raw !== undefined && raw.length > 0 ? raw : "missing-value";
}

type ScopeResult = { readonly ok: true; readonly scope: CatalogScope } | { readonly ok: false; readonly error: string };

/** R2-8: `--scope` with no value, or a value that is neither `bundled` nor `all`, is refused rather than silently defaulting to `bundled`. */
function parseScope(args: readonly string[]): ScopeResult {
  const raw = stringFlag(args, "--scope");
  if (raw === "missing-value") return { ok: false, error: "--scope requires a value" };
  if (raw === undefined) return { ok: true, scope: "bundled" };
  if (raw === "all" || raw === "bundled") return { ok: true, scope: raw };
  return { ok: false, error: `--scope must be 'bundled' or 'all' (got ${JSON.stringify(raw)})` };
}

/**
 * F9 (flow 309 review round 1; hardened R2-8, flow 309 review round 2): a
 * positive integer flag value, in either `--flag value` or `--flag=value`
 * spelling (both handled by the shared `optionValue`, which the local
 * hand-rolled `args.indexOf` reimplementation this replaced did NOT —
 * `--trials=3` read as absent and silently fell back to the default).
 * `undefined` means the flag was not given at all; `"invalid"` means it WAS
 * given but is not usable — not a positive integer (`--trials abc` used to
 * parse as `NaN`, which flowed all the way into the eval report as a trial
 * count no downstream check ever rejected), OR given with no value at all
 * (`--trials` trailing, `--trials --json`, `--trials=`) — R2-8: this last
 * shape used to read as `undefined` (same as "not given") and silently fall
 * back to the default trial count instead of being refused.
 */
// Flow 312, W3 T10: `--origin learned --source-ref <id>` on `keryx skills
// scout --record <pack-dir>` — the provenance a `keryx learn graduate`
// skill-target proposal's own `nextSteps` prints. Duplicated here rather than
// imported from `src/learning/paths.ts`'s `LEARNING_ID_PATTERN`: this module
// (`src/gdskills`) has no dependency on flow 312's feature module, and a
// `sourceRef` here is either a learned-pattern id OR a graduation proposal id
// (`grad-...`, never a learned-pattern id itself) — a shape this module owns
// checking, not one to borrow from the other feature's internal id pattern.
const SCOUT_ORIGIN_VALUES = ["learned"] as const;
const LEARNED_PATTERN_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;

/** A `learned-pattern` record id, or a graduation proposal id (`grad-...`) — see the comment above. */
function isValidScoutSourceRef(value: string): boolean {
  return value.startsWith("grad-") || LEARNED_PATTERN_ID_PATTERN.test(value);
}

function positiveIntegerFlag(args: readonly string[], flag: string): number | undefined | "invalid" {
  const raw = stringFlag(args, flag);
  if (raw === undefined) return undefined;
  if (raw === "missing-value" || !/^\d+$/.test(raw)) return "invalid";
  const value = Number(raw);
  return value >= 1 ? value : "invalid";
}

/**
 * Flow 316, T6: the ONLY seam `eval --judge`/`judge-check` need for offline
 * tests — `buildJudge` defaults to the real, network-calling
 * `buildEvalJudge`; a test overrides it with a deterministic fake `Judge`
 * builder (no credential, no network) the same way `EvalOptions.judge` lets
 * `evalSkill` itself be tested without a real model. Every other governance
 * subcommand (`scout`, `eval --runner`'s existing fail-closed paths,
 * `stocktake`) needs no such seam and is left untouched.
 */
export interface SkillsGovernanceDeps {
  readonly buildJudge?: typeof buildEvalJudge;
}

export async function skillsGovernanceCommand(args: readonly string[], deps: SkillsGovernanceDeps = {}): Promise<void> {
  const command = args[0];
  const rest = args.slice(1);
  if (command === "scout") {
    await scoutCommand(rest);
    return;
  }
  if (command === "eval") {
    await evalCommand(rest, deps);
    return;
  }
  if (command === "judge-check") {
    await judgeCheckCommand(rest, deps);
    return;
  }
  if (command === "stocktake") {
    await stocktakeCommand(rest);
    return;
  }
  console.error(`Unknown skills governance command: ${String(command)}`);
  process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// scout
// ---------------------------------------------------------------------------

function printScoutHelp(): void {
  console.log(`keryx skills scout

Pre-creation dedupe gate: does an existing skill already cover this?

Usage:
  keryx skills scout <name-or-description> [--record <pack-dir>] [--skill-name <name>]
              [--justification <text>] [--include-imports] [--candidate <dir>]
              [--scope bundled|all] [--origin learned --source-ref <id>] [--json]

Examples:
  keryx skills scout "review a Postgres migration"
  keryx skills scout "review a Postgres migration" --record .metaproject/gdskills/review --json
`);
}

function printEvalHelp(): void {
  console.log(`keryx skills eval

Behavioral compliance eval: trigger accuracy + scenario pass rate. --judge <provider>[:<model>]
grades judge-graded behavior scenarios with a live LLM judge.

Usage:
  keryx skills eval <skill-id> [--strictness low|medium|high] [--trials N] [--runner <provider>]
              [--judge <provider>[:<model>]] [--scope bundled|all] [--model-grader] [--json]
  keryx skills eval --reverify <pack-dir> [--sample N] --judge <provider>[:<model>] [--json]

Examples:
  keryx skills eval review/postgres-migration
  keryx skills eval review/postgres-migration --judge anthropic:claude-sonnet-4-5 --json
`);
}

function printJudgeCheckHelp(): void {
  console.log(`keryx skills judge-check

Proves a skill's judge-graded scenarios are hard to game: runs the canned empty/echo/known-wrong/
injection/stuffed/known-right answers through the live judge and exits 1 on any mismatch.
--record saves the verdicts for offline replay.

Usage:
  keryx skills judge-check <skill-id> --judge <provider>[:<model>] [--scope bundled|all]
              [--samples <n>] [--record] [--json]

Examples:
  keryx skills judge-check review/postgres-migration --judge anthropic:claude-sonnet-4-5
`);
}

function printStocktakeHelp(): void {
  console.log(`keryx skills stocktake

Periodic catalog health check: keep|improve|update|retire|merge.

Usage:
  keryx skills stocktake [--scope bundled|all] [--quick] [--json]

Examples:
  keryx skills stocktake
  keryx skills stocktake --scope all --json
`);
}

async function scoutCommand(args: readonly string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    printScoutHelp();
    return;
  }
  // R2-8: a value-taking flag given with no usable value (trailing, or
  // immediately followed by another flag) is refused up front, rather than
  // the loop below silently swallowing the NEXT flag as this one's value
  // (`--record --json` used to set `record = "--json"`) or silently leaving
  // the field `undefined` and proceeding as if the flag were never given.
  for (const flag of ["--record", "--justification", "--skill-name", "--candidate", "--origin", "--source-ref"] as const) {
    if (stringFlag(args, flag) === "missing-value") {
      console.error(`${flag} requires a value`);
      process.exitCode = 1;
      return;
    }
  }
  const scopeResult = parseScope(args);
  if (!scopeResult.ok) {
    console.error(scopeResult.error);
    process.exitCode = 1;
    return;
  }

  const queryWords: string[] = [];
  let record: string | undefined;
  let candidate: string | undefined;
  let justification: string | undefined;
  let skillNameOverride: string | undefined;
  let origin: string | undefined;
  let sourceRef: string | undefined;
  let includeImports = false;
  const json = args.includes("--json");
  const scope = scopeResult.scope;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--record") {
      record = args[++i];
      continue;
    }
    if (arg === "--justification") {
      justification = args[++i];
      continue;
    }
    if (arg === "--skill-name") {
      skillNameOverride = args[++i];
      continue;
    }
    if (arg === "--candidate") {
      candidate = args[++i];
      continue;
    }
    if (arg === "--origin") {
      origin = args[++i];
      continue;
    }
    if (arg === "--source-ref") {
      sourceRef = args[++i];
      continue;
    }
    if (arg === "--scope") {
      i += 1; // value already consumed by parseScope
      continue;
    }
    if (arg === "--include-imports") {
      includeImports = true;
      continue;
    }
    if (arg === "--json") continue;
    queryWords.push(arg);
  }

  const query = queryWords.join(" ");
  if (query.length === 0) {
    console.error(
      "Usage: keryx skills scout <name-or-description> [--record <pack-dir>] [--skill-name <name>] [--justification <text>] " +
        "[--include-imports] [--candidate <dir>] [--scope bundled|all] [--origin learned --source-ref <id>] [--json]",
    );
    process.exitCode = 1;
    return;
  }

  // Flow 312, W3 T10: `--origin`/`--source-ref` are required together, only
  // meaningful alongside `--record` (there is no scout-record row to attach
  // provenance to without it), `--origin` accepts only `"learned"`, and
  // `--source-ref` must look like a learned-pattern or graduation-proposal
  // id — see `isValidScoutSourceRef`'s comment above.
  if ((origin !== undefined) !== (sourceRef !== undefined)) {
    console.error("--origin and --source-ref must be given together");
    process.exitCode = 1;
    return;
  }
  if (origin !== undefined && record === undefined) {
    console.error("--origin/--source-ref require --record <pack-dir>");
    process.exitCode = 1;
    return;
  }
  if (origin !== undefined && !(SCOUT_ORIGIN_VALUES as readonly string[]).includes(origin)) {
    console.error(`--origin must be one of ${SCOUT_ORIGIN_VALUES.join(", ")} (got ${JSON.stringify(origin)})`);
    process.exitCode = 1;
    return;
  }
  if (sourceRef !== undefined && !isValidScoutSourceRef(sourceRef)) {
    console.error(`--source-ref ${JSON.stringify(sourceRef)} is not a valid learned-pattern or graduation-proposal id`);
    process.exitCode = 1;
    return;
  }

  const root = process.cwd();
  const catalog = loadSkillCatalog(root, { scope });

  // Flow 314 T15: a named candidate's own on-disk `SKILL.md` is already
  // IN `catalog` (it was written before this scout run, or `--candidate`
  // names a dir that already has one) — scoring the candidate against a
  // catalog that includes itself always finds a perfect self-match
  // (decision "use", topMatch = itself), which defeats the whole point of a
  // pre-creation dedupe check. Exclude the candidate's own catalog id(s)
  // before scoring; a bare `keryx skills scout "<text>"` with no named
  // candidate has no id to exclude and keeps today's behavior.
  const excludeIds: string[] = [];
  if (record !== undefined && skillNameOverride !== undefined) {
    excludeIds.push(`${path.basename(path.resolve(root, record))}/${skillNameOverride}`);
  }
  if (candidate !== undefined) {
    const candidatePath = path.resolve(root, candidate);
    for (const entry of catalog) {
      if (path.dirname(entry.path) === candidatePath) excludeIds.push(entry.id);
    }
  }

  const result = scoutSkill(query, catalog, excludeIds.length > 0 ? { excludeIds } : {});
  const imports = includeImports ? await scoutImports(query) : undefined;
  const vetting = candidate !== undefined ? await scoutVetCandidate(path.resolve(root, candidate)) : undefined;

  if (record !== undefined) {
    const packDir = path.resolve(root, record);
    recordScout(packDir, {
      query,
      decision: result.decision,
      topMatch: result.matches[0]?.skillId ?? null,
      recordedAt: new Date().toISOString(),
      // `--record <pack-dir>` may name a whole stack pack's root (its
      // `governance/scout.json` holds one log shared by every skill in the
      // pack) rather than a single skill's own directory — `path.basename`
      // of the pack root is then the pack id, not the skill this scout run
      // is actually about. `--skill-name` lets a caller say which skill the
      // query is for; omitted, the prior behavior (basename of `--record`)
      // still holds for the common case where `--record` names the skill's
      // own directory.
      skillName: skillNameOverride ?? path.basename(packDir),
      ...(justification !== undefined ? { justification } : {}),
      ...(origin === "learned" && sourceRef !== undefined ? { origin: { kind: "learned" as const, sourceRef } } : {}),
    });
  }

  const output = {
    ...result,
    ...(imports !== undefined ? { imports } : {}),
    ...(vetting !== undefined ? { vetting } : {}),
  };

  if (json) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  console.log(`Query: ${result.query}`);
  console.log(`Decision: ${result.decision}`);
  console.log(`Thresholds: use >= ${result.thresholds.use}, fork >= ${result.thresholds.fork}`);
  if (result.matches.length === 0) {
    console.log("No matches.");
  } else {
    console.log("Matches:");
    for (const match of result.matches) {
      console.log(`  ${match.skillId}  score=${match.overlapScore.toFixed(2)}  ${match.reason}`);
    }
  }
  if (imports !== undefined) {
    console.log(`Imports searched: ${imports.searched} (${imports.reason})`);
    if (imports.searched && imports.skipped.length > 0) {
      console.log(`Imports skipped (failed re-verification): ${imports.skipped.length}`);
      for (const skip of imports.skipped) {
        console.log(`  ${skip.name}: ${skip.reason}`);
      }
    }
  }
  if (vetting !== undefined) {
    console.log(
      vetting.available
        ? `Candidate vetting: ${vetting.summary?.findings ?? 0} finding(s)`
        : `Candidate vetting unavailable: ${vetting.reason}`,
    );
  }
  if (record !== undefined) {
    console.log(`Recorded to ${path.join(path.resolve(root, record), "governance", "scout.json")}`);
  }
}

// ---------------------------------------------------------------------------
// eval
// ---------------------------------------------------------------------------

function isStrictness(value: string | undefined): value is "low" | "medium" | "high" {
  return value === "low" || value === "medium" || value === "high";
}

async function evalCommand(args: readonly string[], deps: SkillsGovernanceDeps = {}): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    printEvalHelp();
    return;
  }
  // Flow 317 (FU3): `--reverify <pack-dir>` is a distinct mode of `eval` —
  // re-judging RECORDED trials live, never running a fresh eval — so it is
  // dispatched before the normal `<skill-id>` usage check below (a pack
  // directory path is not a skill id).
  if (args[0] === "--reverify") {
    await reverifyCommand(args.slice(1), deps);
    return;
  }

  const buildJudge = deps.buildJudge ?? buildEvalJudge;
  const skillId = args[0];
  if (skillId === undefined || skillId.startsWith("--")) {
    console.error(
      "Usage: keryx skills eval <skill-id> [--strictness low|medium|high] [--trials N] [--runner <provider>] [--judge <provider>[:<model>]] [--scope bundled|all] [--model-grader] [--json]\n" +
        "   or: keryx skills eval --reverify <pack-dir> [--sample N] --judge <provider>[:<model>] [--json]",
    );
    process.exitCode = 1;
    return;
  }

  const strictnessRaw = stringFlag(args, "--strictness");
  // F9 (hardened R2-8, flow 309 review round 2): an unknown `--strictness`
  // value used to silently fall back to "low" — the weakest gate — instead
  // of being refused (`--strictness hihg`, a typo, quietly ran the least
  // strict eval and nobody would notice); R2-8: `--strictness` given with NO
  // value at all (trailing, or followed by another flag) used to read as
  // `undefined` — indistinguishable from "not given" — and fall back to
  // "low" the same silent way.
  if (strictnessRaw === "missing-value") {
    console.error("--strictness requires a value");
    process.exitCode = 1;
    return;
  }
  if (strictnessRaw !== undefined && !isStrictness(strictnessRaw)) {
    console.error(`--strictness must be one of low, medium, high (got ${JSON.stringify(strictnessRaw)})`);
    process.exitCode = 1;
    return;
  }
  const strictness = strictnessRaw ?? "low";

  const trialsArg = positiveIntegerFlag(args, "--trials");
  // F9: `--trials abc` used to parse as `NaN` and flow straight into the
  // report; `--trials=3` (the `=` spelling) was silently ignored (the
  // hand-rolled parser only handled `--trials 3`) and fell back to the
  // default of 3 without any error. Both are now refused up front.
  if (trialsArg === "invalid") {
    console.error("--trials must be a positive integer");
    process.exitCode = 1;
    return;
  }
  const trials = trialsArg ?? 3;
  const modelGrader = args.includes("--model-grader");
  const json = args.includes("--json");

  // R1-11 (flow 314 review round 1): `eval` used to always score triggers
  // against `scope: "all"` (this repository's full catalog, project-local
  // skills included) with no way to ask for anything else — a recorded
  // "pass" could depend on a repo-local skill outside the shipped bundle
  // tipping a trigger score, so it would not reproduce under the
  // bundled-only catalog users actually install. `--scope` defaults to
  // `"all"` for ad-hoc use (unchanged), but is now honored rather than
  // ignored, and the resolved scope is recorded on the report so a
  // consumer (the stable-pack gate) can require `"bundled"` specifically.
  const scopeRaw = stringFlag(args, "--scope");
  if (scopeRaw === "missing-value") {
    console.error("--scope requires a value");
    process.exitCode = 1;
    return;
  }
  if (scopeRaw !== undefined && scopeRaw !== "bundled" && scopeRaw !== "all") {
    console.error(`--scope must be 'bundled' or 'all' (got ${JSON.stringify(scopeRaw)})`);
    process.exitCode = 1;
    return;
  }
  const scope: CatalogScope = scopeRaw === "bundled" ? "bundled" : "all";

  const runnerFlag = stringFlag(args, "--runner");
  // R2-8: `--runner` given with no value silently read as `undefined`
  // (indistinguishable from omitted) and skipped straight past the warning
  // below, as if no runner had been requested at all.
  if (runnerFlag === "missing-value") {
    console.error("--runner requires a value");
    process.exitCode = 1;
    return;
  }
  const runnerName = runnerFlag;

  // W4 Wave 4: `--runner <provider>[:<model>]` builds a real single-turn
  // model runner (`buildEvalRunner`, `./model-eval-runner.ts`) — fail-closed,
  // before any scenario runs: an unknown provider or a known provider with no
  // credential is refused here with `RunnerBuildError`, never silently
  // falling back to a fake provider or letting behavior scenarios report
  // `not-run` while pretending a runner was actually wired. Without
  // `--runner`, behavior scenarios still report `not-run` exactly as before
  // (`runner` stays `undefined` and `evalSkill` takes its no-runner branch).
  let runner: ReturnType<typeof buildEvalRunner> | undefined;
  if (runnerName !== undefined) {
    try {
      runner = buildEvalRunner(runnerName);
    } catch (error) {
      console.error(
        error instanceof RunnerBuildError || error instanceof Error ? error.message : String(error),
      );
      process.exitCode = 1;
      return;
    }
  }

  const judgeFlag = stringFlag(args, "--judge");
  // Flow 316, T6: `--judge` given with no value silently read as `undefined`
  // (indistinguishable from omitted) the same way `--runner` used to, before
  // R2-8 fixed that class of bug for every other flag in this file.
  if (judgeFlag === "missing-value") {
    console.error("--judge requires a value");
    process.exitCode = 1;
    return;
  }
  const judgeName = judgeFlag;

  // Flow 316: `--judge <provider>[:<model>]` builds a real single-turn judge
  // (`buildEvalJudge`, `./model-eval-judge.ts`) — fail-closed, before any
  // scenario runs, exactly like `--runner` above: an unknown provider or a
  // known provider with no credential is refused here, never silently
  // falling back to a fake provider or letting judge-graded scenarios report
  // `skipped` while pretending a judge was actually wired.
  let judge: ReturnType<typeof buildEvalJudge> | undefined;
  if (judgeName !== undefined) {
    try {
      judge = buildJudge(judgeName, { skillId });
    } catch (error) {
      console.error(error instanceof JudgeBuildError || error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
      return;
    }
  }

  const root = process.cwd();
  // R4-2 (flow 309 review round 4): `loadSkillCatalog` silently drops
  // `unreadable` (R3-4) — a skill whose SKILL.md exists but cannot be read
  // (EACCES, ...) is simply absent from `catalog`, so `evalSkill` below threw
  // the generic "unknown skill id" for it, indistinguishable from a skill id
  // that was never a skill at all. Loading with diagnostics lets this name
  // the actual read error instead.
  const { entries: catalog, unreadable } = loadSkillCatalogWithDiagnostics(root, { scope });
  if (!catalog.some((entry) => entry.id === skillId)) {
    const unreadableMatch = unreadable.find((entry) => {
      const normalized = entry.path.split(path.sep).join("/");
      return normalized.endsWith(`/${skillId}/SKILL.md`);
    });
    if (unreadableMatch !== undefined) {
      console.error(`skill ${skillId}: SKILL.md is unreadable: ${unreadableMatch.path} (${unreadableMatch.code})`);
      process.exitCode = 1;
      return;
    }
  }

  try {
    const rawReport = await evalSkill(skillId, catalog, {
      strictness,
      trials,
      modelGrader,
      scope,
      ...(runner !== undefined ? { runner } : {}),
      ...(judge !== undefined ? { judge } : {}),
    });
    // R1-11/R1-15 (flow 314 review round 1): when `--runner` was used, this
    // is a REAL model-backed run — stamp which provider/model actually
    // produced it, and when, onto the report. `evalSkill` itself never sees
    // `runnerName`/timestamp (it only sees the already-built `Runner`
    // function), so the CLI is the one place that knows both. Flow 316:
    // `--judge` stamps `judge`/`judgeModel` the same way (`judgePromptVersion`
    // is already stamped by `evalSkill` itself whenever a judge actually ran).
    let report = rawReport;
    if (runnerName !== undefined) {
      const { provider, model } = splitRunnerSpec(runnerName);
      report = {
        ...report,
        runner: provider,
        model: model ?? defaultModelFor(provider),
        runnerPromptVersion: RUNNER_PROMPT_VERSION,
        recordedAt: new Date().toISOString(),
      };
    }
    if (judgeName !== undefined) {
      const { provider, model } = splitRunnerSpec(judgeName);
      report = { ...report, judge: provider, judgeModel: model ?? defaultModelFor(provider), recordedAt: new Date().toISOString() };
    }
    if (json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`Skill: ${report.skillId}`);
      console.log(`Verdict: ${report.verdict}`);
      console.log(
        `Trigger accuracy: TP=${report.triggerAccuracy.truePositive}/${report.triggerAccuracy.positives}  FP=${report.triggerAccuracy.falsePositive}/${report.triggerAccuracy.negatives}`,
      );
      for (const scenario of report.scenarios) {
        console.log(`  [${scenario.kind}] ${scenario.id}  status=${scenario.status}  passRate=${scenario.passRate.toFixed(2)}`);
      }
    }
    process.exitCode = report.verdict === "fail" ? 1 : 0;
  } catch (error) {
    // R3-6 (flow 309 review round 3): this ternary always evaluated to `1`
    // regardless of the error type — a no-op that masked the intent to
    // exit 1 on ANY eval failure, contract violation (`EvalContractError`)
    // or malformed `evals.json` (`EvalSpecError`, R3-1) alike. Written as a
    // plain assignment now that both branches agree.
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// eval --reverify (flow 317, FU3: the live re-judge sampler)
// ---------------------------------------------------------------------------

const REVERIFY_DEFAULT_SAMPLE = 10;

async function reverifyCommand(args: readonly string[], deps: SkillsGovernanceDeps = {}): Promise<void> {
  const buildJudge = deps.buildJudge ?? buildEvalJudge;
  const packArg = args[0];
  if (packArg === undefined || packArg.startsWith("--")) {
    console.error("Usage: keryx skills eval --reverify <pack-dir> [--sample N] --judge <provider>[:<model>] [--json]");
    process.exitCode = 1;
    return;
  }

  const judgeFlag = stringFlag(args, "--judge");
  if (judgeFlag === "missing-value") {
    console.error("--judge requires a value");
    process.exitCode = 1;
    return;
  }
  if (judgeFlag === undefined) {
    console.error("--judge is required");
    process.exitCode = 1;
    return;
  }

  const sampleFlag = positiveIntegerFlag(args, "--sample");
  if (sampleFlag === "invalid") {
    console.error("--sample must be a positive integer");
    process.exitCode = 1;
    return;
  }
  const sampleSize = sampleFlag ?? REVERIFY_DEFAULT_SAMPLE;
  const json = args.includes("--json");

  const packDir = path.resolve(process.cwd(), packArg);
  let judge: ReturnType<typeof buildEvalJudge>;
  try {
    judge = buildJudge(judgeFlag, { skillId: `reverify:${path.basename(packDir)}` });
  } catch (error) {
    console.error(error instanceof JudgeBuildError || error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  let result;
  try {
    result = await reverifyPackSample(packDir, judge, { sampleSize });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(
      `Pack: ${result.packId}  eligible=${result.totalEligible}  sampled=${result.sampleSize}  disagreements=${result.disagreements.length} (${(result.disagreementRate * 100).toFixed(1)}%)`,
    );
    for (const d of result.disagreements) {
      console.log(`  MISMATCH ${d.skillId} ${d.scenarioId}#${d.trialIndex}: recorded=${d.recordedVerdict} live=${d.liveVerdict} (${d.liveReason})`);
    }
    if (result.thresholdExceeded) {
      console.log(`Disagreement rate exceeds the documented threshold (REVERIFY_DISAGREEMENT_THRESHOLD).`);
    }
  }

  process.exitCode = result.thresholdExceeded ? 1 : 0;
}

// ---------------------------------------------------------------------------
// judge-check
// ---------------------------------------------------------------------------

/** Fix 1 / R1-4: the owner default for `judge-check --samples <n>` — the live judge is non-deterministic on identical input (review round 1 caught it flipping verdicts across calls), so a single sample can no longer stand for "this canned answer grades correctly". */
const JUDGE_CHECK_DEFAULT_SAMPLES = 3;

/** One independent judge call's outcome against one canned answer — mirrors `JudgeRecordingSample`, this command's own in-memory shape before it is (optionally) persisted via `--record`. */
interface JudgeCheckSample {
  readonly verdict: "pass" | "fail";
  readonly reason: string;
  /** Set when this sample's verdict was manufactured after a judge parse failure (mirrors `JudgeVerdict.error`) — an error-carrying sample is itself a mismatch (R1-8), never silently treated as a genuine grading. */
  readonly error?: string;
}

interface JudgeCheckRow {
  readonly scenarioId: string;
  readonly kind: AntiGamingKind;
  readonly expect: "pass" | "fail";
  /** `samples.length` independent judge calls against this exact canned answer (n = `--samples`, or 1 for the `empty` kind, which never reaches the judge). Empty when `skipped` is true. */
  readonly samples: readonly JudgeCheckSample[];
  /** True when ANY sample's verdict disagrees with `expect`, or ANY sample carries an `error` (R1-8: an error-carrying verdict is a mismatch even when its face-value verdict happens to equal `expect`). Always false when `skipped`. */
  readonly mismatch: boolean;
  /** True when this canned answer's calibration text is missing (empty) from the scenario — `vague`/`subtle_wrong` may not exist yet on every scenario's `evals.json` while content authoring is in progress. Never counts toward `mismatch`, is never graded, and is never recorded. */
  readonly skipped?: boolean;
}

/**
 * Flow 316, T6: `keryx skills judge-check <skill-id> --judge <provider>[:<model>]`
 * — proves a skill's judge-graded scenarios are hard to game, against the
 * LIVE judge, not a stub. For every scenario carrying a `judge` expectation,
 * runs `antiGamingAnswers(scenario)` through `gradeScenarioAnswer`, the SAME
 * grading function `evalSkill`'s own trial loop uses, so this command can
 * never disagree with a real eval run about what a given canned answer
 * scores. Exits 1 when any canned answer's verdict does not match the
 * `expect` `antiGamingAnswers` itself assigns it (owner decision, plan.md
 * section "Anti-gaming is mandatory").
 *
 * The empty-answer case never reaches the judge at all —
 * `gradeScenarioAnswer`'s own contract short-circuits it to `fail` ("empty
 * answer") without a network call — so it is never written to the recording
 * file: a replay via `recordedJudge` would also never look an empty answer
 * up by digest (its own call never reaches the injected `Judge` function
 * either), so an entry for it would be dead weight in the recording, not
 * something `--record`'s output is missing.
 */
async function judgeCheckCommand(args: readonly string[], deps: SkillsGovernanceDeps = {}): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    printJudgeCheckHelp();
    return;
  }
  const buildJudge = deps.buildJudge ?? buildEvalJudge;
  const skillId = args[0];
  if (skillId === undefined || skillId.startsWith("--")) {
    console.error(
      "Usage: keryx skills judge-check <skill-id> --judge <provider>[:<model>] [--scope bundled|all] [--samples <n>] [--record] [--json]",
    );
    process.exitCode = 1;
    return;
  }

  const judgeFlag = stringFlag(args, "--judge");
  if (judgeFlag === "missing-value") {
    console.error("--judge requires a value");
    process.exitCode = 1;
    return;
  }
  if (judgeFlag === undefined) {
    console.error("--judge is required");
    process.exitCode = 1;
    return;
  }
  const judgeName = judgeFlag;

  const scopeResult = parseScope(args);
  if (!scopeResult.ok) {
    console.error(scopeResult.error);
    process.exitCode = 1;
    return;
  }
  const scope = scopeResult.scope;
  const record = args.includes("--record");
  const json = args.includes("--json");

  const samplesFlag = positiveIntegerFlag(args, "--samples");
  if (samplesFlag === "invalid") {
    console.error("--samples must be a positive integer");
    process.exitCode = 1;
    return;
  }
  const samples = samplesFlag ?? JUDGE_CHECK_DEFAULT_SAMPLES;

  let judge: ReturnType<typeof buildEvalJudge>;
  try {
    judge = buildJudge(judgeName, { skillId });
  } catch (error) {
    console.error(error instanceof JudgeBuildError || error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  const root = process.cwd();
  const { entries: catalog, unreadable } = loadSkillCatalogWithDiagnostics(root, { scope });
  const skill = catalog.find((entry) => entry.id === skillId);
  if (skill === undefined) {
    const unreadableMatch = unreadable.find((entry) => {
      const normalized = entry.path.split(path.sep).join("/");
      return normalized.endsWith(`/${skillId}/SKILL.md`);
    });
    console.error(
      unreadableMatch !== undefined
        ? `skill ${skillId}: SKILL.md is unreadable: ${unreadableMatch.path} (${unreadableMatch.code})`
        : `unknown skill id: ${skillId}`,
    );
    process.exitCode = 1;
    return;
  }

  let spec: EvalSpecFile | undefined;
  try {
    spec = readSkillEvalSpec(skill.path);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  const judgeScenarios = (spec?.scenarios ?? []).filter((scenario) =>
    scenario.expected_behavior.some((expected) => expected.grader === "judge"),
  );
  if (judgeScenarios.length === 0) {
    console.error(`skill ${skillId}: no judge-graded scenarios in evals.json`);
    process.exitCode = 1;
    return;
  }

  const { provider, model } = splitRunnerSpec(judgeName);
  const judgeModel = model ?? defaultModelFor(provider);

  const rows: JudgeCheckRow[] = [];
  const recordingEntries: JudgeRecordingEntry[] = [];
  let anyMismatch = false;

  for (const scenario of judgeScenarios) {
    const judgeExpectation = scenario.expected_behavior.find(
      (expected): expected is JudgeExpectation => expected.grader === "judge",
    );
    if (judgeExpectation === undefined) continue; // unreachable — filtered above; narrows the type for the digest call below.

    for (const answer of antiGamingAnswers(scenario)) {
      // Fix 1 / R1-11: `vague`/`subtle_wrong` are authored per scenario via
      // `calibration.vague`/`calibration.subtle_wrong` — a scenario whose
      // evals.json has not been migrated to carry them yet (content
      // authoring is a separate, parallel task) yields the empty-string
      // fallback `antiGamingAnswers` uses for a missing calibration field.
      // Grading an empty string here would silently collapse into the SAME
      // "empty answer" short-circuit the real `empty` kind already covers,
      // which would prove nothing about THIS kind and must never be
      // recorded as if it were a genuine calibration answer — so it is
      // skipped outright, named as such, rather than graded or recorded.
      const isAuthoredCalibrationKind = answer.kind === "vague" || answer.kind === "subtle-wrong";
      if (isAuthoredCalibrationKind && answer.answer.trim().length === 0) {
        rows.push({ scenarioId: scenario.id, kind: answer.kind, expect: answer.expect, samples: [], mismatch: false, skipped: true });
        continue;
      }

      // The `empty` kind never reaches the judge (`gradeScenarioAnswer`'s
      // own documented short-circuit) and is fully deterministic — sampling
      // it `samples` times would just repeat the same offline "empty
      // answer" fail, so it is graded once regardless of `--samples`.
      const sampleCount = answer.kind === "empty" ? 1 : samples;
      const graded: JudgeCheckSample[] = [];
      for (let i = 0; i < sampleCount; i += 1) {
        const grade = await gradeScenarioAnswer(answer.answer, scenario, judge);
        // `grade.judge` is always set here: every scenario in
        // `judgeScenarios` carries a judge expectation, and
        // `gradeScenarioAnswer` always returns one (either the real judge's
        // verdict, or its own "empty answer" fail) whenever a judge
        // expectation is present.
        const verdict = grade.judge?.verdict ?? "fail";
        const reason = grade.judge?.reason ?? "empty answer";
        graded.push({ verdict, reason, ...(grade.judge?.error !== undefined ? { error: grade.judge.error } : {}) });
      }

      // R1-8: an error-carrying verdict (the judge's reply was unparseable
      // twice) is itself a mismatch, regardless of what its face-value
      // `verdict` happens to be — it was never a genuine grading, and must
      // not be able to accidentally "pass" the anti-gaming proof.
      const mismatch = graded.some((sample) => sample.verdict !== answer.expect || sample.error !== undefined);
      if (mismatch) anyMismatch = true;
      rows.push({ scenarioId: scenario.id, kind: answer.kind, expect: answer.expect, samples: graded, mismatch });

      if (record && answer.kind !== "empty") {
        const digest = judgeRequestDigest({
          scenarioId: scenario.id,
          prompt: scenario.prompt,
          answer: answer.answer,
          expectation: judgeExpectation,
        });
        const recordedSamples: JudgeRecordingSample[] = graded.map((sample) => ({
          verdict: sample.verdict,
          reason: sample.reason,
          ...(sample.error !== undefined ? { error: sample.error } : {}),
        }));
        recordingEntries.push({ scenarioId: scenario.id, kind: answer.kind, requestDigest: digest, samples: recordedSamples });
      }
    }
  }

  if (record) {
    writeJudgeRecording(skillId, {
      judgePromptVersion: JUDGE_PROMPT_VERSION,
      judge: provider,
      judgeModel,
      recordedAt: new Date().toISOString(),
      entries: recordingEntries,
    });
  }

  if (json) {
    console.log(JSON.stringify({ skillId, judge: provider, judgeModel, samples, recorded: record, rows }, null, 2));
  } else {
    console.log(`Skill: ${skillId}  Judge: ${provider}/${judgeModel}  Samples: ${samples}`);
    const header = ["SCENARIO", "KIND", "EXPECT", "GOT", "REASON"];
    const gotFor = (row: JudgeCheckRow): string =>
      row.skipped ? "skipped" : row.samples.map((sample) => (sample.error !== undefined ? `${sample.verdict}!` : sample.verdict)).join(",");
    const reasonFor = (row: JudgeCheckRow): string => {
      if (row.skipped) return "calibration answer missing from evals.json (not yet authored)";
      const worst = row.samples.find((sample) => sample.verdict !== row.expect || sample.error !== undefined) ?? row.samples[0];
      return worst?.reason ?? "";
    };
    const cellsFor = (row: JudgeCheckRow): readonly string[] => [row.scenarioId, row.kind, row.expect, gotFor(row), reasonFor(row)];
    const widths = header.map((title, col) => Math.max(title.length, ...rows.map((row) => cellsFor(row)[col]?.length ?? 0)));
    const printRow = (cells: readonly string[]): void => console.log(cells.map((cell, i) => cell.padEnd(widths[i] as number)).join("  "));
    printRow(header);
    for (const row of rows) {
      printRow(cellsFor(row));
      if (row.mismatch) console.log(`  <-- MISMATCH (${row.scenarioId}/${row.kind})`);
    }
    if (record) {
      console.log(`Recorded ${recordingEntries.length} verdict(s) (${samples} sample(s) each) to ${skillId}'s judge recording.`);
    }
  }

  process.exitCode = anyMismatch ? 1 : 0;
}

// ---------------------------------------------------------------------------
// stocktake
// ---------------------------------------------------------------------------

async function stocktakeCommand(args: readonly string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    printStocktakeHelp();
    return;
  }
  const scopeResult = parseScope(args);
  if (!scopeResult.ok) {
    console.error(scopeResult.error);
    process.exitCode = 1;
    return;
  }
  const scope = scopeResult.scope;
  const quick = args.includes("--quick");
  const json = args.includes("--json");
  const root = process.cwd();

  const report = runStocktake(root, { scope, quick });

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const counts: Record<string, number> = {};
  for (const entry of report.entries) {
    counts[entry.verdict] = (counts[entry.verdict] ?? 0) + 1;
  }
  console.log(`Stocktake (${report.scope}${quick ? ", quick" : ""}): ${report.entries.length} skill(s)`);
  for (const [verdict, count] of Object.entries(counts).sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`  ${verdict}: ${count}`);
  }
  console.log(`Cache: ${report.cache.hits} hit(s), ${report.cache.misses} miss(es)`);
  // R4-2 (flow 309 review round 4): `report.unreadable` (R3-4) used to be
  // JSON-only — a project skill with an unreadable SKILL.md silently
  // disappeared from the human stocktake output with no indication anything
  // was skipped. Named here the same way `--json` already names it.
  if (report.unreadable.length > 0) {
    console.log(`Unreadable: ${report.unreadable.length}`);
    for (const entry of report.unreadable) {
      console.log(`  ${entry.path}: ${entry.code}`);
    }
  }
}
