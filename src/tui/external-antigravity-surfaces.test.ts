// Flow 357 AC7, TUI clause: `antigravity-cli` surfaces wherever the other
// external agents do.
//
// There is no hand-maintained agent list in the shell — every surface reads the
// registry — so these tests pin the registry-to-surface wiring for the new
// entry: the `/delegate` parser and its roster message, the `keryx agents
// external list` rows, the sidebar fleet events, and the inspector title and
// Meta tab. Headless: a fake `runExternal`, no renderer, no `agy` binary, and
// nothing that reads a Google credential.
import { describe, expect, test } from "bun:test";
import { parseDelegateCommand } from "../commands/agent-commands";
import {
  buildExternalAgentsJson,
  renderExternalAgents,
  type ExternalAgentRow,
} from "../commands/agents-external";
import { EXTERNAL_AGENTS, getExternalAgent, resolveAvailability } from "../harness/external/registry";
import type { StructuredSubagentResult } from "../harness/tool/builtin/spawn-subagent-tool";
import { ExternalOperator } from "./external-operator";
import { externalInspectorTitle } from "./external-inspector";
import { formatExternalMeta } from "./external-transcript";
import { setSubagentFleetListener, type SubagentFleetEvent } from "./subagent-bridge";

const AGY = getExternalAgent("antigravity-cli");
if (AGY === undefined) throw new Error("antigravity-cli is not in the external agent registry");

const OK: StructuredSubagentResult = { status: "Completed", output: "done", isError: false };

describe("antigravity-cli in the /delegate composer command", () => {
  test("is accepted as an agent id", () => {
    expect(parseDelegateCommand("antigravity-cli summarise the diff")).toEqual({
      ok: true,
      agentId: "antigravity-cli",
      task: "summarise the diff",
    });
  });

  test("the unknown-agent refusal lists it among the agents keryx drives", () => {
    const parsed = parseDelegateCommand("gpt-cli do it");
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toContain("antigravity-cli");
    for (const entry of EXTERNAL_AGENTS) expect(parsed.reason).toContain(entry.id);
  });
});

describe("antigravity-cli in the agent roster", () => {
  const rows: ExternalAgentRow[] = EXTERNAL_AGENTS.map((entry) => ({
    entry,
    availability: resolveAvailability(entry, undefined),
  }));

  test("the rendered text has a row with its id, label and read-only sandbox scope", () => {
    const lines = renderExternalAgents(rows, { available: true });
    const index = lines.findIndex((line) => line.includes("antigravity-cli"));
    expect(index).toBeGreaterThan(-1);
    expect(lines[index]).toContain("Antigravity");
    // The detail block under the row names the sandbox scope the CLI offers,
    // including the read-only level `/delegate` actually runs at.
    expect(lines[index + 2]).toContain("sandbox: read-only");
    expect(lines[index + 2]).toContain("transport: line-stream");
  });

  test("an unprobed roster reports it as not probed, never as ready", () => {
    const text = renderExternalAgents(rows, { available: true }).join("\n");
    expect(text).toContain("keryx agents external probe antigravity-cli");
  });

  test("--json carries the entry with its binary and sandbox modes", () => {
    const doc = buildExternalAgentsJson(rows, { available: true }, false);
    const agy = doc.agents.find((agent) => agent.id === "antigravity-cli");
    expect(agy).toMatchObject({ label: "Antigravity", binary: "agy" });
    expect(agy?.sandboxModes).toContain("read-only");
  });
});

describe("antigravity-cli in the live surfaces", () => {
  test("/delegate runs it read-only and the sidebar shows it as an external row", async () => {
    const events: SubagentFleetEvent[] = [];
    const seen: unknown[] = [];
    setSubagentFleetListener((event) => events.push(event));
    try {
      const op = new ExternalOperator({
        idSeq: () => "agy1",
        runExternal: async (request) => {
          seen.push(request);
          return OK;
        },
      });
      const outcome = await op.delegate({ agentId: "antigravity-cli", task: "read the flake" });
      expect(outcome.ok).toBe(true);
      expect(seen[0]).toMatchObject({
        runtime: { kind: "external", agent: "antigravity-cli", sandbox: "read-only" },
        mode: "read_only",
        workerId: "ext:agy1",
      });
      const upserts = events.filter((event) => event.kind === "upsert");
      expect(upserts).toHaveLength(2);
      for (const event of upserts) {
        expect(event).toMatchObject({
          id: "ext:agy1",
          label: "Antigravity",
          runtime: "external",
          agentId: "antigravity-cli",
        });
      }
    } finally {
      setSubagentFleetListener(undefined);
    }
  });

  test("a started run carries the registry label into the inspector title and Meta tab", () => {
    const op = new ExternalOperator();
    op.apply({
      kind: "start",
      id: "r1",
      run: { runId: "r1", agentId: "antigravity-cli", label: "probe", task: "look" },
    });
    const view = op.store.get("r1");
    expect(view).toBeDefined();
    if (view === undefined) return;
    expect(view.agentLabel).toBe("Antigravity");
    // agy reports no monetary cost, so Meta explains the missing figure.
    expect(view.reportsCost).toBe(false);
    expect(externalInspectorTitle(view)).toBe("Antigravity");
    expect(formatExternalMeta(view)).toContain("Antigravity (antigravity-cli)");
  });
});
