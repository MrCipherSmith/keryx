// Contract (flow 494, T7): `--ref` is an alias of `--target-ref` for attach/start/ingest. The alias keeps working,
// still wins when both are given, and prints exactly one stderr notice naming `--target-ref`; `--target-ref` prints none.
// The run is stopped right after the ref is read (an invalid --host), so no review package is written.

import { afterEach, describe, expect, test } from "bun:test";
import { reviewCommand } from "./review";

async function stderrOf(args: string[]): Promise<string[]> {
  const errors: string[] = [];
  const logError = console.error;
  console.error = (...parts: unknown[]) => void errors.push(parts.join(" "));
  try {
    await reviewCommand(args);
  } finally {
    console.error = logError;
  }
  return errors;
}

const aliasNotices = (errors: string[]): string[] => errors.filter((line) => line.includes("alias of --target-ref"));

afterEach(() => {
  process.exitCode = 0;
});

describe("review --ref alias notice", () => {
  for (const command of ["attach", "start", "ingest"]) {
    test(`${command} --ref prints exactly one notice naming --target-ref`, async () => {
      const errors = await stderrOf([command, "--target", "branch", "--ref", "x", "--host", "bogus"]);
      expect(aliasNotices(errors)).toHaveLength(1);
    });

    test(`${command} --target-ref prints no alias notice`, async () => {
      const errors = await stderrOf([command, "--target", "branch", "--target-ref", "x", "--host", "bogus"]);
      expect(aliasNotices(errors)).toHaveLength(0);
    });
  }

  test("exit code is the same with either spelling", async () => {
    process.exitCode = 0;
    await stderrOf(["attach", "--target", "branch", "--ref", "x", "--host", "bogus"]);
    const withAlias = process.exitCode;
    process.exitCode = 0;
    await stderrOf(["attach", "--target", "branch", "--target-ref", "x", "--host", "bogus"]);
    expect(withAlias).toBe(process.exitCode);
  });
});
