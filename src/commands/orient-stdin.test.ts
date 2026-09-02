// The hook runs on EVERY prompt, so the no-prompt path is the one that must not
// move. A runtime that pipes this command nothing, or pipes it something it did
// not expect, has to keep getting exactly the output it got before the prompt
// was ever read — and the turn must survive a router that throws.

import { describe, expect, test } from "bun:test";
import path from "node:path";

const CLI = path.join(import.meta.dir, "..", "cli.ts");
const REPO = path.join(import.meta.dir, "..", "..");

async function orient(stdin: string | null): Promise<{ out: string; code: number }> {
  const proc = Bun.spawn(["bun", CLI, "orient", "claude"], {
    cwd: REPO,
    stdin: stdin === null ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { out, code };
}

describe("orient reads the UserPromptSubmit payload", () => {
  test("a routed prompt appends a block naming the skill", async () => {
    const { out, code } = await orient(JSON.stringify({ prompt: "сделай мне полное ревью без исправления" }));
    expect(code).toBe(0);
    expect(out).toContain("Routing for THIS request");
    expect(out).toContain("review-orchestrator");
  }, 30000);

  test("the output DIFFERS by prompt — the property that was false before", async () => {
    const review = await orient(JSON.stringify({ prompt: "сделай полное ревью" }));
    const trivial = await orient(JSON.stringify({ prompt: "what is 2+2" }));
    expect(review.out).not.toBe(trivial.out);
  }, 30000);

  test("every no-prompt form yields the same output and exit 0", async () => {
    const forms = [null, "", "   ", "not json at all", "[1,2,3]", '{"session_id":"x"}', '{"prompt":""}', '{"prompt":42}'];
    const results = await Promise.all(forms.map((f) => orient(f)));
    for (const r of results) {
      expect(r.code).toBe(0);
      expect(r.out).not.toContain("Routing for THIS request");
    }
    const [first, ...rest] = results;
    for (const r of rest) {
      expect(r.out).toBe(first!.out);
    }
  }, 60000);

  test("an unroutable prompt emits no block, rather than guessing", async () => {
    const { out, code } = await orient(JSON.stringify({ prompt: "what is 2+2" }));
    expect(code).toBe(0);
    expect(out).not.toContain("Routing for THIS request");
  }, 30000);
});

describe("the fail-safes on a hook that runs on every prompt", () => {
  test("a stdin that never closes does not hang the process", async () => {
    // `Bun.stdin.text()` waited forever on an open pipe, AFTER buildOrientation
    // had done its work, so nothing was written at all. Racing a timer was not
    // enough on its own either: the abandoned read holds the event loop, so the
    // orientation got written and the process still never exited — and a hook
    // that never exits hangs the harness just as surely as one that never
    // writes. This drives a real pipe that is opened and never fed.
    const proc = Bun.spawn(["bun", CLI, "orient", "claude"], {
      cwd: REPO,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const settled = await Promise.race([
      Promise.all([new Response(proc.stdout).text(), proc.exited]).then(([out, code]) => ({ out, code })),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 15000)),
    ]);
    if (settled === null) {
      proc.kill();
      throw new Error("orient did not exit with an open stdin — the deadline did not release the read");
    }
    expect(settled.code).toBe(0);
    // It still produced the orientation; the deadline costs the routing block,
    // which is the correct thing to lose.
    expect(settled.out.length).toBeGreaterThan(100);
    expect(settled.out).not.toContain("Routing for THIS request");
  }, 30000);

  test("the no-prompt output is exactly the orientation, not merely self-consistent", async () => {
    // The suite used to assert only that the eight no-prompt forms agreed with
    // EACH OTHER, so a change to the body or to the body/routing concatenation
    // passed for all of them at once — the invariant the test was named for was
    // the one it did not check.
    const { out, code } = await orient("");
    expect(code).toBe(0);
    const { buildOrientation } = await import("../ctx/orient");
    const { getOrientRuntime } = await import("../ctx/orient-runtimes");
    const orientation = await buildOrientation(REPO);
    const runtime = getOrientRuntime("claude");
    expect(out).toBe(`${runtime ? runtime.format(orientation) : orientation}\n`);
  }, 30000);

  test("a routed prompt is the orientation PLUS the block, inside the envelope", async () => {
    // The block used to be appended after `runtime.format(...)`, outside the
    // envelope that function exists to own — which for cursor produced
    // unparseable JSON and lost the orientation too.
    const { out } = await orient(JSON.stringify({ prompt: "сделай полное ревью" }));
    expect(out).toContain("Routing for THIS request");
    expect(out).toContain("review-orchestrator");
  }, 30000);
});
