import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFile, mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseWatchArgs, requestWatch } from "./review-watch";
import { pollWatcher } from "../review/watcher";
import type { ReviewBoardSnapshot, ReviewCard } from "../review/board-types";
import { watcherLabel } from "../review/watch-launchd";
import type { ScheduleHost } from "../trigger/install";

const key = { repo: "org/repo", repositoryId: "R_test", viewer: "alice" };
let dir: string, project: string, host: ScheduleHost;
let loaded: Set<string>, calls: string[], failBootstrap: boolean;
const savedGhToken = process.env.GH_TOKEN, savedGithubToken = process.env.GITHUB_TOKEN;
const ghToken = "test-only-login-one", githubToken = "test-only-login-two";
const oldData = process.env.KERYX_DATA_DIR,
  oldPath = process.env.PATH;
beforeEach(async () => {
  dir = await realpath(await mkdtemp(path.join(tmpdir(), "review-watch-os-")));
  project = path.join(dir, "space & <project>");
  await mkdir(project);
  const tools = path.join(dir, "bin");
  await mkdir(tools);
  await writeFile(path.join(tools, "gh"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
  process.env.KERYX_DATA_DIR = path.join(dir, "data");
  process.env.GH_TOKEN = ghToken;
  process.env.GITHUB_TOKEN = githubToken;
  process.env.PATH = tools + path.delimiter + oldPath;
  loaded = new Set();
  calls = [];
  failBootstrap = false;
  host = {
    uid: 502,
    platform: "darwin",
    launchAgentsDir: path.join(dir, "launch"),
    invocation: { execPath: process.execPath },
    run: async (_, args) => {
      const [op] = args;
      const label = op === "bootstrap" ? path.basename(args[2]!, ".plist") : args[1]!.split("/").at(-1)!;
      calls.push(op!);
      const code =
        op === "print" ? (loaded.has(label) ? 0 : 113) : op === "bootstrap" && failBootstrap ? 5 : 0;
      if (!code && op === "bootstrap") loaded.add(label);
      if (!code && op === "bootout") loaded.delete(label);
      return {
        code,
        stdout:
          op === "print" && !code ? "  path = " + path.join(dir, "launch", label + ".plist") + "\n" : "",
        stderr: "",
      };
    },
  };
});
afterEach(async () => {
  if (savedGhToken === undefined) delete process.env.GH_TOKEN;
  else process.env.GH_TOKEN = savedGhToken;
  if (savedGithubToken === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = savedGithubToken;
  if (oldData === undefined) delete process.env.KERYX_DATA_DIR;
  else process.env.KERYX_DATA_DIR = oldData;
  if (oldPath === undefined) delete process.env.PATH;
  else process.env.PATH = oldPath;
  await rm(dir, { recursive: true, force: true });
});
const verify = async () => {};
const control = (action: "enable" | "status" | "pause" | "resume", mins?: number) =>
  requestWatch(project, { key, action, minutes: mins }, host, verify);
const plist = () => path.join(host.launchAgentsDir!, watcherLabel(project, key) + ".plist");

test("schedule is independent of Desktop, executable paths are pinned and concurrent enables install once", async () => {
  const verifiedEnvs: (NodeJS.ProcessEnv | undefined)[] = [];
  const enable = () => requestWatch(project, { key, action: "enable", minutes: 7 }, host, async (_cwd, _key, env) => {
    verifiedEnvs.push(env);
  });
  const results = await Promise.all([enable(), enable()]);
  expect(results.map((r) => r.installed)).toEqual([true, true]);
  const contents = await readFile(plist(), "utf8");
  expect(contents).toContain("<integer>420</integer>");
  expect(contents).toContain("<key>RunAtLoad</key><true/>");
  expect(contents).toContain("<string>tick</string>");
  expect(contents).toContain("&amp; &lt;project&gt;");
  expect(verifiedEnvs.filter(env => !env)).toHaveLength(2);
  const scheduledEnvs = verifiedEnvs.filter(env => env !== undefined);
  expect(scheduledEnvs).toHaveLength(2);
  for (const env of scheduledEnvs) {
    expect(env.HOME).toBeTruthy();
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(Object.values(env)).not.toContain(ghToken);
    expect(Object.values(env)).not.toContain(githubToken);
  }
  for (const value of ["GH_TOKEN", "GITHUB_TOKEN", ghToken, githubToken]) expect(contents).not.toContain(value);
  expect(calls.filter((c) => c === "bootstrap")).toHaveLength(1);
  await control("enable", 12);
  expect(await readFile(plist(), "utf8")).toContain("<integer>720</integer>");
  expect(loaded.size).toBe(1);
  expect((await control("status")).installed).toBe(true);
});

test("offline pause removes the job and survives login, resume reinstalls the previous interval", async () => {
  await control("enable", 9);
  const pause = await requestWatch(
    project,
    { action: "pause", minutes: undefined, key: undefined },
    host,
    async () => {
      throw Error("offline");
    },
  );
  expect(pause).toMatchObject({ state: "paused", installed: false, lastError: null, events: [] });
  expect(loaded.size).toBe(0);
  expect(await Bun.file(plist()).exists()).toBe(false);
  expect((await control("pause")).installed).toBe(false);
  expect(await control("resume")).toMatchObject({ state: "enabled", installed: true, intervalMinutes: 9 });
});

test("a local pause stops the timer while another request is still verifying GitHub access", async () => {
  await control("enable", 5);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const verified = new Promise<void>(resolve => { release = resolve; });
  const enabling = requestWatch(project, { key, action: "enable", minutes: 1 }, host, async () => {
    entered();
    await verified;
  });
  await started;
  try {
    expect((await control("pause")).state).toBe("paused");
    expect(loaded.size).toBe(0);
  } finally { release(); }
  await expect(enabling).rejects.toThrow("paused during verification");
  expect((await control("status")).installed).toBe(false);
});

test("failed bootstrap is visible and recoverable, missing prerequisites do not install", async () => {
  await expect(
    requestWatch(project, { key, action: "enable", minutes: 1 }, host, async () => {
      throw Error("access denied");
    }),
  ).rejects.toThrow("access");
  expect((await control("status")).state).toBe("disabled");
  failBootstrap = true;
  await expect(control("enable", 1)).rejects.toThrow("could not install");
  expect(await control("status")).toMatchObject({ state: "enabled", installed: false });
  failBootstrap = false;
  expect((await control("enable", 1)).installed).toBe(true);
});

test("unverified status resolves only an unambiguous project watcher", async () => {
  await control("enable", 4);
  await requestWatch(project, { action: "enable", key: { ...key, viewer: "bob" }, minutes: 4 }, host, verify);
  await expect(
    requestWatch(project, { action: "pause", key: undefined, minutes: undefined }, host, verify),
  ).rejects.toThrow("select the repository");
  expect(loaded.size).toBe(2);
});

test("foreign plist is preserved; unknown operations and invalid intervals are rejected", async () => {
  await mkdir(host.launchAgentsDir!, { recursive: true });
  await writeFile(plist(), "foreign agent");
  await expect(control("enable", 2)).rejects.toThrow("managed by another");
  expect(await readFile(plist(), "utf8")).toBe("foreign agent");
  const flags = ["--repo", "org/repo", "--repository-id", "R_test", "--viewer", "alice", "--json"];
  expect(parseWatchArgs(["enable", ...flags, "--interval-minutes", "1"])).toMatchObject({ minutes: 1, key });
  for (const args of [
    ["status", ...flags, "--interval-minutes", "5"],
    ["tick", "--json"],
    ["enable", ...flags, "--interval-minutes", "0"],
    ["enable", ...flags, "--interval-minutes", "1441"],
    ["install", "--json"],
  ])
    expect(() => parseWatchArgs(args)).toThrow();
});

test("a loaded job with its plist removed can be repaired and paused", async () => {
  await control("enable", 3);
  await rm(plist());
  expect(loaded.size).toBe(1);
  expect((await control("status")).installed).toBe(false);
  expect((await control("enable", 3)).installed).toBe(true);
  expect(await Bun.file(plist()).exists()).toBe(true);
  await rm(plist());
  expect((await control("pause")).installed).toBe(false);
  expect(loaded.size).toBe(0);
});

test("foreign loaded source and replaced plist cannot be removed", async () => {
  await control("enable", 3);
  const run = host.run!;
  host = {
    ...host,
    run: async (command, args) =>
      args[0] === "print"
        ? { code: 0, stdout: "  path = /elsewhere/foreign.plist\n", stderr: "" }
        : run(command, args),
  };
  await expect(control("pause")).rejects.toThrow("Another LaunchAgent");
  expect(loaded.size).toBe(1);
  await writeFile(plist(), "replacement");
  await expect(control("pause")).rejects.toThrow("managed by another");
  expect(calls).not.toContain("bootout");
});

test("scoped pause preserves confirmed poll errors but completes offline and redacts private history", async () => {
  await control("enable", 1);
  const card: ReviewCard = {
    number: 14, state: "open", draft: false, title: "Fixture PR", url: "", author: "alice",
    assignees: [], reviewers: [], ci: "passed", decision: null, updatedAt: "1", baseSha: "base", headSha: "head",
  };
  const observe = (cards: ReviewCard[]) => pollWatcher(project, key, {
    fetch: async (): Promise<ReviewBoardSnapshot> => ({
      version: 1, ...key, repositories: [key.repo], fetchedAt: new Date().toISOString(), cards, warnings: [],
    }),
  });
  await observe([]);
  await observe([card]);
  await pollWatcher(project, key, {
    fetch: async () => {
      throw Error("configuration: synthetic poll details");
    },
  });
  const confirmed = await control("status");
  expect(confirmed.lastError).toContain("synthetic");
  expect(confirmed.events).toContainEqual(expect.objectContaining({ kind: "opened", number: card.number }));
  expect(loaded.size).toBe(1);
  const jobsAtVerification: number[] = [];
  const hidden = await requestWatch(project, { key, action: "pause", minutes: undefined }, host, async () => {
    jobsAtVerification.push(loaded.size);
    throw Error("revoked");
  });
  expect(jobsAtVerification).toEqual([0]);
  expect(hidden).toMatchObject({ historyAvailable: false, events: [], state: "paused", installed: false });
  expect(hidden.lastError).not.toContain("synthetic");
  expect((await control("pause")).lastError).toBe(confirmed.lastError);
  const local = await requestWatch(
    project,
    { key: undefined, action: "pause", minutes: undefined },
    host,
    verify,
  );
  expect(local.historyAvailable).toBe(false);
});

test("moving the installed Keryx app marks its job unavailable and enables repair", async () => {
  const binary = path.join(dir, "Keryx.app", "Contents", "MacOS", "keryx");
  await mkdir(path.dirname(binary), { recursive: true });
  await writeFile(binary, "#!/bin/sh\n", { mode: 0o700 });
  host = { ...host, invocation: { execPath: binary } };
  const run = host.run!;
  let reportedProgram = binary;
  host = {
    ...host,
    run: async (cmd, args) => {
      const result = await run(cmd, args);
      if (args[0] === "bootstrap") reportedProgram = host.invocation!.execPath;
      return args[0] === "print" && !result.code
        ? { ...result, stdout: result.stdout + "  program = " + reportedProgram + "\n" }
        : result;
    },
  };
  await control("enable", 3);
  expect((await control("status")).installed).toBe(true);
  await rm(binary);
  expect(loaded.size).toBe(1);
  expect((await control("status")).installed).toBe(false);
  host = { ...host, invocation: { execPath: process.execPath } };
  expect((await control("enable", 3)).installed).toBe(true);
  expect((await control("status")).installed).toBe(true);
  expect(calls.filter((c) => c === "bootout")).toHaveLength(1);
});
