import { expect, test } from "bun:test";
import {
  isNeedsAttentionEmpty,
  needsAttentionItems,
  parseInProgressFlows,
  parsePendingProposals,
  parseProjectsList,
  parseRecentTurns,
  projectNodeItems,
  recentTurnNodeItems,
  statusNodeLabel,
  type FlowListEntry,
  type SacProposalEntry,
} from "./tree-view-logic";

// --- Status node -----------------------------------------------------------

test("statusNodeLabel renders a distinct, legible label per 3-state status", () => {
  expect(statusNodeLabel("not-initialized")).toBe("Not initialized");
  expect(statusNodeLabel("incomplete")).toBe("Incomplete");
  expect(statusNodeLabel("ready")).toBe("Ready");
});

// --- Projects node -----------------------------------------------------------

test("parseProjectsList reads the 'projects' array from `keryx projects list --json`", () => {
  const stdout = JSON.stringify({
    projects: [{ projectId: "1", path: "/a", displayName: "a", state: "active" }],
  });
  expect(parseProjectsList(stdout)).toHaveLength(1);
});

test("parseProjectsList returns an empty array for garbled/missing output, never throws", () => {
  expect(parseProjectsList("")).toEqual([]);
  expect(parseProjectsList("not json")).toEqual([]);
  expect(parseProjectsList("{}")).toEqual([]);
});

test("projectNodeItems marks a 'missing' project's path in its description", () => {
  const items = projectNodeItems([
    { projectId: "1", path: "/a", displayName: "a", state: "active" },
    { projectId: "2", path: "/gone", displayName: "gone", state: "missing" },
  ]);
  expect(items[0]?.description).toBe("/a");
  expect(items[1]?.description).toContain("missing");
});

// --- Recent Turns node -----------------------------------------------------------

test("parseRecentTurns sorts most-recently-updated first and caps at the limit", () => {
  const stdout = JSON.stringify({
    sessions: [
      { id: "1", title: "old", updatedAt: "2026-08-01T00:00:00.000Z", messageCount: 1 },
      { id: "2", title: "new", updatedAt: "2026-08-20T00:00:00.000Z", messageCount: 2 },
      { id: "3", title: "mid", updatedAt: "2026-08-10T00:00:00.000Z", messageCount: 3 },
    ],
  });
  const sessions = parseRecentTurns(stdout, 2);
  expect(sessions).toHaveLength(2);
  expect(sessions[0]?.id).toBe("2");
  expect(sessions[1]?.id).toBe("3");
});

test("parseRecentTurns defaults to a limit of 10", () => {
  const sessions = Array.from({ length: 15 }, (_, i) => ({
    id: String(i),
    title: `t${i}`,
    updatedAt: new Date(2026, 0, i + 1).toISOString(),
    messageCount: 0,
  }));
  expect(parseRecentTurns(JSON.stringify({ sessions }))).toHaveLength(10);
});

test("parseRecentTurns returns an empty array for garbled/missing output, never throws", () => {
  expect(parseRecentTurns("")).toEqual([]);
  expect(parseRecentTurns("not json")).toEqual([]);
});

test("recentTurnNodeItems falls back to '(untitled)' for an empty title", () => {
  const items = recentTurnNodeItems([
    { id: "1", title: "", updatedAt: "2026-08-20T00:00:00.000Z", messageCount: 5, provider: "deepseek" },
  ]);
  expect(items[0]?.label).toBe("(untitled)");
  expect(items[0]?.description).toContain("deepseek");
});

// --- Needs Your Attention node -----------------------------------------------------------

test("parseInProgressFlows filters `keryx flow list --json` down to in-progress entries", () => {
  const stdout = JSON.stringify([
    { id: "001", status: "done", title: "old", tasksDone: 5, tasksTotal: 5 },
    { id: "185", status: "in-progress", title: "vscode ext", tasksDone: 2, tasksTotal: 11 },
  ]);
  const flows = parseInProgressFlows(stdout);
  expect(flows).toHaveLength(1);
  expect(flows[0]?.id).toBe("185");
});

test("parseInProgressFlows returns an empty array for garbled/missing output, never throws", () => {
  expect(parseInProgressFlows("")).toEqual([]);
  expect(parseInProgressFlows("not json")).toEqual([]);
  expect(parseInProgressFlows("{}")).toEqual([]);
});

test("parsePendingProposals reads the 'proposals' array from `keryx workspace catch-up --json`", () => {
  const stdout = JSON.stringify({ proposals: [{ type: "decision" }], blocked: [], unboundCandidates: [] });
  expect(parsePendingProposals(stdout)).toHaveLength(1);
});

test("parsePendingProposals returns an empty array for garbled/missing output, never throws", () => {
  expect(parsePendingProposals("")).toEqual([]);
  expect(parsePendingProposals("not json")).toEqual([]);
});

test("needsAttentionItems merges flow tasks and sac proposals, flows sorted before proposals", () => {
  const flows: FlowListEntry[] = [{ id: "185", status: "in-progress", title: "vscode ext", tasksDone: 2, tasksTotal: 11 }];
  const proposals: SacProposalEntry[] = [{ type: "decision" }];
  const items = needsAttentionItems(flows, proposals);
  expect(items).toHaveLength(2);
  expect(items[0]?.kind).toBe("flow");
  expect(items[1]?.kind).toBe("sac-proposal");
});

// AC5, dedicated test case (not incidental coverage): a project with NEITHER
// flow nor sac configured must render a real, legible empty-state item.
test("AC5: needsAttentionItems returns an explicit, legible empty state when neither flow nor sac has anything", () => {
  const items = needsAttentionItems([], []);
  expect(items).toHaveLength(1);
  expect(items[0]?.kind).toBe("empty");
  expect(items[0]?.label).toBe("Nothing needs your attention");
  expect(items[0]?.description.length).toBeGreaterThan(0);
  expect(isNeedsAttentionEmpty(items)).toBe(true);
});

test("AC5: isNeedsAttentionEmpty is false as soon as either source has an item", () => {
  const withFlow = needsAttentionItems(
    [{ id: "1", status: "in-progress", title: "x", tasksDone: 0, tasksTotal: 1 }],
    [],
  );
  expect(isNeedsAttentionEmpty(withFlow)).toBe(false);

  const withProposal = needsAttentionItems([], [{ type: "decision" }]);
  expect(isNeedsAttentionEmpty(withProposal)).toBe(false);
});
