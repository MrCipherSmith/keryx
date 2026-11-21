import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { ensureCheckout, listLiveCheckoutIds, readCheckout } from "./checkout";
import { addWorktree, createFixture, removeWorktree, type Fixture } from "./test-support";

let fixture: Fixture | undefined;
afterEach(() => {
  fixture?.cleanup();
  fixture = undefined;
});

describe("checkout label", () => {
  test("the main checkout has no label", async () => {
    fixture = createFixture();
    expect(await readCheckout(fixture.main)).toBeUndefined();
    expect(await ensureCheckout(fixture.main)).toBeUndefined();
    expect(existsSync(path.join(fixture.main, ".git", "keryx", "checkout.json"))).toBe(false);
  });

  test("ensureCheckout creates the label in the worktree git dir, idempotently", async () => {
    fixture = createFixture();
    const worktree = addWorktree(fixture, "wt-a");
    expect(await readCheckout(worktree)).toBeUndefined();

    const first = await ensureCheckout(worktree, { flowId: "512" });
    expect(first).toMatchObject({ version: 1, flowId: "512" });
    expect(first?.checkoutId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

    const again = await ensureCheckout(worktree, { flowId: "other" });
    expect(again).toEqual(first);
    expect(await readCheckout(worktree)).toEqual(first);

    const file = path.join(fixture.main, ".git", "worktrees", "wt-a", "keryx", "checkout.json");
    expect(JSON.parse(readFileSync(file, "utf8")).checkoutId).toBe(first?.checkoutId);
    // Nothing is written into the working copy.
    expect(existsSync(path.join(worktree, ".keryx"))).toBe(false);
  });

  test("a worktree re-created under the same name gets a new id", async () => {
    fixture = createFixture();
    const first = addWorktree(fixture, "wt-a");
    const oldId = (await ensureCheckout(first))?.checkoutId;
    removeWorktree(fixture, first);

    const second = addWorktree(fixture, "wt-a2");
    const otherId = (await ensureCheckout(second))?.checkoutId;
    expect(otherId).not.toBe(oldId);

    // Same name again: git reuses the admin directory name once the old one is gone.
    removeWorktree(fixture, second);
    const again = path.join(fixture.base, "wt-a2-again");
    const { fixtureGit } = await import("./test-support");
    fixtureGit(fixture.base, fixture.main, ["worktree", "add", "-q", "-b", "wt-a2-again", again]);
    expect((await ensureCheckout(again))?.checkoutId).not.toBe(otherId);
  });

  test("listLiveCheckoutIds sees live worktrees only", async () => {
    fixture = createFixture();
    const a = addWorktree(fixture, "wt-a");
    const b = addWorktree(fixture, "wt-b");
    const idA = (await ensureCheckout(a))?.checkoutId as string;
    const idB = (await ensureCheckout(b))?.checkoutId as string;
    const common = path.join(fixture.main, ".git");
    expect((await listLiveCheckoutIds(common)).sort()).toEqual([idA, idB].sort());

    removeWorktree(fixture, a);
    expect(await listLiveCheckoutIds(common)).toEqual([idB]);
  });

  test("listLiveCheckoutIds is empty without a worktrees directory", async () => {
    fixture = createFixture();
    expect(await listLiveCheckoutIds(path.join(fixture.main, ".git"))).toEqual([]);
  });
});
