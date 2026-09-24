// O2-6 (flow 312 review): `readStdinBounded` must stop BUFFERING once stdin
// exceeds its byte cap, not merely let a caller reject an already-fully-read
// oversized payload after the fact. Exercised out-of-process (a real `bun`
// child fed real stdin) because the function reads `Bun.stdin.stream()`
// directly — there is no seam to inject a fake stream in-process.
import { describe, expect, test } from "bun:test";
import path from "node:path";

const MODULE_PATH = path.join(import.meta.dir, "bounded-stdin.ts");

async function readWithHelper(totalBytes: number, maxBytesArg?: number): Promise<number> {
  const script = `
    const { readStdinBounded } = await import(${JSON.stringify(MODULE_PATH)});
    const out = await readStdinBounded(5000${maxBytesArg !== undefined ? `, ${maxBytesArg}` : ""});
    process.stdout.write(String(Buffer.byteLength(out ?? "", "utf8")));
  `;
  const proc = Bun.spawn({
    cmd: ["bun", "-e", script],
    stdin: Buffer.alloc(totalBytes, "a"),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const exitCode = await proc.exited;
  if (exitCode !== 0) throw new Error(`helper exited ${exitCode}: ${stderr}`);
  return Number(stdout.trim());
}

describe("readStdinBounded byte cap (O2-6)", () => {
  test("stops buffering once stdin exceeds the explicit cap (~1 MiB), rather than reading it all", async () => {
    const LEARN_OBSERVE_MAX_STDIN_BYTES = 1024 * 1024 + 1;
    const totalBytes = 8 * 1024 * 1024; // 8 MiB fed in, far past the ~1 MiB cap
    const receivedBytes = await readWithHelper(totalBytes, LEARN_OBSERVE_MAX_STDIN_BYTES);
    expect(receivedBytes).toBeGreaterThan(0);
    // Never the full 8 MiB the child actually wrote.
    expect(receivedBytes).toBeLessThan(totalBytes);
    // Bounded near the 1 MiB + 1 byte cap, plus at most a little chunking
    // slack — not merely "less than 8 MiB" (a weaker, non-discriminating
    // bound the unfixed reader would also satisfy for a moderately smaller
    // input, but not for this large a gap).
    expect(receivedBytes).toBeLessThanOrEqual(LEARN_OBSERVE_MAX_STDIN_BYTES + 1024 * 1024);
  });

  test("a custom maxBytes is honored", async () => {
    const totalBytes = 4 * 1024 * 1024;
    const receivedBytes = await readWithHelper(totalBytes, 2048);
    expect(receivedBytes).toBeLessThan(totalBytes);
    expect(receivedBytes).toBeLessThanOrEqual(2048 + 1024 * 1024);
  });

  test("stdin smaller than the passed cap is read in full", async () => {
    const totalBytes = 4096;
    const receivedBytes = await readWithHelper(totalBytes, 1024 * 1024 + 1);
    expect(receivedBytes).toBe(totalBytes);
  });

  test("with no maxBytes (POSITIVE_INFINITY), a payload larger than 1 MiB is returned in full", async () => {
    const totalBytes = 2 * 1024 * 1024; // 2 MiB, larger than the old hardcoded cap
    const receivedBytes = await readWithHelper(totalBytes); // no maxBytes arg = Number.POSITIVE_INFINITY
    expect(receivedBytes).toBe(totalBytes);
  });
});
