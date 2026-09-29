// Flow 362, AC8: `product` never gates anything. A flow is driven through
// init, freeze, start, implemented, confirm and complete with the product index
// empty, missing and unreadable, and every transition succeeds. The structural
// half pins that nothing on the flow path imports the module.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFlowService } from "../flow/service";
import type { FlowServiceDeps, TrackerAdapter } from "../flow/types";
import { buildIntentIndex } from "./corpus";
import { indexPath, writeIntentIndex } from "./store";

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
    now: () => new Date("2026-09-28T10:00:00Z"),
  };
}

async function freshRoot(): Promise<void> {
  ROOT = await mkdtemp(path.join(tmpdir(), "keryx-product-never-gates-"));
  await mkdir(path.join(ROOT, ".metaproject"), { recursive: true });
}

async function driveOneFlow(title: string): Promise<{ transitions: string[]; gates: string[] }> {
  const service = createFlowService(deps());
  const transitions: string[] = [];
  const { flow, dir } = await service.init({ cwd: ROOT, title });
  transitions.push("init");
  await Bun.write(
    path.join(ROOT, ".metaproject", "flows", path.basename(dir), "acceptance-criteria.md"),
    ["# Acceptance Criteria", "", "## Criteria", "", "- AC1: It works", "- AC2: It is read [verify: judged]", ""].join("\n"),
  );
  const id = flow.id;
  await service.freeze({ cwd: ROOT, id });
  transitions.push("freeze");
  await service.start({ cwd: ROOT, id });
  transitions.push("start");
  await service.implemented({ cwd: ROOT, id, prUrl: "https://github.com/acme/app/pull/9" });
  transitions.push("implemented");
  await service.acConfirm({ cwd: ROOT, id, criterion: "AC1", note: "read it" });
  await service.acConfirm({ cwd: ROOT, id, criterion: "AC2", note: "read it" });
  transitions.push("confirm");
  const result = await service.complete({ cwd: ROOT, id });
  transitions.push("complete");
  // The scaffold tasks, owner and review are not set up here, so those gates fail
  // for reasons of their own; what matters is that none of them is about the product.
  const gates = result.gates.map((gate) => `${gate.name}:${gate.status}`);
  expect(gates.filter((gate) => /product/i.test(gate))).toEqual([]);
  expect(gates).toContain("acceptance-criteria:pass");
  expect(gates).toContain("pull-request:pass");
  return { transitions, gates };
}

const EVERY_TRANSITION = ["init", "freeze", "start", "implemented", "confirm", "complete"];

afterEach(async () => {
  if (ROOT) await rm(ROOT, { recursive: true, force: true });
  ROOT = "";
});

describe("a product index never gates a flow transition", () => {
  test("with no product index at all, every transition succeeds", async () => {
    await freshRoot();
    const outcome = await driveOneFlow("No index");
    expect(outcome.transitions).toEqual(EVERY_TRANSITION);
  });

  test("with an empty product index, every transition succeeds", async () => {
    await freshRoot();
    await writeIntentIndex(ROOT, await buildIntentIndex(ROOT));
    expect(JSON.parse(await readFile(indexPath(ROOT), "utf8")).intents).toEqual([]);
    const outcome = await driveOneFlow("Empty index");
    expect(outcome.transitions).toEqual(EVERY_TRANSITION);
  });

  test("with an unreadable product index, every transition succeeds", async () => {
    await freshRoot();
    await Bun.write(indexPath(ROOT), "{ not json");
    const outcome = await driveOneFlow("Broken index");
    expect(outcome.transitions).toEqual(EVERY_TRANSITION);
  });

  test("the gates a flow passes are the same with and without an index", async () => {
    await freshRoot();
    const without = await driveOneFlow("Twin without");
    await writeIntentIndex(ROOT, await buildIntentIndex(ROOT));
    const withIndex = await driveOneFlow("Twin with");
    expect(withIndex.gates).toEqual(without.gates);
  });

  test("running the module's own commands leaves a later flow untouched", async () => {
    await freshRoot();
    const { productCommand } = await import("../commands/product");
    const realLog = console.log;
    const cwd = process.cwd();
    console.log = () => {};
    try {
      process.chdir(ROOT);
      await productCommand(["index"]);
      await productCommand(["open"]);
    } finally {
      process.chdir(cwd);
      console.log = realLog;
      process.exitCode = 0;
    }
    expect((await driveOneFlow("After product")).transitions).toEqual(EVERY_TRANSITION);
  });
});

describe("where the module is reached from", () => {
  async function sourceFiles(dir: string): Promise<string[]> {
    const out: string[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "fixtures" || entry.name === "node_modules") continue;
        out.push(...(await sourceFiles(full)));
      } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        out.push(full);
      }
    }
    return out;
  }

  test("only the command adapter, the TUI surface and the shell that opens it import the module", async () => {
    const repo = path.resolve(import.meta.dir, "..", "..");
    const importers: string[] = [];
    for (const file of await sourceFiles(path.join(repo, "src"))) {
      const relative = path.relative(repo, file);
      if (relative.startsWith(path.join("src", "product") + path.sep)) continue;
      const text = await readFile(file, "utf8");
      if (/from\s+["'](?:\.\.?\/)+(?:product\/service|product-open-surface|commands\/product)["']/.test(text)) importers.push(relative);
    }
    expect(importers.sort()).toEqual(["src/cli-registry.ts", "src/commands/product.ts", "src/tui/product-open-surface.ts", "src/tui/tui-shell.ts"]);
  });

  test("the flow module, its gates and the completion path never import it", async () => {
    const repo = path.resolve(import.meta.dir, "..", "..");
    for (const file of await sourceFiles(path.join(repo, "src", "flow"))) {
      expect(await readFile(file, "utf8"), path.relative(repo, file)).not.toMatch(/product\/|\/product["']/);
    }
    const flowCommand = await readFile(path.join(repo, "src", "commands", "flow.ts"), "utf8");
    expect(flowCommand).not.toMatch(/product\/|\/product["']/);
  });
});
