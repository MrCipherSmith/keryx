import { expect, test } from "bun:test";
import {
  renderSetupGuide,
  renderSetupScenario,
  renderSetupUsage,
  SETUP_SCENARIOS,
  setupScenario,
} from "./setup-guide";
import { setupCommand } from "./setup";

test("the guide has init, refresh, and repair, each with a CLI line and an agent prompt", () => {
  expect(SETUP_SCENARIOS.map((scenario) => scenario.id)).toEqual(["init", "refresh", "repair"]);
  for (const scenario of SETUP_SCENARIOS) {
    expect(scenario.steps.length).toBeGreaterThan(0);
    expect(scenario.agentPrompt.length).toBeGreaterThan(40);
    expect(scenario.agentPrompt.toLowerCase()).toContain("commit");
    for (const step of scenario.steps) {
      expect(step.cli.startsWith("keryx ")).toBe(true);
      expect(step.note.length).toBeGreaterThan(0);
    }
  }
});

test("init scaffolds before the graph, and does not pretend wiki enrich is this step", () => {
  const init = setupScenario("init");
  expect(init).toBeDefined();
  const commands = init!.steps.map((step) => step.cli).join("\n");
  expect(commands.indexOf("keryx init --yes")).toBeLessThan(commands.indexOf("keryx gdgraph build"));
  expect(commands).toContain("keryx wiki collect --force");
  expect(commands).not.toContain("wiki enrich");
  expect(init!.agentPrompt).toContain("Do not enrich wiki prose");
});

test("refresh and repair preserve accepted content and start from a read", () => {
  const refresh = setupScenario("refresh")!;
  const repair = setupScenario("repair")!;
  expect(refresh.steps[0]?.cli).toBe("keryx update --skip-runtime");
  expect(refresh.steps.map((step) => step.cli).join(" ")).toContain("keryx sync --apply");
  expect(repair.steps[0]?.cli).toContain("keryx standard doctor");
  expect(repair.agentPrompt).toContain("Do not delete .metaproject");
});

test("a scenario render names the CLI line and the agent prompt", () => {
  const text = renderSetupScenario(setupScenario("init")!, 72);
  expect(text).toContain("\$ keryx init --yes");
  expect(text).toContain("Ask the agent:");
  expect(text).toContain("This guide only prints the steps.");
});

test("the full guide names every scenario and stays a print, not a runner", () => {
  const text = renderSetupGuide();
  expect(text).toContain("keryx setup");
  expect(text).toContain("From scratch");
  expect(text).toContain("After a pull");
  expect(text).toContain("Partial or stale");
  expect(text).not.toContain("spawn_subagent");
});

test("usage names the three scenarios and the shell command", () => {
  const usage = renderSetupUsage();
  expect(usage).toContain("keryx setup [init|refresh|repair]");
  expect(usage).toContain("/setup");
  expect(usage).toContain("Does not run init, update, or sync.");
});

async function capture(rest: string[]): Promise<{ out: string; err: string; code: number | undefined }> {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  const previous = process.exitCode;
  process.exitCode = undefined;
  console.log = (...args: unknown[]) => {
    out.push(args.map((arg) => String(arg)).join(" "));
  };
  console.error = (...args: unknown[]) => {
    err.push(args.map((arg) => String(arg)).join(" "));
  };
  try {
    await setupCommand(rest);
    return { out: out.join("\n"), err: err.join("\n"), code: process.exitCode ?? undefined };
  } finally {
    console.log = log;
    console.error = error;
    process.exitCode = previous;
  }
}

test("keryx setup with no args prints every scenario", async () => {
  const captured = await capture([]);
  expect(captured.code).toBeUndefined();
  expect(captured.out).toContain("From scratch");
  expect(captured.out).toContain("After a pull");
  expect(captured.out).toContain("Partial or stale");
});

test("keryx setup refresh prints only that scenario", async () => {
  const captured = await capture(["refresh"]);
  expect(captured.out).toContain("After a pull");
  expect(captured.out).not.toContain("From scratch");
  expect(captured.out).toContain("\$ keryx sync --apply");
});

test("an unknown scenario exits non-zero and names the choices", async () => {
  const captured = await capture(["swarm"]);
  expect(captured.code).toBe(1);
  expect(captured.err).toContain("Unknown setup scenario: swarm");
  expect(captured.err).toContain("init, refresh, repair");
});
