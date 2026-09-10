import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import { CONTRACTS, type ContractInfo } from "./contracts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Every way a registration's enforcement claim can be untrue, as messages.
 *
 * A list of problems rather than a boolean, and one that names the contract,
 * because "the contracts guard failed" sends the reader to eleven registrations
 * to find out which.
 *
 * `readModule` is injected so the negative cases can be built in memory. A
 * guard whose only test is the real tree passes for as long as the real tree
 * happens to be right, which is not the same as the guard working.
 */
/**
 * Comments removed, so a call that is only mentioned does not read as a call.
 *
 * Deliberately crude — it is a lexer's job done with two regexes, and a
 * `loadSchema("x")` inside a string literal would still count. That is a much
 * narrower hole than the one it closes, and widening this into a parser would
 * put a second, unverified implementation of TypeScript's grammar in a file
 * whose entire subject is unverified claims. What it cannot establish is
 * stated where it is used, not implied by silence.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/**
 * The test that drives each contract's refusal through the path it claims.
 *
 * A registry rather than a convention, so a contract cannot claim enforcement
 * with nothing exercising it. `contract-enforcement-regression.test.ts` covers
 * the schema-level rejections; `review-result-contract.test.ts` spawns the real
 * CLI, which is the only one of the two that would notice the enforcement
 * becoming unreachable.
 */
const LIVE_REFUSAL_TESTS: Record<string, string> = {
  "job-orchestrator-state": "src/gdskills/contract-enforcement-regression.test.ts",
  "review-finding": "src/gdskills/contract-enforcement-regression.test.ts",
  "subagent-result": "src/gdskills/contract-enforcement-regression.test.ts",
  "review-pr-feedback-output": "src/commands/review-result-contract.test.ts",
};

export function enforcementProblems(
  contracts: readonly ContractInfo[],
  readModule: (relPath: string) => string | undefined,
): string[] {
  const problems: string[] = [];

  for (const contract of contracts) {
    const enforcement = contract.enforcement as ContractInfo["enforcement"] | undefined;

    // The discriminant is checked at runtime as well as in the type, because
    // AC4 is about the registration that lands in NEITHER group, and a cast or
    // a JSON-shaped registration can do that while the compiler is satisfied.
    if (enforcement === undefined) {
      problems.push(`${contract.name}: no enforcement declared — it must state production or none`);
      continue;
    }
    const KINDS = ["production", "opt-in", "none"];
    if (!KINDS.includes(enforcement.kind)) {
      problems.push(
        `${contract.name}: enforcement.kind is ${JSON.stringify(
          (enforcement as { kind: unknown }).kind,
        )}, which is none of ${KINDS.join(", ")}`,
      );
      continue;
    }

    if (enforcement.kind === "none") {
      if (enforcement.reason.trim() === "") {
        problems.push(
          `${contract.name}: enforcement none carries no reason — a gap with no stated reason reads as an oversight`,
        );
      }
      continue;
    }

    const { module } = enforcement;
    if (module.includes(".test.")) {
      problems.push(
        `${contract.name}: enforcement names ${module}, a test file. A contract enforced only by its own test is not enforced in production`,
      );
      continue;
    }
    const source = readModule(module);
    if (source === undefined) {
      problems.push(`${contract.name}: enforcement names ${module}, which does not exist`);
      continue;
    }
    // The claim, checked rather than accepted. A module that does not load this
    // schema cannot be refusing anything on its behalf, whatever the
    // registration says — and a registration saying otherwise is the exact
    // defect this contract set exists to stop.
    //
    // Comments are stripped first. Without that, the check is satisfied by a
    // commented-out call, which a review demonstrated by handing this function
    // three fabricated modules — a `//` comment, a docstring example, and a
    // dead branch — and getting zero problems from all three.
    if (!stripComments(source).includes(`loadSchema("${contract.name}")`)) {
      problems.push(
        `${contract.name}: enforcement names ${module}, but that file contains no live loadSchema("${contract.name}") call, so it cannot be refusing anything`,
      );
    }
    if (enforcement.refuses.trim() === "") {
      problems.push(`${contract.name}: enforcement ${enforcement.kind} carries no description of what it refuses`);
    }
    if (enforcement.kind === "opt-in" && enforcement.switchedOnBy.trim() === "") {
      problems.push(
        `${contract.name}: enforcement opt-in does not say what switches it on, which is the whole difference from production`,
      );
    }

    // The second layer, and the one that matters.
    //
    // Stripping comments kills the commented-out call. It does NOT establish
    // that the call runs: the same review inserted `return;` above a live
    // `loadSchema` line, leaving it unreachable, and this guard still passed —
    // only a test that spawned the real CLI caught it. Static reading cannot
    // close that, so it is not asked to. Every contract claiming a refusal must
    // also be named by a test that drives the refusal through the path it
    // claims, and that pairing is checked here rather than left to habit.
    const covering = LIVE_REFUSAL_TESTS[contract.name];
    if (covering === undefined) {
      problems.push(
        `${contract.name}: claims ${enforcement.kind} enforcement but no live-refusal test is registered for it in LIVE_REFUSAL_TESTS — a static loadSchema match cannot tell a reachable call from a dead one`,
      );
    } else if (readModule(covering) === undefined) {
      problems.push(`${contract.name}: its registered live-refusal test ${covering} does not exist`);
    }
  }

  return problems;
}

const readFromTree = (relPath: string): string | undefined => {
  const abs = path.join(ROOT, relPath);
  return existsSync(abs) ? readFileSync(abs, "utf8") : undefined;
};

describe("every registered contract states whether it is enforced, and the statement is true", () => {
  test("the real registry declares an enforcement for each contract, and every claim holds", () => {
    expect(enforcementProblems(CONTRACTS, readFromTree)).toEqual([]);
  });

  // Anti-vacuity. The guard above passes just as well over an empty array, and
  // an empty array is what a broken import gives it.
  test("the guard is looking at a populated registry", () => {
    expect(CONTRACTS.length).toBeGreaterThanOrEqual(11);
    const kinds = new Set(CONTRACTS.map((c) => c.enforcement.kind));
    // All three groups must be non-empty, or the distinction this records is
    // not a distinction. `opt-in` is here because a review found `production`
    // being used for two different guarantees: always-validated, and
    // validated-when-the-caller-passes-a-flag.
    expect([...kinds].sort()).toEqual(["none", "opt-in", "production"]);
  });

  test("a registration in neither group fails, so the next contract cannot join the silent set by omission", () => {
    const fake = [
      { name: "agent-event", fileName: "x.json", description: "d" } as unknown as ContractInfo,
    ];
    const problems = enforcementProblems(fake, readFromTree);
    // On content, not on count: a fake registration now trips the live-test
    // pairing as well, and an assertion on the number of problems would break
    // every time the guard learns to check one more thing.
    expect(problems.join("\n")).toContain("no enforcement declared");
  });

  test("a declared enforcement point that does not load the schema fails", () => {
    const fake = [
      {
        name: "agent-event",
        fileName: "x.json",
        description: "d",
        enforcement: { kind: "production", module: "src/lib/templates.ts", refuses: "nothing, in fact" },
      } as ContractInfo,
    ];
    const problems = enforcementProblems(fake, readFromTree);
    expect(problems.join("\n")).toContain("no live loadSchema");
  });

  test("a call that is only commented out does not count as an enforcement", () => {
    // Found by review: the check was a substring match over raw text, so a
    // module mentioning the call in a comment, a docstring or a dead branch
    // satisfied it. Comments are stripped now; the dead branch is covered by
    // the live-test pairing below rather than pretended away.
    const commented = [
      '// const schema = await loadSchema("agent-event");',
      "/** Example: loadSchema(\"agent-event\") */",
      "export const nothing = 1;",
    ].join("\n");
    const fake = [
      {
        name: "agent-event",
        fileName: "x.json",
        description: "d",
        enforcement: { kind: "production", module: "src/fake.ts", refuses: "r" },
      } as ContractInfo,
    ];

    const problems = enforcementProblems(fake, (p) => (p === "src/fake.ts" ? commented : undefined));
    expect(problems.join("\n")).toContain("no live loadSchema");
  });

  test("a live call in the same module still counts", () => {
    // Anti-vacuity for the stripper: if it ate real code too, the check would
    // reject everything and the test above would pass for the wrong reason.
    const live = 'const schema = await loadSchema("agent-event");';
    const fake = [
      {
        name: "agent-event",
        fileName: "x.json",
        description: "d",
        enforcement: { kind: "production", module: "src/fake.ts", refuses: "r" },
      } as ContractInfo,
    ];

    const problems = enforcementProblems(fake, (p) => (p === "src/fake.ts" ? live : undefined));
    expect(problems.join("\n")).not.toContain("no live loadSchema");
  });

  test("a contract claiming enforcement with no live-refusal test registered fails", () => {
    // The static match cannot tell a reachable call from a dead one — proved
    // when `return;` was inserted above a live loadSchema line and this guard
    // still passed. So a claim must also be paired with a test that drives the
    // refusal through the real path.
    const live = 'const schema = await loadSchema("orchestrator-state");';
    const fake = [
      {
        name: "orchestrator-state",
        fileName: "x.json",
        description: "d",
        enforcement: { kind: "production", module: "src/fake.ts", refuses: "r" },
      } as ContractInfo,
    ];

    const problems = enforcementProblems(fake, (p) => (p === "src/fake.ts" ? live : undefined));
    expect(problems.join("\n")).toContain("no live-refusal test is registered");
  });

  test("a declared enforcement point that does not exist fails", () => {
    const fake = [
      {
        name: "agent-event",
        fileName: "x.json",
        description: "d",
        enforcement: { kind: "production", module: "src/does/not/exist.ts", refuses: "r" },
      } as ContractInfo,
    ];
    expect(enforcementProblems(fake, readFromTree)[0]).toContain("does not exist");
  });

  test("a test file cannot be the enforcement point", () => {
    const fake = [
      {
        name: "agent-event",
        fileName: "x.json",
        description: "d",
        enforcement: {
          kind: "production",
          module: "src/gdskills/contract-enforcement.test.ts",
          refuses: "r",
        },
      } as ContractInfo,
    ];
    expect(enforcementProblems(fake, readFromTree)[0]).toContain("a test file");
  });

  test("an unenforced contract must say why", () => {
    const fake = [
      {
        name: "agent-event",
        fileName: "x.json",
        description: "d",
        enforcement: { kind: "none", reason: "   " },
      } as ContractInfo,
    ];
    expect(enforcementProblems(fake, readFromTree)[0]).toContain("no reason");
  });
});
