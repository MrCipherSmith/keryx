import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/** Synthetic leftovers of a round, written into a package directory: names and paths are invented. */
export const FOLLOW_UP_TEXT = "the sign-in audit log writer was not read, so it is not verified that lastSeen is set for accounts created before the audit log existed";

export function followUpObligation(status: "unresolved" | "narrowed" | "refuted" = "unresolved"): Record<string, unknown> {
  return {
    id: "review-testing-practices:fu1",
    source: "raw/review-testing-practices.txt",
    question: `Is the parent follow-up from review-testing-practices done or ruled out, and where is that recorded? ${FOLLOW_UP_TEXT}`,
    status,
    ...(status === "unresolved" ? {} : { evidence: "docs/audit-log.md", reason: "checked by the parent" }),
    ...(status === "narrowed" ? { remains: "accounts created before 2024 are still unchecked" } : {}),
  };
}

export const HELD_FINDING = {
  id: "F-010",
  reviewer: "review-testing-practices",
  severity: "minor",
  problem: "no test asserts the new Last seen row",
  impact: "a wrong value in the row ships unnoticed",
  suggested_fix: "assert the rendered cell",
  evidence: "mutant:m1 survived",
  confidence: "high",
  severity_audit: { held: { severity: "minor", mutant: "m1", kind: "presentation", evidence: "mutation-1.json#m1", reason: "mutant m1 survived but only changes presentation: severity held" } },
};

const spec = (id: string) => ({ id, file: "src/admin/ExamplePage.tsx", anchor: `<th>${id}</th>`, replacement: "<th></th>" });

export const MUTATION_RECORD = {
  schemaVersion: 1,
  worktree: "scratch",
  command: "bun test",
  baseline: { exitCode: 0, ms: 1 },
  mutants: [{ id: "m1", file: "src/admin/ExamplePage.tsx", anchor: "<th>m1</th>", replacement: "<th></th>", status: "survived", ms: 1, kind: "presentation" }],
  totals: { killed: 0, survived: 1, invalid: 0, timeout: 0 },
  cap: 1,
  not_reached: 2,
};

/** Three proposed mutants, one run under a cap of 1: m2 and m3 stay pending. */
export async function writeMutationLeftovers(packageDir: string): Promise<void> {
  const dir = path.join(packageDir, "research-evidence");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "mutants.json"), JSON.stringify({ mutants: [spec("m1"), spec("m2"), spec("m3")] }), "utf8");
  await writeFile(path.join(dir, "mutation-1.json"), JSON.stringify(MUTATION_RECORD), "utf8");
}
