// Flow 421: the shell must not accept a text-only finish while a managed review
// package is open and `keryx review complete` would still refuse.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { REPEATABLE_TOOL_NAMES } from "../commands/agent";
import {
  decideReviewGate,
  findReviewGateState,
  MAX_REVIEW_GATE_CONTINUES,
  type OpenManagedReview,
  reviewRunSeenInHistory,
  sessionStartedAt,
} from "./completion-gate";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "gate-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writePackage(name: string, manifest: Record<string, unknown>): Promise<string> {
  const dir = path.join(root, ".metaproject", "reviews", name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "manifest.json"), JSON.stringify({ reviewId: name, ...manifest }));
  return dir;
}

function open(over: Partial<OpenManagedReview> = {}): OpenManagedReview {
  return {
    reviewId: "r1",
    packageDir: "/x",
    blockers: ["missing artifacts: report.md"],
    signature: "sig-a",
    ...over,
  };
}

const idle = { runSeen: true, continues: 0, stalls: 0, lastSignature: undefined };

test("no open package: the stop is accepted", () => {
  expect(decideReviewGate({ ...idle, open: null }).action).toBe("accept");
});

test("an open package in a session that never ran a review is not gated (a checkout carries old drafts)", () => {
  const decision = decideReviewGate({ ...idle, runSeen: false, open: open() });
  expect(decision.action).toBe("accept");
});

test("an open package with a review run seen continues and names what review complete refuses on", () => {
  const decision = decideReviewGate({ ...idle, open: open() });
  expect(decision.action).toBe("continue");
  if (decision.action === "continue") {
    expect(decision.message).toContain("missing artifacts: report.md");
    expect(decision.message).toContain("prose step");
    expect(decision.message).toContain("keryx review --help");
  }
});

test("an unchanged package soft-stops after three continues with no new artifact", () => {
  let stalls = 0;
  let last: string | undefined;
  const actions: string[] = [];
  for (let continues = 0; continues < 4; continues += 1) {
    const d = decideReviewGate({ open: open(), runSeen: true, continues, stalls, lastSignature: last });
    actions.push(d.action);
    if (d.action === "continue") {
      stalls = d.stalls;
      last = d.signature;
    } else if (d.action === "stop") {
      expect(d.report).toContain("missing artifacts: report.md");
    }
  }
  expect(actions).toEqual(["continue", "continue", "continue", "stop"]);
});


test("progress (a changed signature) resets the stall count", () => {
  const decision = decideReviewGate({
    open: open({ signature: "sig-b" }),
    runSeen: true,
    continues: 3,
    stalls: 1,
    lastSignature: "sig-a",
  });
  expect(decision).toMatchObject({ action: "continue", stalls: 0 });
});

test("the continue cap stops even while the package keeps changing", () => {
  const decision = decideReviewGate({
    open: open({ signature: "new" }),
    runSeen: true,
    continues: MAX_REVIEW_GATE_CONTINUES,
    stalls: 0,
    lastSignature: "old",
  });
  expect(decision.action).toBe("stop");
});

test("findReviewGateState returns the draft review-flow package with its blockers", async () => {
  await writePackage("old-closed", { mode: "review-flow", status: "closed" });
  await writePackage("other-mode", { mode: "something-else", status: "draft" });
  await writePackage("live", { mode: "review-flow", status: "draft" });
  const found = await findReviewGateState(root, Date.now() + 60_000);
  expect(found?.reviewId).toBe("live");
  expect(found?.blockers[0]).toContain("missing artifacts");
});

test("an ingest-mode draft written this session keeps the gate on; one from before the session does not", async () => {
  await writePackage("flipped", { mode: "ingest", status: "draft" });
  expect((await findReviewGateState(root, 0))?.reviewId).toBe("flipped");
  const later = await findReviewGateState(root, Date.now() + 60_000);
  expect(later?.packageDir).toBe("");
});

test("with no package yet the state says review start has not opened one, and names the next step", async () => {
  const found = await findReviewGateState(root, 0);
  expect(found?.packageDir).toBe("");
  expect(found?.blockers[0]).toContain("keryx review start");
  const decision = decideReviewGate({ ...idle, open: found });
  expect(decision.action).toBe("continue");
  if (decision.action === "continue") expect(decision.message).toContain("keryx review start --pr");
});

test("a package closed since the session began ends the gate; one closed before it does not", async () => {
  await writePackage("done", { mode: "review-flow", status: "closed" });
  expect(await findReviewGateState(root, 0)).toBeNull();
  const later = await findReviewGateState(root, Date.now() + 60_000);
  expect(later?.packageDir).toBe("");
});

test("a draft newer than the closed package keeps the gate on", async () => {
  await writePackage("done", { mode: "review-flow", status: "closed" });
  await new Promise((r) => setTimeout(r, 15));
  await writePackage("live", { mode: "review-flow", status: "draft" });
  expect((await findReviewGateState(root, 0))?.reviewId).toBe("live");
});

test("the signature changes when a working file appears under data/review", async () => {
  await writePackage("live", { mode: "review-flow", status: "draft" });
  const before = await findReviewGateState(root, 0);
  const data = path.join(root, ".metaproject", "data", "review");
  await mkdir(data, { recursive: true });
  await writeFile(path.join(data, "note.json"), "{}");
  const after = await findReviewGateState(root, 0);
  expect(after?.signature).not.toBe(before?.signature);
});

test("reviewRunSeenInHistory finds a skill_load of the review skill or a keryx review command", () => {
  const call = (name: string, args: string) => ({ toolCalls: [{ name, arguments: args }] });
  expect(reviewRunSeenInHistory([{}, call("bash", '{"command":"ls"}')])).toBe(false);
  expect(reviewRunSeenInHistory([call("bash", '{"command":"keryx ctx rg review-orchestrator"}')])).toBe(false);
  expect(reviewRunSeenInHistory([call("skill_load", '{"name":"review-orchestrator"}')])).toBe(true);
  expect(reviewRunSeenInHistory([call("bash", '{"command":"keryx review scope --pr 1"}')])).toBe(true);
});

test("sessionStartedAt is the first message timestamp", () => {
  expect(sessionStartedAt([{}, { ts: "2026-10-10T08:00:00.000Z" }, { ts: "2026-10-10T09:00:00.000Z" }])).toBe(
    Date.parse("2026-10-10T08:00:00.000Z"),
  );
});

test("read-only introspection tools are exempt from the repeated-call guard", () => {
  for (const name of ["plan_get", "slate_trail", "recall_step"]) {
    expect(REPEATABLE_TOOL_NAMES.has(name)).toBe(true);
  }
});
