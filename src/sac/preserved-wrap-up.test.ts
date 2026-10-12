import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { commitPreservation } from "../session/preservation";
import { resolvePreservedWrapUp } from "./preserved-wrap-up";
const dirs: string[] = [];
function temp(): string { const dir = mkdtempSync(path.join(tmpdir(), "pinned-wrapup-")); dirs.push(dir); return dir; }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
test("zero Seeds and successor mutation retain pinned Notes and transcript", async () => {
  const cwd = temp(); const dir = temp();
  const raw = JSON.stringify({ workspaceId: "team", seeds: [], notes: { finding: { text: "original finding" } }, trail: [{ outcome: "original outcome" }] });
  const snapshot = commitPreservation(dir, { "slate.json": raw, "archive.jsonl": "original transcript" });
  writeFileSync(path.join(dir, "slate.json"), "successor Slate");
  writeFileSync(path.join(dir, "archive.jsonl"), "successor transcript");
  const resolved = await resolvePreservedWrapUp({ cwd, dir, snapshot, workspaceId: "team" });
  const primary = readFileSync(path.join(cwd, resolved.evidence[0]!.uri), "utf8");
  expect(primary).toContain("original finding"); expect(primary).toContain("original outcome");
  expect(primary).toContain("NOT MEASURED"); expect(primary).not.toContain("successor");
  expect(readFileSync(path.join(cwd, resolved.evidence[1]!.uri), "utf8")).toBe("original transcript");
  expect(readFileSync(path.join(dir, "slate.json"), "utf8")).toBe("successor Slate");
  const again = await resolvePreservedWrapUp({ cwd, dir, snapshot, workspaceId: "team" });
  expect(again.evidence.map((e) => e.uri)).toEqual(resolved.evidence.map((e) => e.uri));
});
test("workspace rebinding and path traversal are refused", async () => {
  const cwd = temp(); const dir = temp();
  const snapshot = commitPreservation(dir, { "slate.json": JSON.stringify({ workspaceId: "team" }) });
  await expect(resolvePreservedWrapUp({ cwd, dir, snapshot, workspaceId: "other" })).rejects.toThrow("mismatch");
  await expect(resolvePreservedWrapUp({ cwd, dir, snapshot, workspaceId: "../escape" })).rejects.toThrow("identity");
});
test("hash corruption cannot become trustworthy evidence", async () => {
  const cwd = temp(); const dir = temp();
  const snapshot = commitPreservation(dir, { "slate.json": JSON.stringify({ workspaceId: "team" }) });
  writeFileSync(path.join(dir, "preservation", "generations", `${snapshot}.json`), "{}");
  await expect(resolvePreservedWrapUp({ cwd, dir, snapshot, workspaceId: "team" })).rejects.toThrow("hash mismatch");
});

test("escaping workspace and evidence ancestors cannot write outside", async () => {
  const cwd = temp(); const dir = temp(); const outside = temp();
  const snapshot = commitPreservation(dir, { "slate.json": JSON.stringify({ workspaceId: "team" }) });
  const workspaces = path.join(cwd, ".metaproject", "workspaces");
  mkdirSync(workspaces, { recursive: true });
  const workspace = path.join(workspaces, "team");
  symlinkSync(outside, workspace, "dir");
  await expect(resolvePreservedWrapUp({ cwd, dir, snapshot, workspaceId: "team" })).rejects.toThrow();
  expect(readdirSync(outside)).toEqual([]);
  rmSync(workspace);
  mkdirSync(workspace);
  symlinkSync(outside, path.join(workspace, "preserved-evidence"), "dir");
  await expect(resolvePreservedWrapUp({ cwd, dir, snapshot, workspaceId: "team" })).rejects.toThrow();
  expect(readdirSync(outside)).toEqual([]);
});
test("a backtick run in the captured Slate cannot close the fence; evidence is git-ignored", async () => {
  const cwd = temp(); const dir = temp();
  const raw = JSON.stringify({ workspaceId: "team", notes: { n: { text: "```\n# injected heading\n```` ````" } } });
  const snapshot = commitPreservation(dir, { "slate.json": raw });
  const resolved = await resolvePreservedWrapUp({ cwd, dir, snapshot, workspaceId: "team" });
  const primary = readFileSync(path.join(cwd, resolved.evidence[0]!.uri), "utf8");
  const fence = /^(`{3,})json$/m.exec(primary)![1]!;
  expect(fence.length).toBeGreaterThan(4);
  expect(primary.split("\n").filter((line) => line === fence)).toHaveLength(1);
  expect(readFileSync(path.join(cwd, ".metaproject", "workspaces", "team", "preserved-evidence", ".gitignore"), "utf8")).toBe("*\n");
});
