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
