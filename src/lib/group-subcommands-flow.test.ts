// The router in cli.ts refuses a subcommand that GROUP_SUBCOMMANDS does not list before
// commands/flow.ts sees it, so a `case` added to the flow switch without its entry here is
// dead from the command line while every test that calls flowCommand directly stays green.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { GROUP_SUBCOMMANDS } from "./group-subcommands";

const SRC = path.join(import.meta.dir, "..");

test("every subcommand commands/flow.ts dispatches is listed for the router", () => {
  const source = readFileSync(path.join(SRC, "commands", "flow.ts"), "utf8");
  const start = source.indexOf("switch (command) {");
  const end = source.indexOf("default:", start);
  expect(start).toBeGreaterThan(-1);
  const dispatched = [...source.slice(start, end).matchAll(/\bcase "([a-z][a-z0-9-]*)":/g)].map((m) => m[1] as string);
  expect(dispatched.length).toBeGreaterThan(10);
  const listed = new Set(GROUP_SUBCOMMANDS.get("flow") ?? []);
  expect(dispatched.filter((name) => !listed.has(name))).toEqual([]);
});

test("`keryx flow outcome author` reaches its handler through the real router", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "keryx-flow-route-"));
  try {
    mkdirSync(path.join(dir, ".metaproject"), { recursive: true });
    const run = (args: string[]) =>
      spawnSync(process.execPath, [path.join(SRC, "cli.ts"), ...args], { cwd: dir, encoding: "utf8" });

    const init = run(["flow", "init", "--title", "route check", "--outcome-author", "human"]);
    expect(init.status).toBe(0);

    const set = run(["flow", "outcome", "author", "001", "agent", "--reason", "route check"]);
    expect(set.stdout + set.stderr).not.toContain("Unknown command");
    expect(set.status).toBe(0);
    expect(set.stdout).toContain("Outcome author human");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);
