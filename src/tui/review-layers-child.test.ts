import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

describe("the production runner behind the /reviews layers refresh", () => {
  test("runs `review layers refresh --package <dir> --json` of the entry in the project root and parses the layers it prints", async () => {
    const entry = await stub(
      `console.log(JSON.stringify({ version: 1, argv: process.argv.slice(2), cwd: process.cwd(), graph: { status: "ok" } }));`,
    );
    const got = (await makeLayersRefreshRunner(entry)(dir, "/pkg dir")) as unknown as { argv: string[]; cwd: string };
    expect(got.argv).toEqual(["review", "layers", "refresh", "--package", "/pkg dir", "--force", "--json"]);
    expect(got.cwd.endsWith(path.basename(dir))).toBe(true);
  });

  test("the argument vector names the entry right before the subcommand words", () => {
    const argv = layersRefreshArgv("e.js", "/p");
    expect(argv.slice(-8)).toEqual(["e.js", "review", "layers", "refresh", "--package", "/p", "--force", "--json"]);
  });

  test("a child that fails reports the first line of its stderr", async () => {
    const entry = await stub(`console.error("boom\\nsecond line"); process.exit(1);`);
    await expect(makeLayersRefreshRunner(entry)(dir, "/p")).rejects.toThrow(/^boom$/);
  });

  test("a child that prints no JSON is an error, not a crash", async () => {
    const entry = await stub(`console.log("not json");`);
    await expect(makeLayersRefreshRunner(entry)(dir, "/p")).rejects.toThrow();
  });

  test("a child that outlives the timeout is killed, gone, and reported as a timeout", async () => {
    const pidFile = path.join(dir, "child.pid");
    const entry = await stub(`require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`);
    const timeoutMs = 600;
    const started = Date.now();
    let outcome: unknown = "pending";
    const guard = new Promise<void>((resolve) => setTimeout(resolve, 8000));
    try {
      await Promise.race([
        makeLayersRefreshRunner(entry, timeoutMs)(dir, "/p").then(
          () => (outcome = "resolved"),
          (error: unknown) => (outcome = error),
        ),
        guard,
      ]);
      const elapsed = Date.now() - started;

      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toMatch(/did not finish within \d+s and was stopped/);
      expect(elapsed).toBeGreaterThanOrEqual(timeoutMs - 50);

      const pid = Number(await readFile(pidFile, "utf8"));
      expect(pid).toBeGreaterThan(0);
      const alive = (): boolean => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      const deadline = Date.now() + 3000;
      while (alive() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
      expect(alive()).toBe(false);
    } finally {
      try {
        process.kill(Number(await readFile(pidFile, "utf8")), "SIGKILL");
      } catch {
        // already gone, which is the point
      }
    }
  }, 20_000);

  test("a child that floods stdout past the buffer limit is reported as too much output, not as a timeout", async () => {
    const entry = await stub(`process.stdout.write("x".repeat(17 * 1024 * 1024)); setInterval(() => {}, 1000);`);
    const error = await makeLayersRefreshRunner(entry, 60_000)(dir, "/p").then(
      () => null,
      (reason: unknown) => reason as Error,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toMatch(/more output than the limit/);
    expect(error?.message).not.toMatch(/did not finish within/);
  }, 30_000);

  test("a child that exits early without JSON is not mistaken for a timeout", async () => {
    const entry = await stub(`process.exit(0);`);
    const error = await makeLayersRefreshRunner(entry, 5000)(dir, "/p").then(
      () => null,
      (reason: unknown) => reason as Error,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).not.toMatch(/did not finish within/);
  });

  test("no entry script is refused instead of running `bun run` with nothing", async () => {
    await expect(makeLayersRefreshRunner(undefined)(dir, "/p")).rejects.toThrow(/entry script/);
  });
});

describe("a refresh whose graph failed is reported as failed", () => {
  test("the error of the graph layer is in the message", async () => {
    const actions = createReviewLayersActions(process.cwd(), async () => ({ graph: { status: "failed", error: "could not check out" } }) as never);
    const message = await actions.refreshLayers({ reviewId: "r1", layersView: { dir: "/tmp/pkg" } } as never);
    expect(message).toBe("Layers refresh failed for r1: graph failed: could not check out");
  });
});
