// The objective gates for an `implement` arm, and the two rules that keep them honest.
//
// **Rule one: a gate is a veto, never a score.** An arm that changed nothing
// passes type-check, lint, tests and build perfectly. Counting gate passes as
// merit would rank doing nothing above an imperfect attempt, so a cell counts as
// implemented only when the gates pass AND the diff is non-empty.
//
// **Rule two: a gate whose baseline is red is measured as a delta, not absolutely.**
// Measured on the untouched target at `441526a25`:
//
//   type-check  `tsc --noEmit`                        PASSES
//   vitest      `vitest run src/pipelines/`           PASSES — 302 suites, 973 tests
//   lint        `oxlint --report-unused-disable-directives`  FAILS, rc=1
//
// The lint failure is five stale `eslint-disable` directives plus "There are
// suppressions that do not occur anymore" from `oxlint-suppressions.json`. None of
// it is the agent's doing, and an absolute lint gate would therefore fail every
// arm in both plateaus identically — a gate that cannot distinguish arms is not a
// gate, it is a constant. So lint is compared against a baseline snapshot and only
// NEW findings fail. That is also the more useful question: did this change make
// the tree worse, not was the tree already imperfect.
//
// Neither of the repository's own lint entry points is usable here, and both
// observations are recorded rather than explained away:
//
//   `pnpm lint`                        fails, ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL,
//                                      "Command \"eslint\" not found"
//   `pnpm exec oxlint --type-aware …`   exits 0 in 193 ms having printed nothing —
//                                      too fast to have linted 266k lines, so this
//                                      is "did not run", not "found nothing"
//
// Plain `oxlint --report-unused-disable-directives` does run: it takes real time
// and reports real findings. That is what the gate uses. Why the other two behave
// this way is not diagnosed here; if the type-aware backend is made to work, the
// same delta comparison applies unchanged to its richer output.

import { spawnSync } from "node:child_process";

export type GateStatus = "pass" | "fail" | "error" | "skipped";

export interface GateResult {
  readonly name: string;
  readonly status: GateStatus;
  readonly ms: number;
  readonly exitCode: number | null;
  /** Tail of combined output, for a human reading a failure. Never the whole thing. */
  readonly output: string;
  /** Findings absent from the baseline. Only meaningful for delta gates. */
  readonly newFindings?: readonly string[];
}

export interface GateSpec {
  readonly name: string;
  readonly command: readonly string[];
  readonly timeoutMs: number;
  /**
   * Compare against a baseline instead of against zero.
   *
   * Set for any gate that does not pass on the untouched tree. The extractor turns
   * raw output into comparable finding lines; anything the baseline already had is
   * not this arm's fault.
   */
  readonly deltaOf?: (output: string) => readonly string[];
}

const OUTPUT_TAIL = 4000;

/** `file:line:col: severity: message`, with the volatile parts kept and the rest dropped. */
export function extractOxlintFindings(output: string): string[] {
  const findings: string[] = [];
  for (const line of output.split("\n")) {
    const match = /^(\S+?:\d+:\d+):\s+(warning|error):\s+(.*)$/.exec(line.trim());
    if (match === null) continue;
    findings.push(`${match[1]} ${match[2]}: ${match[3]}`);
  }
  return findings;
}

/**
 * Findings an arm introduced.
 *
 * Multiset difference, not set difference: three copies of the same warning where
 * the baseline had one is two new findings. A set would call that clean.
 */
export function newFindingsAgainst(baseline: readonly string[], current: readonly string[]): string[] {
  const remaining = new Map<string, number>();
  for (const finding of baseline) remaining.set(finding, (remaining.get(finding) ?? 0) + 1);
  const added: string[] = [];
  for (const finding of current) {
    const left = remaining.get(finding) ?? 0;
    if (left > 0) remaining.set(finding, left - 1);
    else added.push(finding);
  }
  return added;
}

export interface RunGateOptions {
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly baseline?: readonly string[];
}

export function runGate(spec: GateSpec, options: RunGateOptions): GateResult {
  const started = Date.now();
  const [executable, ...args] = spec.command;
  if (executable === undefined) throw new Error(`gate ${spec.name} has an empty command`);

  const proc = spawnSync(executable, args, {
    cwd: options.cwd,
    env: options.env,
    timeout: spec.timeoutMs,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });

  const ms = Date.now() - started;
  const combined = `${proc.stdout ?? ""}${proc.stderr ?? ""}`;
  const output = combined.length > OUTPUT_TAIL ? combined.slice(-OUTPUT_TAIL) : combined;

  // A timeout or a missing executable is neither pass nor fail. Folding it into
  // "fail" would read as "the change broke the build" in the results table.
  if (proc.error !== undefined && proc.error !== null) {
    return { name: spec.name, status: "error", ms, exitCode: proc.status, output: `${proc.error.message}\n${output}` };
  }

  if (spec.deltaOf !== undefined) {
    const added = newFindingsAgainst(options.baseline ?? [], spec.deltaOf(combined));
    return {
      name: spec.name,
      status: added.length === 0 ? "pass" : "fail",
      ms,
      exitCode: proc.status,
      output,
      newFindings: added,
    };
  }

  return { name: spec.name, status: proc.status === 0 ? "pass" : "fail", ms, exitCode: proc.status, output };
}

/**
 * The gates, in the order a human would want them: cheapest signal first.
 *
 * `build` is last and has the largest ceiling because vite needs an 8.4 GB heap on
 * this repository and takes minutes; a type error or a failing test is a cheaper
 * way to learn the same thing.
 */
export function arenaGateSpecs(pnpm: string): GateSpec[] {
  return [
    { name: "type-check", command: [pnpm, "exec", "tsc", "--noEmit"], timeoutMs: 15 * 60_000 },
    {
      name: "lint",
      command: [pnpm, "exec", "oxlint", "--report-unused-disable-directives"],
      timeoutMs: 10 * 60_000,
      deltaOf: extractOxlintFindings,
    },
    { name: "test", command: [pnpm, "exec", "vitest", "run", "src/pipelines/"], timeoutMs: 20 * 60_000 },
    { name: "build", command: [pnpm, "run", "build-fast"], timeoutMs: 30 * 60_000 },
  ];
}

export interface GateVerdict {
  readonly results: readonly GateResult[];
  /** Gates passed AND the arm actually changed something. */
  readonly implemented: boolean;
  readonly reason: string;
}

/**
 * Turn gate results into the one boolean T2 reports — and refuse the empty diff.
 *
 * `changedFiles` is counted over tracked sources only, with `.metaproject/**` and
 * `.claude/**` excluded: a context arm's routing layer writes log and artifact
 * files on every routed command, so counting them would let an arm that touched no
 * source code look like one that did.
 */
export function decideGates(results: readonly GateResult[], changedSourceFiles: number): GateVerdict {
  if (changedSourceFiles === 0) {
    return {
      results,
      implemented: false,
      reason: "no source file changed — an empty diff passes every gate, which is why gates cannot be a score",
    };
  }
  const broken = results.filter((result) => result.status === "fail");
  const errored = results.filter((result) => result.status === "error");
  if (errored.length > 0) {
    return {
      results,
      implemented: false,
      reason: `gate could not run: ${errored.map((result) => result.name).join(", ")} — neither pass nor fail`,
    };
  }
  if (broken.length > 0) {
    return { results, implemented: false, reason: `gates failed: ${broken.map((r) => r.name).join(", ")}` };
  }
  return { results, implemented: true, reason: `all gates passed over ${changedSourceFiles} changed source file(s)` };
}
