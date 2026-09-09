// The preflight gate (AC7 / AC-M07, metrics-and-validation.md §"M06/M07" ¶3-4).
//
// This is the check that runs *before* a measurement run is allowed to start,
// and it is the only reason it is ever responsible to ask to spend money on one.
// Everything it does is a refusal: it never repairs, never rebuilds, never
// downgrades a problem into a caveat on a published number. A run either starts
// from a state that can carry a measurement, or it does not start.
//
// Three properties are load-bearing, and each is enforced structurally rather
// than by discipline:
//
//  1. **Every check runs, every time.** `runPreflight` evaluates the whole
//     `PREFLIGHT_CHECKS` registry and returns the ids it evaluated in `checks`.
//     There is no short-circuit on the first failure, so a caller sees every
//     independent fault at once and cannot mistake "we stopped looking" for
//     "there was only one thing wrong".
//
//  2. **Every check has been watched firing.** `PREFLIGHT_CODES` is derived from
//     the registry, and the test suite cross-references it against a table of
//     fixtures that must be caught. A check added without a fixture that
//     provokes it fails the suite. Three import guards in this repository passed
//     while pointed at an empty directory; that is the failure mode this
//     arrangement exists to make impossible.
//
//  3. **A block is INCOMPLETE, not zero.** A blocked result carries
//     `incomplete: "preflight-blocked"` and no rate of any kind. The norm is
//     explicit — "Неполная подготовка → INCOMPLETE, не нулевой recall" — and the
//     `RateWithCI` split a sibling lane introduced means a stratum that never
//     ran is structurally unmeasurable rather than a confident 0%.
//
// Note what "unverified" does here. An isolation check that could not run, a
// reachability scan that examined no files, an operator-memory check with
// nothing to look for: all three block. "I could not check" is never allowed to
// read the same as "I checked and it was fine", because in a preflight the two
// are indistinguishable from the outside and one of them costs money.

import { isMeasuredRate } from "./benchmark";
import type { CapabilityInclusion, GraphInventory, OperatorMemoryReport, WikiInventory } from "./inventory";
import type { AnswerReachabilityReport } from "./leakage";
import type { IsolationReport } from "./provenance";

export type PreflightCode =
  | "graph-empty"
  | "graph-corrupt"
  | "graph-control-query-failed"
  | "graph-stale"
  | "wiki-coverage-unmeasurable"
  | "capability-inclusion-unrecorded"
  | "manifest-digest-mismatch"
  | "manifest-task-mismatch"
  | "manifest-arm-mismatch"
  | "model-mismatch"
  | "arm-config-mismatch"
  | "answer-reachable"
  | "answer-reachability-unverified"
  | "isolation-violated"
  | "isolation-unverified"
  | "operator-memory-present"
  | "operator-memory-unverified";

export type PreflightBudget = { readonly maxUsd: number | null; readonly maxTokens: number | null };

/** What the protocol says this run is, fixed before any arm executes. */
export type PreflightProtocol = {
  readonly runId: string;
  readonly protocolDigest: string;
  /** The snapshot both arms must be checked out from, and the graph must describe. */
  readonly parentSnapshotCommit: string;
  readonly taskIds: readonly string[];
  readonly arms: readonly string[];
  readonly requestedModel: string;
  readonly toolRoster: readonly string[];
  readonly budget: PreflightBudget;
};

/** What one arm is actually configured to do, as resolved by the runner. */
export type PreflightArmPlan = {
  readonly arm: string;
  /** The model that will actually serve this arm — a fallback here invalidates the run. */
  readonly resolvedModel: string;
  readonly toolRoster: readonly string[];
  readonly budget: PreflightBudget;
};

/** The manifest the results will be written into. */
export type PreflightManifest = {
  readonly protocolDigest: string;
  readonly taskIds: readonly string[];
  readonly arms: readonly string[];
  readonly model: string;
};

export type PreflightEvidence = {
  readonly protocol: PreflightProtocol;
  readonly manifest: PreflightManifest;
  readonly armPlans: readonly PreflightArmPlan[];
  readonly graph: GraphInventory;
  readonly wiki: WikiInventory;
  readonly capabilities: CapabilityInclusion;
  readonly isolation: IsolationReport;
  readonly answerReachability: AnswerReachabilityReport;
  readonly operatorMemory: OperatorMemoryReport;
};

export type PreflightBlock = {
  readonly code: PreflightCode;
  readonly detail: string;
  readonly evidence: readonly string[];
};

export type PreflightResult =
  | { readonly status: "ready"; readonly checks: readonly PreflightCode[]; readonly blocks: readonly PreflightBlock[] }
  | {
      readonly status: "blocked";
      readonly checks: readonly PreflightCode[];
      readonly blocks: readonly PreflightBlock[];
      /**
       * Present only on the blocked branch, so a consumer that renders a number
       * has to acknowledge this field to reach the run at all.
       */
      readonly incomplete: "preflight-blocked";
    };

type PreflightCheck = {
  readonly code: PreflightCode;
  readonly run: (evidence: PreflightEvidence) => PreflightBlock | null;
};

const block = (code: PreflightCode, detail: string, evidence: readonly string[] = []): PreflightBlock => ({
  code,
  detail,
  evidence,
});

export const PREFLIGHT_CHECKS: readonly PreflightCheck[] = [
  // "пустая директория `data/gdgraph` не проходит" — the norm names this case
  // literally. An unbuilt graph today produces an empty answer, not a refusal;
  // this is the line that converts one into the other.
  {
    code: "graph-empty",
    run: ({ graph }) =>
      graph.status === "empty"
        ? block("graph-empty", `the graph at ${graph.dir} has nothing in it to measure against`, graph.problems)
        : null,
  },
  {
    code: "graph-corrupt",
    run: ({ graph }) =>
      graph.status === "corrupt" || graph.status === "unreadable"
        ? block("graph-corrupt", `the graph at ${graph.dir} is ${graph.status}`, graph.problems)
        : null,
  },
  // Presence of artifacts is not evidence that the graph answers. One query
  // whose correct answer is known in advance, checked for shape as well as hits.
  {
    code: "graph-control-query-failed",
    run: ({ graph }) => {
      if (graph.controlQuery === null) {
        return block("graph-control-query-failed", "no control query was run against the graph");
      }
      if (!graph.controlQuery.found || !graph.controlQuery.shapeOk) {
        return block(
          "graph-control-query-failed",
          `the control query for ${graph.controlQuery.probe} did not return a well-shaped answer`,
          graph.controlQuery.problem === null ? [] : [graph.controlQuery.problem],
        );
      }
      return null;
    },
  },
  // Build revision and freshness. A graph describing a different commit than the
  // one both arms are checked out at is measuring a repository nobody is running.
  {
    code: "graph-stale",
    run: ({ graph, protocol }) => {
      if (graph.builtAt === null) return block("graph-stale", "the graph build cannot be dated");
      if (graph.buildCommit === null) return block("graph-stale", "the graph carries no build revision");
      if (graph.buildCommit !== protocol.parentSnapshotCommit) {
        return block(
          "graph-stale",
          `the graph was built at ${graph.buildCommit}, not the parent snapshot ${protocol.parentSnapshotCommit}`,
        );
      }
      return null;
    },
  },
  // INCOMPLETE, not zero: a wiki with no sections cannot yield 0% coverage.
  {
    code: "wiki-coverage-unmeasurable",
    run: ({ wiki }) =>
      isMeasuredRate(wiki.sectionCoverage)
        ? null
        : block(
            "wiki-coverage-unmeasurable",
            "wiki retrievable-section coverage has no denominator: the wiki inventory is INCOMPLETE, not 0%",
            wiki.problems,
          ),
  },
  // "SAC/orient включение фиксируется, не выводится из числа файлов."
  {
    code: "capability-inclusion-unrecorded",
    run: ({ capabilities }) => {
      const unrecorded = (["sac", "orient"] as const).filter((key) => capabilities[key] === "unrecorded");
      return unrecorded.length === 0
        ? null
        : block(
            "capability-inclusion-unrecorded",
            `capability inclusion was never recorded for: ${unrecorded.join(", ")}`,
          );
    },
  },
  {
    code: "manifest-digest-mismatch",
    run: ({ manifest, protocol }) =>
      manifest.protocolDigest === protocol.protocolDigest
        ? null
        : block(
            "manifest-digest-mismatch",
            `the manifest was built for protocol ${manifest.protocolDigest}, this run is ${protocol.protocolDigest}`,
          ),
  },
  {
    code: "manifest-task-mismatch",
    run: ({ manifest, protocol }) => {
      const diff = setDifference(manifest.taskIds, protocol.taskIds);
      return diff === null
        ? null
        : block("manifest-task-mismatch", `manifest tasks do not match the protocol: ${diff}`);
    },
  },
  // Arm identity has two halves: the manifest's declared arms, and whether a plan
  // exists for exactly the protocol's arms and no others.
  {
    code: "manifest-arm-mismatch",
    run: ({ manifest, protocol, armPlans }) => {
      const manifestDiff = setDifference(manifest.arms, protocol.arms);
      if (manifestDiff !== null) {
        return block("manifest-arm-mismatch", `manifest arms do not match the protocol: ${manifestDiff}`);
      }
      const planDiff = setDifference(
        armPlans.map((plan) => plan.arm),
        protocol.arms,
      );
      if (planDiff !== null) {
        return block("manifest-arm-mismatch", `arm plans do not match the protocol arms: ${planDiff}`);
      }
      return null;
    },
  },
  // "Requested и resolved model должны совпадать с protocol либо run invalid."
  // A silent provider fallback is the exact failure this catches.
  {
    code: "model-mismatch",
    run: ({ protocol, manifest, armPlans }) => {
      if (manifest.model !== protocol.requestedModel) {
        return block(
          "model-mismatch",
          `the manifest records model ${manifest.model}, the protocol requested ${protocol.requestedModel}`,
        );
      }
      const drifted = armPlans.filter((plan) => plan.resolvedModel !== protocol.requestedModel);
      return drifted.length === 0
        ? null
        : block(
            "model-mismatch",
            `resolved model differs from the requested ${protocol.requestedModel}`,
            drifted.map((plan) => `${plan.arm} resolves to ${plan.resolvedModel}`),
          );
    },
  },
  // "одинаковые tool roster/model/budget/config" — an asymmetry here means the
  // arms differ by something other than the component under study, so whatever
  // the run measures, it is not the component.
  {
    code: "arm-config-mismatch",
    run: ({ protocol, armPlans }) => {
      const problems: string[] = [];
      for (const plan of armPlans) {
        if (!sameSet(plan.toolRoster, protocol.toolRoster)) {
          problems.push(`${plan.arm} tool roster: [${[...plan.toolRoster].sort().join(", ")}]`);
        }
        if (!sameBudget(plan.budget, protocol.budget)) {
          problems.push(`${plan.arm} budget: ${describeBudget(plan.budget)}`);
        }
      }
      return problems.length === 0
        ? null
        : block("arm-config-mismatch", "arms are not configured identically", [
            `protocol roster: [${[...protocol.toolRoster].sort().join(", ")}]`,
            `protocol budget: ${describeBudget(protocol.budget)}`,
            ...problems,
          ]);
    },
  },
  // The clause that decides whether this is a measurement at all: a benchmark
  // whose answer is already present in what the system under test can see is
  // refused here, before it runs — never discounted afterwards.
  {
    code: "answer-reachable",
    run: ({ answerReachability }) =>
      answerReachability.status === "reachable"
        ? block(
            "answer-reachable",
            "the answer is already reachable from inside the run: this would not be a measurement",
            answerReachability.reachable.map((hit) => `${hit.kind}: ${hit.where}${hit.needle === null ? "" : ` (${hit.needle})`}`),
          )
        : null,
  },
  {
    code: "answer-reachability-unverified",
    run: ({ answerReachability }) =>
      answerReachability.status === "unverified"
        ? block(
            "answer-reachability-unverified",
            `the reachability scan did not establish anything (${answerReachability.scannedFiles} files examined)`,
            answerReachability.problems,
          )
        : null,
  },
  {
    code: "isolation-violated",
    run: ({ isolation }) =>
      isolation.status === "violated"
        ? block("isolation-violated", "the run environment is not isolated from the answer", isolation.problems)
        : null,
  },
  {
    code: "isolation-unverified",
    run: ({ isolation }) =>
      isolation.status === "unverified"
        ? block("isolation-unverified", "isolation could not be established", isolation.problems)
        : null,
  },
  // "отсутствие памяти оператора" — notes left behind measure the notes.
  {
    code: "operator-memory-present",
    run: ({ operatorMemory }) =>
      operatorMemory.status === "present"
        ? block("operator-memory-present", "operator memory is reachable from the run root", operatorMemory.paths)
        : null,
  },
  {
    code: "operator-memory-unverified",
    run: ({ operatorMemory }) =>
      operatorMemory.status === "unverified"
        ? block("operator-memory-unverified", "the operator-memory check had nothing to look for, so it cleared nothing")
        : null,
  },
];

/** Every refusal this gate can emit, derived from the registry rather than restated. */
export const PREFLIGHT_CODES: readonly PreflightCode[] = PREFLIGHT_CHECKS.map((check) => check.code);

/**
 * Evaluate every check against the prepared state. `ready` means all of them
 * passed; anything else is a refusal carrying each independent fault.
 */
export function runPreflight(evidence: PreflightEvidence): PreflightResult {
  const checks: PreflightCode[] = [];
  const blocks: PreflightBlock[] = [];
  for (const check of PREFLIGHT_CHECKS) {
    checks.push(check.code);
    const failure = check.run(evidence);
    if (failure) blocks.push(failure);
  }
  if (blocks.length === 0) return { status: "ready", checks, blocks: [] };
  return { status: "blocked", checks, blocks, incomplete: "preflight-blocked" };
}

/** Render a one-line, quotable explanation of why a run may not start. */
export function explainPreflight(result: PreflightResult): string {
  if (result.status === "ready") return `preflight ready: ${result.checks.length} checks passed`;
  return `preflight blocked (INCOMPLETE): ${result.blocks.map((entry) => `${entry.code} — ${entry.detail}`).join("; ")}`;
}

// ---------------------------------------------------------------------------

function setDifference(actual: readonly string[], expected: readonly string[]): string | null {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const extra = [...actualSet].filter((value) => !expectedSet.has(value)).sort();
  const missing = [...expectedSet].filter((value) => !actualSet.has(value)).sort();
  if (extra.length === 0 && missing.length === 0) return null;
  const parts: string[] = [];
  if (extra.length > 0) parts.push(`unexpected [${extra.join(", ")}]`);
  if (missing.length > 0) parts.push(`missing [${missing.join(", ")}]`);
  return parts.join(", ");
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return setDifference(a, b) === null;
}

function sameBudget(a: PreflightBudget, b: PreflightBudget): boolean {
  return a.maxUsd === b.maxUsd && a.maxTokens === b.maxTokens;
}

function describeBudget(budget: PreflightBudget): string {
  return `usd=${budget.maxUsd ?? "unset"} tokens=${budget.maxTokens ?? "unset"}`;
}
