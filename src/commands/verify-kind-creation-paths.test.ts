// Flow 422 (AC5): every route that creates a flow puts the verification-kind marker in front of the agent.
//   intake  -> `keryx flow init` (createDefaultFlowPort) -> createFlowService().init -> renderAcceptanceCriteria
//   goal    -> createFlowService().init, then its own one-criterion file (`autoProvisionFlow`)
// The helyx/Telegram surface has no flow-creating code in this repository (see the flow-422 T8 report).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseAcKinds } from "../flow/ac-kinds";
import { renderAcceptanceCriteria } from "../flow/templates";
import { flowCommand } from "./flow";
import { autoProvisionFlow } from "./goal-command";
import { createDefaultFlowPort, type KeryxRunner } from "./intake-ports";

let project: string;
beforeEach(() => {
  project = mkdtempSync(path.join(tmpdir(), "keryx-verify-kind-paths-"));
  mkdirSync(path.join(project, ".metaproject"), { recursive: true });
});
afterEach(() => {
  rmSync(project, { recursive: true, force: true });
});

const acOf = (dir: string): string => readFileSync(path.join(project, ".metaproject", "flows", dir, "acceptance-criteria.md"), "utf8");

describe("intake", () => {
  test("a flow made through the intake port gets the acceptance-criteria template with the marker", async () => {
    // The runner stands in for the `keryx flow init` child: it hands the argv the port built to the real `flow init` handler.
    const seen: string[][] = [];
    const run: KeryxRunner = async (args, cwd) => {
      seen.push([...args]);
      const realCwd = process.cwd();
      const realLog = console.log;
      console.log = () => {};
      process.chdir(cwd);
      try {
        await flowCommand(args.slice(1));
      } finally {
        process.chdir(realCwd);
        console.log = realLog;
      }
      return { code: 0, timedOut: false, stdout: "", stderr: "" };
    };
    const result = await createDefaultFlowPort({ run }).init(project, { title: "Speed up checkout", source: "intake card abc123" });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.slice(0, 2)).toEqual(["flow", "init"]);
    expect(seen[0]).toContain("--title");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const body = acOf(result.dir);
    expect(body).toBe(renderAcceptanceCriteria());
    expect(body).toContain("[verify: <exec|invariant|judged|none>]");
    expect(body).toContain("- Every criterion ends with [verify: exec `<command>`],");
  });
});

describe("goal", () => {
  test("an auto-provisioned goal flow ends its single criterion with a valid marker", async () => {
    // F-003: autoProvisionFlow uses the default service deps. Here they are safe: title-only init stays offline (no
    // issue, so the tracker is never asked), and freeze/start never reach the tracker, health or security gates.
    const flowId = await autoProvisionFlow(project, "ship the\nlogin page");
    expect(flowId.length).toBeGreaterThan(0);
    const dir = readdirFlow();
    const parsed = parseAcKinds(acOf(dir));
    expect(parsed.errors).toEqual([]);
    expect(parsed.criteria).toHaveLength(1);
    expect(parsed.criteria[0]?.record).toEqual({ kind: "judged" });
    expect(parsed.criteria[0]?.text).toContain('"ship the login page"');
  });
});

describe("goal text carrying its own marker", () => {
  test("a goal containing [verify: exec `x`] still yields one judged AC1 and no parser errors", async () => {
    await autoProvisionFlow(project, "do it [verify: exec `x`] now [VERIFY: none — z]");
    const parsed = parseAcKinds(acOf(readdirFlow()));
    expect(parsed.errors).toEqual([]);
    expect(parsed.criteria).toHaveLength(1);
    expect(parsed.criteria[0]?.record).toEqual({ kind: "judged" });
  });
});

function readdirFlow(): string {
  const dirs = readdirSync(path.join(project, ".metaproject", "flows")).filter((d) => /^\d+-/.test(d));
  expect(dirs).toHaveLength(1);
  return dirs[0]!;
}
