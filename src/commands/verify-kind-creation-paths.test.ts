// Flow 422 (AC5): every route that creates a flow puts the verification-kind marker in front of the agent.
//   intake  -> `keryx flow init` (createDefaultFlowPort) -> createFlowService().init -> renderAcceptanceCriteria
//   goal    -> createFlowService().init, then its own one-criterion file (`autoProvisionFlow`)
// The helyx/Telegram surface has no flow-creating code in this repository (see the flow-422 T8 report).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseAcKinds } from "../flow/ac-kinds";
import { createFlowService } from "../flow/service";
import { renderAcceptanceCriteria } from "../flow/templates";
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
    const service = createFlowService({ tracker: null, healthGate: async () => ({ status: "skipped", reasons: [] }), now: () => new Date("2026-10-10T10:00:00Z") });
    // The runner stands in for the `keryx flow init` child: it runs the same service `flow init` runs.
    const run: KeryxRunner = async (args) => {
      const title = args[args.indexOf("--title") + 1] ?? "";
      const source = args[args.indexOf("--source") + 1] ?? "";
      await service.init({ cwd: project, title, origin: "agent-proposal", originSource: source });
      return { code: 0, timedOut: false, stdout: "", stderr: "" };
    };
    const result = await createDefaultFlowPort({ run }).init(project, { title: "Speed up checkout", source: "intake card abc123" });
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

function readdirFlow(): string {
  const dirs = readdirSync(path.join(project, ".metaproject", "flows")).filter((d) => /^\d+-/.test(d));
  expect(dirs).toHaveLength(1);
  return dirs[0]!;
}
