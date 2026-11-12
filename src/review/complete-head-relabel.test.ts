// Flow 488 AC3: `review complete --head <sha>` relabels the head the round reviewed. When it differs from the head
// `review start` recorded, it is the operator's act: the refusal names both SHAs, and the manifest keeps both and the quote.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { reviewCommand } from "../commands/review";
import { HEAD, MOVED, OPERATOR_WORDS, PR, ingestReady, lookup, readManifest } from "./close-gates.test-helpers";
import { completeManagedReview } from "./managed";

let dir = "";
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), "keryx-head-relabel-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); process.exitCode = 0; });

describe("--head that differs from the recorded head (AC3)", () => {
  test("is refused without the operator's words, naming both SHAs, and the manifest stays as it was", async () => {
    const ref = await ingestReady(dir, "# Review", { kind: "pr", ref: PR, head: HEAD });
    const error = await completeManagedReview(dir, ref, { prLookup: lookup({ headSha: MOVED }), head: MOVED }).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(HEAD);
    expect((error as Error).message).toContain(MOVED);
    expect((error as Error).message).toContain("--head-reason");
    const onDisk = await readManifest(dir, ref);
    expect(onDisk.status).not.toBe("closed");
    expect(onDisk.target.head).toBe(HEAD);
    expect(onDisk.head_override).toBeUndefined();
  });

  test("is refused with a quote that is a flag name or too short", async () => {
    const ref = await ingestReady(dir, "# Review", { kind: "pr", ref: PR, head: HEAD });
    for (const headReason of ["ok", "--head-reason", "........"]) {
      await expect(completeManagedReview(dir, ref, { prLookup: lookup({ headSha: MOVED }), head: MOVED, headReason })).rejects.toThrow(/--head-reason/);
    }
  });

  test("passes with the operator's quote, and the manifest records the previous head, the new head and the quote", async () => {
    const ref = await ingestReady(dir, "# Review", { kind: "pr", ref: PR, head: HEAD });
    const done = await completeManagedReview(dir, ref, { prLookup: lookup({ headSha: MOVED }), head: MOVED, headReason: OPERATOR_WORDS, now: new Date("2026-11-12T10:00:00Z") });
    expect(done.manifest.status).toBe("closed");
    const onDisk = await readManifest(dir, ref);
    expect(onDisk.target.head).toBe(MOVED);
    expect(onDisk.head_override).toEqual({ from: HEAD, to: MOVED, operator_quote: OPERATOR_WORDS, time: "2026-11-12T10:00:00.000Z" });
  });

  test("a --head equal to the recorded head, in any case or as a prefix, needs no quote and records no override", async () => {
    const ref = await ingestReady(dir, "# Review", { kind: "pr", ref: PR, head: HEAD });
    const done = await completeManagedReview(dir, ref, { prLookup: lookup({ headSha: HEAD }), head: HEAD.slice(0, 12).toUpperCase() });
    expect(done.manifest.status).toBe("closed");
    expect((await readManifest(dir, ref)).head_override).toBeUndefined();
  });

  test("a recorded head that is absent is filled without a quote: nothing is relabelled", async () => {
    const ref = await ingestReady(dir, "# Review", { kind: "pr", ref: PR });
    const done = await completeManagedReview(dir, ref, { prLookup: lookup({ headSha: HEAD }), head: HEAD });
    expect(done.manifest.target.head).toBe(HEAD);
    expect((await readManifest(dir, ref)).head_override).toBeUndefined();
  });

  test("the CLI takes the quote only at a terminal, like --waive", async () => {
    const ref = await ingestReady(dir, "# Review", { kind: "pr", ref: PR, head: HEAD });
    const errors: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => void errors.push(args.map(String).join(" "));
    const cwd = process.cwd();
    try {
      process.chdir(dir);
      await reviewCommand(["complete", ref, "--head", MOVED, "--head-reason", OPERATOR_WORDS], { isTerminal: () => false, prLookup: async () => null, prFiles: async () => null });
      expect(process.exitCode).toBe(1);
      expect(errors.join("\n")).toContain("--head-reason needs a terminal");
      expect((await readManifest(dir, ref)).status).not.toBe("closed");
      errors.length = 0;
      process.exitCode = 0;
      await reviewCommand(["complete", ref, "--head", MOVED, "--head-reason", OPERATOR_WORDS], { isTerminal: () => true, prLookup: async () => null, prFiles: async () => null });
      expect(errors.join("\n")).not.toContain("needs a terminal");
      expect((await readManifest(dir, ref)).head_override).toMatchObject({ from: HEAD, to: MOVED, operator_quote: OPERATOR_WORDS });
    } finally {
      console.error = realError;
      process.chdir(cwd);
    }
  });
});
