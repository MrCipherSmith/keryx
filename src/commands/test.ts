import {
  analyzeTestingProject,
  computeTestingContext,
  loadTestingConfig,
  loadTestingContext,
  loadTestingReport,
  relatedTestsInContext,
  runTesting,
  testingDataRoot,
} from "../testing/service";
import { buildCoverageMap, coverageMapPath, loadCoverageMap } from "../testing/coverage-map";
import { isTestingCapabilityEnabled } from "../testing/capability";
import { optionValue } from "../lib/args";

export async function testCommand(args: string[]): Promise<void> {
  const command = args[0];
  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "init" || command === "analyze") {
    await runAnalyze();
    return;
  }
  if (command === "run") {
    await runRun(args.slice(1));
    return;
  }
  if (command === "status") {
    await runStatus();
    return;
  }
  if (command === "context") {
    await runContext();
    return;
  }
  if (command === "report") {
    await runReport(args.slice(1));
    return;
  }
  if (command === "related") {
    await runRelated(args.slice(1));
    return;
  }
  if (command === "explain") {
    await runExplain(args.slice(1));
    return;
  }
  if (command === "coverage-map") {
    await runCoverageMap(args.slice(1));
    return;
  }
  if (command === "suggest") {
    await runSuggest(args.slice(1));
    return;
  }

  console.error(`Unknown test command: ${command}`);
  printHelp();
  process.exitCode = 1;
}

async function runSuggest(args: string[]): Promise<void> {
  const target = args.find((arg) => !arg.startsWith("--"));
  if (!target) {
    console.error("Usage: keryx test suggest <file> [--provider <p>] [--model <m>] [--json]");
    process.exitCode = 1;
    return;
  }

  const cwd = process.cwd();
  // Flow 234 T21 (finding 2, second-order issue): this used to run
  // `analyzeTestingProject` and `findRelatedTests` concurrently - each doing its
  // own full tree walk and (pre-fix) its own write to the same three snapshot
  // files. `suggest` only asks a question ("what tests exist / relate to this
  // file"), so compute the context once, read-only, and share it.
  const context = await computeTestingContext(cwd);
  const related = await relatedTestsInContext(cwd, context, target);
  const { readFile } = await import("node:fs/promises");
  const { resolveContainedPath, resolveProjectRoot } = await import("../lib/contained-path");
  // Contain before opening. This file's contents are sent to a model provider,
  // so an uncontained path does not just read something local — it ships it off
  // the machine.
  const contained = await resolveContainedPath(resolveProjectRoot(cwd), target);
  if (!contained.ok) {
    console.error(contained.message);
    process.exitCode = 1;
    return;
  }
  let source: string;
  try {
    source = await readFile(contained.path, "utf8");
  } catch {
    console.error(`Cannot read ${target}.`);
    process.exitCode = 1;
    return;
  }

  const { narrate } = await import("../lib/narrate");
  await narrate({
    args,
    requestId: `test-suggest:${target}`,
    maxOutputTokens: 1200,
    system:
      "You are a test engineer. Propose a concise, prioritized test plan (unit + edge cases) " +
      "for the given source file, matching the project's existing test frameworks and " +
      "conventions. List concrete cases as a bullet list; do not write full test code unless " +
      "a case needs a short illustrative snippet.",
    user: [
      `Frameworks: ${context.frameworks.join(", ") || "unknown"}`,
      // F-016 (flow 234 T27, major): `context.status`/`incompleteReasons` were
      // computed above and then discarded before the prompt was built - a
      // testing-context refresh that could not fully walk the tree (e.g. a
      // permission-denied subdirectory) must not silently read as "these are
      // all the related tests there are", the same way `keryx test related`
      // and `keryx test explain` now surface it (see runRelated/runExplain).
      `Testing context: ${context.status}${
        context.status === "incomplete"
          ? ` (incomplete - could not fully walk the tree: ${context.incompleteReasons.join("; ")})`
          : ""
      }`,
      `Existing related tests: ${related.length > 0 ? related.join(", ") : "none"}`,
      "",
      `Source file: ${target}`,
      "```",
      source.slice(0, 8000),
      "```",
    ].join("\n"),
  });
}

async function runAnalyze(): Promise<void> {
  const context = await analyzeTestingProject(process.cwd());
  console.log("# testing analyze");
  console.log("");
  console.log(`status: ${context.status}`);
  if (context.status === "incomplete") {
    for (const reason of context.incompleteReasons) {
      console.log(`  - ${reason}`);
    }
  }
  console.log(`frameworks: ${context.frameworks.join(", ") || "none"}`);
  console.log(`scripts: ${context.scripts.length}`);
  console.log(`configs: ${context.configs.length}`);
  console.log(`test files: ${context.testFiles.length}`);
  console.log(`recommendations: ${context.recommendations.length}`);
  console.log("");
  console.log(`context: ${testingDataRoot(process.cwd())}/context.md`);
  console.log(`json: ${testingDataRoot(process.cwd())}/context.json`);
}

async function runRun(args: string[]): Promise<void> {
  const runId = optionValue(args, "--run-id");
  const result = await runTesting({
    cwd: process.cwd(),
    changed: args.includes("--changed"),
    since: optionValue(args, "--since") ?? null,
    scope: optionValue(args, "--scope") ?? null,
    kind: optionValue(args, "--kind") ?? null,
    strict: args.includes("--strict") || args.includes("--gate"),
    ...(runId ? { runId } : {}),
  });
  console.log(`# Test Report: ${result.report.status.toUpperCase()}`);
  console.log("");
  console.log(`scope: ${result.report.scope}`);
  console.log(`runner: ${result.report.runner ?? "n/a"}`);
  console.log(`command: ${result.report.command ?? "n/a"}`);
  console.log(`passed: ${result.report.counts.passed}`);
  console.log(`failed: ${result.report.counts.failed}`);
  console.log(`selected tests: ${result.report.selection.selectedTests.length}`);
  // Flow 234 T21 (finding 1, AC2 blocker): the testing-context refresh can be
  // `incomplete` (part of the tree could not be walked) even when the executed
  // tests passed - that must be visible here, not just in the JSON/markdown
  // artifacts a caller may never open.
  console.log(`context: ${result.report.context.status}`);
  if (result.report.context.status === "incomplete") {
    for (const reason of result.report.context.incompleteReasons) {
      console.log(`  - ${reason}`);
    }
  }
  console.log("");
  console.log(`report: ${result.markdownPath}`);
  console.log(`json: ${result.jsonPath}`);
  if (result.securityWarnings && result.securityWarnings.length > 0) {
    console.log("");
    console.log("Security:");
    for (const warning of result.securityWarnings) {
      console.log(`- ${warning}`);
    }
  }
  process.exitCode = result.report.status === "fail" || result.report.status === "error" ? 1 : 0;
}

async function runStatus(): Promise<void> {
  const context = await loadTestingContext(process.cwd());
  const report = await loadTestingReport(process.cwd());
  console.log("# testing status");
  console.log("");
  console.log(`enabled: ${context ? "yes" : "no"}`);
  console.log(`frameworks: ${context?.frameworks.join(", ") || "none"}`);
  console.log(`test files: ${context?.testFiles.length ?? 0}`);
  console.log(`latest run: ${report?.generatedAt ?? "never"}`);
  console.log(`latest status: ${report?.status ?? "n/a"}`);
  // F-017 (flow 234 T27, minor): `report.status` alone can read as a clean
  // pass while `report.context` (the same report, same file on disk) says the
  // testing-context refresh that run used was `incomplete` - `keryx test
  // report latest` already renders that (see runReport above); this surface
  // must not give the opposite impression of the same report.
  if (report?.context) {
    console.log(`latest run context: ${report.context.status}`);
    if (report.context.status === "incomplete") {
      for (const reason of report.context.incompleteReasons) {
        console.log(`  - ${reason}`);
      }
    }
  }
  // Flow 237 T6 defect 3 (AFC-28/AC-28, "a different checkout or consumer
  // sees changed grounds before it acts"): `latest status: pass` above said
  // nothing about whether the tree that produced it is still the tree on
  // disk. A report from yesterday and a report from a second ago printed
  // identically. Name both ways the grounds can have moved since: the commit
  // changed (gitRef mismatch) and/or the working tree picked up uncommitted
  // changes since the run — neither is visible from `report.status` alone.
  if (report) {
    console.log(`report freshness: ${await describeReportFreshness(process.cwd(), report.gitRef)}`);
  }
}

// Reused by `runStatus` above and mirrors the `stale`/`gitRef` computation
// `runCoverageMap`'s "status" branch already does for the coverage map
// artifact (same file, see below) — a report whose commit could not be
// confirmed OR whose working tree has moved since is "unknown-not-passed",
// never silently read as still current.
async function describeReportFreshness(cwd: string, reportGitRef: string | null): Promise<string> {
  const currentRef = await gitRefOf(cwd);
  const dirty = await isWorkingTreeDirty(cwd);
  // Two kinds of reason, kept apart: `moved` is a CONFIRMED change since the
  // report, `undetermined` is a check that could not run. Collapsing them
  // would either overclaim ("stale" for something never established) or —
  // the defect this replaces — underclaim.
  const moved: string[] = [];
  const undetermined: string[] = [];
  if (!reportGitRef) {
    undetermined.push("report gitRef is unknown (recorded without git)");
  } else if (!currentRef) {
    undetermined.push("current gitRef is unknown (not a git repository, or git is unavailable)");
  } else if (reportGitRef !== currentRef) {
    moved.push(`gitRef changed since this report (report ${reportGitRef}, now ${currentRef})`);
  }
  // Flow 237 T11 (F3). `isWorkingTreeDirty` deliberately answers `null` for
  // "the check could not run" — and the test for it was `if (dirty)`, so
  // `null` was falsy, contributed no reason at all, and this function returned
  // "current (gitRef matches, working tree clean)". Reproduced with a
  // genuinely corrupt `.git/index`: `git rev-parse HEAD` still succeeds (so
  // the ref matches) while `git status` exits 128, and the surface asserted a
  // clean working tree it had just failed to look at. `null` is now its own
  // branch, which is the whole point of returning a tri-state.
  if (dirty === null) {
    undetermined.push(
      "working tree state could not be determined (`git status` failed: git unavailable, not a git repository, or a broken repository) — this is NOT evidence the tree is clean",
    );
  } else if (dirty) {
    moved.push("working tree has uncommitted changes since this report was generated");
  }
  if (moved.length > 0) {
    return `stale — ${[...moved, ...undetermined].join("; ")}`;
  }
  if (undetermined.length > 0) {
    return `unknown — could not confirm this report still matches the tree: ${undetermined.join("; ")}`;
  }
  return "current (gitRef matches, working tree clean)";
}

async function isWorkingTreeDirty(cwd: string): Promise<boolean | null> {
  if (!Bun.which("git")) {
    return null;
  }
  const proc = Bun.spawn(["git", "status", "--porcelain=v1"], { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) {
    return null;
  }
  // The testing report's own bookkeeping (`.metaproject/data/testing/**` —
  // context.json/md, artifacts/, history/, logs/) is written by the very run
  // this freshness check is about, so it always shows up freshly
  // modified/untracked right after that run. That is normal report residue,
  // not evidence the SOURCE tree moved — the same exclusion
  // `gdgraph/staleness.ts` makes for its own `.metaproject/` bookkeeping, for
  // the same reason. (Paths here are relative to the project root, which is
  // assumed to be the git root, matching every other git call in this file —
  // a project root below the git root, as `gdgraph/staleness.ts` handles via
  // `--show-prefix`, is not handled here.)
  const lines = out
    .split("\n")
    .filter((line) => line.length >= 3 && !line.slice(3).startsWith(".metaproject/"));
  return lines.length > 0;
}

async function runContext(): Promise<void> {
  const context = await loadTestingContext(process.cwd());
  if (!context) {
    console.log("No testing context yet. Run `keryx test analyze`.");
    return;
  }
  console.log("# testing context");
  console.log("");
  console.log(`generatedAt: ${context.generatedAt}`);
  // The same class the rest of this file was repaired for: a context that could
  // not walk the whole tree must not read as a complete one. `test run`,
  // `test related`, `test explain` and `test status` all say so; this surface
  // prints every other field of the same object and used to omit this one.
  console.log(`status: ${context.status}`);
  if (context.status === "incomplete") {
    for (const reason of context.incompleteReasons) {
      console.log(`  - ${reason}`);
    }
  }
  console.log(`frameworks: ${context.frameworks.join(", ") || "none"}`);
  console.log(`scripts: ${context.scripts.map((script) => script.name).join(", ") || "none"}`);
  console.log(`configs: ${context.configs.length}`);
  console.log(`test files: ${context.testFiles.length}`);
  console.log("");
  console.log("## Recommendations");
  for (const recommendation of context.recommendations) {
    console.log(`- ${recommendation}`);
  }
}

async function runReport(args: string[]): Promise<void> {
  if (args[0] && args[0] !== "latest") {
    console.error("Usage: keryx test report latest [--json]");
    process.exitCode = 1;
    return;
  }
  const report = await loadTestingReport(process.cwd());
  if (!report) {
    console.log("No testing report yet. Run `keryx test run`.");
    return;
  }
  if (args.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`# Test Report: ${report.status.toUpperCase()}`);
  console.log("");
  console.log(`scope: ${report.scope}`);
  console.log(`runner: ${report.runner ?? "n/a"}`);
  console.log(`command: ${report.command ?? "n/a"}`);
  console.log(`failures: ${report.failures.length}`);
  // `report.context` may be absent on a report persisted before flow 234 T21 -
  // guard defensively rather than assume every report on disk already has it.
  if (report.context) {
    console.log(`context: ${report.context.status}`);
    if (report.context.status === "incomplete") {
      for (const reason of report.context.incompleteReasons) {
        console.log(`  - ${reason}`);
      }
    }
  }
}

async function runRelated(args: string[]): Promise<void> {
  const target = args[0];
  if (!target) {
    console.error("Usage: keryx test related <file>");
    process.exitCode = 1;
    return;
  }
  // F-003 (flow 234 review, MAJOR) / AC2: compute the context once (read-only,
  // no write) and share it with the relatedness lookup — the same pair
  // `findRelatedTests` itself calls internally — so the context's incomplete
  // status/reasons are available to print here, the same way `keryx test run`
  // already surfaces `report.context` (see runRun above).
  const context = await computeTestingContext(process.cwd());
  const related = await relatedTestsInContext(process.cwd(), context, target);
  console.log(`# related tests: ${target}`);
  console.log("");
  console.log(`context: ${context.status}`);
  if (context.status === "incomplete") {
    for (const reason of context.incompleteReasons) {
      console.log(`  - ${reason}`);
    }
  }
  console.log("");
  if (related.length === 0) {
    console.log("- none");
    return;
  }
  for (const file of related) {
    console.log(`- ${file}`);
  }
}

async function runExplain(args: string[]): Promise<void> {
  const target = args[0];
  if (!target) {
    console.error("Usage: keryx test explain <file-or-scope>");
    process.exitCode = 1;
    return;
  }
  // Flow 234 T27 (F-016): mirror `test related` (runRelated) - compute the
  // context once (read-only) and share it with the relatedness lookup, so the
  // context's incomplete status/reasons are visible here too instead of being
  // silently discarded inside `findRelatedTests`, the same way `keryx test
  // related` already surfaces it (see runRelated above).
  const context = await computeTestingContext(process.cwd());
  const report = await loadTestingReport(process.cwd());
  const related = await relatedTestsInContext(process.cwd(), context, target);
  console.log(`# testing explain: ${target}`);
  console.log("");
  console.log(`frameworks: ${context.frameworks.join(", ") || "none"}`);
  console.log(`context: ${context.status}`);
  if (context.status === "incomplete") {
    for (const reason of context.incompleteReasons) {
      console.log(`  - ${reason}`);
    }
  }
  console.log(`related tests: ${related.length}`);
  for (const file of related) {
    console.log(`- ${file}`);
  }
  console.log("");
  console.log("## Latest Failures");
  const failures = report?.failures.filter((failure) =>
    [failure.file, failure.name, failure.message].filter(Boolean).some((value) => String(value).includes(target)),
  ) ?? [];
  if (failures.length === 0) {
    console.log("- none");
    return;
  }
  for (const failure of failures) {
    console.log(`- [${failure.priority}] ${failure.message}${failure.file ? ` (${failure.file})` : ""}`);
  }
}

async function runCoverageMap(args: string[]): Promise<void> {
  const sub = args[0];
  const cwd = process.cwd();
  const config = await loadTestingConfig(cwd);

  if (sub === "build") {
    // AFC-09 (flow 234, AC2): same staleness class as ensureContext/findRelatedTests
    // in src/testing/service.ts - a cached context.json can predate a test
    // add/rename/delete or a checkout change, so re-analyze rather than trust it.
    const context = await analyzeTestingProject(cwd);
    const gitRef = await gitRefOf(cwd);
    const result = await buildCoverageMap(cwd, config, { testFiles: context.testFiles, gitRef });
    console.log("# testing coverage-map build");
    console.log("");
    console.log(`source: ${config.coverageMap.source}`);
    // A map built from a partially-walked tree is smaller than the truth and
    // looks exactly like a small project. Same class as above.
    console.log(`context: ${context.status}`);
    if (context.status === "incomplete") {
      for (const reason of context.incompleteReasons) {
        console.log(`  - ${reason}`);
      }
    }
    console.log(`entries: ${Object.keys(result.map.map).length}`);
    console.log(`artifact: ${coverageMapPath(cwd, config)}`);
    for (const warning of result.securityWarnings) {
      console.log(`security: ${warning}`);
    }
    return;
  }

  if (sub === "status" || !sub) {
    const map = await loadCoverageMap(cwd, config);
    const enabled = await isTestingCapabilityEnabled(cwd, "coverageMap");
    const currentRef = await resolveGitRef(cwd);
    console.log("# testing coverage-map status");
    console.log("");
    console.log(`capability: ${enabled ? "enabled" : "disabled"}`);
    console.log(`config.enabled: ${config.coverageMap.enabled}`);
    console.log(`map present: ${map ? "yes" : "no"}`);
    if (map) {
      console.log(`entries: ${Object.keys(map.map).length}`);
      console.log(`generatedAt: ${map.generatedAt}`);
      console.log(`gitRef: ${map.gitRef ?? "n/a"}`);
      console.log(`stale: ${describeCoverageMapStaleness(map.gitRef, currentRef)}`);
    }
    return;
  }

  console.error("Usage: keryx test coverage-map build|status");
  process.exitCode = 1;
}

/**
 * What git can say about the current short ref — with "it answered" kept apart
 * from "it could not answer".
 *
 * V237-01 (flow 237 T13): `gitRefOf` below answers `null` for BOTH "there is no
 * repository here" and "git ran and refused", and the coverage-map staleness
 * line read that `null` through `map.gitRef && currentRef && ...`, so a
 * genuinely stale map flipped to `stale: no` the moment git broke. Measured on
 * one map and one repository:
 *
 *   matching ref            → stale: no
 *   HEAD genuinely moved    → stale: yes (falls back to static selection)
 *   same map, .git removed  → stale: no        ← the defect
 *
 * That is the same falsy-`null` collapse `describeReportFreshness` (one
 * function above) already had fixed for the report, in the very computation its
 * comment says it mirrors. A comparison that cannot be made is `unknown`; it is
 * never evidence the two sides agree.
 */
type GitRefResolution =
  | { kind: "resolved"; ref: string }
  | { kind: "unavailable"; detail: string };

async function resolveGitRef(cwd: string): Promise<GitRefResolution> {
  if (!Bun.which("git")) {
    return { kind: "unavailable", detail: "git is not on PATH" };
  }
  const proc = Bun.spawn(["git", "rev-parse", "--short", "HEAD"], { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const ref = out.trim();
  if (code !== 0 || ref.length === 0) {
    const first = err.trim().split("\n")[0] ?? "";
    return {
      kind: "unavailable",
      detail: first || `\`git rev-parse --short HEAD\` exited ${code}`,
    };
  }
  return { kind: "resolved", ref };
}

/**
 * The `stale:` line for `keryx test coverage-map status`. Three answers, never
 * two: a map whose ref cannot be compared is `unknown`, and the line says so
 * rather than printing the same "no" a confirmed match prints.
 */
export function describeCoverageMapStaleness(
  mapGitRef: string | null,
  current: GitRefResolution,
): string {
  if (!mapGitRef) {
    return "unknown (this map was built without a gitRef, so it cannot be compared to the current checkout) — this is NOT evidence the map is current";
  }
  if (current.kind !== "resolved") {
    return `unknown (the current gitRef could not be determined: ${current.detail}) — this is NOT evidence the map is current`;
  }
  return mapGitRef === current.ref ? "no" : "yes (falls back to static selection)";
}

/** The discarding wrapper, for the two callers that already treat `null` as
 * "undetermined" in their own output (`describeReportFreshness`) or as "record
 * no ref" (`coverage-map build`). Anything that COMPARES refs must use
 * `resolveGitRef` and branch on `kind` — see V237-01 above. */
async function gitRefOf(cwd: string): Promise<string | null> {
  const result = await resolveGitRef(cwd);
  return result.kind === "resolved" ? result.ref : null;
}

function printHelp(): void {
  console.log(`keryx test

Usage:
  keryx test init
  keryx test analyze
  keryx test run [--changed] [--strict] [--since <ref>] [--scope <path>] [--kind unit|integration|e2e|smoke] [--run-id <id>]
  keryx test status
  keryx test context
  keryx test explain <file-or-scope>
  keryx test related <file>
  keryx test report latest [--json]
  keryx test suggest <file> [--provider <p>] [--model <m>] [--json]
  keryx test coverage-map build
  keryx test coverage-map status
`);
}
