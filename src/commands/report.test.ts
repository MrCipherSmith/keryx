import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { cursorAtStart, readEvents } from "../bus/log";
import { writePresence } from "../bus/presence";
import { EXTERNAL_RATE_LIMIT_PER_MINUTE, AGENT_RATE_LIMIT_PER_MINUTE } from "../bus/send";
import { MAX_BODY_BYTES, type PresenceRecord } from "../bus/schema";
import { type ReportCommandDeps, runReportCommand, sanitizeReportSender } from "./report";

const ROOTS: string[] = [];
afterAll(async () => {
  await Promise.all(ROOTS.map((root) => rm(root, { recursive: true, force: true })));
});

const NOW = Date.parse("2026-09-19T12:00:00.000Z");
const LIVE = "0f8fad5b-d9cb-469f-a165-70867728950e";
const STALE = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const SESSION = "9b2f7e1c-3f4a-4c55-8d3e-2a1b0c9d8e7f";
const liveness = { host: "this-host", isAlive: (pid: number) => pid === 100 };

function presence(instanceId: string, name: string, heartbeatAt: number): PresenceRecord {
  return {
    schemaVersion: 1,
    instanceId,
    name,
    pid: 100,
    host: "this-host",
    sessionId: SESSION,
    checkout: "/repo",
    branch: null,
    surface: "tui",
    status: "idle",
    activity: "",
    startedAt: new Date(heartbeatAt).toISOString(),
    heartbeatAt: new Date(heartbeatAt).toISOString(),
    keryxVersion: "0.4.11",
  };
}

async function seededRoot(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "keryx-report-"));
  ROOTS.push(dir);
  const root = path.join(dir, "bus");
  await writePresence(root, presence(LIVE, "release", NOW - 1_000));
  await writePresence(root, presence(STALE, "sleepy", NOW - 60_000));
  return root;
}

async function run(args: string[], deps: ReportCommandDeps) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runReportCommand(args, {
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

async function events(root: string) {
  return (await readEvents(root, await cursorAtStart(root))).events;
}

describe("keryx report", () => {
  test("writes one external-origin notice with a default sender and no presence", async () => {
    const root = await seededRoot();
    const result = await run(["--to", "@release", "build is green"], { root });
    expect(result.code).toBe(0);
    const written = await events(root);
    expect(written).toHaveLength(1);
    const event = written[0]!;
    expect(event.kind).toBe("notice");
    expect(event.from.origin).toBe("external");
    expect(event.from.name).toBe("external");
    expect(event.from.instanceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(event.to).toEqual([LIVE]);
    expect(event.body).toBe("build is green");
  });

  test("--from is sanitized; reserved names are refused", async () => {
    expect(sanitizeReportSender("Claude Code!")).toBe("claude-code");
    expect(sanitizeReportSender("!!!")).toBe("external");
    const root = await seededRoot();
    expect((await run(["--to", "@release", "--from", "Claude Code", "hi"], { root })).code).toBe(0);
    expect((await events(root))[0]!.from.name).toBe("claude-code");
    for (const reserved of ["cli", "SYSTEM", "all"]) {
      const result = await run(["--to", "@release", "--from", reserved, "hi"], { root });
      expect(result.code).toBe(1);
      expect(result.err.join("\n")).toContain("reserved-name");
    }
    expect(await events(root)).toHaveLength(1);
  });

  test("each refusal exits non-zero, names itself and writes nothing", async () => {
    const root = await seededRoot();
    const big = "x".repeat(MAX_BODY_BYTES + 1);
    const cases: Array<{ args: string[]; deps: ReportCommandDeps; code: number; message: string }> = [
      { args: ["--to", "@nobody", "hi"], deps: { root }, code: 1, message: "unknown-recipient" },
      { args: ["--to", "@sleepy", "hi"], deps: { root }, code: 1, message: "recipient-not-live" },
      { args: ["--to", "@all", "hi"], deps: { root }, code: 1, message: "not @all" },
      { args: ["--to", "@release", big], deps: { root }, code: 1, message: "Put the text in a file" },
      { args: ["--to", "@release", "hi"], deps: { root, env: { KERYX_BUS: "off" } }, code: 1, message: "bus-disabled" },
      { args: ["--to", "@release", "hi"], deps: { root, env: { NODE_ENV: "test", KERYX_TOOL_CALL: "1" } }, code: 2, message: "bus_send" },
      { args: ["--to", "@release"], deps: { root }, code: 1, message: "usage" },
    ];
    for (const c of cases) {
      const result = await run(c.args, c.deps);
      expect(result.code).toBe(c.code);
      expect(result.err.join("\n")).toContain(c.message);
    }
    expect(await events(root)).toHaveLength(0);
  });

  test("rate limit is per sender name, counted from the log, and tighter than the agent budget", async () => {
    expect(EXTERNAL_RATE_LIMIT_PER_MINUTE).toBeLessThanOrEqual(AGENT_RATE_LIMIT_PER_MINUTE);
    const root = await seededRoot();
    for (let i = 0; i < EXTERNAL_RATE_LIMIT_PER_MINUTE; i += 1) {
      expect((await run(["--to", "@release", "--from", "scribe", `m${i}`], { root })).code).toBe(0);
    }
    const limited = await run(["--to", "@release", "--from", "scribe", "one more"], { root });
    expect(limited.code).toBe(1);
    expect(limited.err.join("\n")).toContain("rate-limited");
    expect((await run(["--to", "@release", "--from", "other", "fine"], { root })).code).toBe(0);
    expect(await events(root)).toHaveLength(EXTERNAL_RATE_LIMIT_PER_MINUTE + 1);
  });
});
