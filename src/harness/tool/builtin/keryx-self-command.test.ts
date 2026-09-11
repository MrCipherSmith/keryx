// K-004 (arena, flow 249): the subprocess runner spawned `keryx` from PATH, which
// ran the installed release under a shell built from source. The argv is now
// derived from the running process, never from PATH, whenever this IS keryx.
import { expect, test } from "bun:test";
import { keryxSelfCommand, makeKeryxRunner } from "./metaproject-tools";

const BUN = "/opt/bun/bin/bun";
const present = (): boolean => true;

test("from source, the runner re-runs this checkout's entry script with this bun", () => {
  expect(keryxSelfCommand("/work/keryx/src/cli.ts", BUN, present)).toEqual([BUN, "/work/keryx/src/cli.ts"]);
});

test("from an npm install, it re-runs the package's own bin (dist/cli.js)", () => {
  const entry = "/usr/lib/node_modules/@mrciphersmith/keryx/dist/cli.js";
  expect(keryxSelfCommand(entry, BUN, present)).toEqual([BUN, entry]);
});

test("a standalone compiled binary re-runs itself", () => {
  expect(keryxSelfCommand("/$bunfs/root/keryx-bun-darwin-arm64", "/usr/local/bin/keryx", present)).toEqual([
    "/usr/local/bin/keryx",
  ]);
});

test("a process that is not keryx falls back to PATH — the only honest answer left", () => {
  expect(keryxSelfCommand("/work/app/server.ts", BUN, present)).toEqual(["keryx"]);
  // An entry that looks right but is gone is not trusted either.
  expect(keryxSelfCommand("/gone/src/cli.ts", BUN, () => false)).toEqual(["keryx"]);
});

test("the argv does not depend on PATH", () => {
  const original = process.env.PATH;
  try {
    process.env.PATH = "/nonexistent";
    expect(keryxSelfCommand("/work/keryx/src/cli.ts", BUN, present)).toEqual([BUN, "/work/keryx/src/cli.ts"]);
  } finally {
    process.env.PATH = original;
  }
});

test("the runner spawns the command it was given, not PATH keryx", async () => {
  // `echo` stands in for keryx: whatever argv the runner builds is what runs.
  const run = makeKeryxRunner(process.cwd(), ["echo", "self"]);
  const result = await run(["ctx", "rg", "x"]);
  expect(result.isError).toBe(false);
  expect(result.output.trim()).toBe("self ctx rg x");
});
