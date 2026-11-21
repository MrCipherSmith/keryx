import { expect, test } from "bun:test";
import { projectNotices, reconcileNoticeMemory, setupRequestForFinding, type ProjectCheck } from "./projectDiagnostics";
import type { SetupInspection } from "./projectSetup";

const report: SetupInspection = {
  root: "/projects/one",
  state: "initialized",
  enclosingRoot: null,
  cliVersion: "1.0.1",
  writerVersion: "1.0.1",
  compatibility: "current",
  modules: [],
  gdskillsProfile: "recommended",
  gdskillsProfiles: ["recommended"],
  graphActions: ["none", "check-and-rebuild"],
  actions: [{ id: "wikiFreshness", module: "gdwiki", runsProjectCommands: false }],
  findings: [],
  cliSource: "bundled",
};

function check(changes: Partial<ProjectCheck> = {}): ProjectCheck {
  return { cwd: "/projects/one", root: "/projects/one", checkedAt: 1, status: "checked", report, error: null, ...changes };
}

test("a missing saved folder is a diagnostic and never an initialization prompt", () => {
  const [notice] = projectNotices([check({ status: "unavailable", report: null })]);
  expect(notice).toMatchObject({ cwd: "/projects/one", target: "retry", finding: "unavailable" });
});

test("aliases deduplicate while a similar finding in another project stays separate", () => {
  const graph = { ...report, findings: [{ id: "graph-freshness", severity: "warning" as const, message: "Graph is stale" }] };
  const first = projectNotices([check({ report: graph })])[0]!;
  const later = projectNotices([
    check({ report: graph, checkedAt: 2 }),
    check({ cwd: "/alias/one", report: graph, checkedAt: 3 }),
    check({ cwd: "/projects/two", root: "/projects/two", report: graph, checkedAt: 4 }),
  ]);
  expect(later).toHaveLength(2);
  expect(later.find(({ key }) => key === first.key)?.fingerprint).toBe(first.fingerprint);
  const memory = { [first.key]: { fingerprint: first.fingerprint, dismissed: true } };
  expect(reconcileNoticeMemory(memory, [check({ report: graph })])).toEqual(memory);
  expect(reconcileNoticeMemory(memory, [check()])).toEqual({});
});

test("repair choices come from the finding ID on fresh inspection", () => {
  const fresh = {
    ...report,
    findings: [
      { id: "graph-freshness", severity: "warning" as const, message: "Graph is stale", action: "unrelated command" },
      { id: "wiki-freshness", severity: "warning" as const, message: "Wiki report missing" },
      { id: "commit-msg-hook", severity: "warning" as const, message: "Hook missing" },
    ],
  };
  expect(setupRequestForFinding(fresh, "graph-freshness")).toEqual({ maintenanceOnly: true, graph: "check-and-rebuild" });
  expect(setupRequestForFinding(fresh, "wiki-freshness")).toEqual({ maintenanceOnly: true, actions: ["wikiFreshness"] });
  expect(setupRequestForFinding(fresh, "commit-msg-hook")).toEqual({});
  expect(setupRequestForFinding(report, "graph-freshness")).toEqual({ maintenanceOnly: true });
});
