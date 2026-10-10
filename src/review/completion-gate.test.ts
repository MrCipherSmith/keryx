// Flow 421: the shell must not accept a text-only finish while a managed review
// package is open and `keryx review complete` would still refuse.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { REPEATABLE_TOOL_NAMES } from "../commands/agent";
import {
  decideReviewGate,
  findOpenManagedReview,
  MAX_REVIEW_GATE_CONTINUES,
  type OpenManagedReview,
  reviewRunSeenInHistory,
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
    recentlyTouched: true,
    ...over,
  };
}

const idle = { runSeen: true, continues: 0, stalls: 0, lastSignature: undefined };

test("no open package: the stop is accepted", () => {
  expect(decideReviewGate({ ...idle, open: null }).action).toBe("accept");
});

test("an open package nobody in this session touched is not gated", () => {
  const decision = decideReviewGate({ ...idle, runSeen: false, open: open({ recentlyTouched: false }) });
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

test("an unchanged package soft-stops after two continues with no new artifact", () => {
  const first = decideReviewGate({ ...idle, open: open() });
  expect(first.action).toBe("continue");
  const second = decideReviewGate({
    open: open(),
    runSeen: true,
    continues: 1,
    stalls: first.action === "continue" ? first.stalls : 0,
    lastSignature: "sig-a",
  });
  expect(second.action).toBe("continue");
  const third = decideReviewGate({
    open: open(),
    runSeen: true,
    continues: 2,
    stalls: second.action === "continue" ? second.stalls : 0,
    lastSignature: "sig-a",
  });
  expect(third.action).toBe("stop");
  if (third.action === "stop") expect(third.report).toContain("missing artifacts: report.md");
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

test("findOpenManagedReview returns the draft review-flow package with its blockers", async () => {
  await writePackage("old-closed", { mode: "review-flow", status: "closed" });
  await writePackage("other-mode", { mode: "something-else", status: "draft" });
  await writePackage("live", { mode: "review-flow", status: "draft" });
  const found = await findOpenManagedReview(root);
  expect(found?.reviewId).toBe("live");
  expect(found?.blockers[0]).toContain("missing artifacts");
  expect(found?.recentlyTouched).toBe(true);
});

test("findOpenManagedReview is null with no reviews directory or only closed packages", async () => {
  expect(await findOpenManagedReview(root)).toBeNull();
  await writePackage("done", { mode: "review-flow", status: "closed" });
  expect(await findOpenManagedReview(root)).toBeNull();
});

test("the signature changes when a working file appears under data/review", async () => {
  await writePackage("live", { mode: "review-flow", status: "draft" });
  const before = await findOpenManagedReview(root);
  const data = path.join(root, ".metaproject", "data", "review");
  await mkdir(data, { recursive: true });
  await writeFile(path.join(data, "note.json"), "{}");
  const after = await findOpenManagedReview(root);
  expect(after?.signature).not.toBe(before?.signature);
});

test("reviewRunSeenInHistory finds the skill or a keryx review command in tool-call arguments", () => {
  const call = (args: string) => ({ toolCalls: [{ name: "bash", arguments: args }] });
  expect(reviewRunSeenInHistory([{}, call('{"command":"ls"}')])).toBe(false);
  expect(reviewRunSeenInHistory([call('{"skill":"review-orchestrator"}')])).toBe(true);
  expect(reviewRunSeenInHistory([call('{"command":"keryx review scope --pr 1"}')])).toBe(true);
});

test("read-only introspection tools are exempt from the repeated-call guard", () => {
  for (const name of ["plan_get", "slate_trail", "recall_step"]) {
    expect(REPEATABLE_TOOL_NAMES.has(name)).toBe(true);
  }
});
