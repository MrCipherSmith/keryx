import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { copyEnvFiles } from "./env-files";
import { addWorktree, createFixture, type Fixture } from "./test-support";

let fixture: Fixture | undefined;
afterEach(() => {
  fixture?.cleanup();
  fixture = undefined;
});

const SECRET = "TOP_SECRET_VALUE_12345";

describe("copyEnvFiles (AC1)", () => {
  test("copies a gitignored .env, skips and names an unignored .env.local, never exposes contents", async () => {
    fixture = createFixture();
    const worktree = addWorktree(fixture, "wt-a");
    writeFileSync(path.join(fixture.main, ".env"), `KEY=${SECRET}\n`, { mode: 0o600 });
    writeFileSync(path.join(fixture.main, ".env.local"), `LOCAL=${SECRET}\n`);

    const result = await copyEnvFiles({ mainRoot: fixture.main, worktreeRoot: worktree, files: [".env", ".env.local"] });

    expect(result.copied).toEqual([".env"]);
    expect(result.skipped).toEqual([{ file: ".env.local", reason: expect.stringContaining("not ignored") }]);
    expect(readFileSync(path.join(worktree, ".env"), "utf8")).toBe(`KEY=${SECRET}\n`);
    expect(statSync(path.join(worktree, ".env")).mode & 0o777).toBe(0o600);
    expect(existsSync(path.join(worktree, ".env.local"))).toBe(false);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  test("keeps an existing destination without force, overwrites with force", async () => {
    fixture = createFixture();
    const worktree = addWorktree(fixture, "wt-a");
    writeFileSync(path.join(fixture.main, ".env"), "NEW=1\n");
    writeFileSync(path.join(worktree, ".env"), "OLD=1\n");

    const kept = await copyEnvFiles({ mainRoot: fixture.main, worktreeRoot: worktree, files: [".env"] });
    expect(kept.copied).toEqual([]);
    expect(kept.skipped[0]).toMatchObject({ file: ".env" });
    expect(readFileSync(path.join(worktree, ".env"), "utf8")).toBe("OLD=1\n");

    const forced = await copyEnvFiles({ mainRoot: fixture.main, worktreeRoot: worktree, files: [".env"], force: true });
    expect(forced.copied).toEqual([".env"]);
    expect(readFileSync(path.join(worktree, ".env"), "utf8")).toBe("NEW=1\n");
  });

  test("skips files missing in the main checkout and unsafe paths", async () => {
    fixture = createFixture();
    const worktree = addWorktree(fixture, "wt-a");
    const result = await copyEnvFiles({ mainRoot: fixture.main, worktreeRoot: worktree, files: [".env.ignored", "../escape", "/abs"] });
    expect(result.copied).toEqual([]);
    expect(result.skipped.map((entry) => entry.file)).toEqual([".env.ignored", "../escape", "/abs"]);
  });

  test("refuses to copy a checkout onto itself", async () => {
    fixture = createFixture();
    writeFileSync(path.join(fixture.main, ".env"), "A=1\n");
    const result = await copyEnvFiles({ mainRoot: fixture.main, worktreeRoot: fixture.main, files: [".env"] });
    expect(result.copied).toEqual([]);
    expect(result.skipped).toHaveLength(1);
  });
});
