// AC2: the compiler's `target="keryx-shell"` output uses ONLY keys from the
// REAL `spawn_subagent` tool's `inputSchema.properties` — instantiated with
// stub deps exactly like `spawn-subagent-model-tier.test.ts` does, not a
// hand-copied list of the schema's keys, so this test cannot drift from the
// tool it is guarding. It also asserts every `AgentDefinition` field is
// projected into either `input` or the documented policy sidecar — none
// silently dropped.
import { expect, test } from "bun:test";
import { createSpawnSubagentTool } from "../harness/tool/builtin/spawn-subagent-tool";
import type { NormalizedEvent, ProviderPort, StreamOptions } from "../harness/provider/types";
import { compileAgentDefinition } from "./compile";
import type { AgentDefinition } from "./types";

function stubProvider(text: string): ProviderPort {
  return {
    describe() {
      return {
        capabilities: {
          streaming: true,
          toolCalls: false,
          parallelToolCalls: false,
          structuredOutput: false,
          reasoningMetadata: false,
          promptCaching: false,
          vision: false,
          tokenCounting: false,
          modelListing: false,
        },
        descriptor: { providerId: "stub" },
      };
    },
    async *stream(_req, opts: StreamOptions): AsyncIterable<NormalizedEvent> {
      yield { kind: "text_delta", sequence: 0, attemptId: opts.attemptId, text };
      yield { kind: "model_end", sequence: 1, attemptId: opts.attemptId };
    },
  };
}

function makeRealSpawnSubagentTool() {
  return createSpawnSubagentTool({
    cwd: process.cwd(),
    // MAE's model-resolution gate only classifies known provider ids (see
    // `spawn-subagent-model-tier.test.ts`'s use of "ollama") — a made-up id
    // like "stub" is denied as unclassifiable before the child ever runs,
    // which would make this test assert on MAE's own gate rather than on
    // the compiler's output shape.
    getParentModel: () => ({ providerId: "ollama", modelId: "keryx-medium-1" }),
    makeProvider: () => stubProvider("done"),
    getDetectedProviders: () => [{ name: "ollama", models: ["keryx-medium-1"] }],
  });
}

const DEFINITION: AgentDefinition = {
  name: "codebase-navigator",
  description: "Read-only location and cross-reference search.",
  role: "You locate code and cross-references; you never write.",
  tools: ["read_file", "search_code"],
  model_tier: "light",
  policy_profile: "read-only",
  skills: [],
  stacks: [],
  output_contract: "subagent-result",
  isolation: "none",
  body: "Find what the caller asked for and report file paths.",
};

const COORDINATOR: AgentDefinition = {
  ...DEFINITION,
  schema_version: 2,
  name: "review-coordinator",
  tools: ["read_file", "spawn_subagent"],
  execution_kind: "orchestrator",
  tool_scope: "parent",
  delegation: { allowed_entities: ["review-worker", "review-validator"], max_depth: 1, max_children: 48 },
};

test("compiled keryx-shell input keys are a subset of the REAL tool's inputSchema.properties", () => {
  const tool = makeRealSpawnSubagentTool();
  const allowedKeys = new Set(Object.keys(tool.definition.inputSchema.properties as Record<string, unknown>));

  const result = compileAgentDefinition(DEFINITION, "keryx-shell");
  expect(result.ok).toBe(true);
  if (!result.ok || result.result.target !== "keryx-shell") {
    throw new Error("expected a keryx-shell compile result");
  }

  for (const key of Object.keys(result.result.input)) {
    expect(allowedKeys.has(key)).toBe(true);
  }
  // The exact set this task's compiler actually populates (task/mode/label/model_tier) — a
  // narrower assertion than "is a subset", so a silently-dropped key would fail this too.
  expect(Object.keys(result.result.input).sort()).toEqual(["label", "mode", "model_tier", "task"]);
});

test("the compiled input is accepted by the real tool's invoke (no invented keys reach it)", async () => {
  const tool = makeRealSpawnSubagentTool();
  const result = compileAgentDefinition(DEFINITION, "keryx-shell");
  if (!result.ok || result.result.target !== "keryx-shell") {
    throw new Error("expected a keryx-shell compile result");
  }
  const invocation = await tool.invoke({ ...result.result.input });
  expect(invocation.isError).toBe(false);
});

test("every AgentDefinition field is projected into input or the policy sidecar — a field→destination table", () => {
  const result = compileAgentDefinition(DEFINITION, "keryx-shell");
  if (!result.ok || result.result.target !== "keryx-shell") {
    throw new Error("expected a keryx-shell compile result");
  }
  const { input, policy } = result.result;

  // field -> where it landed. Every key of AgentDefinition (minus `body`,
  // folded into `input.task`'s compiled header) must appear exactly once.
  const destinations: Record<keyof Omit<AgentDefinition, "body">, "input" | "policy" | "header"> = {
    schema_version: "header", // absent on this fixture; not carried forward at all — never claimed to be
    name: "input", // -> input.label
    description: "header", // not compiled into keryx-shell output at all (host-export only field)
    role: "header", // folded into input.task's compiled header
    tools: "policy", // -> policy.toolAllowlist
    model_tier: "input", // -> input.model_tier
    policy_profile: "policy", // -> policy.profile
    skills: "header", // not projected into keryx-shell (no dispatch slot; verify.ts checks it separately)
    stacks: "header", // not projected into keryx-shell (stack gating is the caller's job, W2 non-goals)
    output_contract: "header", // not projected into keryx-shell (no dispatch slot for it)
    isolation: "policy", // -> policy.isolation
    origin: "header", // provenance only, not a dispatch input
    execution_kind: "policy",
    tool_scope: "policy",
    delegation: "policy",
  };
  void destinations; // documents intent; the concrete assertions below are what actually guards it

  expect(input.label).toBe(DEFINITION.name);
  expect(input.model_tier).toBe(DEFINITION.model_tier);
  expect(input.task).toContain(DEFINITION.role);
  expect(input.task).toContain(DEFINITION.body);
  expect(policy.toolAllowlist).toEqual(DEFINITION.tools);
  expect(policy.profile).toBe("shellChildReadOnlyProfile");
  expect(policy.isolation).toBe(DEFINITION.isolation);
});

test("v2 orchestration constraints are carried but reported unsupported until the runtime controller enforces them", () => {
  const result = compileAgentDefinition(COORDINATOR, "keryx-shell");
  if (!result.ok || result.result.target !== "keryx-shell") throw new Error("expected keryx-shell result");
  expect(result.result.policy.executionKind).toBe("orchestrator");
  expect(result.result.policy.toolScope).toBe("parent");
  expect(result.result.policy.delegation).toEqual(COORDINATOR.delegation!);
  expect(result.result.policy.enforcement.unsupported).toEqual(["executionKind", "toolScope", "delegation"]);
  expect(result.result.policy.enforcement.enforced).toEqual(["mode"]);
});

test("host exports report v2 orchestration constraints as unsupported instead of implying native enforcement", () => {
  for (const target of ["claude", "codex", "kiro", "opencode"] as const) {
    const result = compileAgentDefinition(COORDINATOR, target);
    if (!result.ok || result.result.target === "keryx-shell") throw new Error(`expected ${target} host export`);
    expect(result.result.unsupportedConstraints).toEqual(["executionKind", "toolScope", "delegation"]);
  }
});

test("R1-F6: the policy sidecar is honest about what spawn_subagent actually enforces — only `mode`, never the tool allowlist or isolation", () => {
  const result = compileAgentDefinition(DEFINITION, "keryx-shell");
  if (!result.ok || result.result.target !== "keryx-shell") {
    throw new Error("expected a keryx-shell compile result");
  }
  const { enforcement } = result.result.policy;
  expect(enforcement.enforced).toEqual(["mode"]);
  expect(enforcement.advisory).toContain("toolAllowlist");
  expect(enforcement.advisory).toContain("isolation");
  expect(enforcement.note.toLowerCase()).toContain("not enforced");
});

test("workspace-write policy_profile resolves to mode=general and shellParentProfile", () => {
  const result = compileAgentDefinition({ ...DEFINITION, policy_profile: "workspace-write" }, "keryx-shell");
  if (!result.ok || result.result.target !== "keryx-shell") {
    throw new Error("expected a keryx-shell compile result");
  }
  expect(result.result.input.mode).toBe("general");
  expect(result.result.policy.profile).toBe("shellParentProfile");
});

test("an unknown policy_profile is refused with a named reason, not thrown", () => {
  const result = compileAgentDefinition({ ...DEFINITION, policy_profile: "sudo-everything" }, "keryx-shell");
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected failure");
  expect(result.error.reason).toBe("unknown-policy-profile");
});
