// AC10 (flow 273 task T11A, review r1 F11): no child environment an external
// agent CLI or a third-party MCP server is spawned with may ever carry this
// instance's bus id or name (specification §9.4).
//
// `src/commands/shell-bus.process.test.ts`'s own AC10 test proves this for
// `resolveShellEnv` (the base env every `shell_exec` child starts from) and
// for `process.env` itself, across a real subprocess. This file proves the
// other two child-environment builders never leak it either — both are pure
// functions over an input env object rather than over `process.env`, so
// they're testable at the unit level, against a REAL `joinBus` instance
// rather than a hand-typed id/name pair.
//
// The parent env below is the worst case a future bug could produce: the bus
// identity landing in `KERYX_`-prefixed variables (the only shape keryx's own
// code would plausibly leak it as — see `env.ts`'s "swept wholesale"
// rationale). Both builders sweep that whole namespace unconditionally,
// regardless of which variable name under it the identity ends up in.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildExternalChildEnv } from "../harness/external/env";
import { buildMcpChildEnv } from "../mcp-servers/spawn-env";
import { joinBus, type BusClient } from "./client";

const ROOTS: string[] = [];

afterAll(async () => {
  await Promise.all(ROOTS.map((root) => rm(root, { recursive: true, force: true })));
});

async function git(cwd: string, ...args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "ignore",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "keryx test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "keryx test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
  if ((await proc.exited) !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${await new Response(proc.stderr).text()}`);
  }
}

async function repo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "keryx-bus-ac10-"));
  ROOTS.push(dir);
  await writeFile(path.join(dir, "README.md"), "x\n", "utf8");
  await git(dir, "init", "-q", "-b", "main");
  await git(dir, "add", ".");
  await git(dir, "commit", "-q", "-m", "initial");
  return dir;
}

function asClient(result: BusClient | { disabled: string }): BusClient {
  if ("disabled" in result) throw new Error(`joinBus unexpectedly disabled: ${result.disabled}`);
  return result;
}

describe("AC10: an external-agent or MCP-server child environment never carries the bus identity", () => {
  test("buildExternalChildEnv and buildMcpChildEnv strip it even when the parent env carries it under KERYX_*", async () => {
    const cwd = await repo();
    // Real timers are never started: nothing here waits on a poll or
    // heartbeat, and `leave()` below stops nothing they would need stopping.
    const noopTimers = { setInterval: () => undefined, clearInterval: () => {} };
    const client = asClient(
      await joinBus({
        cwd,
        sessionId: "9b2f7e1c-3f4a-4c55-8d3e-2a1b0c9d8e7f",
        surface: "readline",
        requestedName: "leaktest",
        env: {},
        status: () => ({ status: "idle" as const, activity: "" }),
        onEvent: () => {},
        onPeers: () => {},
        timers: noopTimers,
      }),
    );
    try {
      const parent: Record<string, string> = {
        PATH: process.env.PATH ?? "",
        KERYX_BUS_INSTANCE_ID: client.instanceId,
        KERYX_BUS_NAME: client.name,
        KERYX_SESSION_LABEL: `${client.instanceId}:${client.name}`,
      };

      // `buildExternalChildEnv` deliberately ADDS one KERYX_-prefixed key of
      // its own after the sweep (`KERYX_EXTERNAL_DEPTH`, the nesting-depth
      // marker) — the sweep is over the PARENT's `KERYX_*`, not a promise
      // the result carries none at all, so this checks by key rather than by
      // "no KERYX_ prefix survives".
      const externalEnv = buildExternalChildEnv({ parent, depth: 0 });
      expect(externalEnv.KERYX_BUS_INSTANCE_ID).toBeUndefined();
      expect(externalEnv.KERYX_BUS_NAME).toBeUndefined();
      expect(externalEnv.KERYX_SESSION_LABEL).toBeUndefined();
      for (const [key, value] of Object.entries(externalEnv)) {
        expect(key).not.toContain(client.instanceId);
        expect(key).not.toContain(client.name);
        expect(value).not.toContain(client.instanceId);
        expect(value).not.toContain(client.name);
      }

      const mcpEnv = buildMcpChildEnv({ parent });
      expect(mcpEnv.KERYX_BUS_INSTANCE_ID).toBeUndefined();
      expect(mcpEnv.KERYX_BUS_NAME).toBeUndefined();
      expect(mcpEnv.KERYX_SESSION_LABEL).toBeUndefined();
      for (const [key, value] of Object.entries(mcpEnv)) {
        expect(key).not.toContain(client.instanceId);
        expect(key).not.toContain(client.name);
        expect(value).not.toContain(client.instanceId);
        expect(value).not.toContain(client.name);
      }
    } finally {
      client.leave();
    }
  });
});
