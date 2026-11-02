// Flow 481 T6: the herdr-core reporter's wiring into the TUI shell.
//
// The composite is driven with a fake writer; the shell lines a renderer-less test
// cannot reach are audited as source text (same style as tui-bus.test.ts).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createAgentHostStatus } from "./agent-host-status";
import { createHerdrCoreReporter, createStatusWriter, encodeOsc7501 } from "./herdr-core-status";

function harness(env: Record<string, string | undefined> = { HC_TERMINAL_ID: "t1" }) {
  const writes: string[] = [];
  const host = createAgentHostStatus({
    herdrCore: createHerdrCoreReporter({ env, write: (b) => writes.push(b), redact: (s) => s }),
  });
  return { host, writes };
}

describe("createAgentHostStatus", () => {
  test("emits nothing before markReady, even for status changes", () => {
    const { host, writes } = harness();
    host.status("queued", undefined);
    host.status("running");
    expect(writes).toEqual([]);
  });

  test("markReady emits idle for the launch queued/ready state", () => {
    const { host, writes } = harness();
    host.status("queued");
    host.markReady();
    expect(writes).toEqual([encodeOsc7501({ state: "idle" })]);
  });

  test("markReady emits the remembered state, not a stale idle", () => {
    const { host, writes } = harness();
    host.status("running");
    host.markReady();
    expect(writes).toEqual([encodeOsc7501({ state: "working" })]);
  });

  test("after ready, statuses map through the matrix", () => {
    const { host, writes } = harness();
    host.markReady();
    host.status("running");
    host.status("done");
    host.status("failed");
    host.status("blocked", { kind: "question", text: "Which branch?" });
    host.status("running");
    host.status("queued");
    expect(writes).toEqual([
      encodeOsc7501({ state: "idle" }),
      encodeOsc7501({ state: "working" }),
      encodeOsc7501({ state: "done" }),
      encodeOsc7501({ state: "error" }),
      encodeOsc7501({ state: "blocked", kind: "question", msg: "Which branch?" }),
      encodeOsc7501({ state: "working" }),
      encodeOsc7501({ state: "idle" }),
    ]);
  });

  test("blocked carries permission kind and text", () => {
    const { host, writes } = harness();
    host.markReady();
    host.status("blocked", { kind: "permission", text: "rm -rf build" });
    expect(writes.at(-1)).toBe(encodeOsc7501({ state: "blocked", kind: "permission", msg: "rm -rf build" }));
  });

  test("markReady is idempotent", () => {
    const { host, writes } = harness();
    host.markReady();
    host.markReady();
    expect(writes).toHaveLength(1);
  });

  test("exit writes clear, and later statuses do not resurrect it", () => {
    const { host, writes } = harness();
    host.markReady();
    host.exit();
    expect(writes.at(-1)).toBe(encodeOsc7501({ state: "clear" }));
    const count = writes.length;
    host.status("running");
    expect(writes).toHaveLength(count);
  });

  test("exit before ready writes only the clear; a later markReady emits nothing", () => {
    const { host, writes } = harness();
    host.status("running");
    host.exit();
    host.markReady();
    host.status("done");
    expect(writes).toEqual([encodeOsc7501({ state: "clear" })]);
  });

  test("markReady after exit cannot bring the status back", () => {
    const { host, writes } = harness();
    host.markReady();
    host.exit();
    const count = writes.length;
    host.markReady();
    expect(writes).toHaveLength(count);
  });

  test("inert without HC_TERMINAL_ID", () => {
    const { host, writes } = harness({});
    host.status("running");
    host.markReady();
    host.status("blocked", { kind: "permission", text: "x" });
    host.exit();
    expect(writes).toEqual([]);
  });
});

describe("status writer with a fake renderer", () => {
  test("goes through writeOut once per sequence, never stdout", () => {
    const out: string[] = [];
    const std: string[] = [];
    const fake = { writeOut: (c: string) => void out.push(c) };
    const host = createAgentHostStatus({
      herdrCore: createHerdrCoreReporter({
        env: { HC_TERMINAL_ID: "t1" },
        write: createStatusWriter(() => fake, (s) => void std.push(s)),
      }),
    });
    host.markReady();
    host.status("running");
    expect(out).toHaveLength(2);
    expect(std).toEqual([]);
  });

  test("falls back to stdout once the renderer is gone", () => {
    const std: string[] = [];
    let renderer: { writeOut(c: string): void } | undefined = { writeOut: () => {} };
    const host = createAgentHostStatus({
      herdrCore: createHerdrCoreReporter({
        env: { HC_TERMINAL_ID: "t1" },
        write: createStatusWriter(() => renderer, (s) => void std.push(s)),
      }),
    });
    host.markReady();
    renderer = undefined;
    host.exit();
    expect(std).toEqual([encodeOsc7501({ state: "clear" })]);
  });
});

const source = readFileSync(path.join(import.meta.dir, "tui-shell.ts"), "utf8");

describe("tui-shell wiring (source audit)", () => {
  test("the composite is built on createStatusWriter over the live renderer", () => {
    expect(source).toContain("createAgentHostStatus({");
    expect(source).toContain("createStatusWriter(() => (destroyed ? undefined : renderer))");
  });

  test("setMainAgent feeds the composite and keeps the old reporter and bus join", () => {
    expect(source).toContain("hostStatus.status(status, attention);");
    expect(source).toContain("herdr.report(herdrStateFor(status));");
    expect(source).toContain("herdrStateFor(lastMainAgentStatus)");
  });

  test("every blocked setMainAgent call passes an attention argument", () => {
    const calls = source.split('setMainAgent("blocked"').slice(1);
    expect(calls.length).toBeGreaterThanOrEqual(10);
    for (const rest of calls) {
      const head = rest.slice(0, 200);
      expect(head).toMatch(/kind: "(permission|question)"/);
    }
  });

  test("ask_user blocks with kind question", () => {
    expect(source).toContain('setMainAgent("blocked", "ask", { kind: "question", text: req.question })');
  });

  test("markReady runs after the resume picker and the submit handler, before the positional prompt", () => {
    const picker = source.indexOf("opts.session?.pickOnStart === true && opts.session.resumeId === undefined");
    const ready = source.indexOf("hostStatus.markReady();");
    const onSubmit = source.indexOf("chrome.onSubmit((line) => {");
    const initial = source.indexOf("opts.takeInitialPrompt?.()");
    expect(picker).toBeGreaterThan(0);
    expect(ready).toBeGreaterThan(picker);
    expect(source.indexOf("hostStatus.markReady();", ready + 1)).toBe(-1);
    // `idle` is the signal herdr-core types a line on: the handler that receives it must exist already,
    // with no await between the two (a line typed on the first `idle` would be cleared and dropped).
    expect(ready).toBeGreaterThan(onSubmit);
    expect(initial).toBeGreaterThan(ready);
    expect(source.slice(onSubmit, ready)).not.toMatch(/\bawait\b/);
  });

  test("every herdr.release() is paired with the composite's exit", () => {
    const releases = source.split("await herdr.release();").length - 1;
    const exits = source.split("hostStatus.exit();").length - 1;
    expect(releases).toBeGreaterThan(0);
    expect(exits).toBe(releases);
  });

  test("the shell's finally clears the status before its first await", () => {
    expect(source).toMatch(
      /\} finally \{\n(?:\s*\/\/[^\n]*\n)*\s*hostStatus\.exit\(\);\n\s*const preservation = await finalizeShell\?\.\(\);/,
    );
  });

  test("with a positional prompt the startup notices go to the transcript, not the splash it removes", () => {
    expect(source).toContain(
      "const splashRemovedBeforeFirstFrame = viewedReadOnly || opts.takeInitialPrompt !== undefined;",
    );
    expect(source).toContain(
      "if (splashRemovedBeforeFirstFrame || splash?.addStatusIfShown(text) !== true) {",
    );
    const decided = source.indexOf("const splashRemovedBeforeFirstFrame");
    const notices = source.indexOf("hooks?.takeNotices?.()");
    // The call, not the comment above the notice decision that names it.
    const submitted = source.lastIndexOf('runLine(initialPrompt, "operator", undefined, true);');
    expect(decided).toBeGreaterThan(-1);
    expect(notices).toBeGreaterThan(decided);
    expect(submitted).toBeGreaterThan(notices);
  });
});
