// Flow 308, AC3: the conform-specific PR read port — live `gh` adapter (no
// logic beyond parsing) and fixture adapter, same live/fixture split
// `src/review/ci-port.ts` established for CI triage.

import { describe, expect, test } from "bun:test";
import {
  ConformSpawnKilledError,
  CONFORM_SPAWN_MAX_BUFFER_BYTES,
  CONFORM_SPAWN_TIMEOUT_MS,
  createFixtureConformPrPort,
  createGhConformPrPort,
  defaultConformSpawn,
} from "./conform-pr-port";
import type { BunSpawnFn } from "./conform-pr-port";

function textStream(text: string): ReadableStream<Uint8Array> {
  return new Response(text).body as ReadableStream<Uint8Array>;
}

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

describe("defaultConformSpawn: native timeout/killSignal/maxBuffer, injected spawn for tests", () => {
  test("passes the 30s timeout, SIGKILL, and 8MB cap to the injected spawn, and returns normally on a clean exit", async () => {
    let seenOptions: unknown;
    const fakeSpawn: BunSpawnFn = (_argv, options) => {
      seenOptions = options;
      return {
        stdout: textStream("hello"),
        stderr: textStream(""),
        exited: Promise.resolve(0),
        signalCode: null,
      };
    };
    const result = await defaultConformSpawn(["gh", "pr", "view", "1"], fakeSpawn);
    expect(result).toEqual({ stdout: "hello", stderr: "", exitCode: 0 });
    expect(seenOptions).toMatchObject({
      timeout: CONFORM_SPAWN_TIMEOUT_MS,
      killSignal: "SIGKILL",
      maxBuffer: CONFORM_SPAWN_MAX_BUFFER_BYTES,
    });
    expect(CONFORM_SPAWN_TIMEOUT_MS).toBe(30_000);
    expect(CONFORM_SPAWN_MAX_BUFFER_BYTES).toBe(8 * 1024 * 1024);
  });

  test("a process Bun killed (timeout or over the output cap) throws a named, clear error — never a silent empty result", async () => {
    const fakeSpawn: BunSpawnFn = () => ({
      stdout: textStream("partial output before the kill"),
      stderr: textStream(""),
      exited: Promise.resolve(137),
      signalCode: "SIGKILL",
    });
    const promise = defaultConformSpawn(["gh", "pr", "diff", "999"], fakeSpawn);
    await expect(promise).rejects.toThrow(ConformSpawnKilledError);
    await expect(promise).rejects.toThrow(/killed \(signal SIGKILL\)/);
    await expect(promise).rejects.toThrow(/gh pr diff 999/);
  });

  test("the real Bun.spawn is used when no spawnImpl is injected (production default)", async () => {
    const result = await defaultConformSpawn([process.execPath, "-e", "process.stdout.write('ok')"]);
    expect(result.stdout).toBe("ok");
    expect(result.exitCode).toBe(0);
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
