// `keryx harness exec` runs the command under the runtime it was granted: the reservation is the
// real spawn's deadline, not the adapter's own 5 s default (review-degradation-w4:F-001). Real
// processes, sandbox opted out so the test needs no launcher.
import { describe, expect, test } from "bun:test";

async function runExec(args: string[]): Promise<{ kind: string | undefined; elapsedMs: number }> {
  const { harnessCommand } = await import("./harness");
  const logs: string[] = [];
  const original = console.log;
  // biome-ignore lint: intentional console capture for assertions in this test only.
  console.log = (...values: unknown[]) => {
    logs.push(values.map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join(" "));
  };
  const startedAt = Date.now();
  try {
    await harnessCommand(["exec", "--allow-real-subprocess", ...args], {
      env: { KERYX_DANGEROUSLY_DISABLE_SANDBOX: "1", PATH: process.env.PATH ?? "" },
    });
  } finally {
    console.log = original;
  }
  const elapsedMs = Date.now() - startedAt;
  for (let i = logs.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(logs[i] ?? "") as { outcome?: { kind?: string } };
      return { kind: parsed.outcome?.kind, elapsedMs };
    } catch {
      // not the result line
    }
  }
  return { kind: undefined, elapsedMs };
}

describe("harness exec runtime budget", () => {
  test("a reservation shorter than the adapter default is enforced", async () => {
    const result = await runExec(["--max-runtime-ms", "1000", "--", "/bin/sleep", "4"]);
    expect(result.kind).toBe("timeout");
    expect(result.elapsedMs).toBeLessThan(3_500);
  }, 15_000);

  test("a reservation longer than the adapter default is honoured", async () => {
    const result = await runExec(["--max-runtime-ms", "20000", "--", "/bin/sleep", "6"]);
    expect(result.kind).toBe("completed");
  }, 20_000);
});
