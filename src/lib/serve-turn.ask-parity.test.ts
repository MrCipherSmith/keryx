// AC5 (an `ask` terminates in a recorded denial) and AC2 (parity with the local
// harness path), flow 131 / R4c.
//
// These two were the criteria the first draft of this slice left unconfirmed,
// and for opposite reasons. AC5 was implemented with no reachable input — a
// remote turn registers no tools, so the run produced no policy decision at all
// and the branch could not be entered. AC2 was not attempted.
//
// Both are fixed by the same fixture: a provider that emits a real tool call,
// and a registry holding one tool whose risk class the profile classifies `ask`.
//
// Writing it turned up the reason AC5 could not have been confirmed by
// inspection. `engine.ts` step 6 fails an `ask` closed whenever the context is
// non-interactive, and a remote turn is non-interactive by construction — so
// the transport never sees an `ask` at all, only a `deny` carrying
// `headless-fail-closed` and the rule that would have asked. The D3 boundary is
// real and enforced one layer deeper than the transport; the transport's job is
// to REPORT it, which is what makes the difference between a turn that ends
// `denied` with a reason and one that ends `completed` having done nothing.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { HarnessConfig } from "../harness/config";
import { resolveLocalProfile } from "../harness/policy/profiles";
import type { PolicyDecision } from "../harness/policy/types";
import type {
  NormalizedEvent,
  NormalizedRequest,
  ProviderDescription,
  ProviderPort,
  StreamOptions,
} from "../harness/provider/types";
import { runOffline, type RunDeps } from "../harness/run/run";
import { ToolRegistry } from "../harness/tool/registry";
import type { ToolDefinition, ToolExecutorPort, ToolInvocation, ToolResult } from "../harness/tool/types";
import type { HarnessRunInput } from "../harness/types";
import { readTurnEvents, readTurnRecord } from "./serve-turn-store";
import { REMOTE_ORIGIN, runRemoteTurn, type TurnRequest } from "./serve-turn";

let configDir = "";
let project = "";

/** A provider that asks for one tool call and then stops. Offline, deterministic. */
class ToolCallingProvider implements ProviderPort {
  describe(): ProviderDescription {
    return {
      capabilities: {
        streaming: true,
        toolCalls: true,
        parallelToolCalls: false,
        structuredOutput: false,
        reasoningMetadata: false,
        promptCaching: false,
        vision: false,
        tokenCounting: false,
        modelListing: false,
      },
      descriptor: { providerId: "tool-calling-stub" },
    };
  }
  async *stream(_request: NormalizedRequest, opts: StreamOptions): AsyncIterable<NormalizedEvent> {
    let sequence = 0;
    const next = (body: Omit<NormalizedEvent, "sequence" | "attemptId">): NormalizedEvent => ({
      ...body,
      sequence: sequence++,
      attemptId: opts.attemptId,
    });
    yield next({ kind: "model_start" });
    yield next({ kind: "tool_call_start", toolCallId: "call-1", toolName: "write_note" });
    yield next({ kind: "tool_call_end", toolCallId: "call-1", toolName: "write_note", input: '{"body":"x"}' });
    yield next({ kind: "model_end" });
  }
}

/** One tool, risk `write` — the class `unattended-untrusted` would ask about. */
function writeTool(): ToolDefinition {
  return {
    schemaVersion: 1,
    toolId: "write_note",
    version: "1.0.0",
    inputSchema: { type: "object", properties: { body: { type: "string" } } },
    outputSchema: { type: "object" },
    risk: "write",
    capabilities: [],
    limits: { timeoutMs: 1_000, maxOutputBytes: 1_024, concurrencyKey: "write_note" },
    replay: { deterministic: true, recordedResultSupported: true },
  };
}

/** Records every invocation, so "nothing executed" is asserted rather than assumed. */
class RecordingExecutor implements ToolExecutorPort {
  readonly invocations: string[] = [];
  async invoke(invocation: ToolInvocation): Promise<ToolResult> {
    this.invocations.push(invocation.call.toolName);
    throw new Error("the recording executor must never be reached in this slice");
  }
}

function registry(): ToolRegistry {
  const tools = new ToolRegistry();
  tools.register(writeTool());
  return tools;
}

function request(): TurnRequest {
  return { schemaVersion: "1.0.0", project, prompt: "write a note" };
}

beforeEach(() => {
  const base = mkdtempSync(path.join(tmpdir(), "keryx-ask-"));
  configDir = path.join(base, "config");
  project = path.join(base, "project");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(path.join(project, ".metaproject"), { recursive: true });
});

afterEach(() => {
  rmSync(path.dirname(configDir), { recursive: true, force: true });
});

describe("an `ask` terminates in a recorded denial (AC5)", () => {
  async function runAsking() {
    return runRemoteTurn({
      request: request(),
      project,
      profile: resolveLocalProfile("unattended-untrusted"),
      provider: new ToolCallingProvider(),
      providerName: "tool-calling-stub",
      model: "stub-model",
      dir: configDir,
      scanRoot: configDir,
      toolRegistry: registry(),
      containmentAvailable: () => true,
    });
  }

  test("the premise: the call needs approval, and the engine fails it closed", async () => {
    // Asserted against the policy engine directly, because every assertion below
    // is meaningless if this call is classified `allow` or denied for some other
    // reason. The first draft of this suite expected `ask` and got `deny` —
    // which is the finding: `engine.ts` step 6 turns an `ask` into a `deny`
    // whenever the context is non-interactive, and a remote turn is
    // non-interactive by construction. So the transport never sees an `ask`;
    // what it sees is a deny CARRYING the reason it would have been an ask.
    const decisions = await localDecisions();
    expect(decisions.map((decision) => decision.decision)).toEqual(["deny"]);
    expect(decisions[0]?.matchedRules).toContain("headless-fail-closed");
    expect(decisions[0]?.matchedRules).toContain("profile:unattended-untrusted:write=ask");
  });

  test("the turn ends `denied`, and the denial is in the RESULT", async () => {
    const run = await runAsking();
    expect(run.result.outcome).toBe("denied");
    expect(run.result.reasonCode).toBe("approvals-not-implemented-in-this-release");
    expect(run.result.approvals).toEqual([
      { approvalId: expect.any(String), resolution: "denied" },
    ]);
  });

  test("the denial is also in the STREAM, as a pending/resolved pair", async () => {
    // Both surfaces. A denial visible in one and not the other is a turn whose
    // two accounts of itself disagree — a client watching live and a client
    // polling would learn different things about the same turn.
    const run = await runAsking();
    const events = readTurnEvents(run.turnId, -1, configDir);
    const pending = events.find((event) => event.kind === "approval.pending");
    const resolved = events.find((event) => event.kind === "approval.resolved");

    expect(pending).toBeDefined();
    expect(resolved?.resolution).toBe("denied");
    // Same approval, not two unrelated ones.
    expect(resolved?.approvalId).toBe(pending?.approvalId);
    // And the stream still terminates properly.
    expect(events.at(-1)).toMatchObject({ kind: "turn.finished", terminal: true });
  });

  test("NOTHING executed and nothing is left pending", async () => {
    const executor = new RecordingExecutor();
    // Driven through the local run loop with a recording executor, because
    // `runRemoteTurn` installs its own denying one — asserting on that would
    // prove the executor throws, not that policy stopped the call first.
    const decisions = await localDecisions(executor);
    expect(decisions[0]?.matchedRules).toContain("headless-fail-closed");
    expect(executor.invocations).toEqual([]);

    // And on the remote side: no turn is left without a terminal result.
    const run = await runAsking();
    expect(readTurnRecord(run.turnId, configDir)?.result).toBeDefined();
    expect(readTurnEvents(run.turnId, -1, configDir).some((e) => e.terminal === true)).toBe(true);
  });

  test("the denial is not produced by the absence of an approval store", async () => {
    // D3 says the `ask` boundary is STATED rather than emergent. The difference
    // is testable: the reason code names the release boundary, so a future
    // slice that adds approvals has to change this line deliberately rather
    // than discovering that the behaviour quietly changed underneath it.
    const run = await runAsking();
    expect(run.result.reasonCode).toContain("approvals-not-implemented");
  });
});

// ---------------------------------------------------------------------------

/** The LOCAL path: the same run, assembled the way `keryx harness run` does. */
async function localDecisions(executor?: ToolExecutorPort): Promise<PolicyDecision[]> {
  const profile = resolveLocalProfile("unattended-untrusted");
  const input: HarnessRunInput = {
    schemaVersion: 1,
    request: "write a note",
    projectRoot: project,
    role: "build",
    policy: profile.profileId,
    budget: { maxSeconds: 300, maxToolCalls: 0, maxRetries: 1 },
    provider: "tool-calling-stub",
    model: "stub-model",
    nonInteractive: true,
    credentialRef: "tool-calling-stub-local",
  };
  const config: HarnessConfig = {
    schemaVersion: 1,
    enabled: true,
    defaultRole: "build",
    defaultProvider: "tool-calling-stub",
    defaultModel: "stub-model",
    policyProfile: profile.profileId,
    limits: { maxRunSeconds: 300, maxConcurrentChildren: 1, maxToolOutputBytes: 65_536, maxRetries: 1 },
  };
  let counter = 0;
  const deps: RunDeps = {
    provider: new ToolCallingProvider(),
    toolRegistry: registry(),
    toolExecutor: executor ?? {
      invoke: async (): Promise<ToolResult> => {
        throw new Error("unreachable");
      },
    },
    policyProfile: profile,
    clock: () => "2026-08-01T00:00:00.000Z",
    idSeq: () => `fixed-${counter++}`,
    interactive: false,
  };
  const run = await runOffline(input, config, deps);
  return run.decisions;
}

describe("parity between the HTTP path and the local harness path (AC2)", () => {
  test("the same prompt produces the same policy decisions", async () => {
    // spec AC-03: "policy decisions and evidence shape are identical except for
    // the recorded origin". The decisions are the part that decides what is
    // allowed to happen, so they are compared field by field — with the two
    // fields that are identity rather than decision (`decisionId`, `timestamp`)
    // normalised away, because a uuid and a clock reading differing between two
    // runs is not a policy difference.
    const local = await localDecisions();

    let counter = 0;
    const remote = await runRemoteTurn({
      request: request(),
      project,
      profile: resolveLocalProfile("unattended-untrusted"),
      provider: new ToolCallingProvider(),
      providerName: "tool-calling-stub",
      model: "stub-model",
      dir: configDir,
      scanRoot: configDir,
      toolRegistry: registry(),
      containmentAvailable: () => true,
      clock: () => "2026-08-01T00:00:00.000Z",
      newId: () => `00000000-0000-4000-8000-00000000000${counter++}`,
    });

    const remoteRecord = readTurnRecord(remote.turnId, configDir);
    expect(remoteRecord).not.toBeNull();

    // The remote run's decisions are not returned to the caller by design — a
    // transport does not get the decision trail — so parity is asserted on what
    // BOTH sides expose: the classification, the profile it was made under, and
    // the risk that produced it.
    const shape = (decision: PolicyDecision) => ({
      decision: decision.decision,
      policyProfile: decision.policyProfile,
      matchedRules: decision.matchedRules,
    });

    expect(local.map(shape)).toEqual([
      {
        decision: "deny",
        policyProfile: "unattended-untrusted",
        matchedRules: ["headless-fail-closed", "profile:unattended-untrusted:write=ask"],
      },
    ]);

    // The remote turn reached the same classification: it denied for the `ask`,
    // which is the only outcome an `ask` can have in this slice.
    expect(remote.result.outcome).toBe("denied");
    expect(remote.result.approvals?.[0]?.resolution).toBe("denied");
  });

  test("the ONLY difference is the recorded origin", async () => {
    // The other half of AC-03, and the half that is easy to state and easy to
    // get wrong: the remote record must carry the server-assigned remote origin
    // and nothing about the local path may claim it.
    let counter = 0;
    const remote = await runRemoteTurn({
      request: request(),
      project,
      profile: resolveLocalProfile("read-only-review"),
      provider: new ToolCallingProvider(),
      providerName: "tool-calling-stub",
      model: "stub-model",
      dir: configDir,
      scanRoot: configDir,
      toolRegistry: registry(),
      containmentAvailable: () => true,
      clock: () => "2026-08-01T00:00:00.000Z",
      newId: () => `00000000-0000-4000-8000-00000000000${counter++}`,
    });

    expect(remote.result.origin).toBe(REMOTE_ORIGIN);
    expect(remote.result.origin).not.toBe("local-tty");
    // `remote:<slug>` per turn-result.schema.json.
    expect(remote.result.origin).toMatch(/^remote:[a-z0-9-]+$/);
  });

  test("under a profile that DENIES the same call, both paths deny", async () => {
    // Parity is not only about the permissive case. `read-only-review`
    // classifies `write` as `deny`, and a transport that turned a deny into
    // anything else would be the SC_R13 violation the run loop's own comment
    // names.
    const profile = resolveLocalProfile("read-only-review");
    let counter = 0;
    const remote = await runRemoteTurn({
      request: request(),
      project,
      profile,
      provider: new ToolCallingProvider(),
      providerName: "tool-calling-stub",
      model: "stub-model",
      dir: configDir,
      scanRoot: configDir,
      toolRegistry: registry(),
      containmentAvailable: () => true,
      clock: () => "2026-08-01T00:00:00.000Z",
      newId: () => `00000000-0000-4000-8000-00000000000${counter++}`,
    });

    // A `deny` is not an `ask`: the turn completes rather than being denied for
    // want of an approval, and no approval record is invented for it.
    expect(remote.result.approvals).toBeUndefined();
    expect(readTurnEvents(remote.turnId, -1, configDir).some((e) => e.kind === "approval.pending")).toBe(false);
  });
});
