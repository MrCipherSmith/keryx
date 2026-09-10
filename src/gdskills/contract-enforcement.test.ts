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
    if (enforcement.kind !== "production" && enforcement.kind !== "none") {
      problems.push(
        `${contract.name}: enforcement.kind is ${JSON.stringify(
          (enforcement as { kind: unknown }).kind,
        )}, which is neither "production" nor "none"`,
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
    if (!source.includes(`loadSchema("${contract.name}")`)) {
      problems.push(
        `${contract.name}: enforcement names ${module}, but that file contains no loadSchema("${contract.name}") call, so it cannot be refusing anything`,
      );
    }
    if (enforcement.refuses.trim() === "") {
      problems.push(`${contract.name}: enforcement production carries no description of what it refuses`);
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
    // Both groups must be non-empty, or the split this records is not a split.
    expect([...kinds].sort()).toEqual(["none", "production"]);
  });

  test("a registration in neither group fails, so the next contract cannot join the silent set by omission", () => {
    const fake = [
      { name: "agent-event", fileName: "x.json", description: "d" } as unknown as ContractInfo,
    ];
    const problems = enforcementProblems(fake, readFromTree);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("no enforcement declared");
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
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("no loadSchema");
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
