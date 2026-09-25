// Flow 308 (W8, Lane B, T6): session-state filenames and the append-only log.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ContainedWriteError } from "../../lib/contained-write";
import { appendLogRecord, impactEvidenceDataRoot, loadSessionState, saveSessionState } from "./state";

describe("impact-evidence session state", () => {
  let root = "";

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "keryx-impact-evidence-state-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("F26: two session ids that sanitize to the same string get distinct state files, not a collision", async () => {
    await saveSessionState(root, "a/b", { touched: ["src/from-a-slash-b.ts"], denials: {} });
    await saveSessionState(root, "a_b", { touched: ["src/from-a-underscore-b.ts"], denials: {} });

    const fromSlash = await loadSessionState(root, "a/b");
    const fromUnderscore = await loadSessionState(root, "a_b");

    expect(fromSlash.touched).toEqual(["src/from-a-slash-b.ts"]);
    expect(fromUnderscore.touched).toEqual(["src/from-a-underscore-b.ts"]);

    const sessionsDir = path.join(impactEvidenceDataRoot(root), "sessions");
    const files = await readdir(sessionsDir);
    // Two distinct sessions -> two distinct files, even though both
    // sanitize to the same `a_b` prefix.
    expect(files.length).toBe(2);
    expect(new Set(files).size).toBe(2);
  });

  test("a session id round-trips through save/load unaffected by the filename hash suffix", async () => {
    await saveSessionState(root, "session-123", { touched: ["src/x.ts"], denials: { "src/x.ts": 2 } });
    const state = await loadSessionState(root, "session-123");
    expect(state).toEqual({ touched: ["src/x.ts"], denials: { "src/x.ts": 2 }, pendingAck: [] });
  });

  test("an unknown session id loads empty state rather than throwing", async () => {
    const state = await loadSessionState(root, "never-seen");
    expect(state).toEqual({ touched: [], denials: {}, pendingAck: [] });
  });

  test("N8: pendingAck round-trips through save/load", async () => {
    await saveSessionState(root, "session-ack", { touched: [], denials: {}, pendingAck: ["src/x.ts"] });
    const state = await loadSessionState(root, "session-ack");
    expect(state.pendingAck).toEqual(["src/x.ts"]);
  });
});

describe("impact-evidence state refuses a symlinked data root (R700-03)", () => {
  let root = "";
  let outside = "";

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "keryx-impact-evidence-state-"));
    outside = await mkdtemp(path.join(tmpdir(), "keryx-impact-evidence-outside-"));
    // .metaproject/data/security/impact-evidence -> <outside>
    await mkdir(path.join(root, ".metaproject", "data", "security"), { recursive: true });
    await symlink(outside, impactEvidenceDataRoot(root));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  test("appendLogRecord refuses to append through the symlink: nothing lands outside", async () => {
    await expect(
      appendLogRecord(root, { sessionId: "s1", event: "injected", files: ["src/x.ts"] }),
    ).rejects.toBeInstanceOf(ContainedWriteError);
    const outsideEntries = await readdir(outside);
    expect(outsideEntries).toEqual([]);
  });

  test("saveSessionState refuses to write through the symlink: nothing lands outside", async () => {
    await expect(saveSessionState(root, "s1", { touched: [], denials: {} })).rejects.toBeInstanceOf(ContainedWriteError);
    const outsideEntries = await readdir(outside);
    expect(outsideEntries).toEqual([]);
  });
});
