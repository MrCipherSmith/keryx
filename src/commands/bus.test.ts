import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendEvent, cursorAtStart, readEvents } from "../bus/log";
import { listLeases, readLease } from "../bus/leases";
import { eventsPath, leasePath, leasesDir, resolveBusRoot } from "../bus/paths";
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

// Flow 275 (agent bus P4, T8; specification §7.3): `keryx bus pause` and
// `keryx bus resume`.
describe("keryx bus pause", () => {
  test("creates a lease held by cli, default scope turns and default ttl 30m, targeting @all as [\"*\"]", async () => {
    const root = await seededRoot();
    const result = await run(["pause", "@all", "--reason", "cutting a release"], { root });
    expect(result.code).toBe(0);
    expect(result.out[0]).toMatch(/^paused turns for @all — lease [0-9a-f]{8} expires/);

    const leases = await listLeases(root);
    // seededRoot() already seeded one lease (ID.lease, held by "release"); this is the new one.
    const created = leases.find((l) => l.leaseId !== ID.lease);
    expect(created?.holder).toEqual(expect.objectContaining({ name: "cli", origin: "cli" }));
    expect(created?.targets).toEqual(["*"]);
    expect(created?.scope).toBe("turns");
    expect(created?.reason).toBe("cutting a release");
    const ttlMs = Date.parse(created?.expiresAt ?? "") - Date.parse(created?.createdAt ?? "");
    expect(ttlMs).toBe(30 * 60 * 1000);
  });

  test("--scope, --ttl and --json are honoured", async () => {
    const root = await seededRoot();
    const result = await run(["pause", "@release", "--reason", "hold your turn", "--scope", "git-publish", "--ttl", "5m", "--json"], {
      root,
    });
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.out.join("\n")) as { leaseId: string; scope: string; targets: string[]; expiresAt: string };
    expect(parsed.scope).toBe("git-publish");
    expect(parsed.targets).toEqual([ID.release]);
    const lease = await readLease(root, parsed.leaseId);
    expect(lease).toBeDefined();
    const ttlMs = Date.parse(lease?.expiresAt ?? "") - Date.parse(lease?.createdAt ?? "");
    expect(ttlMs).toBe(5 * 60 * 1000);
  });

  test("refusals: no --reason, an unknown --scope, an unparseable --ttl, and a second CLI-origin lease", async () => {
    const root = await seededRoot();
    const cases: [string[], RegExp][] = [
      [["pause", "@all"], /invalid-event: usage: keryx bus pause/],
      [["pause", "@all", "--reason", "x", "--scope", "nope"], /--scope must be one of/],
      [["pause", "@all", "--reason", "x", "--ttl", "nope"], /--ttl must look like/],
    ];
    for (const [args, pattern] of cases) {
      const result = await run(args, { root });
      expect(result.code).toBe(1);
      expect(result.err.join("\n")).toMatch(pattern);
    }
    // D-12: at most one active CLI-origin lease per clone.
    expect((await run(["pause", "@all", "--reason", "first"], { root })).code).toBe(0);
    const second = await run(["pause", "@release", "--reason", "second"], { root });
    expect(second.code).toBe(1);
    expect(second.err.join("\n")).toMatch(/lease-already-held/);
  });

  test("D-13: refused with use-agent-tool (exit 2) inside a tool call", async () => {
    const root = await seededRoot();
    const env = { NODE_ENV: "test", KERYX_TOOL_CALL: "1" };
    const refused = await run(["pause", "@all", "--reason", "hi"], { root, env });
    expect(refused.code).toBe(USE_AGENT_TOOL_EXIT);
    expect(refused.err.join("\n")).toMatch(/use-agent-tool/);
    expect(await listLeases(root)).toHaveLength(1); // only the seeded one — nothing created
  });
});

describe("keryx bus resume", () => {
  test("ends any lease by id, as cli, regardless of who holds it", async () => {
    const root = await seededRoot();
    const result = await run(["resume", ID.lease], { root });
    expect(result.code).toBe(0);
    expect(result.out[0]).toBe(`resumed lease ${ID.lease.slice(0, 8)}`);
    expect(await readLease(root, ID.lease)).toBeUndefined();

    const { events } = await readEvents(root, await cursorAtStart(root));
    const resumeEvent = events.find((e) => e.kind === "resume");
    expect(resumeEvent?.from).toEqual(expect.objectContaining({ name: "cli", origin: "cli" }));
  });

  test("--json prints { leaseId }; resuming an id that is already gone is a silent no-op", async () => {
    const root = await seededRoot();
    const result = await run(["resume", ID.lease, "--json"], { root });
    expect(JSON.parse(result.out.join("\n"))).toEqual({ schemaVersion: 1, leaseId: ID.lease });

    const again = await run(["resume", ID.lease], { root });
    expect(again.code).toBe(0);
  });

  test("usage error with no leaseId", async () => {
    const root = await seededRoot();
    const result = await run(["resume"], { root });
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/invalid-event: usage: keryx bus resume/);
  });

  test("D-13: refused with use-agent-tool (exit 2) inside a tool call", async () => {
    const root = await seededRoot();
    const env = { NODE_ENV: "test", KERYX_TOOL_CALL: "1" };
    const refused = await run(["resume", ID.lease], { root, env });
    expect(refused.code).toBe(USE_AGENT_TOOL_EXIT);
    expect(refused.err.join("\n")).toMatch(/use-agent-tool/);
    expect(await readLease(root, ID.lease)).toBeDefined(); // untouched
  });
});

describe("bus-disabled", () => {
  const disabled: [string, Partial<BusCommandDeps>, RegExp][] = [
    ["KERYX_BUS=off", { env: { NODE_ENV: "test", KERYX_BUS: "off" } }, /bus-disabled: KERYX_BUS=off/],
    ["bus.enabled: false", { shellConfig: { bus: { enabled: false } } }, /bus-disabled: shell config bus\.enabled is false/],
    ["CI", { env: { NODE_ENV: "test", CI: "true" } }, /bus-disabled: CI environment \(CI is set\)/],
  ];

  for (const [label, deps, pattern] of disabled) {
    test(`${label}: send, pause, resume and prune refuse with the reason; list and log still read`, async () => {
      const root = await seededRoot();
      for (const sub of [["send", "@all", "hi"], ["pause", "@all", "--reason", "x"], ["resume", ID.lease], ["prune"]]) {
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

// Review r1 F5: text written by peers never reaches the terminal with control
// characters or escape sequences in it; --json is left as data.
describe("control characters on display (r1 F5)", () => {
  const ESC = "\u001b";
  // eslint-disable-next-line no-control-regex -- the assertion is about control characters
  const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;
  const hostile = `${ESC}[2J${ESC}]0;pwned\u0007clear${ESC}[31m red\u009b1m\u0000 end`;

  test("an ESC sequence in a body does not reach stdout in `log`; --json keeps the data", async () => {
    const root = await seededRoot();
    await appendEvent(root, { from: { instanceId: ID.release, name: "release", origin: "agent" }, to: ["*"], toLabel: "@all", kind: "notice", body: hostile }, { now: () => NOW });

    const text = (await run(["log"], { root })).out.join("\n");
    expect(text).not.toMatch(CONTROL);
    expect(text).toContain("notice: clear red 1m end");

    const json = JSON.parse((await run(["log", "--json"], { root })).out.join("\n")) as { events: { body: string }[] };
    expect(json.events[0]?.body).toBe(hostile);
  });

  test("activity, branch and checkout are stripped in `list`", async () => {
    const root = await seededRoot();
    await writePresence(root, { ...presence(ID.release, "release", NOW - 1_000), activity: `busy ${ESC}[5mblink`, branch: `feat${ESC}[0m`, checkout: `/repo${ESC}]8;;x\u0007` });
    const text = (await run(["list"], { root })).out.join("\n");
    expect(text).not.toMatch(CONTROL);
    expect(text).toContain("busy blink");
  });
});

test("r2 N1: a record whose ts smuggles an escape sequence is skipped, and `log` never prints ESC", async () => {
  const root = await seededRoot();
  await appendEvent(root, { from: { instanceId: ID.release, name: "release", origin: "agent" }, to: ["*"], toLabel: "@all", kind: "notice", body: "ok" }, { now: () => NOW });
  const hostile = {
    schemaVersion: 1,
    seq: 2,
    id: ID.lease,
    ts: "(\u001b[2J) Jan 1 2026",
    from: { instanceId: ID.release, name: "release", origin: "agent" },
    to: ["*"],
    toLabel: "@all",
    kind: "notice",
    body: "smuggled",
  };
  await writeFile(eventsPath(root), `${JSON.stringify(hostile)}\n`, { flag: "a" });

  const { out } = await run(["log"], { root });
  expect(out.join("\n")).not.toContain("\u001b");
  expect(out).toEqual(["#1 2026-09-19 12:00:00 @release → @all notice: ok"]);
});
