// Flow 301 (AC10): the Grants tab shows the allowlist mode and every domain, and the
// Runs tab surfaces a run's proxy denials through its existing generic `detail` line
// (the same summary the report and `keryx schedule show` already print).
import { describe, expect, test } from "bun:test";
import type { AgentTaskAction, TriggerEntry } from "../trigger/config";
import type { TriggerRunRecord } from "../trigger/record";
import { grantsLines, runsLines } from "./schedules-inspector";
import type { TriggerEntryView } from "./trigger-ledger";

const AGENT_TASK: AgentTaskAction = {
  kind: "agent-task",
  prompt: "check github",
  dispatch: {
    provider: "anthropic",
    model: "m",
    permissionMode: "ask",
    rates: { inputUsdPerMTok: 3, outputUsdPerMTok: 15 },
    ceilingUsd: 1,
    maxSeconds: 120,
    maxAttempts: 1,
    network: false,
  },
  grants: { network: "allowlist", domains: ["api.github.com", "*.githubusercontent.com"], tools: [], repos: [], bins: {}, binDigests: {} },
  report: { keep: 20 },
};

function view(overrides: Partial<TriggerEntryView> = {}): TriggerEntryView {
  const entry: TriggerEntry = {
    name: "check-github",
    fire: { kind: "schedule", cron: "0 */4 * * *" },
    action: AGENT_TASK,
    enabled: true,
    source: "store",
  };
  return { entry, scheduled: true, records: [], latest: undefined, runCount: 0, ...overrides };
}

describe("grantsLines — network: allowlist (flow 301 AC10)", () => {
  test("names the mode and every domain, and says it governs only shell commands", () => {
    const text = grantsLines(view()).join("\n");
    expect(text).toContain("network   allowlist — api.github.com, *.githubusercontent.com");
    expect(text).toContain("governs only the agent's shell commands");
    expect(text).not.toContain("off (the agent's shell has no network)");
    expect(text).not.toContain("NETWORK ON");
  });

  test("flow 301 F2 (security review): shows the default port restriction, and the grant's own ports when set", () => {
    const defaultText = grantsLines(view()).join("\n");
    expect(defaultText).toContain("443 (CONNECT) / 80 (HTTP) default");

    const withPorts = view({
      entry: {
        name: "check-github",
        fire: { kind: "schedule", cron: "0 */4 * * *" },
        action: { ...AGENT_TASK, grants: { ...AGENT_TASK.grants, ports: [443, 8443] } },
        enabled: true,
        source: "store",
      },
    });
    expect(grantsLines(withPorts).join("\n")).toContain("port 443/8443");
  });
});

describe("runsLines — a run's network refusals are visible (flow 301 AC10)", () => {
  test("a run record's detail line, which already names granted-call/denial counts, also names network refusals for an allowlist schedule", () => {
    const record: TriggerRunRecord = {
      v: 1,
      at: "2026-09-23T10:00:00.000Z",
      trigger: "check-github",
      firedBy: { kind: "schedule", cron: "0 */4 * * *" },
      action: AGENT_TASK,
      outcome: "ok",
      detail: "report written → .metaproject/data/trigger/reports/check-github/r1.md [sandbox: hardened sandbox, network allowlist (api.github.com) — governs only shell_exec; 0 granted call(s); 0 denial(s); 2 network refusal(s); $0.0010 of $1.0000 reserved]",
      cost: { recorded: true, usd: 0.001, tokens: { input: 100, output: 10 } },
      agentTask: {
        runId: "r1",
        permissionMode: "ask",
        network: "allowlist",
        networkDecisions: [
          { host: "api.github.com", allowed: true, at: "2026-09-23T10:00:00.000Z" },
          { host: "evil.example.com", allowed: false, reason: "not on the allowlist", at: "2026-09-23T10:00:01.000Z" },
        ],
      },
    };
    const text = runsLines(view({ records: [record] })).join("\n");
    expect(text).toContain("network refusal(s)");
    expect(text).toContain("network allowlist (api.github.com)");
  });
});
