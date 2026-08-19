// Version probe for an external agent CLI (flow 176, T15).
// Package: docs/requirements/keryx-external-agent-runtime §8.1; security-policy §1.
//
// This is the ONLY process this subsystem starts outside a real run, and the
// constraint on it is absolute: it must not spend the operator's subscription
// quota. It therefore runs the registry entry's own `detect` argv — `--version`
// and nothing else — never a prompt, never a `-p`/`exec` invocation.
//
// What it deliberately CANNOT tell you is whether the operator is logged in.
// keryx never opens a vendor credential store, not even for a liveness check
// (security-policy §1, `provider-auth` D-01), and there is no cheap probe for
// the subscription path: `--version` proves a binary and a real probe costs
// quota. That is why `resolveAvailability` has a third state and why this module
// returns a `DetectionOutcome` rather than a boolean — the caller must be forced
// to carry "runnable" and "will answer" as separate facts.
//
// The binary is looked up on PATH by the spawn itself. A missing binary is an
// ordinary outcome (`binaryFound: false`), not an error: an operator who has
// installed neither CLI is the common case, and it must render as a state, not
// as a crash.

import type { DetectionOutcome } from "./external/registry";

/** Wall-clock ceiling for one probe. A `--version` that hangs is a broken install, not a slow one. */
export const PROBE_TIMEOUT_MS = 10_000;

/** The minimal shape this module needs from `Bun.spawn`, so a unit test can supply one. */
export interface ProbeSpawnLike {
  (
    argv: readonly string[],
    opts: { stdin: "ignore"; stdout: "pipe"; stderr: "pipe" },
  ): {
    readonly stdout: ReadableStream<Uint8Array> | undefined;
    readonly stderr: ReadableStream<Uint8Array> | undefined;
    readonly exited: Promise<number>;
    kill(): void;
  };
}

/** Runs an agent's `detect` argv and reports what came back. */
export type VersionProbe = (binary: string, argv: readonly string[]) => Promise<DetectionOutcome>;

/** Drain a byte stream to a string; an absent stream contributes nothing. */
async function drain(stream: ReadableStream<Uint8Array> | undefined): Promise<string> {
  if (stream === undefined) return "";
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  return text;
}

/**
 * Build a real version probe.
 *
 * `spawnImpl` is injectable so every test in this repository can exercise the
 * probe without a vendor CLI on the machine — the same discipline
 * `createBunSpawnPort` follows, and the reason the whole subsystem is testable
 * offline.
 *
 * Both streams are combined because the two CLIs do not agree on where a version
 * banner goes, and a probe that read only stdout would report "no version" for
 * one of them and then judge it out of range.
 */
export function createVersionProbe(
  spawnImpl: ProbeSpawnLike = Bun.spawn as unknown as ProbeSpawnLike,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): VersionProbe {
  return async (binary, argv) => {
    let proc: ReturnType<ProbeSpawnLike>;
    try {
      proc = spawnImpl([binary, ...argv], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    } catch {
      // ENOENT from PATH resolution. An uninstalled CLI is a state, not a fault.
      return { binaryFound: false };
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    try {
      const streams = Promise.all([drain(proc.stdout), drain(proc.stderr)]);
      const settled = await Promise.race([
        (async () => {
          const [stdout, stderr] = await streams;
          const exitCode = await proc.exited;
          return { stdout, stderr, exitCode } as const;
        })(),
        expired,
      ]);
      if (settled === "timeout") {
        proc.kill();
        // A binary that exists but never answers is still installed. Reporting
        // it missing would send the operator to reinstall a CLI that is there.
        return { binaryFound: true, detectOutput: "" };
      }
      // A non-zero exit still proves the binary exists — `resolveAvailability`
      // folds an unparseable banner into `{state: "available", verdict:
      // "unknown"}`, which is the honest reading.
      return { binaryFound: true, detectOutput: `${settled.stdout}\n${settled.stderr}` };
    } catch {
      return { binaryFound: false };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
}
