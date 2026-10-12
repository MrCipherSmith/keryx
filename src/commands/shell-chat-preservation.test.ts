import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runShell } from "./shell";
import { openLeasedSession, type SessionLeaseHandle } from "../session/lease";
import { loadArchive, loadContext } from "../session/store";
import type { ProviderPort } from "../harness/provider/types";

test("chat shutdown saves partial text before release, aborts and fences late events", async () => {
  const previousExitCode = process.exitCode;
  process.exitCode = 0;
  const cwd = mkdtempSync(path.join(tmpdir(), "keryx-chat-exit-"));
  const dataDir = path.join(cwd, "data");
  const finalizerBox: { current: (() => Promise<void>) | undefined } = { current: undefined };
  const leaseBox: { current: SessionLeaseHandle | undefined } = { current: undefined };
  let aborted = false;
  let atRelease: string[] = [];
  let releases = 0;
  const output: string[] = [];
  const provider: ProviderPort = {
    describe: () => ({ descriptor: { providerId: "test" }, capabilities: {
      streaming: true, toolCalls: false, parallelToolCalls: false, structuredOutput: false,
      reasoningMetadata: false, promptCaching: false, vision: false, tokenCounting: false, modelListing: false,
    } }),
    async *stream(_request, opts) {
      yield { kind: "text_delta", sequence: 1, attemptId: opts.attemptId, text: "saved partial" };
      opts.signal?.addEventListener("abort", () => { aborted = true; });
      const finalize = finalizerBox.current;
      if (finalize === undefined) throw new Error("missing chat finalizer");
      await Promise.all([finalize(), finalize()]);
      yield { kind: "text_delta", sequence: 2, attemptId: opts.attemptId, text: "late must not persist" };
    },
  };
  try {
    await runShell({
      lines: (async function* () { yield "question"; yield "must not run"; })(),
      write: (text) => { output.push(text); },
    }, {
      initial: { provider: "test", model: "model" }, makeProvider: () => provider,
      clock: () => "2026-10-08T00:00:00Z", idSeq: () => "attempt", session: {
        cwd, finalizerBox, leaseBox,
        openLeased: (opts) => {
          const opened = openLeasedSession({ ...opts, dataDir });
          const release = opened.lease.release.bind(opened.lease);
          opened.lease.release = () => {
            releases++;
            atRelease = loadArchive(cwd, opened.handle.summary.id, dataDir).map((message) => message.content);
            release();
          };
          return opened;
        },
      },
    });
    expect(aborted).toBe(true);
    expect(releases).toBe(1);
    expect(atRelease).toEqual(["question", "saved partial"]);
    expect(leaseBox.current).toBeUndefined();
    expect(finalizerBox.current).toBeUndefined();
    expect(output.join("")).not.toContain("late must not persist");
    expect(process.exitCode).toBe(0);
  } finally {
    // Bun retains its native exit status when this is assigned undefined.
    // Explicitly reset the success status when no previous status was set.
    process.exitCode = previousExitCode ?? 0;
    leaseBox.current?.release();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("chat shutdown before the first token leaves no dangling user message in the saved context", async () => {
  const previousExitCode = process.exitCode;
  process.exitCode = 0;
  const cwd = mkdtempSync(path.join(tmpdir(), "keryx-chat-exit-empty-"));
  const dataDir = path.join(cwd, "data");
  const finalizerBox: { current: (() => Promise<void>) | undefined } = { current: undefined };
  const leaseBox: { current: SessionLeaseHandle | undefined } = { current: undefined };
  let contextAtRelease: string[] = [];
  const provider: ProviderPort = {
    describe: () => ({ descriptor: { providerId: "test" }, capabilities: {
      streaming: true, toolCalls: false, parallelToolCalls: false, structuredOutput: false,
      reasoningMetadata: false, promptCaching: false, vision: false, tokenCounting: false, modelListing: false,
    } }),
    async *stream(_request, opts) {
      const finalize = finalizerBox.current;
      if (finalize === undefined) throw new Error("missing chat finalizer");
      await finalize();
      yield { kind: "text_delta", sequence: 1, attemptId: opts.attemptId, text: "late must not persist" };
    },
  };
  try {
    await runShell({
      lines: (async function* () { yield "question"; })(),
      write: () => {},
    }, {
      initial: { provider: "test", model: "model" }, makeProvider: () => provider,
      clock: () => "2026-10-08T00:00:00Z", idSeq: () => "attempt", session: {
        cwd, finalizerBox, leaseBox,
        openLeased: (opts) => {
          const opened = openLeasedSession({ ...opts, dataDir });
          const release = opened.lease.release.bind(opened.lease);
          opened.lease.release = () => {
            contextAtRelease = loadContext(cwd, opened.handle.summary.id, dataDir).map((message) => message.content);
            release();
          };
          return opened;
        },
      },
    });
    expect(contextAtRelease).toEqual([]);
  } finally {
    process.exitCode = previousExitCode ?? 0;
    leaseBox.current?.release();
    rmSync(cwd, { recursive: true, force: true });
  }
});
