// Flow 390, AC7 (invariant) — nothing refuses because of the origin. `init`,
// `freeze`, `complete` and the product commands succeed on a flow with no origin,
// an unknown one, or an invalid kind (reported, not fatal); a flow without an
// origin shows "origin: unknown".
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { productCommand } from "../commands/product";
import { createFlowService } from "./service";
import type { FlowServiceDeps, TrackerAdapter } from "./types";
import { plain, runFlowCli } from "./origin.test-helpers";
import { flowCommand } from "../commands/flow";

let ROOT = "";

function tracker(): TrackerAdapter {
  return {
    id: "fake",
    detect: async () => true,
    parseRef: () => null,
    fetchIssue: async () => ({ title: "Issue title", body: "body" }),
    prStatus: async () => ({ exists: true, isDraft: true, checksGreen: true, headSha: "d00d1d00d2d00d3d00d4d00d5d00d6d00d7d00d8" }),
    comment: async () => true,
  };
}

function deps(): FlowServiceDeps {
  return {
    tracker: tracker(),
    healthGate: async () => ({ status: "pass", reasons: [] }),
    now: () => new Date("2026-10-02T10:00:00Z"),
  };
}

afterEach(async () => {
  if (ROOT) await rm(ROOT, { recursive: true, force: true });
  ROOT = "";
});

async function freshRoot(): Promise<void> {
  ROOT = await mkdtemp(path.join(tmpdir(), "keryx-origin-never-gates-"));
  await mkdir(path.join(ROOT, ".metaproject"), { recursive: true });
}

type InitInput = Parameters<ReturnType<typeof createFlowService>["init"]>[0];

/** Drive one flow through every transition the origin could conceivably have blocked. */
async function drive(title: string, init: Partial<InitInput>, tamper?: (flow: Record<string, unknown>) => void): Promise<string[]> {
  const service = createFlowService(deps());
  const steps: string[] = [];
  const { flow, dir } = await service.init({ cwd: ROOT, title, ...init });
  steps.push("init");
  const flowDir = path.join(ROOT, ".metaproject", "flows", path.basename(dir));
  if (tamper !== undefined) {
    const file = path.join(flowDir, "flow.json");
    const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    tamper(raw);
    await writeFile(file, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
  }
  await writeFile(
    path.join(flowDir, "acceptance-criteria.md"),
    ["# Acceptance Criteria", "", "## Criteria", "", "- AC1: It works", "- AC2: It is read [verify: judged]", ""].join("\n"),
    "utf8",
  );
  const id = flow.id;
  await service.freeze({ cwd: ROOT, id });
  steps.push("freeze");
  await service.start({ cwd: ROOT, id });
  steps.push("start");
  await service.implemented({ cwd: ROOT, id, prUrl: "https://github.com/acme/app/pull/9" });
  steps.push("implemented");
  await service.acConfirm({ cwd: ROOT, id, criterion: "AC1", note: "read it" });
  await service.acConfirm({ cwd: ROOT, id, criterion: "AC2", note: "read it" });
  steps.push("confirm");
  const result = await service.complete({ cwd: ROOT, id });
  steps.push("complete");
  const gates = result.gates.map((gate) => `${gate.name}:${gate.status}`);
  expect(gates.filter((gate) => /origin/i.test(gate))).toEqual([]);
  return steps;
}

const EVERY_STEP = ["init", "freeze", "start", "implemented", "confirm", "complete"];

describe("no path refuses because of the origin", () => {
  test("a flow with no origin goes through every transition", async () => {
    await freshRoot();
    expect(await drive("No origin", {})).toEqual(EVERY_STEP);
  });

  test("a flow whose origin evidence was refused (stays unknown) goes through every transition", async () => {
    await freshRoot();
    expect(await drive("Refused evidence", { origin: "human-request" })).toEqual(EVERY_STEP);
  });

  test("a flow created with an invalid kind goes through every transition", async () => {
    await freshRoot();
    expect(await drive("Invalid kind", { origin: "nonsense", originQuote: "q", originSource: "s" })).toEqual(EVERY_STEP);
  });

  test("a flow whose flow.json carries an invalid origin kind goes through every transition", async () => {
    await freshRoot();
    const steps = await drive("Tampered kind", {}, (flow) => {
      flow["origin"] = { kind: "robot", quote: "q" };
    });
    expect(steps).toEqual(EVERY_STEP);
  });

  test("a flow whose flow.json carries a malformed origin (a string) goes through every transition", async () => {
    await freshRoot();
    expect(await drive("Tampered shape", {}, (flow) => {
      flow["origin"] = "human-request";
    })).toEqual(EVERY_STEP);
  });

  test("a flow with a valid origin goes through every transition", async () => {
    await freshRoot();
    expect(await drive("Valid origin", { origin: "agent-finding", originSource: "ci" })).toEqual(EVERY_STEP);
  });
});

describe("an invalid kind is reported, not fatal", () => {
  test("the service records no origin and names the valid kinds", async () => {
    await freshRoot();
    const result = await createFlowService(deps()).init({ cwd: ROOT, title: "Bad kind", origin: "nonsense", originSource: "s" });
    expect(result.flow.origin).toBeUndefined();
    expect(result.originNote).toContain('"nonsense"');
    expect(result.originNote).toContain("human-request, agent-finding, agent-proposal");
  });

  test("the CLI exits 0, creates the flow and prints the problem", async () => {
    await freshRoot();
    const run = await runFlowCli(flowCommand, ROOT, ["init", "--title", "Bad kind via CLI", "--origin", "nonsense"]);
    expect(run.exitCode).toBe(0);
    const text = plain(run.out);
    expect(text).toContain("origin: unknown");
    expect(text).toContain('"nonsense"');
  });
});

describe("origin set with an invalid kind is reported, not fatal", () => {
  test("the service changes nothing and names the valid kinds", async () => {
    await freshRoot();
    const service = createFlowService(deps());
    const created = await service.init({ cwd: ROOT, title: "Set bad kind", origin: "agent-finding", originSource: "ci" });
    const result = await service.originSet({ cwd: ROOT, id: created.flow.id, kind: "robot", reason: "typo" });
    expect(result.changed).toBe(false);
    expect(result.next).toBe(result.previous);
    expect(result.note).toContain('"robot"');
    expect(result.note).toContain("human-request, agent-finding, agent-proposal");
  });

  test("the CLI exits 0 and prints the problem", async () => {
    await freshRoot();
    const created = await createFlowService(deps()).init({ cwd: ROOT, title: "Set bad kind via CLI" });
    const run = await runFlowCli(flowCommand, ROOT, ["origin", "set", created.flow.id, "robot", "--reason", "typo"]);
    expect(run.exitCode).toBe(0);
    expect(plain(`${run.out}\n${run.err}`)).toContain('"robot"');
  });
});

describe("a flow without an origin shows origin: unknown", () => {
  test("flow init and flow status print it", async () => {
    await freshRoot();
    const init = await runFlowCli(flowCommand, ROOT, ["init", "--title", "Plain"]);
    expect(init.exitCode).toBe(0);
    expect(plain(init.out)).toContain("origin: unknown");
    const list = await createFlowService(deps()).list({ cwd: ROOT });
    const status = await runFlowCli(flowCommand, ROOT, ["status", list[0]?.id ?? ""]);
    expect(status.exitCode).toBe(0);
    expect(plain(status.out)).toContain("origin: unknown");
  });

  test("an invalid kind in flow.json reads origin: unknown in flow status", async () => {
    await freshRoot();
    const created = await createFlowService(deps()).init({ cwd: ROOT, title: "Tampered" });
    const file = path.join(ROOT, created.dir, "flow.json");
    const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    raw["origin"] = { kind: "robot" };
    await writeFile(file, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
    const status = await runFlowCli(flowCommand, ROOT, ["status", created.flow.id]);
    expect(status.exitCode).toBe(0);
    expect(plain(status.out)).toContain("origin: unknown");
  });
});

describe("the product commands succeed on flows with no origin, an unknown one and an invalid kind", () => {
  test("product index and product open exit 0", async () => {
    await freshRoot();
    const service = createFlowService(deps());
    await service.init({ cwd: ROOT, title: "None" });
    const tampered = await service.init({ cwd: ROOT, title: "Invalid" });
    const file = path.join(ROOT, tampered.dir, "flow.json");
    const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    raw["origin"] = { kind: "robot", quote: "q" };
    await writeFile(file, `${JSON.stringify(raw, null, 2)}\n`, "utf8");

    const realLog = console.log;
    const cwd = process.cwd();
    const lines: string[] = [];
    console.log = (...parts: unknown[]) => {
      lines.push(parts.map(String).join(" "));
    };
    try {
      process.chdir(ROOT);
      process.exitCode = 0;
      await productCommand(["index"]);
      expect(process.exitCode).toBe(0);
      await productCommand(["open"]);
      expect(process.exitCode).toBe(0);
    } finally {
      process.chdir(cwd);
      console.log = realLog;
      process.exitCode = 0;
    }
    const text = plain(lines.join("\n"));
    // Both flows count as unknown in G1a: one has no origin, the other an invalid kind.
    expect(text).toContain("unknown: 0 real criterion, 2 not measured");
  });
});
