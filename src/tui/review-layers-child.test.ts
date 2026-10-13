import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createReviewLayersActions, layersRefreshArgv, makeLayersRefreshRunner } from "./review-layers-actions";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "keryx-child-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const stub = async (body: string): Promise<string> => {
  const entry = path.join(dir, "entry.js");
  await writeFile(entry, body);
  return entry;
};

describe("the production runner behind the /reviews layers refresh (R2-09)", () => {
  test("runs `review layers refresh --package <dir> --json` of the entry in the project root and parses the layers it prints", async () => {
    const entry = await stub(
      `console.log(JSON.stringify({ version: 1, argv: process.argv.slice(2), cwd: process.cwd(), graph: { status: "ok" } }));`,
    );
    const got = (await makeLayersRefreshRunner(entry)(dir, "/pkg dir")) as unknown as { argv: string[]; cwd: string };
    expect(got.argv).toEqual(["review", "layers", "refresh", "--package", "/pkg dir", "--json"]);
    expect(got.cwd.endsWith(path.basename(dir))).toBe(true);
  });

  test("the argument vector names the entry right before the subcommand words", () => {
    const argv = layersRefreshArgv("e.js", "/p");
    expect(argv.slice(-7)).toEqual(["e.js", "review", "layers", "refresh", "--package", "/p", "--json"]);
  });

  test("a child that fails reports the first line of its stderr", async () => {
    const entry = await stub(`console.error("boom\\nsecond line"); process.exit(1);`);
    await expect(makeLayersRefreshRunner(entry)(dir, "/p")).rejects.toThrow(/^boom$/);
  });

  test("a child that prints no JSON is an error, not a crash", async () => {
    const entry = await stub(`console.log("not json");`);
    await expect(makeLayersRefreshRunner(entry)(dir, "/p")).rejects.toThrow();
  });

  test("a child that outlives the timeout is killed and reported", async () => {
    const entry = await stub(`setInterval(() => {}, 1000);`);
    await expect(makeLayersRefreshRunner(entry, 300)(dir, "/p")).rejects.toThrow();
  });

  test("no entry script is refused instead of running `bun run` with nothing", async () => {
    await expect(makeLayersRefreshRunner(undefined)(dir, "/p")).rejects.toThrow(/entry script/);
  });
});

describe("a refresh whose graph failed is reported as failed (R2-20)", () => {
  test("the error of the graph layer is in the message", async () => {
    const actions = createReviewLayersActions(process.cwd(), async () => ({ graph: { status: "failed", error: "could not check out" } }) as never);
    const message = await actions.refreshLayers({ reviewId: "r1", layersView: { dir: "/tmp/pkg" } } as never);
    expect(message).toBe("Layers refresh failed for r1: graph failed: could not check out");
  });
});
