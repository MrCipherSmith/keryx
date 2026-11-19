import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReviewBoardSnapshot, ReviewCard } from "./board-types";
import { configureWatcher, listConfiguredWatchers, pauseWatcher, pollWatcher, readWatcher } from "./watcher";

const key = { repo: "team/shop", repositoryId: "R_test", viewer: "A" };
let cwd: string;
let previous: string | undefined;
beforeEach(() => {
  previous = process.env.KERYX_DATA_DIR;
  cwd = mkdtempSync(join(tmpdir(), "keryx-watch-"));
  process.env.KERYX_DATA_DIR = cwd;
});
afterEach(() => {
  if (previous === undefined) delete process.env.KERYX_DATA_DIR;
  else process.env.KERYX_DATA_DIR = previous;
  rmSync(cwd, { recursive: true, force: true });
});
const card = (overrides: Partial<ReviewCard> = {}): ReviewCard => ({
  number: 2,
  title: "Example",
  url: "",
  state: "open",
  draft: false,
  author: "Me",
  assignees: [],
  reviewers: [],
  decision: null,
  ci: "pending",
  headSha: "head-a",
  baseSha: "base",
  updatedAt: "1",
  ...overrides,
});
const board = (...cards: ReviewCard[]): ReviewBoardSnapshot => ({
  version: 1,
  ...key,
  repositories: [key.repo],
  fetchedAt: new Date().toISOString(),
  cards,
  warnings: [],
});
const tick = (snapshot: ReviewBoardSnapshot) => pollWatcher(cwd, key, { fetch: async () => snapshot });

test("baseline, later changes, replay and observed closure are durable and project/account scoped", async () => {
  expect(readWatcher(cwd, key).state).toBe("disabled");
  configureWatcher(cwd, key, 1);
  expect((await tick(board(card()))).events).toEqual([]);
  const changed = board(
    card({ headSha: "head-b", ci: "passed", reviewers: ["Team/api"] }),
    card({ number: 3 }),
  );
  const next = await tick(changed);
  expect(next.events.map((item) => item.kind).sort()).toEqual(["ci", "opened", "push", "review_requested"]);
  expect((await tick(changed)).events).toEqual(next.events);
  expect((await tick(board())).events.filter((event) => event.kind === "left_open")).toHaveLength(2);
  expect(readWatcher(cwd, { ...key, viewer: "B" }).events).toEqual([]);
  expect(readWatcher(cwd + "-clone", key).state).toBe("disabled");
  expect(listConfiguredWatchers(cwd)).toEqual([key]);
});

test("temporary errors and incomplete snapshots retain baseline, resume discards it, repeated enable preserves it", async () => {
  configureWatcher(cwd, key, 1);
  const baseline = await tick(board(card()));
  for (const invalid of [
    { ...board(), warnings: ["missing pages"] },
    { ...board(), viewer: "B" },
    { ...board(), repositoryId: "reused-name" },
    board(card({ reviewersComplete: false })),
    board(card({ headSha: "" })),
    board(card({ baseSha: "" })),
  ]) {
    const failed = await tick(invalid);
    expect(failed.lastError).toBeTruthy();
    expect(failed.lastSuccessAt).toBe(baseline.lastSuccessAt);
    expect(failed.events).toEqual([]);
  }
  configureWatcher(cwd, key, 2);
  expect((await tick(board(card({ headSha: "head-b" })))).events.map((x) => x.kind)).toEqual(["push"]);
  pauseWatcher(cwd, key);
  expect((await tick(board())).state).toBe("paused");
  configureWatcher(cwd, key, 3);
  expect((await tick(board())).events).toHaveLength(1);
  expect(readWatcher(cwd, key).lastError).toBeNull();
});

test("concurrent ticks skip an active poll; a pre-pause result cannot overwrite a resumed baseline", async () => {
  configureWatcher(cwd, key, 1);
  let release!: (s: ReviewBoardSnapshot) => void;
  const inflight = pollWatcher(cwd, key, {
    fetch: () =>
      new Promise((r) => {
        release = r;
      }),
  });
  let polled = false;
  await pollWatcher(cwd, key, {
    fetch: async () => {
      polled = true;
      return board();
    },
  });
  expect(polled).toBe(false);
  pauseWatcher(cwd, key);
  configureWatcher(cwd, key, 1);
  await tick(board(card({ headSha: "fresh" })));
  release(board(card({ headSha: "obsolete" })));
  await inflight;
  expect((await tick(board(card({ headSha: "fresh" })))).events).toEqual([]);
});

test("detects a re-request to the same team and preserves history across account failure and restart", async () => {
  const reviewing = (request: string, name = "team/Docs") =>
    card({ reviewers: [name], reviewRequestIds: { "team/docs": request } });
  configureWatcher(cwd, key, 10);
  await tick(board(reviewing("request-A")));
  const failed = await pollWatcher(cwd, key, {
    fetch: async () => {
      throw new Error("secret transport diagnostics");
    },
  });
  expect(failed.lastError).not.toContain("secret");
  const retry = await tick(board(reviewing("request-B", "TEAM/docs")));
  expect(retry.events).toHaveLength(1);
  expect(retry.events[0]).toMatchObject({
    kind: "review_requested",
    reviewer: "TEAM/docs",
    headSha: "head-a",
  });
  expect((await tick(board(reviewing("request-B")))).events).toEqual(retry.events);
  expect((await tick(board(card()))).events[0]?.kind).toBe("review_request_removed");
});

test("after app restart, a dead poll process does not hold the lease until the next interval", async () => {
  const { Database } = await import("bun:sqlite");
  configureWatcher(cwd, key, 1);
  const db = new Database(join(cwd, "desktop-review", "watchers.sqlite"));
  try {
    db.run("UPDATE watchers SET lease='old', pid=2147483647, lastAttemptAt=?", [new Date().toISOString()]);
  } finally {
    db.close();
  }
  expect((await tick(board(card()))).lastSuccessAt).toBeTruthy();
});

test("polling and pausing an unconfigured watcher leave it disabled", async () => {
  await pollWatcher(cwd, key, {
    fetch: async () => {
      throw new Error("unexpected network access");
    },
  });
  expect(pauseWatcher(cwd, key).state).toBe("disabled");
  expect(listConfiguredWatchers(cwd)).toEqual([]);
  for (const interval of [0, 0.5, 1441])
    expect(() => configureWatcher(cwd, key, interval)).toThrow("interval");
});

test("unverified head CI and partial reviewer pages cannot remove requests or recreate an old CI event", async () => {
  configureWatcher(cwd, key, 1);
  const stable = board(card({ ci: "passed", reviewers: ["team/ui"] }));
  const success = await tick(stable);
  const uncertain = await tick(board(card({ ci: "unknown" })));
  expect(uncertain.lastError).toContain("verify CI");
  expect(uncertain.lastSuccessAt).toEqual(success.lastSuccessAt);
  expect(uncertain.events).toEqual([]);
  const partial = await tick(board(card({ reviewersComplete: false })));
  expect(partial.lastSuccessAt).toEqual(success.lastSuccessAt);
  expect(partial.events).toEqual([]);
  expect((await tick(stable)).events).toEqual([]);
});
