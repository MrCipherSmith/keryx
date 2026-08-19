// The external-agent operator loop (flow 176, T18).
// Package: docs/requirements/keryx-external-agent-runtime §7.5, §8.2;
// prd R17-R21, R25; AC10.
//
// Headless throughout: a fake `runExternal` hook, a fake `ExternalRunHandle`,
// and no renderer. Nothing here spawns a vendor CLI or spends a subscription.
import { describe, expect, test } from "bun:test";
import type { ExternalRunHandle } from "../harness/external/supervise";
import type { StructuredSubagentResult } from "../harness/tool/builtin/spawn-subagent-tool";
import type { ExternalRunSignal } from "./external-bridge";
import {
  approveExternalSpawn,
  hasExternalSpawnApprover,
  NO_EXTERNAL_APPROVER_REASON,
  setExternalRunListener,
  setExternalSpawnApprover,
} from "./external-bridge";
import { attachExternalOperator, ExternalOperator } from "./external-operator";
import { setSubagentFleetListener, type SubagentFleetEvent } from "./subagent-bridge";

function handle(): ExternalRunHandle & { writes: string[]; kills: number } {
  const writes: string[] = [];
  let kills = 0;
  return {
    writes,
    get kills() {
      return kills;
    },
    writeStdin(text) {
      writes.push(text);
      return true;
    },
    kill() {
      kills += 1;
    },
  };
}

function start(id: string, agentId: string): ExternalRunSignal {
  return { kind: "start", id, run: { runId: id, agentId, label: "probe", task: "look at the flake" } };
}

const OK: StructuredSubagentResult = { status: "Completed", output: "done", isError: false };

describe("bridge signals fold into the run store", () => {
  test("start registers the run with its registry label and cost posture", () => {
    const op = new ExternalOperator();
    op.apply(start("r1", "codex-cli"));
    const view = op.store.get("r1");
    expect(view?.agentId).toBe("codex-cli");
    expect(view?.agentLabel).toBe("Codex");
    // codex reports no monetary cost; the Meta view turns that into an EXPLAINED
    // missing rather than a zero.
    expect(view?.reportsCost).toBe(false);
  });

  test("events, warnings and the outcome all land on the same record", () => {
    const op = new ExternalOperator();
    op.apply(start("r1", "codex-cli"));
    op.apply({ kind: "event", id: "r1", event: { kind: "child_started", sessionRef: "thread-7" } });
    op.apply({ kind: "warning", id: "r1", warning: "version below the recorded minimum" });
    op.apply({
      kind: "outcome",
      id: "r1",
      outcome: {
        status: "Completed",
        output: "done",
        isError: false,
        argv: ["codex", "exec"],
        worktreePath: "/tmp/wt",
        skippedLines: 1,
      },
    });
    const view = op.store.get("r1");
    expect(view?.sessionRef).toBe("thread-7");
    expect(view?.warnings).toEqual(["version below the recorded minimum"]);
    expect(view?.status).toBe("Completed");
    expect(view?.argv).toEqual(["codex", "exec"]);
    expect(op.store.isRunning("r1")).toBe(false);
  });

  test("a refusal that never reached the runtime still closes the run and records why", () => {
    const op = new ExternalOperator();
    op.apply(start("r1", "codex-cli"));
    op.apply({
      kind: "result",
      id: "r1",
      result: { status: "Denied", output: "the capability is disabled", isError: true },
    });
    expect(op.store.isRunning("r1")).toBe(false);
    expect(op.store.get("r1")?.status).toBe("Denied");
    // Silent no-ops are the one failure mode security-policy §5 forbids.
    expect(op.store.get("r1")?.warnings).toContain("the capability is disabled");
  });

  test("a result arriving after an outcome does not overwrite the real status", () => {
    const op = new ExternalOperator();
    op.apply(start("r1", "codex-cli"));
    op.apply({
      kind: "outcome",
      id: "r1",
      outcome: { status: "Timeout", output: "", isError: true },
    });
    op.apply({ kind: "result", id: "r1", result: { status: "Timeout", output: "", isError: true } });
    expect(op.store.get("r1")?.status).toBe("Timeout");
    expect(op.store.get("r1")?.warnings ?? []).toHaveLength(0);
  });
});

describe("delivery against a live run", () => {
  test("codex holds a message until it announces a thread id, then delivers it", () => {
    const op = new ExternalOperator({ idSeq: () => "1" });
    op.apply(start("r1", "codex-cli"));
    const h = handle();
    op.apply({ kind: "spawned", id: "r1", handle: h });

    // No handle announced yet: codex cannot be resumed, so the message WAITS.
    const held = op.deliver("r1", "check the retry path");
    expect(held.ok).toBe(true);
    if (!held.ok) return;
    expect(held.action).toBe("held");
    expect(op.queue("r1")).toHaveLength(1);

    // `thread.started` arrives — the exact moment §7.5 says the route opens.
    op.apply({ kind: "event", id: "r1", event: { kind: "child_started", sessionRef: "thread-2" } });
    expect(op.queue("r1")).toHaveLength(0);
    const events = op.store.get("r1")?.events ?? [];
    // The message is queued for after-exit, so no `user_message` yet (D-09).
    expect(events.some((e) => e.kind === "user_message")).toBe(false);
    expect(op.store.get("r1")?.resumeArgv).toContain("thread-2");
  });

  test("force on a codex run with no handle kills it and says the message was lost", () => {
    const op = new ExternalOperator({ idSeq: () => "1" });
    op.apply(start("r1", "codex-cli"));
    const h = handle();
    op.apply({ kind: "spawned", id: "r1", handle: h });

    const result = op.deliver("r1", "stop", { force: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe("kill-only");
    expect(result.lost).toBe(true);
    expect(h.kills).toBe(1);
  });

  test("force on a run with a handle kills it and records the resume argv (R20, R21)", () => {
    const op = new ExternalOperator({ idSeq: () => "1" });
    op.apply(start("r1", "codex-cli"));
    op.apply({ kind: "spawned", id: "r1", handle: handle() });
    op.apply({ kind: "event", id: "r1", event: { kind: "child_started", sessionRef: "thread-4" } });

    const result = op.deliver("r1", "reconsider", { force: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe("kill-then-resume-argv");
    // AC10 / D-09: a delivered message emits the canonical event into the same
    // stream the store and the parent's folded view read.
    const events = op.store.get("r1")?.events ?? [];
    expect(events).toContainEqual({ kind: "user_message", text: "reconsider" });
    expect(op.store.get("r1")?.resumeArgv).toContain("reconsider");
  });

  test("a message that becomes undeliverable while queued is REPORTED, never dropped", () => {
    const delivered: Array<[string, boolean]> = [];
    const op = new ExternalOperator({
      idSeq: () => "1",
      onDelivery: (runId, result) => delivered.push([runId, result.ok]),
    });
    op.apply(start("r1", "codex-cli"));
    op.apply({ kind: "spawned", id: "r1", handle: handle() });
    op.deliver("r1", "look at the retry path");
    expect(op.queue("r1")).toHaveLength(1);

    // The run ends without ever announcing a thread id: codex cannot be resumed,
    // so the queued message can never land. An operator who is not told keeps
    // waiting for a reply that is not coming.
    op.apply({ kind: "outcome", id: "r1", outcome: { status: "Error", output: "", isError: true } });
    expect(op.queue("r1")).toHaveLength(0);
    expect(delivered).toEqual([["r1", false]]);
  });

  test("an unknown run id is a named refusal, never a silent no-op", () => {
    const op = new ExternalOperator();
    const result = op.deliver("nope", "hi");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("nope");
  });

  test("queued messages keep their order when the route opens", () => {
    const op = new ExternalOperator({ idSeq: (() => {
      let n = 0;
      return () => `${(n += 1)}`;
    })() });
    op.apply(start("r1", "codex-cli"));
    op.apply({ kind: "spawned", id: "r1", handle: handle() });
    op.deliver("r1", "first");
    op.deliver("r1", "second");
    expect(op.queue("r1").map((item) => item.question)).toEqual(["first", "second"]);

    op.apply({ kind: "event", id: "r1", event: { kind: "child_started", sessionRef: "t" } });
    expect(op.queue("r1")).toHaveLength(0);
  });

  test("remove and edit behave exactly as they do on the main queue", () => {
    const op = new ExternalOperator({ idSeq: (() => {
      let n = 0;
      return () => `${(n += 1)}`;
    })() });
    op.apply(start("r1", "codex-cli"));
    op.enqueue("r1", "one");
    op.enqueue("r1", "two");

    expect(op.removeQueued("r1", 0)?.question).toBe("one");
    const edited = op.editQueued("r1", 0);
    expect(edited?.text).toBe("two");
    expect(op.queue("r1")).toHaveLength(0);
    op.reinsertQueued("r1", edited?.at ?? 0, edited?.item ?? { id: "x", question: "", displayQuestion: "" });
    expect(op.queue("r1").map((i) => i.question)).toEqual(["two"]);
    // Out of range is a no-op copy, never a throw (a stale qN from a reflowed queue).
    expect(op.removeQueued("r1", 99)).toBeUndefined();
  });
});

describe("kill", () => {
  test("a run with a live handle is killed; one without is refused by name", () => {
    const op = new ExternalOperator();
    op.apply(start("r1", "codex-cli"));
    expect(op.kill("r1").ok).toBe(false);
    const h = handle();
    op.apply({ kind: "spawned", id: "r1", handle: h });
    expect(op.kill("r1").ok).toBe(true);
    expect(h.kills).toBe(1);
  });
});

describe("/delegate", () => {
  test("starts a run through the same runExternal hook the model uses", async () => {
    const seen: unknown[] = [];
    const op = new ExternalOperator({
      idSeq: () => "abc",
      runExternal: async (request) => {
        seen.push(request);
        return OK;
      },
    });
    const outcome = await op.delegate({ agentId: "codex-cli", task: "find the flake" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.runId).toBe("ext:abc");
    expect(seen[0]).toMatchObject({
      runtime: { kind: "external", agent: "codex-cli", sandbox: "read-only" },
      task: "find the flake",
      mode: "read_only",
      workerId: "ext:abc",
    });
  });

  test("an unknown agent is refused with a pointer at the listing command", async () => {
    const op = new ExternalOperator({ runExternal: async () => OK });
    const outcome = await op.delegate({ agentId: "gpt-cli", task: "t" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toContain("keryx agents external list");
  });

  test("a session with no runtime wired refuses instead of pretending", async () => {
    const op = new ExternalOperator();
    const outcome = await op.delegate({ agentId: "codex-cli", task: "t" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toContain("keryx agents external list");
  });

  test("the run appears in the subagent sidebar marked as external (§8.2)", async () => {
    const events: SubagentFleetEvent[] = [];
    setSubagentFleetListener((e) => events.push(e));
    try {
      const op = new ExternalOperator({ idSeq: () => "abc", runExternal: async () => OK });
      await op.delegate({ agentId: "codex-cli", task: "t" });
      const upserts = events.filter((e) => e.kind === "upsert");
      expect(upserts).toHaveLength(2);
      for (const event of upserts) {
        expect(event).toMatchObject({ id: "ext:abc", runtime: "external", agentId: "codex-cli" });
      }
      expect(upserts[1]).toMatchObject({ status: "done" });
    } finally {
      setSubagentFleetListener(undefined);
    }
  });

  test("a throwing hook is a keryx bug and never surfaces as the vendor refusing", async () => {
    const op = new ExternalOperator({
      idSeq: () => "abc",
      runExternal: async () => {
        throw new Error("port exploded");
      },
    });
    const outcome = await op.delegate({ agentId: "codex-cli", task: "t" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toContain("port exploded");
  });
});

describe("the spawn approver", () => {
  test("an operator-initiated run is never re-asked; a model-initiated one always is", async () => {
    const asked: string[] = [];
    let operatorWorkerId = "";
    const op = new ExternalOperator({
      idSeq: () => "abc",
      runExternal: async (request) => {
        // Runs INSIDE `delegate`, i.e. while the id is registered as
        // operator-initiated — exactly when the factory would call the approver.
        operatorWorkerId = request.workerId;
        return OK;
      },
    });
    const approve = op.approver(async (request) => {
      asked.push(request.workerId);
      return true;
    });

    await op.delegate({ agentId: "codex-cli", task: "t" });

    const model = await approve({
      agentId: "codex-cli",
      label: "l",
      task: "t",
      sandbox: "read-only",
      workerId: "sub:model-initiated",
    });
    expect(model).toBe(true);
    expect(asked).toEqual(["sub:model-initiated"]);
    expect(operatorWorkerId).toBe("ext:abc");
  });

  test("an operator-initiated id IS auto-approved while its run is in flight", async () => {
    let verdict: unknown;
    const op = new ExternalOperator({
      idSeq: () => "abc",
      runExternal: async (request) => {
        verdict = await op.approver(async () => false)({
          agentId: "codex-cli",
          label: "l",
          task: "t",
          sandbox: "read-only",
          workerId: request.workerId,
        });
        return OK;
      },
    });
    await op.delegate({ agentId: "codex-cli", task: "t" });
    expect(verdict).toEqual({ ok: true });
  });
});

describe("the module-level bridge", () => {
  test("with no host registered, approval is REFUSED with a named reason", async () => {
    setExternalSpawnApprover(undefined);
    expect(hasExternalSpawnApprover()).toBe(false);
    const answer = await approveExternalSpawn({
      agentId: "codex-cli",
      label: "l",
      task: "t",
      sandbox: "read-only",
      workerId: "sub:1",
    });
    // A host that cannot ask must not self-approve (security-policy §6).
    expect(answer).toEqual({ ok: false, reason: NO_EXTERNAL_APPROVER_REASON });
  });

  test("an approver that throws has not approved anything, and says so", async () => {
    setExternalSpawnApprover(async () => {
      throw new Error("modal closed");
    });
    try {
      const answer = await approveExternalSpawn({
        agentId: "codex-cli",
        label: "l",
        task: "t",
        sandbox: "read-only",
        workerId: "sub:1",
      });
      expect(answer).toMatchObject({ ok: false });
      expect(JSON.stringify(answer)).toContain("modal closed");
    } finally {
      setExternalSpawnApprover(undefined);
    }
  });

  test("attach registers both channels and detach removes both", async () => {
    setExternalRunListener(undefined);
    setExternalSpawnApprover(undefined);
    const attached = attachExternalOperator({
      cwd: "/tmp",
      ask: async () => true,
      // Injected so attaching resolves no capability and reads no config.
      makeRunExternal: () => async () => OK,
    });
    expect(hasExternalSpawnApprover()).toBe(true);
    attached.detach();
    expect(hasExternalSpawnApprover()).toBe(false);
    expect(
      await approveExternalSpawn({
        agentId: "codex-cli",
        label: "l",
        task: "t",
        sandbox: "read-only",
        workerId: "sub:1",
      }),
    ).toEqual({ ok: false, reason: NO_EXTERNAL_APPROVER_REASON });
  });
});
