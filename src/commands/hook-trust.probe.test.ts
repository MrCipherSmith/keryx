// R700-01 probe (flow 319, lane A): an untrusted PROJECT SessionStart command
// hook must not run. Before this fix, `.metaproject/hooks.json` was merged
// into `registrations` and executed the moment a session opened — the same
// "clone and it runs" hole `src/mcp-servers/trust.ts` closed for MCP servers,
// here for lifecycle hooks.
//
// Imports ONLY the module's pre-existing public surface (`../harness/hooks`)
// plus node builtins — this file proves the FIX from the outside, the same
// way an attacker/reviewer would exercise it, not by reaching into internals.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { NOOP_LEARNING_OBSERVATION_SINK } from "../harness/hooks";
import { buildShellHookRuntime } from "./agent-hooks";

function makeTmpProject(): { projectRoot: string; homeDir: string; configDir: string; marker: string } {
  const base = mkdtempSync(path.join(tmpdir(), "keryx-hook-trust-probe-"));
  const projectRoot = path.join(base, "repo");
  const homeDir = path.join(base, "home");
  const configDir = path.join(base, "config");
  mkdirSync(path.join(projectRoot, ".metaproject"), { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  const marker = path.join(base, "PWNED");
  const hooksJson = {
    schemaVersion: "1.0.0",
    hooks: {
      SessionStart: [
        {
          id: "repo-poc",
          matcher: "*",
          class: "observe",
          runsIn: "unsandboxed",
          command: {
            argv: [process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'x')`],
          },
        },
      ],
    },
  };
  writeFileSync(path.join(projectRoot, ".metaproject", "hooks.json"), JSON.stringify(hooksJson), "utf8");
  return { projectRoot, homeDir, configDir, marker };
}

describe("R700-01 probe", () => {
  test("an untrusted project SessionStart hook does not run", async () => {
    const { projectRoot, homeDir, configDir, marker } = makeTmpProject();
    try {
      const ctx = buildShellHookRuntime({
        projectRoot,
        homeDir,
        configDir,
        sessionId: "s1",
        runId: "r1",
        env: { KERYX_HOOKS: "on" },
        interactive: true,
        profileId: "monitored-trusted-local",
        learningSink: NOOP_LEARNING_OBSERVATION_SINK,
      } as Parameters<typeof buildShellHookRuntime>[0]);
      if (ctx === undefined) throw new Error("expected a hook runtime");
      await ctx.runtime.fire("SessionStart", {
        sessionId: "s1",
        runId: "r1",
        projectRoot,
        policyProfile: "monitored-trusted-local",
      });
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(path.dirname(projectRoot), { recursive: true, force: true });
    }
  });
});
