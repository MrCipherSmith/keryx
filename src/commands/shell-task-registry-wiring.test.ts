// flow 263 AC7 / brainstorm D-17: without a task registry `shell_exec` keeps the
// synchronous `makeCommandRunner` path, which exists only for tests and direct
// callers. That is safe only while every PRODUCTION tool roster passes a
// registry. `buildInteractiveAgentTools` is the only `shellExecTool`
// construction; this pins that both of its call sites in `shell.ts` (TUI and
// readline) pass `jobRegistry`, so a refactor cannot silently drop one and
// regress a long command back to a blocking, wall-clock-deadline call.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/** Returns the balanced `{ … }` argument text of every `buildInteractiveAgentTools({` CALL (not doc mentions). */
function callArguments(source: string): string[] {
  const calls: string[] = [];
  const re = /buildInteractiveAgentTools\(\{\s*\n/g;
  for (let m = re.exec(source); m !== null; m = re.exec(source)) {
    const open = source.indexOf("{", m.index);
    let depth = 0;
    let end = -1;
    for (let i = open; i < source.length; i += 1) {
      const ch = source[i];
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) throw new Error("unbalanced buildInteractiveAgentTools call in shell.ts");
    calls.push(source.slice(open, end + 1));
  }
  return calls;
}

test("AC7: both production buildInteractiveAgentTools call sites in shell.ts pass a jobRegistry", () => {
  const source = readFileSync(new URL("./shell.ts", import.meta.url), "utf8");
  const calls = callArguments(source);
  expect(calls).toHaveLength(2);
  for (const args of calls) {
    expect(args).toMatch(/\bjobRegistry\b/);
  }
});
