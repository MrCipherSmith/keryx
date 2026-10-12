// Flow 393 AC11: `shell_exec` output beyond its inline cap is saved in full through the spill path.
// The model sees head, tail, counts and the path; stdout and stderr are both kept and the tail of
// stderr is always visible. The command under test prints 3000 stdout lines and then an error on
// stderr, which the old 20 KB head cut dropped first.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runAgentTurn } from "../../../commands/agent";
import { callRound, collectingIo, makeDeps, okReply, scriptedProvider } from "../../../commands/agent.test-helpers";
import type { NormalizedMessage } from "../../provider/types";
import { createJobRegistry } from "./background-job-registry";
import { makeCommandRunner, shellExecTool } from "./shell-exec-tool";
import {
  SHELL_INLINE_CAP,
  TranscriptRecorder,
  renderShellOutput,
  transcriptFromStreams,
} from "./shell-transcript";

const COMMAND = `i=1; while [ $i -le 3000 ]; do echo "stdout line $i"; i=$((i+1)); done; echo "FATAL: the build exploded" >&2; exit 3`;

let root: string;
let session: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "keryx-shell-spill-root-"));
  session = await mkdtemp(path.join(tmpdir(), "keryx-shell-spill-session-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(session, { recursive: true, force: true });
});

function expectBoundedView(view: string): void {
  expect(view.length).toBeLessThanOrEqual(SHELL_INLINE_CAP);
  // Head and tail of stdout.
  expect(view).toContain("stdout line 1\n");
  expect(view).toContain("stdout line 3000");
  // The middle is gone.
  expect(view).not.toContain("stdout line 1500\n");
  // The error on stderr survives, and the counts name both streams.
  expect(view).toContain("FATAL: the build exploded");
  expect(view).toContain("stdout 3000 lines");
  expect(view).toContain("stderr 1 lines");
}

test("the synchronous runner returns a bounded view and the whole transcript to save", async () => {
  const result = await makeCommandRunner(root)(COMMAND);
  expect(result.isError).toBe(true);
  expectBoundedView(result.output);
  expect(result.spill).toBeDefined();
  const full = result.spill?.full ?? "";
  for (const n of [1, 1500, 3000]) expect(full).toContain(`stdout line ${n}\n`);
  expect(full).toContain("FATAL: the build exploded");
  // The view the model gets once a file exists names it.
  const view = result.spill?.render("/tmp/saved/out.txt") ?? "";
  expect(view).toContain("/tmp/saved/out.txt");
  expect(view).toContain("read_file");
  expectBoundedView(view);
});

test("a supervised foreground task returns the same bounded view and the whole transcript", async () => {
  const registry = createJobRegistry({ cwd: root });
  const tool = shellExecTool(root, undefined, registry, { yieldMs: 30_000 });
  const result = await tool.invoke({ command: COMMAND });
  await registry.sweepAll();
  expect(result.isError).toBe(true);
  expectBoundedView(result.output);
  const full = result.spill?.full ?? "";
  for (const n of [1, 1500, 3000]) expect(full).toContain(`stdout line ${n}\n`);
  expect(full).toContain("FATAL: the build exploded");
});

test("an output under the cap is returned as before, with nothing to spill", async () => {
  const result = await makeCommandRunner(root)(`echo hello; echo oops >&2`);
  expect(result.spill).toBeUndefined();
  // stdout keeps its newline and the join adds one: the shape this result always had.
  expect(result.output).toBe("hello\n\noops");
  expect(result.isError).toBe(false);

  const registry = createJobRegistry({ cwd: root });
  const tool = shellExecTool(root, undefined, registry, { yieldMs: 30_000 });
  const viaRegistry = await tool.invoke({ command: `echo hello` });
  expect(viaRegistry.spill).toBeUndefined();
  expect(viaRegistry.output).toBe("hello");
});

test("stderr written EARLY stays visible when later stdout pushes it out of the tail", () => {
  const recorder = new TranscriptRecorder();
  recorder.push("EARLY-ERROR: config missing\n", "stderr");
  for (let i = 0; i < 3000; i++) recorder.push(`line ${i}\n`, "stdout");
  const view = renderShellOutput(recorder.snapshot(), undefined);
  expect(view.length).toBeLessThanOrEqual(SHELL_INLINE_CAP);
  expect(view).toContain("EARLY-ERROR: config missing");
  expect(view).toContain("line 2999");
  expect(view).toContain("stderr 1 lines, 28 bytes");
  // Nothing was saved, and the view says so instead of inventing a path.
  expect(view).toContain("not saved");
});

test("the stderr tail is not printed twice when the tail of the transcript already holds it", () => {
  const view = renderShellOutput(transcriptFromStreams("x\n".repeat(20_000), "FATAL: once"), "/tmp/o.txt");
  expect(view.split("FATAL: once")).toHaveLength(2);
});

test("a long stderr keeps its last 4000 characters and its full size in the counts", () => {
  const stderr = `${"e".repeat(60_000)}\nLAST-ERROR-LINE`;
  const view = renderShellOutput(transcriptFromStreams("out\n", stderr), "/tmp/o.txt");
  expect(view).toContain("LAST-ERROR-LINE");
  expect(view).toContain(`stderr 2 lines, ${Buffer.byteLength(stderr)} bytes`);
  expect(view.length).toBeLessThanOrEqual(SHELL_INLINE_CAP);
});

test("through the agent loop the model sees the view with the path, and the file holds both streams", async () => {
  const { provider, requests } = scriptedProvider([callRound("c0", "shell_exec", JSON.stringify({ command: COMMAND })), okReply]);
  const { io } = collectingIo();
  const history: NormalizedMessage[] = [];
  await runAgentTurn(
    { ...io, requestApproval: async () => true },
    makeDeps(provider, { tools: [shellExecTool(root)] }),
    history,
    "build it",
    { slateSession: { dir: session, cwd: root, opened: true } },
  );
  const tool = history.find((m) => m.role === "tool") as NormalizedMessage;
  expectBoundedView(tool.content);
  expect(tool.spillPath).toBeDefined();
  expect(tool.content).toContain(tool.spillPath as string);
  expect(path.dirname(tool.spillPath as string)).toBe(path.join(session, "tool-output"));
  const saved = await readFile(tool.spillPath as string, "utf8");
  expect(saved).toContain("stdout line 1500\n");
  expect(saved).toContain("stdout line 3000\n");
  expect(saved).toContain("FATAL: the build exploded");
  // What the model is sent on the next round is the bounded view, not the 3000 lines.
  const second = requests[1];
  const sent = second?.messages.find((m) => m.role === "tool")?.content ?? "";
  expect(sent.length).toBeLessThanOrEqual(SHELL_INLINE_CAP + 200);
  expect(sent).not.toContain("stdout line 1500\n");
});

test("a secret in the output is redacted in the saved file and in the view", async () => {
  const secretCommand = `i=1; while [ $i -le 3000 ]; do echo "row $i"; i=$((i+1)); done; echo "key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" >&2`;
  const { provider } = scriptedProvider([callRound("c0", "shell_exec", JSON.stringify({ command: secretCommand })), okReply]);
  const { io } = collectingIo();
  const history: NormalizedMessage[] = [];
  await runAgentTurn(
    { ...io, requestApproval: async () => true },
    makeDeps(provider, { tools: [shellExecTool(root)] }),
    history,
    "run it",
    { slateSession: { dir: session, cwd: root, opened: true } },
  );
  const tool = history.find((m) => m.role === "tool") as NormalizedMessage;
  expect(tool.content).not.toContain("sk-ant-api03");
  const saved = await readFile(tool.spillPath as string, "utf8");
  expect(saved).not.toContain("sk-ant-api03");
});
