import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runChunks } from "./review-chunks";

const deps = { rejectUnknownFlags: () => undefined };

describe("review chunks estimate --answer needs a terminal (R3-01)", () => {
  test("refuses the answer when no person is at a terminal, before touching the package", async () => {
    const dir = await mkdtemp(join(tmpdir(), "keryx-chunks-answer-"));
    try {
      await expect(runChunks(["estimate", "--package", dir, "--answer", "yes", "--quote", "go ahead and run it"], deps, { isTerminal: () => false })).rejects.toThrow(/--answer needs a terminal/);
      await expect(runChunks(["estimate", "--package", dir, "--answer=yes", "--quote", "go ahead"], deps, { isTerminal: () => false })).rejects.toThrow(/--answer needs a terminal/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a terminal gets past the check; an estimate without --answer never needed one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "keryx-chunks-answer-"));
    try {
      const attempt = (args: string[], tty: boolean) => runChunks(["estimate", "--package", dir, ...args], deps, { isTerminal: () => tty }).then(() => "ok", (e: Error) => e.message);
      expect(await attempt(["--answer", "yes", "--quote", "go ahead"], true)).not.toMatch(/needs a terminal/);
      expect(await attempt([], false)).not.toMatch(/needs a terminal/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
