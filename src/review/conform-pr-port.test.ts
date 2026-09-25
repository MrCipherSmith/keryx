// Flow 308, AC3: the conform-specific PR read port — live `gh` adapter (no
// logic beyond parsing) and fixture adapter, same live/fixture split
// `src/review/ci-port.ts` established for CI triage.

import { describe, expect, test } from "bun:test";
import { createFixtureConformPrPort, createGhConformPrPort } from "./conform-pr-port";

describe("createGhConformPrPort", () => {
  test("calls gh pr view then gh pr diff, and parses the result", async () => {
    const calls: string[][] = [];
    const spawn = async (argv: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
      calls.push(argv);
      if (argv.includes("view")) {
        return { stdout: JSON.stringify({ title: "Invented PR title", body: "Invented body" }), stderr: "", exitCode: 0 };
      }
      return { stdout: "diff --git a/x b/x\n", stderr: "", exitCode: 0 };
    };
    const port = createGhConformPrPort(spawn, "owner/repo");
    const info = await port.pr(42);
    expect(info).toEqual({ number: 42, title: "Invented PR title", body: "Invented body", diff: "diff --git a/x b/x\n" });
    expect(calls[0]).toEqual(["gh", "pr", "view", "42", "--repo", "owner/repo", "--json", "title,body"]);
    expect(calls[1]).toEqual(["gh", "pr", "diff", "42", "--repo", "owner/repo"]);
  });

  test("a non-zero exit from gh pr view is a named error, no fallback", async () => {
    const spawn = async (): Promise<{ stdout: string; stderr: string; exitCode: number }> => ({
      stdout: "",
      stderr: "not found",
      exitCode: 1,
    });
    const port = createGhConformPrPort(spawn);
    await expect(port.pr(1)).rejects.toThrow(/gh pr view 1/);
  });
});

describe("createFixtureConformPrPort", () => {
  test("answers from the fixture, and records the call", async () => {
    const port = createFixtureConformPrPort({ pr: { number: 7, title: "t", body: "b", diff: "d" } });
    const info = await port.pr(7);
    expect(info).toEqual({ number: 7, title: "t", body: "b", diff: "d" });
    expect(port.calls).toEqual([{ op: "pr", number: 7 }]);
  });

  test("no fixture PR is a named error, never a silent empty result", async () => {
    const port = createFixtureConformPrPort({});
    await expect(port.pr(7)).rejects.toThrow(/no fixture PR/);
  });
});
