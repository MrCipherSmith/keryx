import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFlowService } from "./service";
import type { TrackerAdapter } from "./types";

// Keep the whole callback alive through Bun's timeout before another test starts.
const pending = new Set<Promise<void>>();
afterEach(async () => {
  const results = await Promise.allSettled([...pending]);
  pending.clear();
  const failed = results.find((result) => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
}, 60_000);

test.each([
  { name: "title-only init never detects a tracker", issue: false, ready: true },
  { name: "issue init still detects and fetches the issue", issue: true, ready: true },
  { name: "issue init retains the unavailable-tracker fallback", issue: true, ready: false },
])("$name", (scenario) => {
  const work = (async () => {
    const root = await mkdtemp(path.join(tmpdir(), "keryx-init-tracker-"));
    try {
      await mkdir(path.join(root, ".metaproject"));
      let detects = 0;
      let fetches = 0;
      const tracker: TrackerAdapter = {
        id: "fake",
        detect: async () => {
          detects++;
          if (!scenario.issue) throw new Error("title-only init must stay offline");
          return scenario.ready;
        },
        parseRef: () => ({ repo: "owner/repo", number: 1 }),
        fetchIssue: async () => {
          fetches++;
          return { title: "Issue title", body: "Issue body" };
        },
        prStatus: async () => ({ exists: false, isDraft: false, checksGreen: false }),
        comment: async () => true,
      };
      const service = createFlowService({
        tracker,
        healthGate: async () => ({ status: "pass", reasons: [] }),
        now: () => new Date("2026-07-07T10:00:00Z"),
      });
      const result = await service.init({
        cwd: root,
        ...(scenario.issue
          ? { issue: "https://github.com/owner/repo/issues/1" }
          : { title: "Offline title" }),
      });
      expect(detects).toBe(scenario.issue ? 1 : 0);
      expect(fetches).toBe(scenario.issue && scenario.ready ? 1 : 0);
      expect(result.flow.title).toBe(scenario.issue
        ? (scenario.ready ? "Issue title" : "Issue owner/repo#1")
        : "Offline title");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  })();
  pending.add(work);
  void work.catch(() => {});
  return work;
});
