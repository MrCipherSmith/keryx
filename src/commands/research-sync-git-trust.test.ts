// Flow 404 (AC8): the daily Part 1 materials sync trusts a schedule.json entry only when the real `git` check says
// the entry is untracked in a real repository. These cases run real `git init` / `git add -f` in a temp directory, so
// they live here (under src/commands) and not in src/scheduler, whose no-live-network guard keeps child_process out.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { readResearchSyncFired, researchSyncClaimPath, researchSyncEntryPath, scheduleResearchSync } from "../scheduler/research-sync-job";
import { createServeResearchSync } from "./serve-research-sync";

const CATALOG = path.join("docs", "research", "role-blurring-part1");

let root: string;
let notices: string[];
let calls: string[];

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "keryx-research-git-trust-")));
  await mkdir(path.join(root, CATALOG), { recursive: true });
  notices = [];
  calls = [];
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const at = (iso: string) => (): Date => new Date(iso);
const exec = promisify(execFile);
const git = (cwd: string, ...args: string[]): Promise<unknown> => exec("git", args, { cwd });
const sync = async (r: string): Promise<{ ok: true }> => {
  calls.push(r);
  return { ok: true };
};

describe("the real serve wiring over a real repository", () => {
  test("the real serve wiring leaves a stale -latest file alone when the real sync fails", async () => {
    await git(root, "init", "-q");
    await scheduleResearchSync(root);
    const latest = path.join(root, CATALOG, "part1-counts-latest.json");
    await writeFile(latest, '{"good":true}\n');
    // No part1-counts.json and no script in the catalog: the real sync fails before it writes anything.
    // No trust override either: the entry is untracked in a real repository, so the real check lets it through.
    const job = createServeResearchSync({ roots: () => [root], now: at("2026-10-05T04:00:00Z"), onNotice: (m) => notices.push(m) });
    const reports = await job.tick();
    expect(reports.map((r) => r.action)).toEqual(["failed"]);
    expect(await readFile(latest, "utf8")).toBe('{"good":true}\n');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("research sync could not run");
  });
});

describe("an entry the project ships is not an entry the operator made", () => {
  test("a schedule.json that git tracks is ignored: the sync does not run and nothing is claimed", async () => {
    await git(root, "init", "-q");
    await scheduleResearchSync(root);
    // `git add -f` beats the ignore file of the state directory, exactly as a committed clone would carry it.
    await git(root, "add", "-f", path.relative(root, researchSyncEntryPath(root)));
    const job = createServeResearchSync({ roots: () => [root], sync, now: at("2026-10-05T04:00:00Z"), onNotice: (m) => notices.push(m) });
    expect(await job.tick()).toEqual([]);
    expect(calls).toEqual([]);
    expect(await readResearchSyncFired(root)).toBeUndefined();
    expect(existsSync(researchSyncClaimPath(root, "2026-10-05"))).toBe(false);
  });

  test("the same entry, untracked, runs; a directory that is not a repository is skipped", async () => {
    await scheduleResearchSync(root);
    const make = (): ReturnType<typeof createServeResearchSync> =>
      createServeResearchSync({ roots: () => [root], sync, now: at("2026-10-05T04:00:00Z"), onNotice: (m) => notices.push(m) });
    // Not a repository: git cannot say the entry is untracked, so it is not believed.
    expect(await make().tick()).toEqual([]);
    expect(calls).toEqual([]);

    await git(root, "init", "-q");
    expect((await make().tick()).map((r) => r.action)).toEqual(["ran"]);
    expect(calls).toEqual([root]);
  });
});
