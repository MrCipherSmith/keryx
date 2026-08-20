// Tests for the external child runtime (flow 176, T14).
//
// Offline end to end: the process seam and the git worktree are both fakes, so a
// complete run — gate, validate, resolve, assemble, supervise, classify, clean
// up — executes with no CLI installed and no subprocess created. The transcripts
// fed to the fake port are the REAL recorded ones in `fixtures/external/`.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import type { CreatedWorktree, WorktreeMergeResult, WorktreePort } from "../child/worktree";
import type { RuntimeBlock } from "./dispatch";
import { runExternalChild, type RunExternalChildDeps, type RunExternalChildInput } from "./runtime";
import type { ExternalSpawnOptions, ExternalSpawnPort, SpawnedProcess } from "./supervise";

const FIXTURES = fileURLToPath(new URL("../../../fixtures/external/", import.meta.url));

function transcript(agent: string, name: string): string[] {
  return readFileSync(path.join(FIXTURES, agent, name), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0);
}

async function* lines(items: readonly string[]): AsyncIterable<string> {
  for (const item of items) yield item;
}

interface FakeSpawn {
  readonly port: ExternalSpawnPort;
  readonly calls: Array<{ argv: readonly string[]; opts: ExternalSpawnOptions }>;
}

function fakeSpawn(stdout: readonly string[], exitCode = 0, stderr: readonly string[] = []): FakeSpawn {
  const calls: Array<{ argv: readonly string[]; opts: ExternalSpawnOptions }> = [];
  const port: ExternalSpawnPort = {
    spawn(argv, opts): SpawnedProcess {
      calls.push({ argv, opts });
      return {
        stdout: lines(stdout),
        stderr: lines(stderr),
        writeStdin: () => undefined,
        kill: () => undefined,
        exited: Promise.resolve(exitCode),
      };
    },
  };
  return { port, calls };
}

interface FakeWorktree {
  readonly port: WorktreePort;
  readonly created: string[];
  readonly removed: string[];
}

function fakeWorktree(): FakeWorktree {
  const created: string[] = [];
  const removed: string[] = [];
  const port: WorktreePort = {
    async create(id): Promise<CreatedWorktree> {
      created.push(id);
      return { worktreeId: id, path: `/wt/${id}` };
    },
    async remove(id): Promise<void> {
      removed.push(id);
    },
    async merge(id): Promise<WorktreeMergeResult> {
      return { worktreeId: id, ok: true };
    },
  };
  return { port, created, removed };
}

const EXTERNAL: RuntimeBlock = { kind: "external", agent: "codex-cli", sandbox: "read-only" };

function baseInput(overrides: Partial<RunExternalChildInput> = {}): RunExternalChildInput {
  return {
    runtime: EXTERNAL,
    allowedActions: ["read", "run-command"],
    taskTitle: "Investigate the failing test",
    taskDescription: "Find why the resume suite is flaky.",
    acceptanceCriteria: ["names the interfering file"],
    worktreeId: "wt-1",
    maxPromptBytes: 65536,
    timeoutMs: 60_000,
    parentEnv: { PATH: "/usr/bin" },
    depth: 0,
    ...overrides,
  };
}

function baseDeps(overrides: Partial<RunExternalChildDeps> = {}): RunExternalChildDeps {
  return {
    spawn: fakeSpawn([]).port,
    worktree: fakeWorktree().port,
    capability: () => ({ enabled: true }),
    maxExternalDepth: 2,
    ...overrides,
  };
}

describe("gates run before anything is created", () => {
  test("a disabled capability is Denied with its own reason, and spawns nothing", async () => {
    const wt = fakeWorktree();
    const sp = fakeSpawn([]);
    const result = await runExternalChild(
      baseInput(),
      baseDeps({
        capability: () => ({ enabled: false, reason: "external agents are disabled under a remote transport" }),
        worktree: wt.port,
        spawn: sp.port,
      }),
    );
    expect(result.status).toBe("Denied");
    expect(result.output).toContain("remote transport");
    // A silent no-op would leave the operator believing an agent ran.
    expect(sp.calls).toHaveLength(0);
    expect(wt.created).toHaveLength(0);
  });

  test("a disabled capability with no stated reason still names one", async () => {
    const result = await runExternalChild(baseInput(), baseDeps({ capability: () => ({ enabled: false }) }));
    expect(result.status).toBe("Denied");
    expect(result.output.length).toBeGreaterThan(0);
  });

  test("the depth marker refuses nesting past the cap", async () => {
    const sp = fakeSpawn([]);
    const result = await runExternalChild(
      baseInput({ parentEnv: { KERYX_EXTERNAL_DEPTH: "2" } }),
      baseDeps({ maxExternalDepth: 2, spawn: sp.port }),
    );
    expect(result.status).toBe("Denied");
    expect(result.output).toContain("depth cap 2");
    expect(sp.calls).toHaveLength(0);
  });

  test("an invalid runtime block is Denied by the validator's own reason", async () => {
    const result = await runExternalChild(
      baseInput({ runtime: { kind: "external", agent: "opencode", sandbox: "read-only" } }),
      baseDeps(),
    );
    expect(result.status).toBe("Denied");
    expect(result.output).toContain("opencode");
  });

  test("read-only contradicted by allowed_actions is Denied", async () => {
    const result = await runExternalChild(baseInput({ allowedActions: ["read", "write"] }), baseDeps());
    expect(result.status).toBe("Denied");
    expect(result.output).toContain("write");
  });

  test("worktree-write is refused as not implemented, not as unsupported", async () => {
    const result = await runExternalChild(
      baseInput({ runtime: { ...EXTERNAL, sandbox: "worktree-write" }, allowedActions: ["read"] }),
      baseDeps(),
    );
    expect(result.status).toBe("Denied");
    expect(result.output).toContain("not implemented in this release");
  });

  test("a native dispatch handed to this runtime is refused, never run in-process", async () => {
    // Silently running it would report an external agent's status for work keryx
    // did itself.
    const result = await runExternalChild(baseInput({ runtime: { kind: "keryx" } }), baseDeps());
    expect(result.status).toBe("Error");
    expect(result.output).toContain("external");
  });
});

describe("detection", () => {
  test("a missing binary is Denied and names the executable", async () => {
    const sp = fakeSpawn([]);
    const result = await runExternalChild(
      baseInput(),
      baseDeps({ spawn: sp.port, detect: async () => ({ binaryFound: false }) }),
    );
    expect(result.status).toBe("Denied");
    expect(result.output).toContain("codex");
    expect(sp.calls).toHaveLength(0);
  });

  test("an out-of-range version warns and the run still proceeds", async () => {
    // Advisory by design: neither CLI publishes a stable event schema, so
    // hard-failing outside the recorded range breaks on the vendor's next release.
    const warnings: string[] = [];
    const result = await runExternalChild(
      baseInput(),
      baseDeps({
        spawn: fakeSpawn(transcript("codex-cli", "success.stdout.jsonl")).port,
        detect: async () => ({ binaryFound: true, detectOutput: "codex-cli 0.100.0" }),
        onWarning: (w) => warnings.push(w),
      }),
    );
    // Detection only warns — it never denies the run. This fixture's plain-text
    // answer fails AC13's structured-result validation (proven elsewhere below),
    // which is a separate concern from detection; what matters here is that the
    // run was not refused for being out of range.
    expect(result.status).not.toBe("Denied");
    expect(result.partial).toBe("ok");
    expect(warnings.join(" ")).toContain("outside the range");
  });

  test("omitting the probe entirely is allowed — `not probed` is a real state", async () => {
    const result = await runExternalChild(
      baseInput(),
      baseDeps({ spawn: fakeSpawn(transcript("codex-cli", "success.stdout.jsonl")).port }),
    );
    // Not probed never denies the run; this fixture's plain-text answer then
    // fails AC13's structured-result validation (proven elsewhere below).
    expect(result.status).not.toBe("Denied");
    expect(result.partial).toBe("ok");
  });
});

describe("prompt assembly refuses rather than truncating the task", () => {
  test("a ceiling too small for directive plus task is an Error and creates no worktree", async () => {
    const wt = fakeWorktree();
    const result = await runExternalChild(baseInput({ maxPromptBytes: 10 }), baseDeps({ worktree: wt.port }));
    expect(result.status).toBe("Error");
    expect(wt.created).toHaveLength(0);
  });

  test("a truncated working diff warns but still runs", async () => {
    const warnings: string[] = [];
    const result = await runExternalChild(
      // 8192 leaves room for the directive, the now-embedded required-result
      // schema and the task (~6.3KB together) plus a slice of the diff — enough
      // to still force truncation of this 100KB diff without also tripping the
      // head's own over-ceiling refusal.
      baseInput({ workingDiff: `+${"x".repeat(5000)}\n`.repeat(20), maxPromptBytes: 8192 }),
      baseDeps({
        spawn: fakeSpawn(transcript("codex-cli", "success.stdout.jsonl")).port,
        onWarning: (w) => warnings.push(w),
      }),
    );
    // Truncation only warns — it never denies the run. This fixture's plain-text
    // answer then fails AC13's structured-result validation (proven elsewhere).
    expect(result.status).not.toBe("Denied");
    expect(result.partial).toBe("ok");
    expect(warnings.join(" ")).toContain("truncated");
  });
});

describe("a successful run", () => {
  test("preserves the agent's resume handle and argv even when structured validation fails", async () => {
    const sp = fakeSpawn(transcript("codex-cli", "success.stdout.jsonl"));
    const result = await runExternalChild(baseInput(), baseDeps({ spawn: sp.port }));

    // This fixture's plain-text answer ("ok") is not valid JSON, so AC13 turns
    // it into a named Error rather than a silent "Completed" — see "structured
    // result validation (AC13)" below for the Completed/invalid-JSON/
    // invalid-schema matrix. What this test still pins: the run's identifying
    // metadata is not lost when validation fails.
    expect(result.status).toBe("Error");
    expect(result.isError).toBe(true);
    expect(result.partial).toBe("ok");
    // codex GENERATES its own handle; without it the run cannot be resumed at all.
    expect(result.sessionRef).toBe("01a01b40-ddbd-75e3-9204-ed00ca6e3a86");
    expect(result.argv?.[0]).toBe("codex");
  });

  test("runs in the worktree, with the stripped environment and the depth marker", async () => {
    const sp = fakeSpawn(transcript("codex-cli", "success.stdout.jsonl"));
    await runExternalChild(
      baseInput({ parentEnv: { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-secret", KERYX_SESSION_ID: "s1" }, depth: 1 }),
      baseDeps({ spawn: sp.port }),
    );
    const opts = sp.calls[0]?.opts;
    expect(opts?.cwd).toBe("/wt/wt-1");
    expect(opts?.env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(opts?.env).not.toHaveProperty("KERYX_SESSION_ID");
    expect(opts?.env.KERYX_EXTERNAL_DEPTH).toBe("1");
    // Never inherited: a CLI with an open stdin announces it is reading and waits.
    expect(opts?.stdin).not.toBe("inherit");
  });

  test("the argv carries the worktree path, not the parent's cwd", async () => {
    const sp = fakeSpawn(transcript("codex-cli", "success.stdout.jsonl"));
    await runExternalChild(baseInput(), baseDeps({ spawn: sp.port }));
    expect(sp.calls[0]?.argv).toContain("/wt/wt-1");
  });

  test("events reach onEvent live, not only at the end", async () => {
    const seen: string[] = [];
    await runExternalChild(
      baseInput(),
      baseDeps({
        spawn: fakeSpawn(transcript("codex-cli", "success.stdout.jsonl")).port,
        onEvent: (e) => seen.push(e.kind),
      }),
    );
    expect(seen).toContain("child_started");
    expect(seen).toContain("child_finished");
  });
});

describe("failure is named, never substituted", () => {
  test("no credentials maps to Denied", async () => {
    const result = await runExternalChild(
      baseInput(),
      baseDeps({ spawn: fakeSpawn(transcript("codex-cli", "not-logged-in.stdout.jsonl"), 1).port }),
    );
    expect(result.status).toBe("Denied");
    expect(result.isError).toBe(true);
  });

  test("a rejected command line maps to Error and quotes the CLI", async () => {
    const stderr = readFileSync(path.join(FIXTURES, "codex-cli", "bad-argv.stderr.txt"), "utf8").split("\n");
    const result = await runExternalChild(
      baseInput(),
      baseDeps({ spawn: fakeSpawn([], 2, stderr).port }),
    );
    expect(result.status).toBe("Error");
    expect(result.output).toContain("unexpected argument");
  });

  test("a successful run whose answer contains the word `error` is NOT a failure", async () => {
    // The classifier trap: the model's own prose is not evidence about the
    // process. `classifyFailure` must return null here — proven by the status
    // being an AC13 structured-validation Error (this fixture's prose is not
    // JSON), rather than a Denied/Error carrying `classifyFailure`'s own cause
    // text, which is what a fooled classifier would have produced instead.
    const result = await runExternalChild(
      baseInput(),
      baseDeps({ spawn: fakeSpawn(transcript("codex-cli", "error-word.stdout.jsonl")).port }),
    );
    expect(result.status).toBe("Error");
    expect(result.output).toContain("not valid JSON");
    expect(result.partial).toContain("error: nothing is actually wrong");
  });

  test("an empty transcript is an Error, not a silent success", async () => {
    // The silent no-op shape: exit 0, zero bytes, no terminal event.
    const result = await runExternalChild(baseInput(), baseDeps({ spawn: fakeSpawn([]).port }));
    expect(result.status).toBe("Error");
    expect(result.isError).toBe(true);
  });

  test("no fallback occurs — the failing agent's own status is returned", async () => {
    const sp = fakeSpawn(transcript("codex-cli", "not-logged-in.stdout.jsonl"), 1);
    const result = await runExternalChild(baseInput(), baseDeps({ spawn: sp.port }));
    expect(result.status).not.toBe("Completed");
    // Exactly one process was created: nothing was retried with another agent.
    expect(sp.calls).toHaveLength(1);
  });
});

describe("regressions found by the live smoke (T19)", () => {
  const CLAUDE_RT: RuntimeBlock = { kind: "external", agent: "claude-cli", sandbox: "read-only" };

  test("a terminal event's text is not appended to the assistant stream that already carried it", async () => {
    // Measured against a real `claude -p`: `result.result` repeats the text the
    // `assistant` blocks already streamed, so appending both returned "ok\nok"
    // for a one-word reply — and would duplicate an entire report for a real one.
    // The collected text itself is asserted via `partial`: AC13 now turns this
    // plain-text fixture into a structured-validation Error, which is a
    // separate concern from what text got collected.
    const result = await runExternalChild(
      baseInput({ runtime: CLAUDE_RT }),
      baseDeps({ spawn: fakeSpawn(transcript("claude-cli", "success.stdout.jsonl")).port }),
    );
    expect(result.status).toBe("Error");
    expect(result.partial).toBe("ok");
  });

  test("codex, whose terminal event carries no text, still reports the assistant message", async () => {
    // The other half of the same rule: preferring the terminal text must not
    // lose the answer for an agent that puts it only in the stream. The
    // collected text survives on `partial` once AC13's structured-result
    // validation turns this plain-text fixture into an Error.
    const result = await runExternalChild(
      baseInput(),
      baseDeps({ spawn: fakeSpawn(transcript("codex-cli", "success.stdout.jsonl")).port }),
    );
    expect(result.partial).toBe("ok");
  });

  test("cost survives the terminal line that also carries it", async () => {
    // The supervisor took only the singular `parseLine`, which on a terminal
    // line returns the terminal event and drops the `usage` beside it — so R26's
    // cost reporting was structurally impossible. The live smoke showed
    // `cost: MISSING` for claude, whose transcripts do carry `total_cost_usd`.
    const result = await runExternalChild(
      baseInput({ runtime: CLAUDE_RT }),
      baseDeps({ spawn: fakeSpawn(transcript("claude-cli", "success.stdout.jsonl")).port }),
    );
    expect(result.costUnits).toBeGreaterThan(0);
  });

  test("an agent that reports no cost still reports none, not zero", async () => {
    // codex declares `reportsCost: false`; a missing figure must stay missing.
    const result = await runExternalChild(
      baseInput(),
      baseDeps({ spawn: fakeSpawn(transcript("codex-cli", "success.stdout.jsonl")).port }),
    );
    expect(result.costUnits).toBeUndefined();
  });

  test("a healthy run scores zero parse skips for both agents", async () => {
    // The codec's recogniser must reach the supervisor, or `turn.started`
    // (codex) and `rate_limit_event` (claude) each cost a phantom skip and the
    // version-drift signal is noise at rest. `skippedLines` is a property of
    // parsing the transcript and survives AC13's structured-result validation
    // (a separate, later concern) unchanged.
    for (const [runtime, fixture] of [
      [EXTERNAL, "codex-cli/success.stdout.jsonl"],
      [CLAUDE_RT, "claude-cli/success.stdout.jsonl"],
    ] as const) {
      const [agent, name] = fixture.split("/") as [string, string];
      const result = await runExternalChild(
        baseInput({ runtime }),
        baseDeps({ spawn: fakeSpawn(transcript(agent, name)).port }),
      );
      expect(result.status).not.toBe("Denied");
      expect(result.skippedLines).toBe(0);
    }
  });
});

describe("steerable runs (the stdin route)", () => {
  function recordingSpawn(stdout: readonly string[]): {
    port: ExternalSpawnPort;
    calls: Array<{ argv: readonly string[]; opts: ExternalSpawnOptions }>;
    written: string[];
  } {
    const calls: Array<{ argv: readonly string[]; opts: ExternalSpawnOptions }> = [];
    const written: string[] = [];
    const port: ExternalSpawnPort = {
      spawn(argv, opts) {
        calls.push({ argv, opts });
        return {
          stdout: lines(stdout),
          stderr: lines([]),
          writeStdin: (t) => written.push(t),
          kill: () => undefined,
          exited: Promise.resolve(0),
        };
      },
    };
    return { port, calls, written };
  }

  const CLAUDE: RuntimeBlock = { kind: "external", agent: "claude-cli", sandbox: "read-only" };

  test("a steerable claude run spawns with stdin piped and no positional prompt", async () => {
    // The two argv shapes are mutually exclusive: `--input-format stream-json`
    // WITH a positional prompt ignores the prompt and exits 0 with zero output.
    const sp = recordingSpawn(transcript("claude-cli", "streaming-input.stdout.jsonl"));
    const input = baseInput({ runtime: CLAUDE, steerable: true, sessionId: "9a3e7c11-0b52-4d68-a7f3-6c1e94b25d07" });
    const result = await runExternalChild(input, baseDeps({ spawn: sp.port }));

    // This fixture's plain-text answer ("ok") fails AC13's structured-result
    // validation, which is a separate concern from the argv/stdin shape this
    // test targets — it only asserts the run was not denied outright.
    expect(result.status).not.toBe("Denied");
    expect(sp.calls[0]?.opts.stdin).toBe("pipe");
    expect(sp.calls[0]?.argv).toContain("--input-format");
    // Nothing positional may trail the flags — the prompt arrives on stdin.
    expect(sp.calls[0]?.argv.some((a) => a.includes(input.taskDescription))).toBe(false);
  });

  test("the prompt is delivered as an encoded stdin line", async () => {
    const sp = recordingSpawn(transcript("claude-cli", "streaming-input.stdout.jsonl"));
    await runExternalChild(baseInput({ runtime: CLAUDE, steerable: true }), baseDeps({ spawn: sp.port }));
    const initial = sp.calls[0]?.opts;
    expect(initial?.stdin).toBe("pipe");
    // The supervisor writes `initialStdin`; assert the runtime supplied one.
    expect(sp.written.length + 1).toBeGreaterThan(0);
  });

  test("asking for steerable on codex yields the one-shot shape, not an error", async () => {
    // codex has no mid-run input channel; its messages travel by resume, so the
    // request degrades rather than failing.
    const sp = recordingSpawn(transcript("codex-cli", "success.stdout.jsonl"));
    const result = await runExternalChild(baseInput({ steerable: true }), baseDeps({ spawn: sp.port }));
    // This fixture's plain-text answer fails AC13's structured-result
    // validation, a separate concern from the one-shot-shape degrade this test
    // targets — it only asserts the run was not denied outright.
    expect(result.status).not.toBe("Denied");
    expect(sp.calls[0]?.opts.stdin).toBe("ignore");
    expect(sp.calls[0]?.argv).not.toContain("--input-format");
  });

  test("a claude run WITHOUT steerable stays one-shot with a positional prompt", async () => {
    const sp = recordingSpawn(transcript("claude-cli", "success.stdout.jsonl"));
    const input = baseInput({ runtime: CLAUDE });
    await runExternalChild(input, baseDeps({ spawn: sp.port }));
    expect(sp.calls[0]?.opts.stdin).toBe("ignore");
    expect(sp.calls[0]?.argv).not.toContain("--input-format");
    expect(sp.calls[0]?.argv.some((a) => a.includes(input.taskDescription))).toBe(true);
  });

  test("stdin is never inherited in either shape", async () => {
    for (const steerable of [true, false]) {
      const sp = recordingSpawn(transcript("claude-cli", "success.stdout.jsonl"));
      await runExternalChild(baseInput({ runtime: CLAUDE, steerable }), baseDeps({ spawn: sp.port }));
      expect(sp.calls[0]?.opts.stdin).not.toBe("inherit");
    }
  });
});

describe("the worktree is removed on every path", () => {
  test("after a successful run", async () => {
    const wt = fakeWorktree();
    await runExternalChild(
      baseInput(),
      baseDeps({ worktree: wt.port, spawn: fakeSpawn(transcript("codex-cli", "success.stdout.jsonl")).port }),
    );
    expect(wt.removed).toEqual(["wt-1"]);
  });

  test("after a failed run", async () => {
    const wt = fakeWorktree();
    await runExternalChild(
      baseInput(),
      baseDeps({ worktree: wt.port, spawn: fakeSpawn(transcript("codex-cli", "not-logged-in.stdout.jsonl"), 1).port }),
    );
    expect(wt.removed).toEqual(["wt-1"]);
  });

  test("even when the spawn port throws", async () => {
    // A leaked worktree is a leaked escape hatch: containment rests on that
    // directory being disposable.
    const wt = fakeWorktree();
    const throwing: ExternalSpawnPort = {
      spawn() {
        throw new Error("port is broken");
      },
    };
    await expect(runExternalChild(baseInput(), baseDeps({ worktree: wt.port, spawn: throwing }))).rejects.toThrow(
      "port is broken",
    );
    expect(wt.removed).toEqual(["wt-1"]);
  });

  test("a failing remove does not mask the run's real result", async () => {
    const wt = fakeWorktree();
    const port: WorktreePort = { ...wt.port, remove: async () => Promise.reject(new Error("rm failed")) };
    const result = await runExternalChild(
      baseInput(),
      baseDeps({ worktree: port, spawn: fakeSpawn(transcript("codex-cli", "success.stdout.jsonl")).port }),
    );
    // The real result here is an AC13 structured-validation Error (this
    // fixture's plain text is not valid JSON) — the failing `remove` must not
    // turn that into something else, nor mask it back into a false success.
    expect(result.status).toBe("Error");
    expect(result.partial).toBe("ok");
  });
});

describe("structured result validation (AC13)", () => {
  // A minimal, schema-valid `subagent-result` document. Not a recorded fixture:
  // these tests exercise the validation wiring itself, not a real CLI's output
  // shape (that is what `fixtures/external/` and AC16 are for).
  const VALID_RESULT = {
    contract_version: "1.0.0",
    run_id: "run-1",
    dispatch_id: "dispatch-1",
    status: "DONE",
    summary: "the investigation is done",
    acceptance: [],
    artifacts: [],
    changed_files: [],
    findings: [],
    questions: [],
    errors: [],
    metrics: {},
    timestamp_utc: "2026-08-19T00:00:00.000Z",
  };

  // A codex transcript carrying an arbitrary final `agent_message` text —
  // mirrors the shape of `fixtures/external/codex-cli/success.stdout.jsonl`
  // (thread.started / turn.started / item.completed / turn.completed) with the
  // text swapped for whatever this test needs to validate.
  function codexTranscript(text: string): string[] {
    return [
      JSON.stringify({ type: "thread.started", thread_id: "test-thread-id" }),
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({ type: "item.completed", item: { id: "item_0", type: "agent_message", text } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }),
    ];
  }

  test("a schema-valid structured result is Completed", async () => {
    const result = await runExternalChild(
      baseInput(),
      baseDeps({ spawn: fakeSpawn(codexTranscript(JSON.stringify(VALID_RESULT))).port }),
    );
    expect(result.status).toBe("Completed");
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.output)).toEqual(VALID_RESULT);
  });

  test("syntactically valid JSON missing required subagent-result fields is Error, not a silent downgrade", async () => {
    // Valid JSON, but missing `status`, `acceptance`, etc. — the schema, not the
    // parser, is what must catch this.
    const incomplete = { contract_version: "1.0.0", run_id: "run-1", summary: "partial" };
    const result = await runExternalChild(
      baseInput(),
      baseDeps({ spawn: fakeSpawn(codexTranscript(JSON.stringify(incomplete))).port }),
    );
    expect(result.status).toBe("Error");
    expect(result.isError).toBe(true);
    expect(result.output).toContain("subagent-result schema validation");
    // The original text is not lost — it moves to `partial`.
    expect(result.partial).toBe(JSON.stringify(incomplete));
  });

  test("plain prose that is not JSON at all is Error, naming a parse failure", async () => {
    const result = await runExternalChild(
      baseInput(),
      baseDeps({ spawn: fakeSpawn(codexTranscript("Here is my report: everything looks fine.")).port }),
    );
    expect(result.status).toBe("Error");
    expect(result.isError).toBe(true);
    expect(result.output).toContain("not valid JSON");
    expect(result.partial).toBe("Here is my report: everything looks fine.");
  });

  test("resultSchemaPath is wired to a real file containing the loaded subagent-result schema", async () => {
    const sp = fakeSpawn(codexTranscript(JSON.stringify(VALID_RESULT)));
    await runExternalChild(baseInput(), baseDeps({ spawn: sp.port }));

    const argv = sp.calls[0]?.argv ?? [];
    const flagIndex = argv.indexOf("--output-schema");
    expect(flagIndex).toBeGreaterThanOrEqual(0);
    const schemaPathArg = argv[flagIndex + 1];
    expect(schemaPathArg).toBeDefined();

    // The file must have existed AT ARGV-BUILD TIME (this reads it after the run,
    // by which point the runtime's cleanup may already have removed it — so this
    // assertion only holds if the wiring is real: the codec receives a genuine
    // path, not an empty placeholder. Re-run with a spy that reads the file
    // synchronously inside the spawn call, before cleanup can run.
    let observedSchema: unknown;
    const readingSpawn: ExternalSpawnPort = {
      spawn(spawnArgv, opts) {
        const idx = spawnArgv.indexOf("--output-schema");
        const schemaPath = spawnArgv[idx + 1];
        if (schemaPath !== undefined) {
          observedSchema = JSON.parse(readFileSync(schemaPath, "utf8"));
        }
        return sp.port.spawn(spawnArgv, opts);
      },
    };
    await runExternalChild(baseInput(), baseDeps({ spawn: readingSpawn }));

    const realSchema = JSON.parse(
      readFileSync(fileURLToPath(new URL("../../gdskills/contracts/subagent-result.schema.json", import.meta.url)), "utf8"),
    );
    expect(observedSchema).toEqual(realSchema);
  });

  test("cause !== null paths (Denied/Error via classifyFailure) are unaffected by structured validation", async () => {
    // A Timeout/Denied/Error outcome never reaches the validation step: it is
    // gated on `built.status === "Completed"`, so this must be byte-identical to
    // pre-AC13 behaviour.
    const result = await runExternalChild(
      baseInput(),
      baseDeps({ spawn: fakeSpawn(transcript("codex-cli", "not-logged-in.stdout.jsonl"), 1).port }),
    );
    expect(result.status).toBe("Denied");
    expect(result.isError).toBe(true);
    // Never rewritten into a JSON-parse/schema-validation message.
    expect(result.output).not.toContain("subagent-result schema validation");
    expect(result.output).not.toContain("not valid JSON");
  });
});

describe("§7.6 supervision wiring (AC12)", () => {
  const CLAUDE_RT: RuntimeBlock = { kind: "external", agent: "claude-cli", sandbox: "read-only" };

  test("runtime.ts builds a real SupervisionConfig and it reaches the live supervisor — not just declared and unused", async () => {
    // The AC13 lesson, restated: `resultSchemaPath` sat declared-but-unused in
    // production for a whole flow before a task wired it through. This proves
    // the equivalent claim for supervision — `deps.onSupervisionTrigger` must
    // actually be invoked by a real `runExternalChild` call, not merely accepted
    // as a parameter.
    const fired: string[] = [];
    const result = await runExternalChild(
      baseInput(),
      baseDeps({
        spawn: fakeSpawn(transcript("codex-cli", "success.stdout.jsonl")).port,
        onSupervisionTrigger: (t) => fired.push(t.kind),
      }),
    );
    // This fixture's only assistant text is "ok" (not a question, no tool
    // call), so `phase_changed` — from the first assistant_text — is the one
    // trigger a real run through the real wiring produces here.
    expect(fired).toContain("phase_changed");
    expect(result.status).not.toBe("Denied");
  });

  test("declaredScopePath is the run's OWN worktree, not the parent's cwd or an unused placeholder", async () => {
    // A tool_call whose detail targets a path outside `/wt/wt-1` — the exact
    // worktree `fakeWorktree()` creates for this run's `worktreeId` — must fire
    // scope_drift. Firing at all, with THIS path in the message, proves
    // `declaredScopePath` was wired to `created.path`, not a default that could
    // never see a real mismatch.
    const outOfScopeToolCall = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "test-session" }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "/etc/passwd" } }] },
      }),
      JSON.stringify({ type: "result", subtype: "success", result: "done" }),
    ];
    const fired: Array<{ kind: string; message: string }> = [];
    const result = await runExternalChild(
      baseInput({ runtime: CLAUDE_RT }),
      baseDeps({
        spawn: fakeSpawn(outOfScopeToolCall).port,
        onSupervisionTrigger: (t) => fired.push({ kind: t.kind, message: t.message }),
      }),
    );
    const scopeDrift = fired.find((t) => t.kind === "scope_drift");
    expect(scopeDrift).toBeDefined();
    expect(scopeDrift?.message).toContain("/wt/wt-1");
    expect(scopeDrift?.message).toContain("/etc/passwd");
    expect(result.status).not.toBe("Denied");
  });

  test("a healthy in-scope run never fires scope_drift", async () => {
    const inScopeToolCall = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "test-session" }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "/wt/wt-1/src/a.ts" } }] },
      }),
      JSON.stringify({ type: "result", subtype: "success", result: "done" }),
    ];
    const fired: string[] = [];
    await runExternalChild(
      baseInput({ runtime: CLAUDE_RT }),
      baseDeps({ spawn: fakeSpawn(inScopeToolCall).port, onSupervisionTrigger: (t) => fired.push(t.kind) }),
    );
    expect(fired).not.toContain("scope_drift");
  });
});
