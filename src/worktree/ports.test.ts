import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { ensureCheckout, listLiveCheckoutIdsSync } from "./checkout";
import { allocatePorts, portsJournalPath, readWorktreeEnv, releasePorts } from "./ports";
import { addWorktree, createFixture, fixtureGit, removeWorktree, type Fixture } from "./test-support";

let fixture: Fixture | undefined;
afterEach(() => {
  fixture?.cleanup();
  fixture = undefined;
});

const config = { ports: { web: { env: "PORT", range: [47200, 47299] as [number, number] } } };
const always = (): boolean => true;

describe("allocatePorts", () => {
  test("two worktrees get different ports and worktree.env is written", async () => {
    fixture = createFixture();
    const a = addWorktree(fixture, "wt-a");
    const b = addWorktree(fixture, "wt-b");
    const first = await allocatePorts({ cwd: a, config, isPortFree: always });
    const second = await allocatePorts({ cwd: b, config, isPortFree: always });
    expect(first.ports.web).toBe(47200);
    expect(second.ports.web).toBe(47201);
    expect(await readWorktreeEnv(a)).toEqual({ PORT: "47200" });
    expect(readFileSync(path.join(fixture.main, ".git", "worktrees", "wt-b", "keryx", "worktree.env"), "utf8")).toBe("PORT=47201\n");
  });

  test("is idempotent for one checkout", async () => {
    fixture = createFixture();
    const a = addWorktree(fixture, "wt-a");
    const first = await allocatePorts({ cwd: a, config, isPortFree: always });
    const again = await allocatePorts({ cwd: a, config, isPortFree: always });
    expect(again).toEqual(first);
    const lines = readFileSync(portsJournalPath(path.join(fixture.main, ".git")), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
  });

  test("removing a worktree frees its port; a re-created one inherits nothing", async () => {
    fixture = createFixture();
    const a = addWorktree(fixture, "wt-a");
    const b = addWorktree(fixture, "wt-b");
    const first = await allocatePorts({ cwd: a, config, isPortFree: always });
    await allocatePorts({ cwd: b, config, isPortFree: always });
    removeWorktree(fixture, a);

    const again = path.join(fixture.base, "wt-a");
    fixtureGit(fixture.base, fixture.main, ["worktree", "add", "-q", "-b", "wt-a-2", again]);
    const recreated = await allocatePorts({ cwd: again, config, isPortFree: always });
    expect(recreated.checkoutId).not.toBe(first.checkoutId);
    expect(recreated.ports.web).toBe(47200); // the freed port is reused by a new label
  });

  test("releasePorts frees the port of a live checkout", async () => {
    fixture = createFixture();
    const a = addWorktree(fixture, "wt-a");
    const b = addWorktree(fixture, "wt-b");
    const first = await allocatePorts({ cwd: a, config, isPortFree: always });
    await releasePorts(path.join(fixture.main, ".git"), first.checkoutId);
    expect((await allocatePorts({ cwd: b, config, isPortFree: always })).ports.web).toBe(47200);
  });

  test("skips a port actually bound by another process", async () => {
    fixture = createFixture();
    const a = addWorktree(fixture, "wt-a");
    const blocker = Bun.listen({ hostname: "127.0.0.1", port: 47250, socket: { data() {} } });
    try {
      const result = await allocatePorts({ cwd: a, config: { ports: { web: { env: "PORT", range: [47250, 47252] } } } });
      expect(result.ports.web).toBe(47251);
    } finally {
      blocker.stop(true);
    }
  });

  test("concurrent allocation from two worktrees yields distinct ports", async () => {
    fixture = createFixture();
    const a = addWorktree(fixture, "wt-a");
    const b = addWorktree(fixture, "wt-b");
    const [first, second] = await Promise.all([
      allocatePorts({ cwd: a, config, isPortFree: always }),
      allocatePorts({ cwd: b, config, isPortFree: always }),
    ]);
    expect(first.ports.web).not.toBe(second.ports.web);
  });

  test("several names in one worktree get distinct ports", async () => {
    fixture = createFixture();
    const a = addWorktree(fixture, "wt-a");
    const result = await allocatePorts({
      cwd: a,
      config: { ports: { web: { env: "PORT", range: [47300, 47302] }, api: { env: "API_PORT", range: [47300, 47302] } } },
      isPortFree: always,
    });
    expect(result.env).toEqual({ PORT: "47300", API_PORT: "47301" });
  });

  test("a name that moves to a new config order never takes another name's kept port", async () => {
    fixture = createFixture();
    const a = addWorktree(fixture, "wt-a");
    await allocatePorts({ cwd: a, config: { ports: { second: { env: "SECOND_PORT", range: [47500, 47502] } } }, isPortFree: always });
    const result = await allocatePorts({
      cwd: a,
      config: { ports: { first: { env: "FIRST_PORT", range: [47500, 47502] }, second: { env: "SECOND_PORT", range: [47500, 47502] } } },
      isPortFree: always,
    });
    expect(result.ports.second).toBe(47500);
    expect(result.ports.first).toBe(47501);
  });

  test("many worktrees allocating at once keep every journal record and distinct ports", async () => {
    fixture = createFixture();
    const trees = ["a", "b", "c", "d", "e", "f"].map((name) => addWorktree(fixture as Fixture, `wt-${name}`));
    const results = await Promise.all(trees.map((cwd) => allocatePorts({ cwd, config, isPortFree: always })));
    expect(new Set(results.map((entry) => entry.ports.web)).size).toBe(trees.length);
    const ids = readFileSync(portsJournalPath(path.join(fixture.main, ".git")), "utf8")
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { checkoutId: string }).checkoutId);
    expect(new Set(ids)).toEqual(new Set(results.map((entry) => entry.checkoutId)));
  });

  test("a worktree labelled after another allocation started keeps its record (live set read under the lock)", async () => {
    fixture = createFixture();
    const a = addWorktree(fixture, "wt-a");
    const b = addWorktree(fixture, "wt-b");
    const second = await allocatePorts({ cwd: b, config, isPortFree: always });
    // `a` allocates after b's record exists; b's label was created long after nothing here pre-reads it.
    await allocatePorts({ cwd: a, config, isPortFree: always });
    const journalText = readFileSync(portsJournalPath(path.join(fixture.main, ".git")), "utf8");
    expect(journalText).toContain(second.checkoutId);
    expect(listLiveCheckoutIdsSync(path.join(fixture.main, ".git"))).toContain(second.checkoutId);
  });

  test("worktree.env is written through a temp file and leaves none behind", async () => {
    fixture = createFixture();
    const a = addWorktree(fixture, "wt-a");
    await allocatePorts({ cwd: a, config, isPortFree: always });
    const dir = path.join(fixture.main, ".git", "worktrees", "wt-a", "keryx");
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(readFileSync(path.join(dir, "worktree.env"), "utf8")).toBe("PORT=47200\n");
  });

  test("an exhausted range fails with a clear error", async () => {
    fixture = createFixture();
    const a = addWorktree(fixture, "wt-a");
    const b = addWorktree(fixture, "wt-b");
    const tiny = { ports: { web: { env: "PORT", range: [47400, 47400] as [number, number] } } };
    await allocatePorts({ cwd: a, config: tiny, isPortFree: always });
    await expect(allocatePorts({ cwd: b, config: tiny, isPortFree: always })).rejects.toThrow(/no free port for "web" in range 47400-47400/);
  });

  test("the main checkout cannot hold ports", async () => {
    fixture = createFixture();
    expect(await ensureCheckout(fixture.main)).toBeUndefined();
    await expect(allocatePorts({ cwd: fixture.main, config, isPortFree: always })).rejects.toThrow(/main checkout/);
  });

  test("readWorktreeEnv is empty before allocation", async () => {
    fixture = createFixture();
    const a = addWorktree(fixture, "wt-a");
    expect(await readWorktreeEnv(a)).toEqual({});
  });
});
