// RED tests for the `keryx harness run` CLI (flow 020, T5 / AC4).
//
// Pins `harnessCommand` (`src/commands/harness.ts`, registered in
// `src/cli.ts` by T6): `keryx harness run --provider <fake|anthropic|ollama>
// --model <m> [--base-url <url>] "<prompt>"` assembles `runOffline` with real
// deps and the selected provider, printing the normalized events / final text
// / completion / evidence. See `.metaproject/flows/020-2026-07-13-keryx-
// harness-ollama-cli/{context.md,acceptance-criteria.md}` (AC4) for the
// frozen scope.
//
// `src/commands/harness.ts` does NOT exist yet (T6 implements it to make this
// suite GREEN); until then the missing-module import is the expected RED
// failure for the WHOLE file (every test below fails identically at import
// time — this is NOT a per-test bug).
//
// PINNED API (T6 implements exactly this surface — see subagent-result):
//   export interface HarnessCommandDeps {
//     fetch?: typeof fetch;
//     clock?: () => string;
//     idSeq?: () => string;
//     env?: Record<string, string | undefined>;
//   }
//   export async function harnessCommand(args: string[], deps?: HarnessCommandDeps): Promise<void>;
// `deps` is OPTIONAL (a real CLI invocation supplies none and falls back to
// `globalThis.fetch` / wall-clock / `process.env`); every test below supplies
// an explicit `deps` so the run stays OFFLINE and deterministic. The command's
// LAST `console.log` call prints a single JSON-stringified structured result
// with `events` (array) / `text` (string) / `completion` (object) / `evidence`
// (array) — the "fake" path never reaches the network, so a matching-fixture
// failure surfaces as a structured (non-throwing) result, never an uncaught
// exception.
//
// OFFLINE / DETERMINISTIC: `fetch` is always injected via `deps.fetch`; no
// test touches `globalThis.fetch` except to prove it is left untouched. No
// `Date.now()` / `Math.random()` in this file (a fixed `clock`/`idSeq` is
// injected for the "fake" path).
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "bun:test";
// PINNED API (RED: module does not exist until T6).
import type { HarnessCommandDeps } from "./harness";
import { harnessCommand, parseArgs } from "./harness";

/** Records call count and always throws — proves a code path never reaches the network. */
function makeThrowingFetch(): { fetch: typeof fetch; callCount: () => number } {
  let calls = 0;
  const fn = async (): Promise<Response> => {
    calls += 1;
    throw new Error("network must not be reached by this test path");
  };
  return { fetch: fn as unknown as typeof fetch, callCount: () => calls };
}

/** Patches `console.log` to capture every call's stringified arguments. */
function captureConsoleLog(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const original = console.log;
  // biome-ignore lint: intentional console capture for assertions in this test only.
  console.log = (...values: unknown[]) => {
    logs.push(values.map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join(" "));
  };
  return { logs, restore: () => { console.log = original; } };
}

/** Parse the LAST captured console.log line as JSON (the pinned structured-result contract). */
function lastJson(logs: string[]): Record<string, unknown> {
  for (let i = logs.length - 1; i >= 0; i--) {
    const line = logs[i];
    if (line === undefined) continue;
    try {
      return JSON.parse(line) as Record<string, unknown>;
    } catch {
      // Not this line; keep scanning backwards.
    }
  }
  throw new Error(`no JSON-parseable console.log line found among: ${JSON.stringify(logs)}`);
}

let counter = 0;
function fixedDeps(overrides?: Partial<HarnessCommandDeps>): HarnessCommandDeps {
  counter = 0;
  return {
    clock: () => "2026-01-01T00:00:00.000Z",
    idSeq: () => `id-${counter++}`,
    ...overrides,
  };
}

describe("AC4 — keryx harness run --provider fake runs fully offline and prints a structured result", () => {
  test("assembles runOffline and prints events/text/completion/evidence; fetch is NEVER invoked", async () => {
    const { fetch: fetchMock, callCount } = makeThrowingFetch();
    const { logs, restore } = captureConsoleLog();

    try {
      await harnessCommand(
        ["run", "--provider", "fake", "--model", "fixture-model", "hello there"],
        fixedDeps({ fetch: fetchMock, env: {} }),
      );
    } finally {
      restore();
    }

    expect(callCount()).toBe(0);
    expect(logs.length).toBeGreaterThan(0);

    const result = lastJson(logs);
    expect(Array.isArray(result.events)).toBe(true);
    expect(typeof result.text).toBe("string");
    expect(result.completion).toBeDefined();
    expect(result.completion).not.toBeNull();
    expect(Array.isArray(result.evidence)).toBe(true);
  });

  test("never touches the global fetch on the fake path", async () => {
    const originalFetch = globalThis.fetch;
    let globalFetchCalled = false;
    // biome-ignore lint: intentional structural network-call detector for this test only.
    globalThis.fetch = (() => {
      globalFetchCalled = true;
      throw new Error("harnessCommand must not touch globalThis.fetch on the fake path.");
    }) as unknown as typeof fetch;

    const { fetch: fetchMock } = makeThrowingFetch();
    const { restore } = captureConsoleLog();
    try {
      await harnessCommand(
        ["run", "--provider", "fake", "--model", "fixture-model", "offline check"],
        fixedDeps({ fetch: fetchMock, env: {} }),
      );
    } finally {
      restore();
      globalThis.fetch = originalFetch;
    }

    expect(globalFetchCalled).toBe(false);
  });
});

describe("AC4 — keryx harness run --provider anthropic with no ANTHROPIC_API_KEY fails closed with NO network", () => {
  test("prints a clear fail-closed message mentioning ANTHROPIC_API_KEY; fetch is NEVER invoked", async () => {
    const { fetch: fetchMock, callCount } = makeThrowingFetch();
    const { logs, restore } = captureConsoleLog();

    try {
      await harnessCommand(
        ["run", "--provider", "anthropic", "--model", "claude-3-5-sonnet-20241022", "hello"],
        fixedDeps({ fetch: fetchMock, env: {} }),
      );
    } finally {
      restore();
    }

    expect(callCount()).toBe(0);
    const combined = logs.join("\n").toLowerCase();
    expect(combined.includes("anthropic_api_key")).toBe(true);
    // A clear fail-closed signal: some recognizable failure/refusal wording.
    expect(/fail|refus|denied|missing|require|not set/.test(combined)).toBe(true);
  });
});

describe("AC4 (flow 021, T5) — `keryx harness run` UX fix: empty/missing --provider or prompt prints usage, no run", () => {
  test('"run" with no other args (no --provider, no prompt) prints usage and never runs runOffline', async () => {
    const { fetch: fetchMock, callCount } = makeThrowingFetch();
    const { logs, restore } = captureConsoleLog();

    try {
      await harnessCommand(["run"], fixedDeps({ fetch: fetchMock, env: {} }));
    } finally {
      restore();
    }

    expect(callCount()).toBe(0);
    const combined = logs.join("\n");
    expect(combined).toContain("Usage: keryx harness run");
    // Must NOT have fallen through to a structured (blocked/failed) run result.
    expect(/"status"\s*:\s*"(blocked|failed)"/.test(combined)).toBe(false);
  });

  test('"run" with an empty --provider prints usage and never runs runOffline', async () => {
    const { fetch: fetchMock, callCount } = makeThrowingFetch();
    const { logs, restore } = captureConsoleLog();

    try {
      await harnessCommand(
        ["run", "--provider", "", "--model", "fixture-model", "hello there"],
        fixedDeps({ fetch: fetchMock, env: {} }),
      );
    } finally {
      restore();
    }

    expect(callCount()).toBe(0);
    const combined = logs.join("\n");
    expect(combined).toContain("Usage: keryx harness run");
    expect(/"status"\s*:\s*"(blocked|failed)"/.test(combined)).toBe(false);
  });

  test('"run" with an empty prompt prints usage and never runs runOffline', async () => {
    const { fetch: fetchMock, callCount } = makeThrowingFetch();
    const { logs, restore } = captureConsoleLog();

    try {
      await harnessCommand(
        ["run", "--provider", "fake", "--model", "fixture-model"],
        fixedDeps({ fetch: fetchMock, env: {} }),
      );
    } finally {
      restore();
    }

    expect(callCount()).toBe(0);
    const combined = logs.join("\n");
    expect(combined).toContain("Usage: keryx harness run");
    expect(/"status"\s*:\s*"(blocked|failed)"/.test(combined)).toBe(false);
  });
});

describe("SLATE-8 — keryx harness run --unattended flag parses correctly", () => {
  // Direct `parseArgs` assertions (review finding: the end-to-end tests below
  // assert identical CLI output whether or not `--unattended` is passed, so
  // they would still pass unchanged even if the flag were silently dropped —
  // these prove the actual `ParsedArgs.unattended` value).
  test("parseArgs sets unattended: true when --unattended is present", () => {
    const parsed = parseArgs(["run", "--provider", "fake", "--model", "fixture-model", "--unattended", "hello"]);
    expect(parsed.unattended).toBe(true);
  });

  test("parseArgs leaves unattended undefined when --unattended is absent", () => {
    const parsed = parseArgs(["run", "--provider", "fake", "--model", "fixture-model", "hello"]);
    expect(parsed.unattended).toBeUndefined();
  });

  test("--unattended flag parses to true when present", async () => {
    const { fetch: fetchMock, callCount } = makeThrowingFetch();
    const { logs, restore } = captureConsoleLog();

    try {
      await harnessCommand(
        ["run", "--provider", "fake", "--model", "fixture-model", "--unattended", "hello"],
        fixedDeps({ fetch: fetchMock, env: {} }),
      );
    } finally {
      restore();
    }

    expect(callCount()).toBe(0);
    expect(logs.length).toBeGreaterThan(0);
    const result = lastJson(logs);
    expect(Array.isArray(result.events)).toBe(true);
  });

  test("--unattended flag has falsy default when absent", async () => {
    const { fetch: fetchMock, callCount } = makeThrowingFetch();
    const { logs, restore } = captureConsoleLog();

    try {
      await harnessCommand(
        ["run", "--provider", "fake", "--model", "fixture-model", "hello"],
        fixedDeps({ fetch: fetchMock, env: {} }),
      );
    } finally {
      restore();
    }

    expect(callCount()).toBe(0);
    expect(logs.length).toBeGreaterThan(0);
    const result = lastJson(logs);
    expect(Array.isArray(result.events)).toBe(true);
  });
});

describe("SLATE-15 — keryx harness run --goal / --workspace flags (flow 161, T10 — AC1)", () => {
  // PINNED API (T11 implements exactly this surface — see subagent-result):
  //   ParsedArgs gains `goal?: string; workspace?: string;`.
  //   `--goal <text>` becomes the EFFECTIVE `prompt` when given (no positional
  //   args needed) — mechanical parse-and-store, mirroring `--unattended`'s
  //   own SLATE-8 precedent (parsed above at line ~223).
  //   `--workspace <id>` reuses the SAME fail-closed validation `/goal`
  //   itself uses (`resolveWorkspaceForActor`, `src/sac/workspace-service.ts`
  //   — see `workspace-service.test.ts`'s SLATE-15 describe block and
  //   `goal-command.test.ts`): `harnessCommand` calls it BEFORE constructing
  //   the provider/`runOffline` input, and on `!ok` prints a clear rejection
  //   and returns WITHOUT ever calling `runOffline` (proven below via
  //   `callCount()`, mirroring this file's existing "usage guard" tests
  //   above, which detect the analogous never-ran outcome the same way).
  test("parseArgs: --goal <text> becomes the effective prompt, with no positional args needed", () => {
    const parsed = parseArgs(["run", "--provider", "fake", "--model", "fixture-model", "--goal", "do X"]);
    expect(parsed.goal).toBe("do X");
    expect(parsed.prompt).toBe("do X");
  });

  test("parseArgs: --goal is preferred over any positional prompt text when both are given", () => {
    const parsed = parseArgs([
      "run",
      "--provider",
      "fake",
      "--model",
      "fixture-model",
      "--goal",
      "do X",
      "ignored positional text",
    ]);
    expect(parsed.prompt).toBe("do X");
  });

  test("parseArgs: goal is undefined when --goal is absent (existing positional-prompt behavior is unaffected)", () => {
    const parsed = parseArgs(["run", "--provider", "fake", "--model", "fixture-model", "hello there"]);
    expect(parsed.goal).toBeUndefined();
    expect(parsed.prompt).toBe("hello there");
  });

  test("parseArgs: --workspace <id> is captured", () => {
    const parsed = parseArgs([
      "run",
      "--provider",
      "fake",
      "--model",
      "fixture-model",
      "--workspace",
      "workspace-abc",
      "hello",
    ]);
    expect(parsed.workspace).toBe("workspace-abc");
  });

  test("parseArgs: workspace is undefined when --workspace is absent", () => {
    const parsed = parseArgs(["run", "--provider", "fake", "--model", "fixture-model", "hello"]);
    expect(parsed.workspace).toBeUndefined();
  });

  test("review finding: --goal immediately followed by another recognized flag does not swallow that flag as the goal text", () => {
    const parsed = parseArgs([
      "run",
      "--provider",
      "fake",
      "--model",
      "fixture-model",
      "--goal",
      "--unattended",
      "implement X",
    ]);
    // Before the fix: goal === "--unattended", unattended === undefined,
    // prompt === "--unattended" (the real prompt text lost entirely).
    expect(parsed.goal).toBeUndefined();
    expect(parsed.unattended).toBe(true);
    expect(parsed.prompt).toBe("implement X");
  });

  test("review finding: --workspace immediately followed by another recognized flag is treated as dangling (no value), not as swallowing that flag", () => {
    const parsed = parseArgs(["run", "--provider", "fake", "--model", "fixture-model", "--workspace", "--goal", "do X"]);
    expect(parsed.workspace).toBeUndefined();
    expect(parsed.goal).toBe("do X");
  });

  test("harnessCommand: an invalid/invisible --workspace id is rejected fail-closed BEFORE any run — fetch is NEVER invoked, no structured blocked/failed run result is printed", async () => {
    const { fetch: fetchMock, callCount } = makeThrowingFetch();
    const { logs, restore } = captureConsoleLog();

    try {
      await harnessCommand(
        [
          "run",
          "--provider",
          "fake",
          "--model",
          "fixture-model",
          "--workspace",
          "definitely-not-a-real-workspace",
          "--goal",
          "do X",
        ],
        fixedDeps({ fetch: fetchMock, env: {} }),
      );
    } finally {
      restore();
    }

    expect(callCount()).toBe(0);
    const combined = logs.join("\n");
    expect(combined).toContain("definitely-not-a-real-workspace");
    // Never a structured run result (blocked/failed status, or the
    // events/text/completion/evidence shape) — the command refused before
    // constructing any of that, same posture as the existing usage-guard tests.
    expect(/"status"\s*:\s*"(blocked|failed)"/.test(combined)).toBe(false);
    expect(combined).not.toContain('"events"');
  });

  test("review finding: harnessCommand rejects an EXPLICIT empty --workspace \"\" the same way as a dangling --workspace, instead of silently proceeding unscoped", async () => {
    const { fetch: fetchMock, callCount } = makeThrowingFetch();
    const { logs, restore } = captureConsoleLog();

    try {
      await harnessCommand(
        ["run", "--provider", "fake", "--model", "fixture-model", "--workspace", "", "--goal", "do X"],
        fixedDeps({ fetch: fetchMock, env: {} }),
      );
    } finally {
      restore();
    }

    // Never reached resolveWorkspaceForActor/runOffline — refused before any run.
    expect(callCount()).toBe(0);
    expect(logs.join("\n")).toContain("--workspace requires a value");
  });

  test("harnessCommand: a --goal with a VALID/absent --workspace still runs normally (no false-positive rejection)", async () => {
    const { fetch: fetchMock, callCount } = makeThrowingFetch();
    const { logs, restore } = captureConsoleLog();

    try {
      await harnessCommand(
        ["run", "--provider", "fake", "--model", "fixture-model", "--goal", "do X"],
        fixedDeps({ fetch: fetchMock, env: {} }),
      );
    } finally {
      restore();
    }

    expect(callCount()).toBe(0); // "fake" provider path never touches network fetch either way.
    const result = lastJson(logs);
    expect(Array.isArray(result.events)).toBe(true);
  });

  // --- Review finding 4: a value-less trailing --workspace must not silently
  // proceed unscoped ---------------------------------------------------------
  //
  // `parseArgs` never fails (mechanical parse-and-store) — a trailing
  // `--workspace` with nothing after it produces `workspace: undefined`,
  // IDENTICAL to "the flag was never given at all". `harnessCommand` must
  // tell the two apart by checking the raw `args` array, not just the parsed
  // field, or it silently runs unscoped instead of refusing the malformed
  // invocation.

  test("parseArgs: a trailing --workspace with no value leaves workspace undefined — same as absent, so harnessCommand must check the raw args to tell them apart (review finding 4)", () => {
    const parsed = parseArgs(["run", "--provider", "fake", "--model", "fixture-model", "--workspace"]);
    expect(parsed.workspace).toBeUndefined();
  });

  test("harnessCommand: a trailing --workspace with no value is rejected fail-closed, not silently treated as absent — fetch is NEVER invoked, no structured run result is printed (review finding 4)", async () => {
    const { fetch: fetchMock, callCount } = makeThrowingFetch();
    const { logs, restore } = captureConsoleLog();

    try {
      await harnessCommand(
        ["run", "--provider", "fake", "--model", "fixture-model", "--goal", "do X", "--workspace"],
        fixedDeps({ fetch: fetchMock, env: {} }),
      );
    } finally {
      restore();
    }

    expect(callCount()).toBe(0);
    const combined = logs.join("\n");
    expect(combined).toContain("--workspace");
    // Never a structured run result — the command refused before constructing
    // any of that, same posture as the existing usage-guard tests.
    expect(/"status"\s*:\s*"(blocked|failed)"/.test(combined)).toBe(false);
    expect(combined).not.toContain('"events"');
  });
});

describe("AC4 — src/cli.ts registers the harness command (source-text audit)", () => {
  test("the root CLI dispatch mentions the harness command", () => {
    const cliSource = readFileSync(path.join(import.meta.dir, "..", "cli.ts"), "utf8");
    expect(/harness/i.test(cliSource)).toBe(true);
  });
});

describe("D-02 invariant — the harness CLI never writes flow.json (source-text audit)", () => {
  test("src/commands/harness.ts contains no flow.json write reference", () => {
    const source = readFileSync(path.join(import.meta.dir, "harness.ts"), "utf8");
    expect(/flow\.json/i.test(source)).toBe(false);
  });
});

// --- flow 163 AC8: the wrap-up trigger fires at one-shot process
// termination -----------------------------------------------------------
//
// NOT YET IMPLEMENTED (RED until task-implementer's AC8 wiring lands): today
// `harnessCommand`'s `run` branch ends at `console.log(JSON.stringify(structured));`
// (line ~548) with zero slate/wrap-up wiring — Phase 3 only parsed/stored
// `--goal`/`--unattended`/`--workspace` per its own doc comment, deferring
// "harness run -> workspace review pipe" (plan.md's AC8 section, quoting
// harness.ts's own comment).
//
// Per plan.md AC8: "at the end of harnessCommand's run branch (after
// structured is computed, before the function returns — one call site,
// unconditional on whether a slate happens to have content), call the Track
// B composer (`runWrapUp({ trigger: "process-termination", ... })`)". This is
// a source-text audit — the same convention `shell.test.ts` and
// `tui-shell.test.ts` already use for their own wiring proofs (see those
// files' own "source-text audit" describe blocks) — because asserting the
// trigger actually FIRES end-to-end would require driving `runOffline`'s
// whole offline replay path for no additional signal beyond "the call site
// exists and passes the right trigger", which this text-level check already
// proves cheaply and unambiguously.
//
// DEVIATION FROM plan.md (documented per the tests-creator dispatch brief):
// none for the trigger literal — `runWrapUp` is plan.md's own suggested
// composer entry-point name (also the name `src/sac/machine-wrap-up.test.ts`
// pins for Track B), and `trigger: "process-termination"` is plan.md's own
// literal string for this exact call site.
describe("flow 163 AC8 — harnessCommand's run branch triggers wrap-up on process termination (source-text audit)", () => {
  const harnessSource = readFileSync(path.join(import.meta.dir, "harness.ts"), "utf8");
  const runBranchStart = harnessSource.indexOf('if (subcommand !== "run") {');
  // A generous fixed window from the "run" branch start through its end
  // (this file has no other "run" subcommand body) — large enough to reach
  // past the final `console.log(JSON.stringify(structured));` line.
  const runBranch = harnessSource.slice(runBranchStart, runBranchStart + 6000);

  test("the run branch calls the Track B wrap-up composer, runWrapUp(...)", () => {
    // A boolean check on `.includes(...)` (not `expect(runBranch).toContain(...)`)
    // deliberately avoids dumping the whole multi-thousand-char `runBranch`
    // slice into the failure output — this test is expected to be RED until
    // AC8 lands, and a compact "false !== true" failure is far more useful
    // signal than a multi-KB source dump on every RED run.
    expect(runBranch.includes("runWrapUp(")).toBe(true);
  });

  test("the runWrapUp(...) call passes trigger: \"process-termination\"", () => {
    const callIndex = runBranch.indexOf("runWrapUp(");
    expect(callIndex).toBeGreaterThanOrEqual(0);
    const callBlock = runBranch.slice(callIndex, callIndex + 400);
    expect(callBlock.includes('trigger: "process-termination"')).toBe(true);
  });

  test("the wrap-up call site is imported from the Track B module, src/sac/machine-wrap-up", () => {
    expect(/from\s+["'].*machine-wrap-up["']/.test(harnessSource)).toBe(true);
  });
});
