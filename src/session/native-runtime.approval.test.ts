import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNativeSessionRuntime } from "./native-runtime";
import { resolveLocalProfile } from "../harness/policy/profiles";
import { callRound, okReply, scriptedProvider } from "../commands/agent.test-helpers";

const config = { configVersion: 1, baselineCandidateId: "scripted:m", reasoningEffort: "none" as const, routing: { enabled: false, profileId: "local", candidateIds: ["scripted:m"], fallbackCandidateId: "scripted:m" },
  policyDigest: "a".repeat(64), capabilityDigest: "a".repeat(64) };

test("the host's ask restriction makes a mutating call ask even where the floor allows it and the turn's own mode would not ask", async () => {
  for (const asked of [false, true]) {
    const cwd = await mkdtemp(join(tmpdir(), "keryx-runtime-ask-"));
    const provider = scriptedProvider([callRound("shell", "shell_exec", JSON.stringify({ command: "echo native-approval" })), okReply]);
    // monitored-trusted-local allows a shell call without asking; the caller's mode is the most permissive one.
    const runtime = createNativeSessionRuntime({ cwd, provider: provider.provider, providerId: "scripted", modelId: "m", policy: resolveLocalProfile("monitored-trusted-local") });
    runtime.bindRestrictions(() => false, (version) => asked && version === 1);
    const approvals: string[] = []; const risks: unknown[] = []; const results: string[] = [];
    try {
      const snapshot = await runtime.routing(config).select("run the echo", config);
      await runtime.run({ write: () => {}, permissionMode: () => "auto", onToolResult: (_name, result) => results.push(result.output),
        requestApproval: async (name, _input, meta) => { approvals.push(name); risks.push(meta?.risk); return meta === undefined ? false : { approved: true, fingerprint: meta.fingerprint }; } }, [], "Run the echo", snapshot, {});
      expect({ asked, approvals }).toEqual({ asked, approvals: asked ? ["shell_exec"] : [] });
      expect(risks).toEqual(asked ? ["shell"] : []);
      expect(results.some((output) => output.includes("native-approval"))).toBe(true);
    } finally { await runtime.stop(); await rm(cwd, { recursive: true, force: true }); }
  }
});

test("a denied approval under the ask restriction leaves the call unexecuted", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "keryx-runtime-ask-deny-"));
  const provider = scriptedProvider([callRound("shell", "shell_exec", JSON.stringify({ command: "echo must-not-run" })), okReply]);
  const runtime = createNativeSessionRuntime({ cwd, provider: provider.provider, providerId: "scripted", modelId: "m", policy: resolveLocalProfile("monitored-trusted-local") });
  runtime.bindRestrictions(() => false, () => true);
  const results: string[] = [];
  try {
    const snapshot = await runtime.routing(config).select("run the echo", config);
    await runtime.run({ write: () => {}, permissionMode: () => "auto", onToolResult: (_name, result) => results.push(result.output), requestApproval: async () => false }, [], "Run the echo", snapshot, {});
    expect(results.some((output) => output.includes("must-not-run"))).toBe(false);
    expect(runtime.jobs.list()).toEqual([]);
  } finally { await runtime.stop(); await rm(cwd, { recursive: true, force: true }); }
});
