import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readEditGuardLogRecords } from "../review/jev-edit-guard-log";
import {
  defaultEditGuardFileDiff,
  fixtureEditGuardFetch,
  handleInstall,
  handleStatus,
  handleUninstall,
  runJevEditGuardHook,
  type EditGuardCliDeps,
} from "./review-jev-edit-guard";

let dir: string;
let logLines: string[];
let errorLines: string[];
let originalLog: typeof console.log;
let originalError: typeof console.error;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "keryx-edit-guard-cli-"));
  mkdirSync(path.join(dir, ".metaproject", "rules", "core"), { recursive: true });
  logLines = [];
  errorLines = [];
  originalLog = console.log;
  originalError = console.error;
  console.log = (...args: unknown[]) => {
    logLines.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    errorLines.push(args.map(String).join(" "));
  };
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
  rmSync(dir, { recursive: true, force: true });
});

function writeConfig(content: unknown): void {
  writeFileSync(path.join(dir, ".metaproject", "tasks.config.json"), JSON.stringify(content));
}

function writeRule(): void {
  writeFileSync(
    path.join(dir, ".metaproject", "rules", "core", "no-console.mdc"),
    [
      "# No console logging",
      "",
      "- A function must never call console.log directly in application source.",
    ].join("\n"),
  );
}

const DIFF_WITH_CONSOLE_LOG = [
  "diff --git a/src/example.ts b/src/example.ts",
  "index 1111111..2222222 100644",
  "--- a/src/example.ts",
  "+++ b/src/example.ts",
  "@@ -1,3 +1,4 @@ function foo() {",
  " function foo() {",
  '+  console.log("debug");',
  "   return 1;",
  " }",
].join("\n");

/** A fake `/systemone` fetch: answers every question generically — `noul` questions get `probability`, `choice` (clause-tagging) questions always answer "hunk" (or the first offered criterion when "hunk" is not one). Counts calls so a test can assert how many Jev round trips happened. */
function fakeJevFetch(probability: number, callCount: { count: number }): typeof fetch {
  return (async (_url: string, init: { body?: string }) => {
    callCount.count += 1;
    const body = JSON.parse(init.body ?? "{}") as { questions: Record<string, { type: "noul" | "choice"; criteria?: Record<string, string> }> };
    const answers: Record<string, unknown> = {};
    for (const [key, question] of Object.entries(body.questions)) {
      if (question.type === "noul") {
        answers[key] = { type: "noul", noul: probability };
      } else {
        const criteria = question.criteria ?? {};
        const choice = "hunk" in criteria ? "hunk" : (Object.keys(criteria)[0] ?? "not-checkable");
        answers[key] = { type: "choice", choice };
      }
    }
    return new Response(JSON.stringify({ answers, usage: { cost: 0.0001, input_tokens: 5, output_tokens: 1 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

/** Like a real `fetch` against a server that never answers: the returned promise only ever settles when the request's own `AbortSignal` fires — exactly what `attemptJevRequest` (`jev-client.ts`) depends on to turn an external abort into a `JevTimeoutError`. */
function neverReturningFetch(): typeof fetch {
  return ((_url: string, init?: { signal?: AbortSignal }) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
    })) as unknown as typeof fetch;
}

const FAKE_ENV = { OPENROUTER_API_KEY: "sk-or-test-fake-not-a-real-key" };

function deps(overrides: Partial<EditGuardCliDeps>): EditGuardCliDeps {
  return {
    env: FAKE_ENV,
    diffFn: async () => DIFF_WITH_CONSOLE_LOG,
    stdin: (async function* () {
      yield JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: "src/example.ts" }, session_id: "s1", cwd: dir });
    })(),
    ...overrides,
  };
}

describe("runJevEditGuardHook: flagged -> feedback, silent otherwise", () => {
  test("a violation above threshold prints hookSpecificOutput.additionalContext", async () => {
    writeConfig({ review: { jev: { edit_guard: true, edit_guard_threshold: 0.5 } } });
    writeRule();
    const calls = { count: 0 };
    await runJevEditGuardHook(dir, deps({ fetchFn: fakeJevFetch(0.9, calls) }));
    expect(process.exitCode === 0 || process.exitCode === undefined).toBe(true);
    expect(logLines).toHaveLength(1);
    const output = JSON.parse(logLines[0]!) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    expect(output.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(output.hookSpecificOutput.additionalContext).toContain("Rule check flagged:");
    expect(output.hookSpecificOutput.additionalContext).toContain("src/example.ts");
    expect(output.hookSpecificOutput.additionalContext).toContain("fix it if it is a real violation.");
    expect(calls.count).toBeGreaterThan(0);

    const records = await readEditGuardLogRecords(dir);
    expect(records).toHaveLength(1);
    expect(records[0]!.status).toBe("flagged");
    expect(records[0]!.flags.length).toBeGreaterThan(0);
  });

  test("no violation above threshold -> silent (no stdout at all)", async () => {
    writeConfig({ review: { jev: { edit_guard: true, edit_guard_threshold: 0.5 } } });
    writeRule();
    const calls = { count: 0 };
    await runJevEditGuardHook(dir, deps({ fetchFn: fakeJevFetch(0.1, calls) }));
    expect(logLines).toHaveLength(0);
    const records = await readEditGuardLogRecords(dir);
    expect(records).toHaveLength(1);
    expect(records[0]!.status).toBe("clean");
  });

  test("threshold is respected: the same probability flags at 0.5 but not at 0.95", async () => {
    writeRule();
    const calls1 = { count: 0 };
    writeConfig({ review: { jev: { edit_guard: true, edit_guard_threshold: 0.5 } } });
    await runJevEditGuardHook(dir, deps({ fetchFn: fakeJevFetch(0.8, calls1) }));
    expect(logLines).toHaveLength(1);

    logLines = [];
    rmSync(path.join(dir, ".metaproject", "data"), { recursive: true, force: true });
    const calls2 = { count: 0 };
    writeConfig({ review: { jev: { edit_guard: true, edit_guard_threshold: 0.95 } } });
    await runJevEditGuardHook(dir, deps({ fetchFn: fakeJevFetch(0.8, calls2) }));
    expect(logLines).toHaveLength(0);
  });
});

describe("runJevEditGuardHook: fails open, always exits clean", () => {
  test("disabled (no tasks.config.json) -> silent, no network call at all", async () => {
    let fetchCalled = false;
    await runJevEditGuardHook(
      dir,
      deps({
        fetchFn: (async () => {
          fetchCalled = true;
          return new Response("{}", { status: 200 });
        }) as unknown as typeof fetch,
      }),
    );
    expect(logLines).toHaveLength(0);
    expect(fetchCalled).toBe(false);
    const records = await readEditGuardLogRecords(dir);
    expect(records[0]!.status).toBe("skipped");
  });

  test("missing credential (env option, never the real machine key) -> silent, no network call", async () => {
    writeConfig({ review: { jev: { edit_guard: true } } });
    let fetchCalled = false;
    await runJevEditGuardHook(
      dir,
      deps({
        env: {},
        fetchFn: (async () => {
          fetchCalled = true;
          return new Response("{}", { status: 200 });
        }) as unknown as typeof fetch,
      }),
    );
    expect(logLines).toHaveLength(0);
    expect(fetchCalled).toBe(false);
    const records = await readEditGuardLogRecords(dir);
    expect(records[0]!.status).toBe("skipped");
    expect(records[0]!.reason).toContain("credential");
  });

  test("a Jev error (e.g. a rejected credential) fails open: silent, exit stays 0, logged as error", async () => {
    writeConfig({ review: { jev: { edit_guard: true } } });
    writeRule();
    await runJevEditGuardHook(
      dir,
      deps({
        fetchFn: (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch,
      }),
    );
    expect(logLines).toHaveLength(0);
    expect(process.exitCode === 0 || process.exitCode === undefined).toBe(true);
    const records = await readEditGuardLogRecords(dir);
    expect(records.at(-1)!.status).toBe("error");
  });

  test("the hard wall-clock timeout fails open: silent, logged as timeout", async () => {
    writeConfig({ review: { jev: { edit_guard: true } } });
    writeRule();
    await runJevEditGuardHook(dir, deps({ fetchFn: neverReturningFetch(), timeoutMs: 50 }));
    expect(logLines).toHaveLength(0);
    expect(process.exitCode === 0 || process.exitCode === undefined).toBe(true);
    const records = await readEditGuardLogRecords(dir);
    expect(records.at(-1)!.status).toBe("timeout");
  }, 2_000);

  test("an unsupported tool_name is skipped without ever reading tool_input", async () => {
    writeConfig({ review: { jev: { edit_guard: true } } });
    let fetchCalled = false;
    await runJevEditGuardHook(
      dir,
      deps({
        stdin: (async function* () {
          yield JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "rm -rf /" } });
        })(),
        fetchFn: (async () => {
          fetchCalled = true;
          return new Response("{}", { status: 200 });
        }) as unknown as typeof fetch,
      }),
    );
    expect(logLines).toHaveLength(0);
    expect(fetchCalled).toBe(false);
  });

  test("malformed stdin JSON fails open: silent, logged as error", async () => {
    writeConfig({ review: { jev: { edit_guard: true } } });
    await runJevEditGuardHook(
      dir,
      deps({
        stdin: (async function* () {
          yield "{not json";
        })(),
      }),
    );
    expect(logLines).toHaveLength(0);
    const records = await readEditGuardLogRecords(dir);
    expect(records.at(-1)!.status).toBe("error");
  });

  test("no changed region against HEAD -> silent, logged as clean, no network call", async () => {
    writeConfig({ review: { jev: { edit_guard: true } } });
    let fetchCalled = false;
    await runJevEditGuardHook(
      dir,
      deps({
        diffFn: async () => "",
        fetchFn: (async () => {
          fetchCalled = true;
          return new Response("{}", { status: 200 });
        }) as unknown as typeof fetch,
      }),
    );
    expect(logLines).toHaveLength(0);
    expect(fetchCalled).toBe(false);
    const records = await readEditGuardLogRecords(dir);
    expect(records.at(-1)!.status).toBe("clean");
  });
});

describe("defaultEditGuardFileDiff: real git, no network", () => {
  test("diffs a tracked file's uncommitted change against HEAD", async () => {
    const proc1 = Bun.spawn(["git", "init", "-q"], { cwd: dir });
    await proc1.exited;
    const proc2 = Bun.spawn(["git", "-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "init"], { cwd: dir });
    await proc2.exited;
    writeFileSync(path.join(dir, "tracked.txt"), "one\ntwo\n");
    const proc3 = Bun.spawn(["git", "add", "tracked.txt"], { cwd: dir });
    await proc3.exited;
    const proc4 = Bun.spawn(["git", "-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "-q", "-m", "add tracked"], { cwd: dir });
    await proc4.exited;
    writeFileSync(path.join(dir, "tracked.txt"), "one\ntwo\nthree\n");
    const diff = await defaultEditGuardFileDiff(dir, "tracked.txt", 3);
    expect(diff).toContain("+three");
  });

  test("a brand-new untracked file falls back to a whole-file diff", async () => {
    const proc1 = Bun.spawn(["git", "init", "-q"], { cwd: dir });
    await proc1.exited;
    writeFileSync(path.join(dir, "brand-new.txt"), "hello\n");
    const diff = await defaultEditGuardFileDiff(dir, "brand-new.txt", 3);
    expect(diff).toContain("+hello");
  });
});

describe("install / uninstall: merge-safe, idempotent, no network", () => {
  function settingsFile(): string {
    return path.join(dir, ".claude", "settings.json");
  }

  test("install writes the PostToolUse hook, preserving unrelated settings", async () => {
    mkdirSync(path.join(dir, ".claude"), { recursive: true });
    writeFileSync(settingsFile(), JSON.stringify({ someUserSetting: true, hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] }] } }));
    await handleInstall(dir);
    const settings = JSON.parse(readFileSync(settingsFile(), "utf8"));
    expect(settings.someUserSetting).toBe(true);
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.hooks.PostToolUse).toHaveLength(1);
    expect(settings.hooks.PostToolUse[0].matcher).toBe("Edit|Write|MultiEdit");
    expect(settings.hooks.PostToolUse[0].hooks[0].command).toBe("keryx review jev-edit-guard --hook claude");
  });

  test("install is idempotent: running it twice writes exactly one PostToolUse group", async () => {
    await handleInstall(dir);
    await handleInstall(dir);
    const settings = JSON.parse(readFileSync(settingsFile(), "utf8"));
    expect(settings.hooks.PostToolUse).toHaveLength(1);
  });

  test("uninstall removes only the edit-guard group, keeping other hooks", async () => {
    mkdirSync(path.join(dir, ".claude"), { recursive: true });
    writeFileSync(settingsFile(), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] }] } }));
    await handleInstall(dir);
    await handleUninstall(dir);
    const settings = JSON.parse(readFileSync(settingsFile(), "utf8"));
    expect(settings.hooks.PostToolUse).toBeUndefined();
    expect(settings.hooks.PreToolUse).toHaveLength(1);
  });

  test("uninstall without a prior install is a no-op, not an error", async () => {
    await handleUninstall(dir);
    expect(errorLines).toHaveLength(0);
  });
});

describe("fixtureEditGuardFetch: --fixtures, no network", () => {
  test("answers each call from jev-responses.json in order, and flags a real violation end to end", async () => {
    writeConfig({ review: { jev: { edit_guard: true, edit_guard_threshold: 0.5 } } });
    writeRule();
    const fixturesDir = mkdtempSync(path.join(tmpdir(), "keryx-edit-guard-fixtures-"));
    // One tagging call (the clause has no explicit `[state:...]` marker, so
    // it goes through `buildClauseTagQuestions` first), then one violation
    // call — a fresh rule doc means the tag cache is always cold here.
    // `clauseId` is `<heading-slug>-<index>` (`extractReferenceClauses`,
    // `src/review/conform-clauses.ts`) — "no-console-logging-1" from this
    // fixture's own `# No console logging` heading, first clause under it.
    // The TAGGING question (`buildClauseTagQuestions`) keys its answer by
    // the bare clause id; the VIOLATION question (`ruleQuestionKey`,
    // `src/review/jev-rules.ts`) keys it by `<ruleId>::<clauseId>`, `ruleId`
    // being the rule's own repo-relative path — two different keys for the
    // SAME clause, by design (they are two different Jev calls).
    const clauseId = "no-console-logging-1";
    const ruleId = path.join(".metaproject", "rules", "core", "no-console.mdc");
    writeFileSync(
      path.join(fixturesDir, "jev-responses.json"),
      JSON.stringify([
        { answers: { [clauseId]: { type: "choice", choice: "hunk" } }, usage: { cost: 0.00001 } },
        { answers: { [`${ruleId}::${clauseId}`]: { type: "noul", noul: 0.9 } }, usage: { cost: 0.0001 } },
      ]),
    );
    await runJevEditGuardHook(dir, deps({ fetchFn: await fixtureEditGuardFetch(fixturesDir) }));
    expect(logLines).toHaveLength(1);
    expect(logLines[0]).toContain("Rule check flagged:");
    rmSync(fixturesDir, { recursive: true, force: true });
  });

  test("throws when a call exceeds the canned responses", async () => {
    const fixturesDir = mkdtempSync(path.join(tmpdir(), "keryx-edit-guard-fixtures-"));
    writeFileSync(path.join(fixturesDir, "jev-responses.json"), JSON.stringify([]));
    const fetchFn = await fixtureEditGuardFetch(fixturesDir);
    await expect((fetchFn as unknown as () => Promise<Response>)()).rejects.toThrow(/only 0 response/);
    rmSync(fixturesDir, { recursive: true, force: true });
  });
});

describe("status", () => {
  test("reports enabled/threshold/today's counts and recent flags", async () => {
    writeConfig({ review: { jev: { edit_guard: true, edit_guard_threshold: 0.7 } } });
    await handleStatus(dir, ["--json"]);
    expect(logLines).toHaveLength(1);
    const parsed = JSON.parse(logLines[0]!);
    expect(parsed.config).toEqual({ enabled: true, threshold: 0.7, maxCalls: expect.any(Number) });
    expect(parsed.today).toEqual({ calls: 0, flagged: 0, costUsd: 0 });
    expect(parsed.recentFlags).toEqual([]);
  });
});
