// Flow 362, AC5: `product` never gates anything. A flow is driven through
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
import { withCwd } from "../lib/test-cwd";

const pendingTests = new Set<Promise<void>>();

function workspaceTest(name: string, fn: (root: string) => Promise<void>): void {
  test(name, () => {
    const run = (async () => {
      // Each callback owns an immutable absolute root, even after a Bun timeout.
      const root = await mkdtemp(path.join(tmpdir(), "keryx-product-never-gates-"));
      try {
        await mkdir(path.join(root, ".metaproject"), { recursive: true });
        await fn(root);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    })();
    pendingTests.add(run);
    // Handle late rejections without hiding ordinary failures from the runner.
    void run.then(() => pendingTests.delete(run), () => pendingTests.delete(run));
    return run;
  });
}

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

async function driveOneFlow(root: string, title: string): Promise<{ transitions: string[]; gates: string[] }> {
  const service = createFlowService(deps());
  const transitions: string[] = [];
  const { flow, dir } = await service.init({ cwd: root, title });
  transitions.push("init");
  await Bun.write(
    path.join(root, ".metaproject", "flows", path.basename(dir), "acceptance-criteria.md"),
    ["# Acceptance Criteria", "", "## Criteria", "", "- AC1: It works", "- AC2: It is read [verify: judged]", ""].join("\n"),
  );
  const id = flow.id;
  await service.freeze({ cwd: root, id });
  transitions.push("freeze");
  await service.start({ cwd: root, id });
  transitions.push("start");
  await service.implemented({ cwd: root, id, prUrl: "https://github.com/acme/app/pull/9" });
  transitions.push("implemented");
  await service.acConfirm({ cwd: root, id, criterion: "AC1", note: "read it" });
  await service.acConfirm({ cwd: root, id, criterion: "AC2", note: "read it" });
  transitions.push("confirm");
  const result = await service.complete({ cwd: root, id });
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
  // Bun times out a test without cancelling its callback. Drain all fixture work,
  // including assertions and cleanup, before the runner advances to another test.
  await Promise.allSettled([...pendingTests]);
}, 60_000);

describe("a product index never gates a flow transition", () => {
  workspaceTest("with no product index at all, every transition succeeds", async (root) => {
    const outcome = await driveOneFlow(root, "No index");
    expect(outcome.transitions).toEqual(EVERY_TRANSITION);
  });

  workspaceTest("with an empty product index, every transition succeeds", async (root) => {
    await writeIntentIndex(root, await buildIntentIndex(root));
    expect(JSON.parse(await readFile(indexPath(root), "utf8")).intents).toEqual([]);
    const outcome = await driveOneFlow(root, "Empty index");
    expect(outcome.transitions).toEqual(EVERY_TRANSITION);
  });

  workspaceTest("with an unreadable product index, every transition succeeds", async (root) => {
    await Bun.write(indexPath(root), "{ not json");
    const outcome = await driveOneFlow(root, "Broken index");
    expect(outcome.transitions).toEqual(EVERY_TRANSITION);
  });

  workspaceTest("the gates a flow passes are the same with and without an index", async (root) => {
    const without = await driveOneFlow(root, "Twin without");
    await writeIntentIndex(root, await buildIntentIndex(root));
    const withIndex = await driveOneFlow(root, "Twin with");
    expect(withIndex.gates).toEqual(without.gates);
  });

  workspaceTest("running the module's own commands leaves a later flow untouched", async (root) => {
    const { productCommand } = await import("../commands/product");
    await withCwd(root, async () => {
      const realLog = console.log;
      const exitCode = process.exitCode;
      console.log = () => {};
      try {
        await productCommand(["index"]);
        await productCommand(["open"]);
      } finally {
        console.log = realLog;
        process.exitCode = exitCode;
      }
    });
    expect((await driveOneFlow(root, "After product")).transitions).toEqual(EVERY_TRANSITION);
  });
});

/** Every module specifier a source text names: static import/export-from, side-effect import, `require()` and dynamic `import()`. */
export function moduleSpecifiers(text: string): string[] {
  const found: string[] = [];
  const patterns = [
    /\bfrom\s*["'`]([^"'`\n]+)["'`]/g,
    /\bimport\s*["'`]([^"'`\n]+)["'`]/g,
    /\b(?:import|require)\s*\(\s*["'`]([^"'`\n]+)["'`]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) found.push(match[1] ?? "");
  }
  return found;
}

/** The specifiers in a text that name the product module in any spelling: a path segment, a barrel, the TUI surface, a dynamic import. `production` is a word of its own. */
export function productSpecifiers(text: string): string[] {
  return moduleSpecifiers(text).filter((specifier) => /product(?!ion)/i.test(specifier));
}

describe("the import scanner", () => {
  const offending: Array<[string, string]> = [
    ["a static import", 'import { buildIntentIndex } from "../product/service";'],
    ["a barrel import", 'import { loadOpenReport } from "../product";'],
    ["a path into the TUI surface", 'import { openProduct } from "../tui/product-open-surface";'],
    ["a dynamic import", 'const store = await import("../product/store");'],
    ["a multi-line import", 'import {\n  a,\n  b,\n} from "../product/open";'],
    ["a require call", 'const service = require("../product/service");'],
    ["an export-from", 'export { x } from "../product/service";'],
    ["a side-effect import", 'import "../product/service";'],
  ];
  for (const [name, snippet] of offending) {
    test(`flags ${name}`, () => {
      expect(productSpecifiers(snippet).length).toBe(1);
    });
  }

  test("passes an import that has nothing to do with the product module", () => {
    expect(productSpecifiers('import { x } from "../flow/service";\nconst y = await import("./gates");')).toEqual([]);
    expect(productSpecifiers("// recorded from `production` runs")).toEqual([]);
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
      if (productSpecifiers(await readFile(file, "utf8")).length > 0) importers.push(relative);
    }
    expect(importers.sort()).toEqual(["src/cli-registry.ts", "src/commands/product.ts", "src/tui/product-open-surface.ts", "src/tui/tui-shell.ts"]);
  });

  test("the flow module, its gates and the completion path never import it, in any spelling", async () => {
    const repo = path.resolve(import.meta.dir, "..", "..");
    const files = [...(await sourceFiles(path.join(repo, "src", "flow"))), path.join(repo, "src", "commands", "flow.ts")];
    expect(files.length).toBeGreaterThan(1);
    for (const file of files) {
      expect(productSpecifiers(await readFile(file, "utf8")), path.relative(repo, file)).toEqual([]);
    }
  });
});
