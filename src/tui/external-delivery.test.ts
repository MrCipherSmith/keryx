// Executing operator-message delivery intents (flow 176, T18).
// Package: docs/requirements/keryx-external-agent-runtime §7.5; AC10.
//
// Every branch runs against a FAKE handle: no subprocess, no TTY, and — the
// point of the whole codec/supervisor split — no vendor subscription spent per
// test run.
import { describe, expect, test } from "bun:test";
import type { ExternalRunHandle } from "../harness/external/supervise";
import { executeExternalDelivery, STREAMING_STDIN_AGENT_ID } from "./external-delivery";
import type { ExternalDeliveryIntent } from "./addressee-queue";

function fakeHandle(writeAccepts = true): ExternalRunHandle & { writes: string[]; kills: number } {
  const writes: string[] = [];
  let kills = 0;
  return {
    writes,
    // Mirrors the real handle: a fake that always claimed streaming would hide
    // the very routing bug this field exists to prevent.
    streaming: writeAccepts,
    get kills() {
      return kills;
    },
    writeStdin(text: string): boolean {
      if (!writeAccepts) return false;
      writes.push(text);
      return true;
    },
    kill(): void {
      kills += 1;
    },
  };
}

const RUN_INPUT = { prompt: "", cwd: "/tmp/wt", sandbox: "read-only" } as const;

describe("stdin delivery", () => {
  test("writes one encoded claude stdin line and emits the user_message event", () => {
    const handle = fakeHandle();
    const intent: ExternalDeliveryIntent = { kind: "stdin", message: "focus on the flaky test" };
    const result = executeExternalDelivery(intent, { agentId: STREAMING_STDIN_AGENT_ID, handle });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe("stdin");
    expect(handle.writes).toHaveLength(1);
    const line = handle.writes[0] ?? "";
    expect(line.endsWith("\n")).toBe(true);
    expect(JSON.parse(line.trim())).toEqual({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "focus on the flaky test" }] },
    });
    // D-09: delivery and awareness are separate, and both must happen.
    expect(result.event).toEqual({ kind: "user_message", text: "focus on the flaky test" });
  });

  test("a one-shot run refuses rather than reporting a delivery that did not happen", () => {
    const handle = fakeHandle(false);
    const result = executeExternalDelivery(
      { kind: "stdin", message: "hello" },
      { agentId: STREAMING_STDIN_AGENT_ID, handle },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("one-shot");
  });

  test("an agent with no keryx stdin encoding is refused, never guessed at", () => {
    const result = executeExternalDelivery(
      { kind: "stdin", message: "hello" },
      { agentId: "codex-cli", handle: fakeHandle() },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("codex-cli");
  });

  test("no live handle is a named refusal", () => {
    const result = executeExternalDelivery(
      { kind: "stdin", message: "hello" },
      { agentId: STREAMING_STDIN_AGENT_ID },
    );
    expect(result.ok).toBe(false);
  });
});

describe("resume delivery", () => {
  test("builds the codex resume argv and carries the message verbatim", () => {
    const result = executeExternalDelivery(
      { kind: "resume", when: "now", sessionRef: "thread-9", message: "keep going" },
      { agentId: "codex-cli", runInput: RUN_INPUT },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe("resume-argv");
    expect(result.resumeArgv).toContain("thread-9");
    expect(result.resumeArgv).toContain("keep going");
    // `when: "now"` means the run already ended, so the message lands.
    expect(result.event).toEqual({ kind: "user_message", text: "keep going" });
  });

  test("a message that only lands after the run ends emits NO user_message yet", () => {
    const result = executeExternalDelivery(
      { kind: "resume", when: "after-exit", sessionRef: "thread-9", message: "later" },
      { agentId: "codex-cli", runInput: RUN_INPUT },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Emitting here would tell the parent's fold the child heard something it
    // has not heard.
    expect(result.event).toBeUndefined();
  });

  test("without the recorded launch input the resume argv is refused, not invented", () => {
    const result = executeExternalDelivery(
      { kind: "resume", when: "now", sessionRef: "s", message: "m" },
      { agentId: "claude-cli" },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("resume command");
  });

  test("an agent with no shipped codec points at the CLI that lists the real ones", () => {
    const result = executeExternalDelivery(
      { kind: "resume", when: "now", sessionRef: "s", message: "m" },
      { agentId: "not-an-agent", runInput: RUN_INPUT },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("keryx agents external list");
  });
});

describe("force", () => {
  test("kill-then-resume kills the child AND yields the resume argv", () => {
    const handle = fakeHandle();
    const result = executeExternalDelivery(
      { kind: "kill-then-resume", sessionRef: "thread-3", message: "stop and reconsider" },
      { agentId: "codex-cli", handle, runInput: RUN_INPUT },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(handle.kills).toBe(1);
    expect(result.killed).toBe(true);
    expect(result.resumeArgv).toContain("thread-3");
    expect(result.event).toEqual({ kind: "user_message", text: "stop and reconsider" });
  });

  test("a codec that cannot build the resume argv leaves the child ALIVE", () => {
    const handle = fakeHandle();
    const result = executeExternalDelivery(
      { kind: "kill-then-resume", sessionRef: "thread-3", message: "m" },
      { agentId: "codex-cli", handle },
    );
    expect(result.ok).toBe(false);
    // The whole promise of force is that intervention costs a restart, not the
    // work. Killing first and failing to build the resume afterwards breaks it.
    expect(handle.kills).toBe(0);
  });

  test("kill-only kills, says the message was lost, and emits no user_message", () => {
    const handle = fakeHandle();
    const result = executeExternalDelivery(
      { kind: "kill-only", message: "gone", reason: "no session handle was announced" },
      { agentId: "codex-cli", handle },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(handle.kills).toBe(1);
    expect(result.lost).toBe(true);
    expect(result.note).toContain("NOT delivered");
    expect(result.event).toBeUndefined();
  });
});

describe("non-delivering intents", () => {
  test("hold reports as held and touches nothing", () => {
    const handle = fakeHandle();
    const result = executeExternalDelivery(
      { kind: "hold", message: "m", reason: "no handle announced yet" },
      { agentId: "codex-cli", handle },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe("held");
    expect(handle.kills).toBe(0);
    expect(handle.writes).toHaveLength(0);
  });

  test("undeliverable forwards the planner's own reason rather than inventing one", () => {
    const result = executeExternalDelivery(
      { kind: "undeliverable", message: "m", reason: "accepts neither streaming input nor resume" },
      { agentId: "codex-cli" },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("accepts neither streaming input nor resume");
  });
});
