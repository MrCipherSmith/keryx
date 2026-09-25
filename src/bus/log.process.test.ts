// Cross-process proofs for the bus event log (flow 272 T9).
//
//   AC4  eight real processes appending 100 events each: 800 events, seq unique
//        and gap-free, no torn line, head.json at 800;
//   AC4  a writer SIGKILLed between its line and its head.json update: the next
//        append from another process takes the following seq, no duplicate;
//   AC5  rotation under concurrent writers with a reader holding a cursor: every
//        event read exactly once, at most two rotated segments kept;
//   AC9  two linked worktrees: `keryx bus list --json` in each sees the other.
//
// Hermetic: every process works on a fresh temp directory, and the driver
// script is generated there. Signals are POSIX-only, so the file is skipped on
// win32.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { type BusCursor, cursorAtEnd, cursorAtStart, readEvents, readHead } from "./log";
import { SAFE_BUN_SPAWN_ARGS } from "../lib/safe-exec";
import { eventsPath, resolveBusRoot } from "./paths";
import { writePresence } from "./presence";
import type { BusEvent, PresenceRecord } from "./schema";

const LOG_MODULE = path.join(import.meta.dir, "log.ts");
const CLI = path.join(import.meta.dir, "..", "cli.ts");
const posix = process.platform !== "win32";

let work: string;
let driver: string;

beforeAll(async () => {
  work = await mkdtemp(path.join(tmpdir(), "keryx-bus-proc-"));
  driver = path.join(work, "append-driver.ts");
  // args: <root> <count> <label> [maxSegmentBytes] [parkFile]
  // With parkFile, the FIRST append parks after its line is written and before
  // head.json is updated: it writes parkFile and waits to be killed.
  await writeFile(
    driver,
    `import { writeFileSync } from "node:fs";
import { appendEvent } from ${JSON.stringify(LOG_MODULE)};
const [root, countRaw, label, maxRaw, parkFile] = process.argv.slice(2);
const maxSegmentBytes = maxRaw && maxRaw !== "-" ? Number(maxRaw) : undefined;
const from = { instanceId: crypto.randomUUID(), name: "cli", origin: "cli" };
for (let i = 0; i < Number(countRaw); i += 1) {
  await appendEvent(root, { from, to: ["*"], toLabel: "@all", kind: "notice", body: label + ":" + i }, {
    ...(maxSegmentBytes !== undefined ? { maxSegmentBytes } : {}),
    ...(parkFile ? { afterLineWritten: async () => { writeFileSync(parkFile, "parked"); await new Promise(() => {}); } } : {}),
  });
}
`,
    "utf8",
  );
});

afterAll(async () => {
  await rm(work, { recursive: true, force: true });
});

function spawnDriver(root: string, count: number, label: string, maxSegmentBytes?: number, parkFile?: string) {
  return Bun.spawn(["bun", driver, root, String(count), label, maxSegmentBytes === undefined ? "-" : String(maxSegmentBytes), ...(parkFile ? [parkFile] : [])], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
}

async function finish(proc: ReturnType<typeof spawnDriver>): Promise<void> {
  const code = await proc.exited;
  if (code !== 0) throw new Error(`driver exited ${code}: ${await new Response(proc.stderr).text()}`);
}

async function freshRoot(name: string): Promise<string> {
  return path.join(await mkdtemp(path.join(work, `${name}-`)), "bus");
}

const seqs = (events: readonly BusEvent[]): number[] => events.map((e) => e.seq);
const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, i) => from + i);

async function allLines(root: string): Promise<string[]> {
  const names = (await readdir(root)).filter((n) => /^events(\.\d+)?\.jsonl$/.test(n));
  const lines: string[] = [];
  for (const name of names) {
    lines.push(...(await readFile(path.join(root, name), "utf8")).split("\n").filter((l) => l.length > 0));
  }
  return lines;
}

describe.skipIf(!posix)("bus log across processes", () => {
  test("AC4: 8 processes x 100 appends -> 800 events, seq 1..800 unique and gap-free, no torn line", async () => {
    const root = await freshRoot("concurrent");
    const procs = Array.from({ length: 8 }, (_, i) => spawnDriver(root, 100, `w${i}`));
    await Promise.all(procs.map(finish));

    const lines = await allLines(root);
    expect(lines.length).toBe(800);
    const parsed = lines.map((line) => JSON.parse(line) as BusEvent); // throws on a torn line
    expect(parsed.map((e) => e.seq).sort((a, b) => a - b)).toEqual(range(1, 800));
    expect(seqs((await readEvents(root, await cursorAtStart(root))).events)).toEqual(range(1, 800));
    expect((await readHead(root))?.seq).toBe(800);
    // Every writer's 100 events are all there.
    for (let i = 0; i < 8; i += 1) {
      expect(parsed.filter((e) => e.body?.startsWith(`w${i}:`)).length).toBe(100);
    }
  }, 60_000);

  test("AC4: a writer SIGKILLed between its line and head.json causes no duplicate seq", async () => {
    const root = await freshRoot("killed");
    await finish(spawnDriver(root, 3, "before"));
    const parkFile = path.join(path.dirname(root), "parked");
    const victim = spawnDriver(root, 1, "victim", undefined, parkFile);
    const deadline = Date.now() + 20_000;
    while (!existsSync(parkFile)) {
      if (Date.now() > deadline) throw new Error(`victim never parked: ${await new Response(victim.stderr).text()}`);
      await Bun.sleep(20);
    }
    victim.kill("SIGKILL");
    await victim.exited;
    // The victim's line is on disk; head.json still says 3.
    expect((await readHead(root))?.seq).toBe(3);

    const startedAt = Date.now();
    await finish(spawnDriver(root, 1, "after"));
    const waitedMs = Date.now() - startedAt;

    const events = (await readEvents(root, await cursorAtStart(root))).events;
    expect(events.map((e) => [e.seq, e.body])).toEqual([
      [1, "before:0"],
      [2, "before:1"],
      [3, "before:2"],
      [4, "victim:0"],
      [5, "after:0"],
    ]);
    expect((await readHead(root))?.seq).toBe(5);
    // The dead holder's append.lock is reclaimed promptly, not after 30 s.
    expect(waitedMs).toBeLessThan(15_000);
  }, 60_000);

  test("AC5: a reader holding a cursor through >= 3 rotations reads every event exactly once", async () => {
    const root = await freshRoot("rotation");
    const maxSegmentBytes = 4096; // ~14 events per segment
    const writers = 4;
    const perWriter = 40;
    const total = writers * perWriter;

    let cursor: BusCursor = await cursorAtEnd(root);
    const seen: number[] = [];
    let offsetBeyondNewSegment = 0;
    let lastSegment = cursor.segment;
    const poll = async (): Promise<void> => {
      const sizeBefore = existsSync(eventsPath(root)) ? (await stat(eventsPath(root)).catch(() => undefined))?.size : undefined;
      const read = await readEvents(root, cursor);
      if (read.cursor.segment !== lastSegment && sizeBefore !== undefined && cursor.offset > sizeBefore) {
        offsetBeyondNewSegment += 1;
      }
      lastSegment = read.cursor.segment;
      seen.push(...seqs(read.events));
      cursor = read.cursor;
    };

    const procs = Array.from({ length: writers }, (_, i) => spawnDriver(root, perWriter, `r${i}`, maxSegmentBytes));
    let done = false;
    const all = Promise.all(procs.map(finish)).finally(() => {
      done = true;
    });
    while (!done) {
      await poll();
      await Bun.sleep(1);
    }
    await all;
    await poll();

    expect(seen).toEqual(range(1, total));
    const rotated = (await readdir(root)).filter((n) => /^events\.\d+\.jsonl$/.test(n));
    expect(rotated.length).toBeLessThanOrEqual(2);
    expect((await readHead(root))?.segment).toBeGreaterThanOrEqual(4); // >= 3 rotations
    expect(offsetBeyondNewSegment).toBeGreaterThanOrEqual(1);
  }, 60_000);
});

describe.skipIf(!posix)("keryx bus list across two worktrees (real CLI processes)", () => {
  test("AC9: each worktree's `bus list --json` sees the presence the other wrote", async () => {
    const repo = await mkdtemp(path.join(work, "repo-"));
    const gitEnv = {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    };
    const git = async (cwd: string, ...args: string[]) => {
      const proc = Bun.spawn(["git", ...args], { cwd, stdout: "ignore", stderr: "ignore", env: gitEnv });
      expect(await proc.exited).toBe(0);
    };
    await writeFile(path.join(repo, "README.md"), "x\n", "utf8");
    await git(repo, "init", "-b", "main");
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", "initial");
    const worktree = path.join(repo, "wt");
    await git(repo, "worktree", "add", "-b", "feature", worktree, "main");

    const now = new Date().toISOString();
    const record = (instanceId: string, name: string, checkout: string): PresenceRecord => ({
      schemaVersion: 1,
      instanceId,
      name,
      pid: process.pid,
      host: hostname(),
      sessionId: "9b2f7e1c-3f4a-4c55-8d3e-2a1b0c9d8e7f",
      checkout,
      branch: null,
      surface: "tui",
      status: "idle",
      activity: "",
      startedAt: now,
      heartbeatAt: now,
      keryxVersion: "0.2.121",
    });
    await writePresence((await resolveBusRoot(repo)).root, record("0f8fad5b-d9cb-469f-a165-70867728950e", "main-shell", repo));
    await writePresence((await resolveBusRoot(worktree)).root, record("7c9e6679-7425-40de-944b-e07fc1f90ae7", "wt-shell", worktree));

    const listed = await Promise.all(
      [repo, worktree].map(async (cwd) => {
        const proc = Bun.spawn(["bun", ...SAFE_BUN_SPAWN_ARGS, CLI, "bus", "list", "--json"], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env } });
        const out = await new Response(proc.stdout).text();
        expect(await proc.exited).toBe(0);
        return (JSON.parse(out) as { peers: { name: string }[] }).peers.map((p) => p.name).sort();
      }),
    );
    expect(listed).toEqual([
      ["main-shell", "wt-shell"],
      ["main-shell", "wt-shell"],
    ]);
  }, 60_000);
});
