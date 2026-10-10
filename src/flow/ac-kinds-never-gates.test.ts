// Acceptance layer W0, AC4 — `flow freeze` on a flow whose criteria are all
// `none` completes normally and prints the distribution; no code path refuses a
// freeze, a confirmation or a completion on the basis of a kind.
//
// Two halves. The behavioural half drives a flow of only `none` criteria (the
// kind a gate would be most tempted to refuse) and a twin flow of unmarked
// criteria through freeze, confirm and complete, and asserts the outcomes are
// the same. The structural half pins WHERE a kind is read, so a later change
// that adds a consumer inside a gate has to edit this list on purpose.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { flowCommand } from "../commands/flow";
import { createFlowService } from "./service";
import type { FlowServiceDeps, TrackerAdapter } from "./types";

let ROOT = "";
const ORIGINAL_CWD = process.cwd();
const realLog = console.log;
const realError = console.error;

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
  ROOT = await mkdtemp(path.join(tmpdir(), "keryx-ac-never-gates-"));
  await mkdir(path.join(ROOT, ".metaproject"), { recursive: true });
}

async function newFlow(title: string, criteria: string[]): Promise<string> {
  const service = createFlowService(deps());
  const { flow, dir } = await service.init({ cwd: ROOT, title });
  await Bun.write(
    path.join(ROOT, ".metaproject", "flows", path.basename(dir), "acceptance-criteria.md"),
    ["# Acceptance Criteria", "", "## Criteria", "", ...criteria, ""].join("\n"),
  );
  return flow.id;
}

const ALL_NONE = [
  "- AC1: A judgement about ergonomics [verify: none — no check can settle it]",
  "- AC2: A second judgement [verify: none — a human reads it]",
];
const UNMARKED = ["- AC1: A judgement about ergonomics", "- AC2: A second judgement"];

afterEach(async () => {
  console.log = realLog;
  console.error = realError;
  process.chdir(ORIGINAL_CWD);
  process.exitCode = 0;
  if (ROOT) await rm(ROOT, { recursive: true, force: true });
  ROOT = "";
});

describe("a kind never gates a freeze, a confirmation or a completion", () => {
  test("freeze of an all-none flow completes and prints the distribution", async () => {
    await freshRoot();
    const id = await newFlow("All none", ALL_NONE);
    process.chdir(ROOT);
    const logs: string[] = [];
    console.log = (...args: unknown[]) => void logs.push(args.map(String).join(" "));
    await flowCommand(["freeze", id]);
    expect(process.exitCode ?? 0).toBe(0);
    const out = logs.join("\n");
    expect(out).toContain("acceptance kinds: exec 0  invariant 0  judged 0  none 2  unclassified 0");
    expect(out).toContain("0/2 runnable (0%)");
    expect(out).toContain("2 accepted as unverifiable");
    const flow = await createFlowService(deps()).get({ cwd: ROOT, id });
    expect(flow.status).toBe("ready");
    expect(flow.acKinds?.["AC1"]).toEqual({ kind: "none", reason: "no check can settle it" });
  });

  test("freeze of a flow with a malformed marker still completes, and says so", async () => {
    await freshRoot();
    const id = await newFlow("Malformed", ["- AC1: broken [verify: exec]", "- AC2: fine [verify: judged]"]);
    process.chdir(ROOT);
    const logs: string[] = [];
    console.log = (...args: unknown[]) => void logs.push(args.map(String).join(" "));
    await flowCommand(["freeze", id]);
    expect(process.exitCode ?? 0).toBe(0);
    const output = logs.join("\n");
    expect(output).toContain("AC1: `exec` requires a backticked command");
    expect(output).toContain("(read as unclassified)");
    expect(output).not.toContain("AC2:");
    expect((await createFlowService(deps()).get({ cwd: ROOT, id })).status).toBe("ready");
  });

  test("confirmation and the completion gate treat an all-none flow exactly like an unmarked twin", async () => {
    await freshRoot();
    const service = createFlowService(deps());
    const outcomes: Array<{ gates: string[]; confirmed: string[] }> = [];
    for (const [title, criteria] of [
      ["Twin none", ALL_NONE],
      ["Twin unmarked", UNMARKED],
    ] as const) {
      const id = await newFlow(title, [...criteria]);
      await service.freeze({ cwd: ROOT, id });
      await service.start({ cwd: ROOT, id });
      await service.implemented({ cwd: ROOT, id, prUrl: "https://github.com/acme/app/pull/9" });
      await service.acConfirm({ cwd: ROOT, id, criterion: "AC1", note: "read it" });
      await service.acConfirm({ cwd: ROOT, id, criterion: "AC2", note: "read it" });
      const result = await service.complete({ cwd: ROOT, id });
      outcomes.push({
        gates: result.gates.map((gate) => `${gate.name}:${gate.status}`),
        confirmed: Object.keys(result.flow.acConfirmed),
      });
      const acGate = result.gates.find((gate) => gate.name === "acceptance-criteria");
      expect(acGate?.status).toBe("pass");
    }
    expect(outcomes[0]).toEqual(outcomes[1]);
    expect(outcomes[0]?.confirmed).toEqual(["AC1", "AC2"]);
  });
});

describe("where a kind is read", () => {
  // Every non-test source file that names the kind vocabulary. A new entry here
  // is a reviewed decision: none of these may sit on a freeze, confirm or
  // completion refusal path.
  const READERS = [
    "src/commands/flow.ts",
    "src/commands/governance.ts",
    "src/commands/research-sync-kinds.ts",
    "src/flow/ac-kinds.ts",
    "src/flow/check-ac.ts",
    "src/flow/service.ts",
    "src/flow/types.ts",
    "src/governance/accountability.ts",
    "src/governance/aggregate.ts",
    "src/governance/types.ts",
    "src/product/extract.ts",
    "src/product/types.ts",
    "src/tui/ac-kinds-surface.ts",
    "src/tui/flow-inspector.ts",
    "src/tui/inspector-sources.ts",
  ];

  async function sourceFiles(dir: string): Promise<string[]> {
    const out: string[] = [];
    const { readdir } = await import("node:fs/promises");
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "fixtures" || entry.name === "node_modules") continue;
        out.push(...(await sourceFiles(full)));
      } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)) {
        out.push(full);
      }
    }
    return out;
  }

  test("only the reviewed files reference the kind vocabulary", async () => {
    const repo = path.resolve(import.meta.dir, "..", "..");
    const found: string[] = [];
    for (const file of await sourceFiles(path.join(repo, "src"))) {
      const text = await readFile(file, "utf8");
      if (/acKinds|ac-kinds|AcKind/.test(text)) found.push(path.relative(repo, file));
    }
    for (const file of found) expect(READERS).toContain(file);
  });

  test("the store, the state machine and the confirm/complete gates never read a kind", async () => {
    const repo = path.resolve(import.meta.dir, "..", "..");
    for (const file of ["store.ts", "machine.ts", "ac-reseal.ts", "confirm-token.ts", "review-gate.ts"]) {
      // A renamed gate file must fail here, not pass by being absent.
      const text = await readFile(path.join(repo, "src", "flow", file), "utf8");
      expect(text).not.toMatch(/acKinds|ac-kinds|AcKind/);
    }
  });

  test("in service.ts a kind only feeds the derived field, never a throw or a gate", async () => {
    const repo = path.resolve(import.meta.dir, "..", "..");
    const text = await readFile(path.join(repo, "src", "flow", "service.ts"), "utf8");
    const lines = text.split("\n");
    lines.forEach((line, index) => {
      if (!/acKinds|AcKind|deriveAcKinds|\.kind\b/.test(line)) return;
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      const context = lines.slice(Math.max(0, index - 1), index + 2).join("\n");
      expect(context).not.toMatch(/throw |gates\.push|status: "fail"/);
    });
  });
});
