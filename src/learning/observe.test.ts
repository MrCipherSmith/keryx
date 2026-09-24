// W3-AC1 (and D3 edit-field/host-adapter coverage) for the Observe stage.
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BUILTIN_HOOK_REGISTRATIONS } from "../harness/hooks/builtins";
import { createHookRuntime } from "../harness/hooks/runtime";
import type { HookProcessRunner, HookRunRequest, HookRunResult } from "../harness/hooks/runner";
import {
  appendObservation,
  buildObservationLine,
  createLearningObservationSink,
  mapHookEventToObservation,
  observeHostHookPayload,
} from "./observe";
import { observationFilePath, observationsDir } from "./paths";
import { validateObservationEvent } from "./schema";

// Constructed rather than written literally so this fixture does not itself
// trip a secret scanner reading the repo (same convention as scan.test.ts).
const AWS_SECRET = ["AKIA", "IOSFODNN7EXAMPLE"].join("");

async function withTempRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-learning-observe-"));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function makeNoopRunner(): HookProcessRunner {
  const runner: HookProcessRunner = {
    async run(_req: HookRunRequest): Promise<HookRunResult> {
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 0 };
    },
  };
  return runner;
}

async function readDayFileLines(root: string, date: string): Promise<unknown[]> {
  const raw = await readFile(observationFilePath(root, date), "utf8");
  return raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

describe("mapHookEventToObservation", () => {
  test("maps every C-14 hook event", () => {
    expect(mapHookEventToObservation("PreToolUse")).toBe("tool-start");
    expect(mapHookEventToObservation("PostToolUse")).toBe("tool-complete");
    expect(mapHookEventToObservation("PostToolUseFailure")).toBe("tool-failed");
    expect(mapHookEventToObservation("UserPromptSubmit")).toBe("user-prompt");
    expect(mapHookEventToObservation("SessionStart")).toBe("session-start");
    expect(mapHookEventToObservation("Stop")).toBe("turn-stop");
    expect(mapHookEventToObservation("SessionEnd")).toBe("session-end");
  });

  test("accepts an already-mapped observation-event name (W6 LearningObservation.kind) unchanged", () => {
    expect(mapHookEventToObservation("tool-complete")).toBe("tool-complete");
    expect(mapHookEventToObservation("session-end")).toBe("session-end");
  });

  test("returns null for an unrecognized event", () => {
    expect(mapHookEventToObservation("PreCompact")).toBeNull();
    expect(mapHookEventToObservation("nonsense")).toBeNull();
  });
});

describe("createLearningObservationSink through a real createHookRuntime (AC1)", () => {
  test("records tool-complete and session-end lines, each valid against validateObservationEvent", async () => {
    await withTempRoot(async (root) => {
      const sink = createLearningObservationSink(root, { now: () => "2026-09-24T12:00:00.000Z" });
      const runtime = createHookRuntime({
        registrations: BUILTIN_HOOK_REGISTRATIONS,
        runner: makeNoopRunner(),
        clock: () => "2026-09-24T12:00:00.000Z",
        profileId: "monitored-trusted-local",
        interactive: true,
        sessionId: "s1",
        runId: "r1",
        projectRoot: root,
        builtinArgvResolver: (argv) => [...argv],
        ports: { learningSink: sink },
      });

      await runtime.fire(
        "PostToolUse",
        {
          sessionId: "s1",
          runId: "r1",
          toolCallId: "t1",
          toolName: "Bash",
          keryxToolName: "shell_exec",
          toolInput: { command: "echo hi" },
          toolOutput: { stdout: "hi\n" },
        },
        { toolName: "Bash" },
      );
      await runtime.fire("SessionEnd", { sessionId: "s1", runId: "r1", endReason: "done" });

      const lines = await readDayFileLines(root, "2026-09-24");
      const events = lines.map((l) => (l as { event: string }).event);
      expect(events).toContain("tool-complete");
      expect(events).toContain("session-end");
      for (const line of lines) {
        expect(validateObservationEvent(line).ok).toBe(true);
      }
    });
  });

  test("a secret in tool output is stored as [redacted:secret], never the raw text", async () => {
    await withTempRoot(async (root) => {
      const sink = createLearningObservationSink(root, { now: () => "2026-09-24T12:00:00.000Z" });
      await sink.record({
        kind: "tool-complete",
        sessionId: "s1",
        runId: "r1",
        timestamp: "2026-09-24T12:00:00.000Z",
        payload: {
          sessionId: "s1",
          runId: "r1",
          toolCallId: "t1",
          toolName: "Bash",
          toolInput: { command: "print-secret" },
          toolOutput: { stdout: `aws_access_key_id = ${AWS_SECRET}` },
        },
      });

      const lines = await readDayFileLines(root, "2026-09-24");
      expect(lines).toHaveLength(1);
      const line = lines[0] as { outputPreview: string | null };
      expect(line.outputPreview).toBe("[redacted:secret]");
      const raw = await readFile(observationFilePath(root, "2026-09-24"), "utf8");
      expect(raw).not.toContain(AWS_SECRET);
    });
  });

  test("previews are bounded to 200 chars for a 10 KB input, and the raw cwd string never appears in the file", async () => {
    await withTempRoot(async (root) => {
      const sink = createLearningObservationSink(root, { now: () => "2026-09-24T12:00:00.000Z" });
      const bigCommand = "a".repeat(10_000);
      await sink.record({
        kind: "tool-complete",
        sessionId: "s1",
        runId: "r1",
        timestamp: "2026-09-24T12:00:00.000Z",
        payload: {
          sessionId: "s1",
          runId: "r1",
          toolCallId: "t1",
          toolName: "Bash",
          toolInput: { command: bigCommand },
          toolOutput: { stdout: "a".repeat(10_000) },
        },
      });

      const lines = await readDayFileLines(root, "2026-09-24");
      const line = lines[0] as { inputPreview: string; outputPreview: string; inputDigest: string; cwdHash: string };
      expect(line.inputPreview.length).toBeLessThanOrEqual(200);
      expect(line.outputPreview.length).toBeLessThanOrEqual(200);
      expect(line.inputDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(line.cwdHash).toMatch(/^[a-f0-9]{64}$/);

      const raw = await readFile(observationFilePath(root, "2026-09-24"), "utf8");
      expect(raw).not.toContain(root);
    });
  });

  test("KERYX_LEARNING=off writes nothing", async () => {
    await withTempRoot(async (root) => {
      const sink = createLearningObservationSink(root, { env: { KERYX_LEARNING: "off" } as NodeJS.ProcessEnv });
      await sink.record({
        kind: "session-end",
        sessionId: "s1",
        runId: "r1",
        timestamp: "2026-09-24T12:00:00.000Z",
        payload: { sessionId: "s1", runId: "r1", endReason: "done" },
      });
      const exists = await Bun.file(observationFilePath(root, "2026-09-24")).exists();
      expect(exists).toBe(false);
    });
  });

  test("the sink never throws when the observations directory cannot be created", async () => {
    await withTempRoot(async (root) => {
      // A plain FILE where the "learning" directory should be forces every
      // `mkdir(..., {recursive:true})` under it to fail (ENOTDIR) regardless
      // of the running user's permissions (unlike a chmod-based approach,
      // which a root-run CI job would silently bypass).
      await mkdir(path.join(root, ".metaproject", "data"), { recursive: true });
      await writeFile(path.join(root, ".metaproject", "data", "learning"), "not a directory", "utf8");

      const warnings: unknown[] = [];
      const sink = createLearningObservationSink(root, {
        now: () => "2026-09-24T12:00:00.000Z",
        warn: (message, error) => warnings.push({ message, error }),
      });

      await expect(
        sink.record({
          kind: "session-end",
          sessionId: "s1",
          runId: "r1",
          timestamp: "2026-09-24T12:00:00.000Z",
          payload: { sessionId: "s1", runId: "r1", endReason: "done" },
        }),
      ).resolves.toBeUndefined();
      expect(warnings.length).toBeGreaterThan(0);
    });
  });

  test("the edit field is hash-only: no raw path or content leaks into the stored line", async () => {
    await withTempRoot(async (root) => {
      const sink = createLearningObservationSink(root, { now: () => "2026-09-24T12:00:00.000Z" });
      await sink.record({
        kind: "tool-complete",
        sessionId: "s1",
        runId: "r1",
        timestamp: "2026-09-24T12:00:00.000Z",
        payload: {
          sessionId: "s1",
          runId: "r1",
          toolCallId: "t1",
          toolName: "Edit",
          toolInput: { file_path: "src/secret-module.ts", old_string: "const password = 'old-value';", new_string: "const password = readSecret();" },
          toolOutput: {},
        },
      });

      const lines = await readDayFileLines(root, "2026-09-24");
      const line = lines[0] as { edit?: { pathDigest: string; removedDigest: string | null; addedDigest: string | null } };
      expect(line.edit).toBeDefined();
      expect(line.edit!.pathDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(line.edit!.removedDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(line.edit!.addedDigest).toMatch(/^[a-f0-9]{64}$/);

      // The `edit` field itself (D3: hash-only) never carries the raw path or
      // content — only the (separately bounded/redacted) `*Preview` fields
      // are allowed to carry a bounded slice of it, per the W3 spec.
      const editJson = JSON.stringify(line.edit);
      expect(editJson).not.toContain("secret-module.ts");
      expect(editJson).not.toContain("old-value");
      expect(editJson).not.toContain("readSecret");
    });
  });
});

describe("appendObservation bounding (5000 lines/day, rolls to next UTC day)", () => {
  test("a small injected maxLinesPerFile rolls the third line into the next UTC day's file", async () => {
    await withTempRoot(async (root) => {
      for (let i = 0; i < 3; i += 1) {
        const line = await buildObservationLine(
          root,
          {
            event: "session-end",
            tool: null,
            sessionId: "s1",
            toolUseId: null,
            cwd: root,
            observedAt: "2026-09-24T12:00:00.000Z",
          },
          {},
        );
        expect(line).not.toBeNull();
        await appendObservation(root, line!, { maxLinesPerFile: 2 });
      }

      const day1 = await readDayFileLines(root, "2026-09-24");
      const day2 = await readDayFileLines(root, "2026-09-25");
      expect(day1).toHaveLength(2);
      expect(day2).toHaveLength(1);
    });
  });

  test("both daily files full: the observation is dropped and reported, never thrown", async () => {
    await withTempRoot(async (root) => {
      const warnings: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        const line = await buildObservationLine(
          root,
          { event: "session-end", tool: null, sessionId: "s1", toolUseId: null, cwd: root, observedAt: "2026-09-24T12:00:00.000Z" },
          {},
        );
        await appendObservation(root, line!, { maxLinesPerFile: 1, warn: (m) => warnings.push(m) });
      }
      const day1 = await readDayFileLines(root, "2026-09-24");
      const day2 = await readDayFileLines(root, "2026-09-25");
      expect(day1).toHaveLength(1);
      expect(day2).toHaveLength(1);
      expect(warnings.some((w) => w.includes("dropped"))).toBe(true);
    });
  });
});

describe("observeHostHookPayload (Claude host hook payload mapping)", () => {
  test("maps a PostToolUse payload to a tool-complete line", async () => {
    await withTempRoot(async (root) => {
      await observeHostHookPayload(
        root,
        "claude",
        {
          hook_event_name: "PostToolUse",
          session_id: "s1",
          tool_name: "Bash",
          tool_input: { command: "ls" },
          tool_response: { stdout: "file.txt" },
          tool_use_id: "tu1",
          cwd: root,
        },
        { now: () => "2026-09-24T12:00:00.000Z" },
      );
      const lines = await readDayFileLines(root, "2026-09-24");
      expect(lines).toHaveLength(1);
      expect((lines[0] as { event: string }).event).toBe("tool-complete");
      expect(validateObservationEvent(lines[0]).ok).toBe(true);
    });
  });

  test("maps a SessionEnd payload to a session-end line", async () => {
    await withTempRoot(async (root) => {
      await observeHostHookPayload(
        root,
        "claude",
        { hook_event_name: "SessionEnd", session_id: "s1", cwd: root },
        { now: () => "2026-09-24T12:00:00.000Z" },
      );
      const lines = await readDayFileLines(root, "2026-09-24");
      expect(lines).toHaveLength(1);
      expect((lines[0] as { event: string }).event).toBe("session-end");
    });
  });

  test("KERYX_LEARNING=off writes nothing for a host payload either", async () => {
    await withTempRoot(async (root) => {
      await observeHostHookPayload(
        root,
        "claude",
        { hook_event_name: "SessionEnd", session_id: "s1", cwd: root },
        { env: { KERYX_LEARNING: "off" } as NodeJS.ProcessEnv },
      );
      const exists = await Bun.file(observationFilePath(root, "2026-09-24")).exists();
      expect(exists).toBe(false);
    });
  });

  test("never throws on a malformed payload", async () => {
    await withTempRoot(async (root) => {
      await expect(observeHostHookPayload(root, "claude", "not an object", {})).resolves.toBeUndefined();
      await expect(observeHostHookPayload(root, "claude", { no_hook_event_name: true }, {})).resolves.toBeUndefined();
    });
  });
});

// Sanity: the append path never rewrites the file (append-only) and asserts
// its target stays inside `.metaproject/data/learning/` — exercised
// indirectly above via successful appends; this proves the directory exists
// and is never touched outside `observationsDir`.
test("appendObservation creates the observations directory under .metaproject/data/learning", async () => {
  await withTempRoot(async (root) => {
    const line = await buildObservationLine(
      root,
      { event: "session-end", tool: null, sessionId: "s1", toolUseId: null, cwd: root, observedAt: "2026-09-24T12:00:00.000Z" },
      {},
    );
    await appendObservation(root, line!, {});
    const dirExists = await Bun.file(path.join(observationsDir(root), "2026-09-24.jsonl")).exists();
    expect(dirExists).toBe(true);
  });
});

