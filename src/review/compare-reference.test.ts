import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { compareReference, loadPackageEvidence, parseReferenceReport, renderComparison } from "./compare-reference";

const REPORT = `# Review report — PR #1

### Major

| # | Where | Finding | Suggested fix |
|---|---|---|---|
| M1 | \`cart.test.ts:40-48\`; store \`cart.ts:55\` (\`effectiveId\`) | **Params are unpinned.** Mutating \`cart.ts:55\` keeps all tests green (testing-practices probe, mutant A survives). | Assert the params. |

### Cycle

**C1. Real widget vs CI timeout.** Chain of two fixes that conflict at \`widget.test.tsx:150\`.

<details open><summary><b>Minor (3)</b></summary>

- **m1. Dead branch.** \`view.tsx:226-232\` derives the tab in render; the last operand is unreachable. (ARCH-1, BOSS-004)
- **m2. Naming.** \`modal.tsx:40\` local \`hasExplorer\` shadows the store computed. (R-FE-02)
- **m3. Barrel import.** \`tabs.tsx:8\` reaches the store eagerly. (PERF-004)

</details>

<details open><summary><b>Questions (non-blocking)</b></summary>

- **Q1. Old runs.** Results without columns lose the button. Intended?

</details>

<details open><summary><b>Pre-existing (not blocking)</b></summary>

- **m99. Not an item.** \`other.ts:1\`

</details>
`;

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "keryx-compare-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writePackage(options: { mutation?: boolean } = {}): Promise<string> {
  const pkg = path.join(dir, "pkg");
  await mkdir(path.join(pkg, "research-evidence"), { recursive: true });
  await writeFile(
    path.join(pkg, "findings.json"),
    JSON.stringify([
      { id: "r:F1", severity: "major", problem: "dead tab branch", evidence: "view.tsx:230 derives the tab in render", file: "src/view.tsx", line: 230 },
      { id: "r:F2", severity: "minor", problem: "unpinned", evidence: "cart.test.ts:44 asserts nothing about params; cart.ts:55", file: "src/cart.test.ts", line: 44 },
    ]),
  );
  await writeFile(
    path.join(pkg, "research.json"),
    JSON.stringify({
      dispatch: { mode: "all", selected: ["review-architecture", "review-logic"], runs: [{ reviewer: "review-logic", status: "complete" }] },
      obligations: [
        { id: "o1", source: "raw/review-logic.txt", question: "Is the widget.test.tsx:148 timeout real?", status: "refuted", evidence: "widget.test.tsx:150 passes", reason: "not reproduced" },
      ],
    }),
  );
  if (options.mutation) await writeFile(path.join(pkg, "research-evidence", "mutation-1.json"), "{}");
  return pkg;
}

describe("parseReferenceReport", () => {
  test("reads the major row, the cycle, minors and questions, and stops at pre-existing", () => {
    const items = parseReferenceReport(REPORT);
    expect(items.map((i) => i.id)).toEqual(["M1", "C1", "m1", "m2", "m3", "Q1"]);
    expect(items[0]!.executionDerived).toBe(true);
    expect(items[2]!.roles).toEqual(["review-architecture", "code-boss-reviewer"]);
    expect(items[2]!.locations[0]).toEqual({ file: "view.tsx", line: 226 });
  });
});

describe("compareReference", () => {
  test("classes A to E, each with the reason", async () => {
    const pkg = await writePackage();
    const result = compareReference(parseReferenceReport(REPORT), await loadPackageEvidence(pkg));
    const byId = Object.fromEntries(result.items.map((e) => [e.item.id, e]));
    expect(byId.m1!.class).toBe("D");
    expect(byId.m1!.severity).toBe("major");
    expect(byId.M1!.class).toBe("D");
    expect(byId.C1!.class).toBe("C");
    expect(byId.m2!.class).toBe("A");
    expect(byId.m3!.class).toBe("A");
    expect(byId.Q1!.class).toBe("B");
    expect(result.totals.D).toBe(2);
    expect(result.reproduced).toBe(2);
  });

  test("an execution-derived item with no match is E until a mutation pass exists", async () => {
    const pkg = path.join(dir, "bare");
    await mkdir(pkg, { recursive: true });
    await writeFile(path.join(pkg, "findings.json"), "[]");
    const items = parseReferenceReport(REPORT).filter((i) => i.id === "M1");
    expect(compareReference(items, await loadPackageEvidence(pkg)).items[0]!.class).toBe("E");
    await mkdir(path.join(pkg, "research-evidence"), { recursive: true });
    await writeFile(path.join(pkg, "research-evidence", "mutation-1.json"), "{}");
    expect(compareReference(items, await loadPackageEvidence(pkg)).items[0]!.class).toBe("A");
  });

  test("a baseline-failure evidence file is not a mutation pass", async () => {
    const pkg = path.join(dir, "red");
    await mkdir(path.join(pkg, "research-evidence"), { recursive: true });
    await writeFile(path.join(pkg, "findings.json"), "[]");
    await writeFile(path.join(pkg, "research-evidence", "mutation-baseline-1.json"), "{}");
    await writeFile(path.join(pkg, "research-evidence", "mutation-baseline-1.md"), "x");
    const items = parseReferenceReport(REPORT).filter((i) => i.id === "M1");
    expect(compareReference(items, await loadPackageEvidence(pkg)).items[0]!.class).toBe("E");
  });

  test("the rendering prints a row per item and the totals", async () => {
    const pkg = await writePackage({ mutation: true });
    const text = renderComparison(compareReference(parseReferenceReport(REPORT), await loadPackageEvidence(pkg)));
    expect(text).toContain("M1");
    expect(text).toContain("reproduced 2 of 6");
    expect(text).toContain("E execution pass not run 0");
  });
});
