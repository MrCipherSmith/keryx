// Flow 286 T6: trigger config loader tests. AC1: "each entry names what
// fires it ... and what it does; an entry that is malformed is refused on
// load with the reason, and the other entries still work."

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { loadTriggersConfig, scheduleContentCanonical, scheduleStorePath, triggerEntryProblems, triggersConfigPath } from "./config";
import { GRANTED_TOOL_CATALOGUE, grantedToolProblems, type GrantedToolSpec } from "./granted-tools";

async function projectWith(content: string | undefined): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-triggers-config-"));
  if (content !== undefined) {
    await mkdir(path.join(root, ".metaproject"), { recursive: true });
    await writeFile(triggersConfigPath(root), content, "utf8");
  }
  return root;
}

describe("triggersConfigPath", () => {
  test("resolves under .metaproject/triggers.json", () => {
    expect(triggersConfigPath("/repo")).toBe(path.join("/repo", ".metaproject", "triggers.json"));
  });
});

describe("loadTriggersConfig: no file", () => {
  test("a project with no triggers.json loads zero triggers with fileProblem 'absent', not a throw", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "keryx-triggers-config-"));
    const result = loadTriggersConfig(root);
    expect(result.triggers).toEqual([]);
    expect(result.rejected).toEqual([]);
    expect(result.fileProblem).toBe("absent");
  });
});

describe("loadTriggersConfig: a valid file with several entries", () => {
  test("every entry loads: an event trigger, a schedule trigger, open-flow and flow-next actions", async () => {
    const root = await projectWith(
      JSON.stringify({
        schemaVersion: 1,
        triggers: [
          { name: "post-merge-reconcile", on: { kind: "event", event: "post-merge" }, action: { kind: "reconcile" } },
          {
            name: "nightly-rebuild",
            on: { kind: "schedule", cron: "0 2 * * *" },
            action: { kind: "rebuild" },
          },
          {
            name: "open-bugfix-flow",
            on: { kind: "event", event: "ci" },
            action: { kind: "open-flow", template: "bugfix", skipIfOpen: true },
          },
          {
            name: "advance-flow-286",
            on: { kind: "event", event: "post-commit" },
            action: { kind: "flow-next", flow: "286" },
          },
        ],
      }),
    );

    const result = loadTriggersConfig(root);
    expect(result.fileProblem).toBeUndefined();
    expect(result.rejected).toEqual([]);
    expect(result.triggers).toHaveLength(4);

    const byName = Object.fromEntries(result.triggers.map((t) => [t.name, t]));
    expect(byName["post-merge-reconcile"]?.fire).toEqual({ kind: "event", event: "post-merge" });
    expect(byName["post-merge-reconcile"]?.action).toEqual({ kind: "reconcile" });
    expect(byName["post-merge-reconcile"]?.enabled).toBe(true);

    expect(byName["nightly-rebuild"]?.fire).toEqual({ kind: "schedule", cron: "0 2 * * *" });
    expect(byName["nightly-rebuild"]?.action).toEqual({ kind: "rebuild" });

    expect(byName["open-bugfix-flow"]?.fire).toEqual({ kind: "event", event: "ci" });
    expect(byName["open-bugfix-flow"]?.action).toEqual({ kind: "open-flow", template: "bugfix", skipIfOpen: true });

    expect(byName["advance-flow-286"]?.action).toEqual({ kind: "flow-next", flow: "286" });
  });

  test("enabled: false is preserved rather than defaulted to true", async () => {
    const root = await projectWith(
      JSON.stringify({
        schemaVersion: 1,
        triggers: [
          {
            name: "paused",
            on: { kind: "event", event: "post-merge" },
            action: { kind: "reconcile" },
            enabled: false,
          },
        ],
      }),
    );
    const result = loadTriggersConfig(root);
    expect(result.triggers[0]?.enabled).toBe(false);
  });
});

describe("loadTriggersConfig: one malformed entry, neighbours survive", () => {
  test("a structurally broken middle entry is rejected with a reason; the entries before and after it still load", async () => {
    const root = await projectWith(
      JSON.stringify({
        schemaVersion: 1,
        triggers: [
          { name: "good-one", on: { kind: "event", event: "post-merge" }, action: { kind: "reconcile" } },
          { name: "broken", on: { kind: "event", event: "post-merge" } /* no action */ },
          { name: "good-two", on: { kind: "event", event: "post-checkout" }, action: { kind: "rebuild" } },
        ],
      }),
    );

    const result = loadTriggersConfig(root);
    expect(result.fileProblem).toBeUndefined();
    expect(result.triggers.map((t) => t.name)).toEqual(["good-one", "good-two"]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.index).toBe(1);
    expect(result.rejected[0]?.name).toBe("broken");
    expect(result.rejected[0]?.reasons.some((r) => r.includes("action"))).toBe(true);
  });

  test("a duplicate name is rejected on the later entry; the first occurrence still loads", async () => {
    const root = await projectWith(
      JSON.stringify({
        schemaVersion: 1,
        triggers: [
          { name: "dupe", on: { kind: "event", event: "post-merge" }, action: { kind: "reconcile" } },
          { name: "dupe", on: { kind: "event", event: "post-checkout" }, action: { kind: "rebuild" } },
        ],
      }),
    );

    const result = loadTriggersConfig(root);
    expect(result.triggers).toHaveLength(1);
    expect(result.triggers[0]?.fire).toEqual({ kind: "event", event: "post-merge" });
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.index).toBe(1);
    expect(result.rejected[0]?.reasons[0]).toContain("already used");
  });
});

describe("loadTriggersConfig: unknown event name", () => {
  test("an entry naming an event outside the known set is refused with the reason, others still load", async () => {
    const root = await projectWith(
      JSON.stringify({
        schemaVersion: 1,
        triggers: [
          { name: "unknown-event", on: { kind: "event", event: "pre-push" }, action: { kind: "reconcile" } },
          { name: "fine", on: { kind: "event", event: "post-merge" }, action: { kind: "reconcile" } },
        ],
      }),
    );

    const result = loadTriggersConfig(root);
    expect(result.triggers.map((t) => t.name)).toEqual(["fine"]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.name).toBe("unknown-event");
    expect(result.rejected[0]?.reasons.join(" ")).toContain("unknown event");
  });
});

describe("loadTriggersConfig: a schedule entry", () => {
  test("a well-formed cron shape loads as a schedule trigger", async () => {
    const root = await projectWith(
      JSON.stringify({
        schemaVersion: 1,
        triggers: [{ name: "hourly", on: { kind: "schedule", cron: "0 * * * *" }, action: { kind: "reconcile" } }],
      }),
    );
    const result = loadTriggersConfig(root);
    expect(result.rejected).toEqual([]);
    expect(result.triggers[0]?.fire).toEqual({ kind: "schedule", cron: "0 * * * *" });
  });

  test("a schedule entry whose cron field isn't cron-shaped is refused with a reason", async () => {
    const root = await projectWith(
      JSON.stringify({
        schemaVersion: 1,
        triggers: [{ name: "bad-cron", on: { kind: "schedule", cron: "every night" }, action: { kind: "reconcile" } }],
      }),
    );
    const result = loadTriggersConfig(root);
    expect(result.triggers).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.reasons.join(" ")).toContain("cron");
  });
});

describe("loadTriggersConfig: an empty file", () => {
  test("a zero-byte triggers.json is refused as a file problem, not parsed as zero entries silently succeeding", async () => {
    const root = await projectWith("");
    const result = loadTriggersConfig(root);
    expect(result.triggers).toEqual([]);
    expect(result.rejected).toEqual([]);
    expect(result.fileProblem).toBe("not-json");
  });

  test("an explicit empty triggers array is valid and loads zero entries", async () => {
    const root = await projectWith(JSON.stringify({ schemaVersion: 1, triggers: [] }));
    const result = loadTriggersConfig(root);
    expect(result.triggers).toEqual([]);
    expect(result.rejected).toEqual([]);
    expect(result.fileProblem).toBeUndefined();
  });
});

describe("loadTriggersConfig: a file that is not JSON", () => {
  test("garbage content is refused with fileProblem 'not-json', never throws", async () => {
    const root = await projectWith("this is not json at all {{{");
    const result = loadTriggersConfig(root);
    expect(result.triggers).toEqual([]);
    expect(result.rejected).toEqual([]);
    expect(result.fileProblem).toBe("not-json");
  });
});

describe("loadTriggersConfig: other whole-file problems", () => {
  test("a JSON array at the top level (not an object) is refused as 'not-an-object'", async () => {
    const root = await projectWith(JSON.stringify([{ name: "x" }]));
    const result = loadTriggersConfig(root);
    expect(result.fileProblem).toBe("not-an-object");
  });

  test("a wrong schemaVersion is refused rather than guessed at", async () => {
    const root = await projectWith(JSON.stringify({ schemaVersion: 2, triggers: [] }));
    const result = loadTriggersConfig(root);
    expect(result.fileProblem).toBe("wrong-schema-version");
  });

  test("triggers not an array is refused as 'triggers-not-an-array'", async () => {
    const root = await projectWith(JSON.stringify({ schemaVersion: 1, triggers: { oops: true } }));
    const result = loadTriggersConfig(root);
    expect(result.fileProblem).toBe("triggers-not-an-array");
  });
});

describe("triggerEntryProblems", () => {
  test("a fully valid entry has no problems", () => {
    expect(
      triggerEntryProblems({
        name: "ok",
        on: { kind: "event", event: "post-merge" },
        action: { kind: "reconcile" },
      }),
    ).toEqual([]);
  });

  test("a non-object entry is one problem, not a throw", () => {
    expect(triggerEntryProblems("not an object")).toEqual(["entry: must be an object"]);
    expect(triggerEntryProblems(null)).toEqual(["entry: must be an object"]);
    expect(triggerEntryProblems(42)).toEqual(["entry: must be an object"]);
  });

  test("a name unsafe as a CLI argument is rejected with a reason naming the constraint", () => {
    const problems = triggerEntryProblems({
      name: "has a space",
      on: { kind: "event", event: "post-merge" },
      action: { kind: "reconcile" },
    });
    expect(problems.some((p) => p.startsWith("name:"))).toBe(true);
  });

  test("open-flow without a template is rejected", () => {
    const problems = triggerEntryProblems({
      name: "ok",
      on: { kind: "event", event: "post-merge" },
      action: { kind: "open-flow" },
    });
    expect(problems.some((p) => p.includes("template"))).toBe(true);
  });

  test("flow-next without a flow id is rejected", () => {
    const problems = triggerEntryProblems({
      name: "ok",
      on: { kind: "event", event: "post-merge" },
      action: { kind: "flow-next" },
    });
    expect(problems.some((p) => p.includes("action.flow"))).toBe(true);
  });

  test("an unknown action kind is rejected with the allowed list", () => {
    const problems = triggerEntryProblems({
      name: "ok",
      on: { kind: "event", event: "post-merge" },
      action: { kind: "teleport" },
    });
    expect(problems.some((p) => p.includes("action.kind"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Flow 290 (AC1, AC4, AC6): the `dispatch` block on `flow-next`.
// ---------------------------------------------------------------------------

const VALID_DISPATCH = {
  provider: "anthropic",
  model: "claude-sonnet",
  permissionMode: "trust",
  rates: { inputUsdPerMTok: 3, outputUsdPerMTok: 15 },
  ceilingUsd: 2,
  maxSeconds: 600,
};

function flowNextWith(dispatch: unknown): unknown {
  return { name: "overnight", on: { kind: "schedule", cron: "0 2 * * *" }, action: { kind: "flow-next", flow: "290", dispatch } };
}

describe("flow-next dispatch block (flow 290)", () => {
  test("a full dispatch block loads, with maxAttempts defaulted", async () => {
    const root = await projectWith(JSON.stringify({ schemaVersion: 1, triggers: [flowNextWith(VALID_DISPATCH)] }));
    const result = loadTriggersConfig(root);
    expect(result.rejected).toEqual([]);
    const action = result.triggers[0]!.action;
    expect(action.kind).toBe("flow-next");
    if (action.kind === "flow-next") {
      expect(action.dispatch).toEqual({ ...VALID_DISPATCH, permissionMode: "trust", maxAttempts: 3, network: false } as never);
    }
  });

  test("permissionMode defaults to ask and maxSeconds to 1800", async () => {
    const { permissionMode: _p, maxSeconds: _m, ...rest } = VALID_DISPATCH;
    const root = await projectWith(JSON.stringify({ schemaVersion: 1, triggers: [flowNextWith(rest)] }));
    const action = loadTriggersConfig(root).triggers[0]!.action;
    if (action.kind !== "flow-next" || action.dispatch === undefined) throw new Error("expected a dispatch");
    expect(action.dispatch.permissionMode).toBe("ask");
    expect(action.dispatch.maxSeconds).toBe(1800);
  });

  test('AC4: permissionMode "auto" is rejected at load with a stated reason', () => {
    const problems = triggerEntryProblems(flowNextWith({ ...VALID_DISPATCH, permissionMode: "auto" }));
    expect(problems.some((p) => p.includes('"auto" is never allowed for an unattended run'))).toBe(true);
  });

  test("AC6: a dispatch without rates is rejected — an unpriced dispatch cannot be bounded", () => {
    const { rates: _r, ...rest } = VALID_DISPATCH;
    const problems = triggerEntryProblems(flowNextWith(rest));
    expect(problems.some((p) => p.startsWith("action.dispatch.rates: required") && p.includes("unpriced"))).toBe(true);
  });

  test("AC6: a dispatch without ceilingUsd is rejected", () => {
    const { ceilingUsd: _c, ...rest } = VALID_DISPATCH;
    const problems = triggerEntryProblems(flowNextWith(rest));
    expect(problems.some((p) => p.startsWith("action.dispatch.ceilingUsd: required"))).toBe(true);
  });

  test("malformed rates, a zero ceiling and a missing model are each named", () => {
    const problems = triggerEntryProblems(
      flowNextWith({ ...VALID_DISPATCH, model: "", ceilingUsd: 0, rates: { inputUsdPerMTok: -1, outputUsdPerMTok: "x" } }),
    );
    expect(problems).toContain("action.dispatch.model: required, non-empty string");
    expect(problems).toContain("action.dispatch.ceilingUsd: must be a positive number of USD");
    expect(problems.some((p) => p.startsWith("action.dispatch.rates.inputUsdPerMTok"))).toBe(true);
    expect(problems.some((p) => p.startsWith("action.dispatch.rates.outputUsdPerMTok"))).toBe(true);
  });

  test("a rejected dispatch entry does not take the other entries down with it", async () => {
    const root = await projectWith(
      JSON.stringify({
        schemaVersion: 1,
        triggers: [
          flowNextWith({ ...VALID_DISPATCH, permissionMode: "auto" }),
          { name: "nightly", on: { kind: "schedule", cron: "0 3 * * *" }, action: { kind: "rebuild" } },
        ],
      }),
    );
    const result = loadTriggersConfig(root);
    expect(result.triggers.map((t) => t.name)).toEqual(["nightly"]);
    expect(result.rejected.map((r) => r.name)).toEqual(["overnight"]);
  });

  test("a flow-next with no dispatch block still loads as report-only", async () => {
    const root = await projectWith(
      JSON.stringify({
        schemaVersion: 1,
        triggers: [{ name: "report", on: { kind: "event", event: "post-merge" }, action: { kind: "flow-next", flow: "290" } }],
      }),
    );
    const action = loadTriggersConfig(root).triggers[0]!.action;
    expect(action).toEqual({ kind: "flow-next", flow: "290" });
  });
});

describe("flow 290 T13: dispatch hardening at load (AC14, review item 8)", () => {
  test.each([
    ["input", { inputUsdPerMTok: 0, outputUsdPerMTok: 15 }, "inputUsdPerMTok"],
    ["output", { inputUsdPerMTok: 3, outputUsdPerMTok: 0 }, "outputUsdPerMTok"],
  ])("AC14: a zero %s rate is rejected — it would make every run free to the ceiling", (_label, rates, field) => {
    const problems = triggerEntryProblems(flowNextWith({ ...VALID_DISPATCH, rates }));
    expect(problems.some((p) => p.includes(`rates.${field}`) && p.includes("zero rate"))).toBe(true);
  });

  test.each(["http://localhost:11434", "http://127.0.0.1:8080/v1", "https://[::1]:9000"])("a loopback baseUrl is accepted: %s", (baseUrl) => {
    expect(triggerEntryProblems(flowNextWith({ ...VALID_DISPATCH, baseUrl }))).toEqual([]);
  });

  test.each(["https://api.evil.example", "http://10.0.0.5:8080", "http://localhost.evil.example", "file:///tmp/x"])(
    "a non-loopback baseUrl is rejected — a committed triggers.json must not redirect the saved key: %s",
    (baseUrl) => {
      const problems = triggerEntryProblems(flowNextWith({ ...VALID_DISPATCH, baseUrl }));
      expect(problems.some((p) => p.startsWith("action.dispatch.baseUrl") && p.includes("not loopback"))).toBe(true);
    },
  );

  test("network defaults to false and must be a boolean", async () => {
    expect(triggerEntryProblems(flowNextWith({ ...VALID_DISPATCH, network: "yes" }))).toContain(
      "action.dispatch.network: must be a boolean when present",
    );
    const root = await projectWith(JSON.stringify({ schemaVersion: 1, triggers: [flowNextWith({ ...VALID_DISPATCH, network: true })] }));
    const action = loadTriggersConfig(root).triggers[0]!.action;
    if (action.kind !== "flow-next" || action.dispatch === undefined) throw new Error("expected a dispatch");
    expect(action.dispatch.network).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Flow 295 (AC1, AC4): the `agent-task` kind, loaded from the schedule store.
// ---------------------------------------------------------------------------

describe("flow 295: agent-task entries", () => {
  const RATES = { inputUsdPerMTok: 3, outputUsdPerMTok: 15 };
  function agentTask(overrides: Record<string, unknown> = {}, name = "check-github"): Record<string, unknown> {
    return {
      name,
      on: { kind: "schedule", cron: "0 */4 * * *" },
      action: {
        kind: "agent-task",
        prompt: "Check open PRs and summarise what needs my attention.",
        dispatch: { provider: "anthropic", model: "m", permissionMode: "ask", rates: RATES, ceilingUsd: 0.5 },
        grants: { network: "off", tools: ["gh.pr.list"], repos: ["MrCipherSmith/keryx"], bins: { gh: "/usr/bin/gh" } },
        ...overrides,
      },
    };
  }
  async function storeWith(entries: unknown[], config?: unknown[]): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), "keryx-triggers-store-"));
    await mkdir(path.join(root, ".metaproject", "data", "trigger"), { recursive: true });
    await writeFile(scheduleStorePath(root), JSON.stringify({ schemaVersion: 1, triggers: entries }), "utf8");
    if (config !== undefined) await writeFile(triggersConfigPath(root), JSON.stringify({ schemaVersion: 1, triggers: config }), "utf8");
    return root;
  }
  function reasonsOf(root: string, name: string): string {
    return (loadTriggersConfig(root).rejected.find((r) => r.name === name)?.reasons ?? []).join("\n");
  }

  test("a complete agent-task loads from the store with defaults filled (ask, 600s, keep 20)", async () => {
    const root = await storeWith([agentTask()]);
    const { triggers, rejected, fileProblem } = loadTriggersConfig(root);
    expect(fileProblem).toBeUndefined();
    expect(rejected).toEqual([]);
    const entry = triggers[0]!;
    expect(entry.source).toBe("store");
    if (entry.action.kind !== "agent-task") throw new Error("expected an agent-task");
    expect(entry.action.dispatch.permissionMode).toBe("ask");
    expect(entry.action.dispatch.maxSeconds).toBe(600);
    expect(entry.action.grants).toEqual({ network: "off", domains: [], tools: ["gh.pr.list"], repos: ["MrCipherSmith/keryx"], bins: { gh: "/usr/bin/gh" }, binDigests: {} });
    expect(entry.action.report.keep).toBe(20);
  });

  test("a missing prompt, rates or ceiling is refused with the reason; a neighbour still loads", async () => {
    const noPrompt = agentTask({ prompt: undefined }, "no-prompt");
    const noRates = agentTask({ dispatch: { provider: "p", model: "m", ceilingUsd: 1 } }, "no-rates");
    const noCeiling = agentTask({ dispatch: { provider: "p", model: "m", rates: RATES } }, "no-ceiling");
    const root = await storeWith([noPrompt, noRates, noCeiling, agentTask()]);
    expect(reasonsOf(root, "no-prompt")).toContain("action.prompt: required");
    expect(reasonsOf(root, "no-rates")).toContain("action.dispatch.rates: required");
    expect(reasonsOf(root, "no-ceiling")).toContain("action.dispatch.ceilingUsd: required");
    expect(loadTriggersConfig(root).triggers.map((t) => t.name)).toEqual(["check-github"]);
  });

  test('permissionMode "auto" is refused with the reason', async () => {
    const root = await storeWith([
      agentTask({ dispatch: { provider: "p", model: "m", permissionMode: "auto", rates: RATES, ceilingUsd: 1 } }),
    ]);
    expect(reasonsOf(root, "check-github")).toContain('"auto" is never allowed for an unattended run');
  });

  test("a granted tool outside the built-in catalogue is refused with the reason", async () => {
    const root = await storeWith([agentTask({ grants: { network: "off", tools: ["gh.pr.merge"], repos: ["o/r"], bins: {} } })]);
    expect(reasonsOf(root, "check-github")).toContain('"gh.pr.merge" is not in the built-in granted-tool catalogue');
  });

  test("a granted tool whose argv the unattended floor refuses is refused on load with the floor's reason", () => {
    // The shipped catalogue is read-only; a merge entry reaching it would be a
    // reviewed code change. The floor still refuses it, so no grant can lift it.
    const merge: GrantedToolSpec = {
      id: "gh.pr.merge",
      tool: "gh_pr_merge",
      program: "gh",
      description: "merge",
      params: { number: { description: "n", required: true, pattern: /^\d+$/ } },
      argv: (v) => ["pr", "merge", v["number"]!, "--squash"],
    };
    const problems = grantedToolProblems(["gh.pr.merge"], [...GRANTED_TOOL_CATALOGUE, merge]);
    expect(problems.join("\n")).toContain("which the unattended floor refuses");
    // Every shipped catalogue entry passes the same check.
    expect(grantedToolProblems(GRANTED_TOOL_CATALOGUE.map((s) => s.id))).toEqual([]);
  });

  test('flow 301 AC1: network "allowlist" loads with a non-empty domains list; "full" and "off" load unchanged', async () => {
    const root = await storeWith([
      agentTask({ grants: { network: "allowlist", domains: ["api.github.com", "*.example.com"], tools: [], repos: [] } }, "allow"),
      agentTask({ grants: { network: "full", tools: [], repos: [] } }, "full"),
      agentTask({ grants: { network: "off", tools: [], repos: [] } }, "off"),
    ]);
    expect(reasonsOf(root, "allow")).toBe("");
    expect(loadTriggersConfig(root).triggers.map((t) => t.name).sort()).toEqual(["allow", "full", "off"].sort());
    const allow = loadTriggersConfig(root).triggers.find((t) => t.name === "allow")!.action;
    if (allow.kind !== "agent-task") throw new Error("expected an agent-task");
    expect(allow.grants.domains).toEqual(["api.github.com", "*.example.com"]);
  });

  test('flow 301 AC1: "allowlist" with an empty, malformed, IP-literal or bare-"*" domain is refused with the reason', async () => {
    const root = await storeWith([
      agentTask({ grants: { network: "allowlist", domains: [], tools: [], repos: [] } }, "empty"),
      agentTask({ grants: { network: "allowlist", domains: ["not a domain!"], tools: [], repos: [] } }, "malformed"),
      agentTask({ grants: { network: "allowlist", domains: ["169.254.169.254"], tools: [], repos: [] } }, "ip-literal"),
      agentTask({ grants: { network: "allowlist", domains: ["::1"], tools: [], repos: [] } }, "ipv6-literal"),
      agentTask({ grants: { network: "allowlist", domains: ["*"], tools: [], repos: [] } }, "bare-star"),
    ]);
    expect(reasonsOf(root, "empty")).toContain('required and non-empty when network is "allowlist"');
    expect(reasonsOf(root, "malformed")).toContain("does not look like a domain");
    expect(reasonsOf(root, "ip-literal")).toContain("is an IP literal");
    expect(reasonsOf(root, "ipv6-literal")).toContain("is an IP literal");
    expect(reasonsOf(root, "bare-star")).toContain('"*" is not a domain');
    expect(loadTriggersConfig(root).triggers).toEqual([]);
  });

  test("flow 301 F3 (security review): inet_aton short/mixed-radix forms and a numeric final label are refused", async () => {
    const root = await storeWith([
      agentTask({ grants: { network: "allowlist", domains: ["127.1"], tools: [], repos: [] } }, "short-form"),
      agentTask({ grants: { network: "allowlist", domains: ["10.1.2"], tools: [], repos: [] } }, "three-part"),
      agentTask({ grants: { network: "allowlist", domains: ["0x7f.0.0.1"], tools: [], repos: [] } }, "hex-octet"),
      agentTask({ grants: { network: "allowlist", domains: ["example.123"], tools: [], repos: [] } }, "numeric-final-label"),
      agentTask({ grants: { network: "allowlist", domains: ["example.0x1a"], tools: [], repos: [] } }, "hex-final-label"),
      agentTask({ grants: { network: "allowlist", domains: ["api.github.com"], tools: [], repos: [] } }, "still-loads"),
    ]);
    expect(reasonsOf(root, "short-form")).toContain("inet_aton");
    expect(reasonsOf(root, "three-part")).toContain("inet_aton");
    expect(reasonsOf(root, "hex-octet")).toContain("inet_aton");
    expect(reasonsOf(root, "numeric-final-label")).toContain("final label is numeric");
    expect(reasonsOf(root, "hex-final-label")).toContain("final label is numeric");
    expect(loadTriggersConfig(root).triggers.map((t) => t.name)).toEqual(["still-loads"]);
  });

  test("flow 301 F2 (security review): an agent-task grant's ports must be a non-empty array of integers 1-65535", async () => {
    const root = await storeWith([
      agentTask({ grants: { network: "allowlist", domains: ["api.github.com"], ports: [], tools: [], repos: [] } }, "empty-ports"),
      agentTask({ grants: { network: "allowlist", domains: ["api.github.com"], ports: [0], tools: [], repos: [] } }, "zero-port"),
      agentTask({ grants: { network: "allowlist", domains: ["api.github.com"], ports: [70000], tools: [], repos: [] } }, "too-big"),
      agentTask({ grants: { network: "allowlist", domains: ["api.github.com"], ports: [443.5], tools: [], repos: [] } }, "non-integer"),
      agentTask({ grants: { network: "allowlist", domains: ["api.github.com"], ports: [443, 8443], tools: [], repos: [] } }, "valid"),
    ]);
    expect(reasonsOf(root, "empty-ports")).toContain("action.grants.ports");
    expect(reasonsOf(root, "zero-port")).toContain("action.grants.ports");
    expect(reasonsOf(root, "too-big")).toContain("action.grants.ports");
    expect(reasonsOf(root, "non-integer")).toContain("action.grants.ports");
    expect(reasonsOf(root, "valid")).toBe("");
    const valid = loadTriggersConfig(root).triggers.find((t) => t.name === "valid")!.action;
    if (valid.kind !== "agent-task") throw new Error("expected an agent-task");
    expect(valid.grants.ports).toEqual([443, 8443]);
  });

  test("an agent-task in the committed triggers.json is refused — it lives only in the per-machine store", async () => {
    const root = await storeWith([], [agentTask({}, "committed")]);
    expect(reasonsOf(root, "committed")).toContain("never in the committed triggers.json");
  });

  test("granted tools without named repositories are refused", async () => {
    const root = await storeWith([agentTask({ grants: { network: "off", tools: ["gh.pr.list"], repos: [] } })]);
    expect(reasonsOf(root, "check-github")).toContain("action.grants.repos: required when granted tools are listed");
  });

  test("scheduleContentCanonical ignores key order and `enabled`, but changes with the grants", () => {
    const a = agentTask();
    const reordered = { action: a["action"], on: a["on"], name: a["name"], enabled: false };
    expect(scheduleContentCanonical(reordered)).toBe(scheduleContentCanonical(a));
    const widened = agentTask({ grants: { network: "full", tools: ["gh.pr.list"], repos: ["MrCipherSmith/keryx"], bins: { gh: "/usr/bin/gh" } } });
    expect(scheduleContentCanonical(widened)).not.toBe(scheduleContentCanonical(a));
  });

  test("flow 301 AC8: the domain list is part of the signed content — changing it changes the hash", () => {
    const base = agentTask({ grants: { network: "allowlist", domains: ["api.github.com"], tools: [], repos: [] } });
    const sameDomains = agentTask({ grants: { network: "allowlist", domains: ["api.github.com"], tools: [], repos: [] } });
    const differentDomains = agentTask({ grants: { network: "allowlist", domains: ["api.github.com", "evil.example.com"], tools: [], repos: [] } });
    expect(scheduleContentCanonical(base)).toBe(scheduleContentCanonical(sameDomains));
    expect(scheduleContentCanonical(base)).not.toBe(scheduleContentCanonical(differentDomains));
  });

  // --- flow 295 security review --------------------------------------------------

  test("F1c: a stored schedule that fires on a git event is refused on load, and never hooked", async () => {
    const root = await storeWith([{ ...agentTask(), on: { kind: "event", event: "post-merge" } }]);
    expect(reasonsOf(root, "check-github")).toContain("fires only on {\"kind\": \"schedule\"}");
    expect(loadTriggersConfig(root).triggers).toEqual([]);
  });

  test("F1c: the store holds only agent-task schedules", async () => {
    const root = await storeWith([{ name: "sneaky", on: { kind: "schedule", cron: "0 2 * * *" }, action: { kind: "rebuild" } }]);
    expect(reasonsOf(root, "sneaky")).toContain("the schedule store holds only agent-task schedules");
  });

  test("F1d: bins must name the program they stand for — bins.gh = /bin/bash is refused", async () => {
    const root = await storeWith([agentTask({ grants: { network: "off", tools: ["gh.pr.list"], repos: ["a/b"], bins: { gh: "/bin/bash" } } })]);
    expect(reasonsOf(root, "check-github")).toContain('"/bin/bash" is not a program named "gh"');
  });

  test("F1b: a schedule store tracked by git is refused whole", async () => {
    const root = await storeWith([agentTask()]);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
    expect(loadTriggersConfig(root).triggers.map((t) => t.name)).toEqual(["check-github"]);
    execFileSync("git", ["add", "-f", path.relative(root, scheduleStorePath(root))], { cwd: root });
    const loaded = loadTriggersConfig(root);
    expect(loaded.triggers).toEqual([]);
    expect(loaded.rejected.map((r) => r.reasons.join(" ")).join("\n")).toContain("is tracked by git");
  });

  test("F4: a committed trigger with a local schedule's name is refused; the local schedule is kept", async () => {
    const root = await storeWith(
      [agentTask({}, "nightly")],
      [{ name: "nightly", on: { kind: "schedule", cron: "0 2 * * *" }, action: { kind: "rebuild" } }],
    );
    const loaded = loadTriggersConfig(root);
    expect(loaded.triggers.map((t) => `${t.name}/${t.source}`)).toEqual(["nightly/store"]);
    expect(loaded.rejected.find((r) => r.source === "config")?.reasons.join(" ")).toContain("also a local schedule on this machine");
  });
});
