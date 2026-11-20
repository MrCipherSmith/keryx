import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as reader from "./desk-reviewer-progress";
import type { DeskRun, DeskReviewerSession } from "./desk-run-types";
import { createWorkerRoster } from "./desk-worker-roster";

test("reuses the admitted plan on 100 usage updates and revalidates changed assignments and revisions", () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "desk-roster-")));
  const key = { viewer: "test", repositoryId: "repo", repo: "org/repo", number: 4 };
  const run: DeskRun = { id: crypto.randomUUID(), source: "manual", state: "running", phase: "", reason: "", result: null,
    baseSha: "a".repeat(40), headSha: "b".repeat(40), createdAt: "", startedAt: null, finishedAt: null };
  const ref = "https://github.com/org/repo/pull/4", packageId = "prepared";
  const live = path.join(dir, "checkout", ".metaproject", "reviews", packageId);
  const write = (file: string, value: unknown) => writeFileSync(file, JSON.stringify(value));
  const target = { ref, base: run.baseSha, head: run.headSha };
  const calls = Array.from({ length: 100 }, (_, i) => ({ label: "review-" + i, save_result_to: "raw/review-" + i + "-w1.txt" }));
  const session: DeskReviewerSession = { id: crypto.randomUUID(), reviewer: "review-0", wave: 1, state: "running" };
  const aux = { ...session, id: crypto.randomUUID(), reviewer: "triage" };
  const p = { packageId, reviewerSessions: [session, aux] };
  const read = spyOn(reader, "readDeskReviewerProgress");
  try {
    mkdirSync(live, { recursive: true });
    mkdirSync(path.join(dir, "run"));
    write(path.join(live, "manifest.json"), { target });
    write(path.join(live, "desktop-dispatch.json"), { calls });
    const publish = () => write(path.join(dir, "run/progress.json"), { ref, ...p });
    publish();
    const checkpoint = createWorkerRoster(dir, key, run);
    expect(checkpoint(p)?.planned).toBe(100);
    for (let i = 0; i < 100; i++) {
      session.usage = { inputTokens: i };
      if (i < 99) session.usagePartial = true;
      else delete session.usagePartial;
      const update = checkpoint(p);
      expect(update?.sessions[0]?.usage?.inputTokens).toBe(i);
      expect(!!update?.sessions[0]?.usagePartial).toBe(i < 99);
      expect(update?.sessions.some(s => s.id === aux.id)).toBe(false);
    }
    expect(read).toHaveBeenCalledTimes(1);
    expect(checkpoint(p)).toBeUndefined();
    publish();
    write(path.join(live, "desktop-dispatch.json"), { calls: calls.slice(1) });
    expect(checkpoint(p)?.sessions.some(s => s.id === session.id)).toBe(false);
    expect(read).toHaveBeenCalledTimes(2);
    write(path.join(live, "manifest.json"), { target: { ...target, head: run.baseSha } });
    expect(checkpoint(p)?.planned).toBeNull();
    expect(read).toHaveBeenCalledTimes(3);
  } finally { read.mockRestore(); rmSync(dir, { recursive: true, force: true }); }
});
