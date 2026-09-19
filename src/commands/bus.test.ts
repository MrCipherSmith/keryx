import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendEvent } from "../bus/log";
import { leasePath, leasesDir, resolveBusRoot } from "../bus/paths";
import { writePresence } from "../bus/presence";
import type { PauseLease, PresenceRecord } from "../bus/schema";
import { type BusCommandDeps, runBusCommand, USE_AGENT_TOOL_EXIT } from "./bus";

// AC7-AC10 through the command function, with an injected env, root and clock.

const ROOTS: string[] = [];

afterAll(async () => {
  await Promise.all(ROOTS.map((root) => rm(root, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  ROOTS.push(dir);
  return dir;
}

const NOW = Date.parse("2026-09-19T12:00:00.000Z");
const ID = {
  release: "0f8fad5b-d9cb-469f-a165-70867728950e",
  docs: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  gone: "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
  session: "9b2f7e1c-3f4a-4c55-8d3e-2a1b0c9d8e7f",
  lease: "3e4f5a6b-7c8d-4e9f-8a1b-2c3d4e5f6a7b",
};
const liveness = { host: "this-host", isAlive: (pid: number) => pid === 100 };

function presence(instanceId: string, name: string, heartbeatAt: number, pid = 100, checkout = "/repo/main"): PresenceRecord {
  return {
    schemaVersion: 1,
    instanceId,
    name,
    pid,
    host: "this-host",
    sessionId: ID.session,
    checkout,
    branch: "main",
    surface: "tui",
    status: "working",
    activity: "flow 272 task 8",
    startedAt: new Date(heartbeatAt).toISOString(),
    heartbeatAt: new Date(heartbeatAt).toISOString(),
    keryxVersion: "0.2.121",
  };
}

interface Run {
  code: number;
  out: string[];
  err: string[];
}

async function run(args: string[], deps: BusCommandDeps): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runBusCommand(args, {
    env: { NODE_ENV: "test" },
    shellConfig: {},
    now: () => NOW,
    liveness,
    ...deps,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });
  return { code, out, err };
}

async function seededRoot(): Promise<string> {
  const root = path.join(await tempDir("keryx-bus-cli-"), "bus");
  await writePresence(root, presence(ID.release, "release", NOW - 2_000));
  await writePresence(root, presence(ID.docs, "docs", NOW - 60_000)); // stale
  await writePresence(root, presence(ID.gone, "gone", NOW - 60_000, 999)); // gone
  await mkdir(leasesDir(root), { recursive: true });
  const lease: PauseLease = {
    schemaVersion: 1,
    leaseId: ID.lease,
    holder: { instanceId: ID.release, name: "release", origin: "agent" },
    targets: ["*"],
    scope: "git-publish",
    reason: "cutting 0.2.122",
    createdAt: new Date(NOW - 60_000).toISOString(),
    expiresAt: new Date(NOW + 30 * 60_000).toISOString(),
    requestEventSeq: 1,
  };
  await writeFile(leasePath(root, ID.lease), JSON.stringify(lease), "utf8");
  return root;
}

describe("keryx bus list", () => {
  test("shows live and stale peers with name, status, activity, checkout and branch, plus active leases", async () => {
    const root = await seededRoot();
    const { code, out } = await run(["list"], { root });
    const text = out.join("\n");

    expect(code).toBe(0);
    expect(text).toContain("@release");
    expect(text).toMatch(/@release\s+live\s+working\s+2s\s+main\s+\/repo\/main\s+flow 272 task 8/);
    expect(text).toMatch(/@docs\s+stale/);
    expect(text).not.toContain("@gone");
    expect(text).toMatch(/3e4f5a6b\s+@release\s+git-publish\s+.*cutting 0\.2\.122/);
  });

  test("--json carries the same peers and leases", async () => {
    const root = await seededRoot();
    const { out } = await run(["list", "--json"], { root });
    const parsed = JSON.parse(out.join("\n")) as { peers: { name: string; state: string }[]; leases: { leaseId: string }[] };
    expect(parsed.peers.map((p) => [p.name, p.state])).toEqual([
      ["docs", "stale"],
      ["release", "live"],
    ]);
    expect(parsed.leases.map((l) => l.leaseId)).toEqual([ID.lease]);
  });

  test("two linked worktrees of one clone list each other", async () => {
    const repo = await tempDir("keryx-bus-cli-repo-");
    const git = async (cwd: string, ...args: string[]) => {
      const proc = Bun.spawn(["git", ...args], {
        cwd,
        stdout: "ignore",
        stderr: "ignore",
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@example.com",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@example.com",
        },
      });
      expect(await proc.exited).toBe(0);
    };
    await writeFile(path.join(repo, "README.md"), "x\n", "utf8");
    await git(repo, "init", "-b", "main");
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", "initial");
    const worktree = path.join(repo, "wt");
    await git(repo, "worktree", "add", "-b", "feature", worktree, "main");

    await writePresence((await resolveBusRoot(repo)).root, presence(ID.release, "main-shell", NOW - 1_000, 100, repo));
    await writePresence((await resolveBusRoot(worktree)).root, presence(ID.docs, "wt-shell", NOW - 1_000, 100, worktree));

    for (const cwd of [repo, worktree]) {
      const text = (await run(["list"], { cwd })).out.join("\n");
      expect(text).toContain("@main-shell");
      expect(text).toContain("@wt-shell");
    }
  });
});

describe("keryx bus log", () => {
  async function withEvents(): Promise<string> {
    const root = await seededRoot();
    for (const body of ["one", "two", "three", "four"]) {
      await appendEvent(root, { from: { instanceId: ID.release, name: "release", origin: "agent" }, to: ["*"], toLabel: "@all", kind: "notice", body }, { now: () => NOW });
    }
    return root;
  }

  test("prints events oldest first", async () => {
    const { code, out } = await run(["log"], { root: await withEvents() });
    expect(code).toBe(0);
    expect(out).toEqual([
      "#1 2026-09-19 12:00:00 @release → @all notice: one",
      "#2 2026-09-19 12:00:00 @release → @all notice: two",
      "#3 2026-09-19 12:00:00 @release → @all notice: three",
      "#4 2026-09-19 12:00:00 @release → @all notice: four",
    ]);
  });

  test("--since, --limit and --json", async () => {
    const root = await withEvents();
    expect((await run(["log", "--since", "2"], { root })).out.map((l) => l.split(" ")[0])).toEqual(["#3", "#4"]);
    expect((await run(["log", "--limit", "1"], { root })).out.map((l) => l.split(" ")[0])).toEqual(["#4"]);
    const json = JSON.parse((await run(["log", "--since", "1", "--limit", "2", "--json"], { root })).out.join("\n")) as {
      events: { seq: number; body: string }[];
    };
    expect(json.events.map((e) => [e.seq, e.body])).toEqual([
      [3, "three"],
      [4, "four"],
    ]);
    expect((await run(["log", "--limit", "0"], { root })).code).toBe(1);
  });
});

describe("keryx bus send", () => {
  test("sends to a live @name and to @all", async () => {
    const root = await seededRoot();
    const direct = await run(["send", "@release", "--kind", "question", "ready", "to", "tag?"], { root });
    expect(direct.code).toBe(0);
    expect(direct.out[0]).toMatch(/^sent #1 question to @release \(1 instance\(s\)\) id [0-9a-f-]{36}$/);

    const all = await run(["send", "@all", "--json", "heads up"], { root });
    expect(JSON.parse(all.out.join("\n"))).toEqual(expect.objectContaining({ seq: 2, resolvedTo: ["*"] }));
    const log = (await run(["log"], { root })).out;
    expect(log[0]).toContain("@cli → @release question: ready to tag?");
  });

  test("refusals print their code and exit non-zero", async () => {
    const root = await seededRoot();
    const cases: [string[], RegExp][] = [
      [["send", "@nobody", "hi"], /unknown-recipient/],
      [["send", "@docs", "hi"], /recipient-not-live/],
      [["send", "@release", "--kind", "reply", "hi"], /reply-without-replyTo/],
      [["send", "@release"], /invalid-event: usage/],
    ];
    for (const [args, pattern] of cases) {
      const result = await run(args, { root });
      expect(result.code).toBe(1);
      expect(result.err.join("\n")).toMatch(pattern);
    }
  });

  test("D-13: refused with use-agent-tool (exit 2) inside a tool call; list, log and prune still work", async () => {
    const root = await seededRoot();
    const env = { NODE_ENV: "test", KERYX_TOOL_CALL: "1" };
    const refused = await run(["send", "@all", "hi"], { root, env });
    expect(refused.code).toBe(USE_AGENT_TOOL_EXIT);
    expect(refused.err.join("\n")).toMatch(/use-agent-tool/);
    for (const sub of [["list"], ["log"], ["prune"]]) {
      expect((await run(sub, { root, env })).code).toBe(0);
    }
    expect((await run(["log"], { root, env })).out).toEqual(["No events."]);
  });

  test("KERYX_SESSION_* without the marker is not refused", async () => {
    const root = await seededRoot();
    const env = { NODE_ENV: "test", KERYX_SESSION_PROVIDER: "anthropic", KERYX_SESSION_MODEL: "claude" };
    expect((await run(["send", "@all", "from a host terminal"], { root, env })).code).toBe(0);
  });
});

describe("bus-disabled", () => {
  const disabled: [string, Partial<BusCommandDeps>, RegExp][] = [
    ["KERYX_BUS=off", { env: { NODE_ENV: "test", KERYX_BUS: "off" } }, /bus-disabled: KERYX_BUS=off/],
    ["bus.enabled: false", { shellConfig: { bus: { enabled: false } } }, /bus-disabled: shell config bus\.enabled is false/],
    ["CI", { env: { NODE_ENV: "test", CI: "true" } }, /bus-disabled: CI environment \(CI is set\)/],
  ];

  for (const [label, deps, pattern] of disabled) {
    test(`${label}: send and prune refuse with the reason; list and log still read`, async () => {
      const root = await seededRoot();
      for (const sub of [["send", "@all", "hi"], ["prune"]]) {
        const result = await run(sub, { root, ...deps });
        expect(result.code).toBe(1);
        expect(result.err.join("\n")).toMatch(pattern);
      }
      expect((await run(["list"], { root, ...deps })).code).toBe(0);
      expect((await run(["log"], { root, ...deps })).code).toBe(0);
    });
  }
});

describe("keryx bus prune", () => {
  test("reports what it removed", async () => {
    const root = await seededRoot();
    const result = await run(["prune"], { root, now: () => NOW + 25 * 60 * 60_000 });
    expect(result.code).toBe(0);
    expect(result.out[0]).toMatch(/^Pruned \d+ presence record\(s\), \d+ lease\(s\), 0 rotated segment\(s\)\.$/);
  });
});

test("unknown subcommands are refused with the help text", async () => {
  const result = await run(["frobnicate"], { root: "/nonexistent" });
  expect(result.code).toBe(1);
  expect(result.err[0]).toBe("Unknown bus subcommand: frobnicate");
});
