// K-004 (arena, flow 249): the subprocess runner spawned `keryx` from PATH, which
// ran the installed release under a shell built from source. The argv is now
// derived from the running process, never from PATH, whenever this IS keryx.
import { expect, test } from "bun:test";
import path from "node:path";
import { keryxSelfCommand, makeKeryxRunner } from "./metaproject-tools";

const BUN = "/opt/bun/bin/bun";
const present = (): boolean => true;

test("from source, the runner re-runs this checkout's entry script with this bun", () => {
  const entry = "/work/keryx/src/cli.ts";
  expect(keryxSelfCommand(entry, BUN, present, [entry])).toEqual([BUN, entry]);
});

test("from an npm install, it re-runs the package's own bin (dist/cli.js)", () => {
  const entry = "/usr/lib/node_modules/@mrciphersmith/keryx/dist/cli.js";
  expect(keryxSelfCommand(entry, BUN, present, [entry])).toEqual([BUN, entry]);
});

test("the real default entries point at this checkout's src/cli.ts", () => {
  // Proves the module-relative derivation, not just the injected list.
  const here = path.resolve(import.meta.dir, "..", "..", "..", "cli.ts");
  expect(keryxSelfCommand(here, BUN, present)).toEqual([BUN, here]);
});

test("a host app whose entry is also named src/cli.ts is NOT treated as keryx (review F-004)", () => {
  expect(keryxSelfCommand("/app/src/cli.ts", BUN, present, ["/work/keryx/src/cli.ts"])).toEqual(["keryx"]);
});

test("a standalone compiled binary re-runs itself", () => {
  expect(keryxSelfCommand("/$bunfs/root/keryx-bun-darwin-arm64", "/usr/local/bin/keryx", present)).toEqual([
    "/usr/local/bin/keryx",
  ]);
});

test("a process that is not keryx falls back to PATH — the only honest answer left", () => {
  expect(keryxSelfCommand("/work/app/server.ts", BUN, present)).toEqual(["keryx"]);
  // An entry that matches but is gone is not trusted either.
  expect(keryxSelfCommand("/gone/src/cli.ts", BUN, () => false, ["/gone/src/cli.ts"])).toEqual(["keryx"]);
});

test("the argv does not depend on PATH", () => {
  const original = process.env.PATH;
  const entry = "/work/keryx/src/cli.ts";
  try {
    process.env.PATH = "/nonexistent";
    expect(keryxSelfCommand(entry, BUN, present, [entry])).toEqual([BUN, entry]);
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
