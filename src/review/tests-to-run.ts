// The run list of a review package (flow 457): tests the blast radius reached are run, not read.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../lib/fs";
import type { BlastRadius, TestToRun } from "./blast-radius";
import { VERIFY_EVIDENCE_DIR } from "./verify-run";

export const TESTS_TO_RUN_FILE = "tests-to-run.json";

/**
 * The project's test command, when it can be read off the project: `bun test` for a Bun project (a bun lockfile, or a
 * `test` script that runs `bun test`), `npm test --` for another package with a `test` script. `undefined` otherwise:
 * the run list is then printed as a bare file list.
 */
export function detectTestCommand(projectRoot: string): string | undefined {
  let script: string | undefined;
  try {
    const manifest = JSON.parse(readFileSync(path.join(projectRoot, "package.json"), "utf8")) as { scripts?: Record<string, unknown> };
    script = typeof manifest.scripts?.test === "string" ? manifest.scripts.test : undefined;
  } catch {
    return undefined;
  }
  if (existsSync(path.join(projectRoot, "bun.lock")) || existsSync(path.join(projectRoot, "bun.lockb")) || script?.trim().startsWith("bun test") === true) {
    return "bun test";
  }
  return script === undefined ? undefined : "npm test --";
}

/** `[{file, reason, symbols}]`, one per test, sorted by file. Empty under a radius that keeps tests in the reviewed set. */
export function testsToRunRecord(radius: Pick<BlastRadius, "testsToRun">): Array<Pick<TestToRun, "file" | "reason" | "symbols">> {
  return (radius.testsToRun ?? []).map((test) => ({ file: test.file, reason: test.reason, symbols: test.symbols }));
}

export async function writeTestsToRun(packageDir: string, radius: Pick<BlastRadius, "testsToRun">): Promise<string> {
  const file = path.join(packageDir, TESTS_TO_RUN_FILE);
  await writeFileAtomic(file, `${JSON.stringify(testsToRunRecord(radius), null, 2)}\n`);
  return file;
}

/**
 * A non-blocking warning: `tests-to-run.json` lists tests the blast radius reached, and the package holds no
 * `keryx review verify-run` record, so nothing says any of them ran. Undefined when nothing is listed or a run is recorded.
 */
export function testsNotRunWarning(packageDir: string): string | undefined {
  let listed: number;
  try {
    const parsed = JSON.parse(readFileSync(path.join(packageDir, TESTS_TO_RUN_FILE), "utf8")) as unknown;
    listed = Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return undefined;
  }
  if (listed === 0) return undefined;
  const evidence = path.join(packageDir, VERIFY_EVIDENCE_DIR);
  const ran = existsSync(evidence) && readdirSync(evidence).some((name) => name.startsWith("verify-") && name.endsWith(".txt"));
  return ran ? undefined : `${listed} tests listed to run; none recorded as run`;
}
