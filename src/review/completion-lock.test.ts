import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { withFileLock } from "../lib/fs";
import { withCompletionLock } from "./completion-lock";
import { withOperatorDecisionsLock } from "./operator-decisions";

test("completion operations share the cross-process lock and permit nested waivers", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "completion-lock-"));
  let release!: () => void;
  let acquired!: () => void;
  const held = new Promise<void>((resolve) => { acquired = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const events: string[] = [];
  const owner = withFileLock(path.join(dir, ".completion.lock"), async () => {
    acquired();
    await gate;
    events.push("released");
  });
  try {
    await held;
    const waiting = withCompletionLock(dir, async () => {
      events.push("acquired");
      await withCompletionLock(dir, async () => { events.push("nested"); });
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(events).toEqual([]);
    release();
    await Promise.all([owner, waiting]);
    expect(events).toEqual(["released", "acquired", "nested"]);
  } finally {
    release();
    await owner;
    await rm(dir, { recursive: true, force: true });
  }
});


test("premise and ingest writers wait for completion rollback and permit nested dispositions", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "decisions-completion-lock-"));
  let release!: () => void;
  let acquired!: () => void;
  const held = new Promise<void>((resolve) => { acquired = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const events: string[] = [];
  const owner = withFileLock(path.join(dir, ".completion.lock"), async () => {
    acquired();
    await gate;
    events.push("rollback-finished");
  });
  try {
    await held;
    const waiting = withOperatorDecisionsLock(dir, async () => { events.push("decision"); });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(events).toEqual([]);
    release();
    await Promise.all([owner, waiting]);
    await withCompletionLock(dir, () => withOperatorDecisionsLock(dir, async () => { events.push("nested"); }));
    expect(events).toEqual(["rollback-finished", "decision", "nested"]);
  } finally {
    release();
    await owner;
    await rm(dir, { recursive: true, force: true });
  }
});
