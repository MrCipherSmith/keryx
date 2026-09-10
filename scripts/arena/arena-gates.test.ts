import { describe, expect, test } from "bun:test";
import {
  arenaGateSpecs,
  decideGates,
  extractOxlintFindings,
  newFindingsAgainst,
  runGate,
  type GateResult,
} from "./arena-gates";

const BASELINE_OUTPUT = `
src/data/task-service.ts:586:9: warning: Unused eslint-disable directive (no problems were reported).
src/core/media/image-blob-cache.ts:63:5: warning: Unused eslint-disable directive (no problems were reported).
: error: There are suppressions that do not occur anymore. help: Run \`oxlint --prune-suppressions\` to remove unused suppressions.
`;

describe("extractOxlintFindings", () => {
  test("keeps file:line:col findings and drops the rest", () => {
    const findings = extractOxlintFindings(BASELINE_OUTPUT);
    expect(findings).toHaveLength(2);
    expect(findings[0]).toContain("src/data/task-service.ts:586:9");
  });

  test("the un-anchored summary line is not a finding", () => {
    // `: error: There are suppressions that do not occur anymore` has no file and
    // would otherwise compare unequal between runs for no reason.
    expect(extractOxlintFindings(BASELINE_OUTPUT).join("\n")).not.toContain("suppressions that do not occur");
  });

  test("output with nothing in it yields nothing, not a spurious finding", () => {
    expect(extractOxlintFindings("")).toEqual([]);
    expect(extractOxlintFindings("Found 0 warnings.\n")).toEqual([]);
  });
});

describe("newFindingsAgainst", () => {
  test("a tree as bad as the baseline introduces nothing", () => {
    // This is the whole reason the lint gate is a delta: on the untouched target
    // `oxlint` exits 1 with five stale directives. An absolute gate would fail
    // every arm in both plateaus identically, which is a constant, not a gate.
    const baseline = extractOxlintFindings(BASELINE_OUTPUT);
    expect(newFindingsAgainst(baseline, baseline)).toEqual([]);
  });

  test("a finding the baseline did not have is reported", () => {
    const baseline = extractOxlintFindings(BASELINE_OUTPUT);
    const current = [...baseline, "src/pipelines/PipelineFlow.tsx:700:1 error: no-unused-vars"];
    expect(newFindingsAgainst(baseline, current)).toEqual(["src/pipelines/PipelineFlow.tsx:700:1 error: no-unused-vars"]);
  });

  test("counts duplicates, because a set would call three copies of one warning clean", () => {
    expect(newFindingsAgainst(["a"], ["a", "a", "a"])).toEqual(["a", "a"]);
  });

  test("a fixed baseline finding is not credited as new, and not an error either", () => {
    expect(newFindingsAgainst(["a", "b"], ["a"])).toEqual([]);
  });
});

describe("runGate", () => {
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin" };

  test("a passing command is pass", () => {
    const result = runGate({ name: "ok", command: ["true"], timeoutMs: 5000 }, { cwd: process.cwd(), env });
    expect(result.status).toBe("pass");
    expect(result.exitCode).toBe(0);
  });

  test("a non-zero command is fail", () => {
    const result = runGate({ name: "nope", command: ["false"], timeoutMs: 5000 }, { cwd: process.cwd(), env });
    expect(result.status).toBe("fail");
  });

  test("a missing executable is ERROR, not fail", () => {
    // Folding it into "fail" would read as "the change broke the build" in the
    // results table, which is a different claim about the arm.
    const result = runGate(
      { name: "absent", command: ["definitely-not-a-real-binary-xyz"], timeoutMs: 5000 },
      { cwd: process.cwd(), env },
    );
    expect(result.status).toBe("error");
  });

  test("a delta gate passes when it reproduces the baseline exactly", () => {
    const result = runGate(
      {
        name: "lint",
        command: ["printf", "%s\\n", "src/a.ts:1:1: warning: stale"],
        timeoutMs: 5000,
        deltaOf: extractOxlintFindings,
      },
      { cwd: process.cwd(), env, baseline: ["src/a.ts:1:1 warning: stale"] },
    );
    expect(result.status).toBe("pass");
    expect(result.newFindings).toEqual([]);
  });

  test("a delta gate fails on a finding the baseline lacked, even at exit 0", () => {
    const result = runGate(
      {
        name: "lint",
        command: ["printf", "%s\\n", "src/b.ts:2:2: error: new problem"],
        timeoutMs: 5000,
        deltaOf: extractOxlintFindings,
      },
      { cwd: process.cwd(), env, baseline: [] },
    );
    expect(result.status).toBe("fail");
    expect(result.newFindings).toHaveLength(1);
  });
});

describe("decideGates", () => {
  const pass = (name: string): GateResult => ({ name, status: "pass", ms: 1, exitCode: 0, output: "" });
  const fail = (name: string): GateResult => ({ name, status: "fail", ms: 1, exitCode: 1, output: "" });
  const errored = (name: string): GateResult => ({ name, status: "error", ms: 1, exitCode: null, output: "" });

  test("an empty diff is NOT implemented, however green the gates are", () => {
    // The defect this exists to prevent: doing nothing passes type-check, lint,
    // tests and build, and would otherwise outrank an imperfect real attempt.
    const verdict = decideGates([pass("type-check"), pass("lint"), pass("test"), pass("build")], 0);
    expect(verdict.implemented).toBe(false);
    expect(verdict.reason).toContain("empty diff");
  });

  test("all green over a real diff is implemented", () => {
    expect(decideGates([pass("type-check"), pass("test")], 3).implemented).toBe(true);
  });

  test("one failing gate vetoes", () => {
    const verdict = decideGates([pass("type-check"), fail("test")], 3);
    expect(verdict.implemented).toBe(false);
    expect(verdict.reason).toContain("test");
  });

  test("a gate that could not run is reported as such, not as a failure of the change", () => {
    const verdict = decideGates([pass("type-check"), errored("build")], 3);
    expect(verdict.implemented).toBe(false);
    expect(verdict.reason).toContain("could not run");
  });
});

describe("arenaGateSpecs", () => {
  test("lint is the only delta gate, because it is the only one red on baseline", () => {
    const specs = arenaGateSpecs("pnpm");
    const delta = specs.filter((spec) => spec.deltaOf !== undefined).map((spec) => spec.name);
    expect(delta).toEqual(["lint"]);
  });

  test("build gets the largest ceiling — vite needs minutes and an 8.4GB heap here", () => {
    const specs = arenaGateSpecs("pnpm");
    const build = specs.find((spec) => spec.name === "build");
    const typecheck = specs.find((spec) => spec.name === "type-check");
    expect(build?.timeoutMs).toBeGreaterThan(typecheck?.timeoutMs ?? 0);
  });

  test("lint does not go through `pnpm lint` or `--type-aware`, both of which are broken here", () => {
    const lint = arenaGateSpecs("pnpm").find((spec) => spec.name === "lint");
    expect(lint?.command).not.toContain("--type-aware");
    expect(lint?.command).toContain("oxlint");
  });
});
