// Flow 392, AC10 — the two tails left by flow 390:
//   - `originSet` no longer carries the previous quote or source over when the kind changes;
//   - `/flow origin` without an id prints a bounded summary instead of every flow.
import { afterEach, expect, test } from "bun:test";
import { FLOW_ORIGIN_RECENT_LIMIT, runFlowOriginForShell } from "../tui/flow-origin-command";
import { originRoot, readRawFlow, type OriginRoot } from "./origin.test-helpers";

let env: OriginRoot | undefined;

afterEach(async () => {
  await env?.cleanup();
  env = undefined;
});

test("a kind change does not inherit the previous quote or source", async () => {
  env = await originRoot();
  const created = await env.service.init({
    cwd: env.root,
    title: "Switch kind",
    origin: "human-request",
    originQuote: "сделай это",
    originSource: "chat 9",
  });
  // Without its own evidence the new kind is refused, and the old origin stays.
  const refused = await env.service.originSet({ cwd: env.root, id: created.flow.id, kind: "agent-proposal", reason: "was the agent's idea" });
  expect(refused.changed).toBe(false);
  expect(refused.note).toContain("needs a --source");
  expect((await readRawFlow(env.root, created.dir)).origin).toEqual({ kind: "human-request", quote: "сделай это", source: "chat 9" });

  // With its own source the new origin carries that source and none of the old quote.
  const set = await env.service.originSet({
    cwd: env.root,
    id: created.flow.id,
    kind: "agent-proposal",
    source: "design talk",
    reason: "was the agent's idea",
  });
  expect(set.changed).toBe(true);
  expect((await readRawFlow(env.root, created.dir)).origin).toEqual({ kind: "agent-proposal", source: "design talk" });
});

test("the same kind still inherits what it already holds", async () => {
  env = await originRoot();
  const created = await env.service.init({ cwd: env.root, title: "Same kind", origin: "human-request", originQuote: "q", originSource: "chat 1" });
  const result = await env.service.originSet({ cwd: env.root, id: created.flow.id, kind: "human-request", source: "chat 2", reason: "fix the source" });
  expect(result.changed).toBe(true);
  expect((await readRawFlow(env.root, created.dir)).origin).toEqual({ kind: "human-request", quote: "q", source: "chat 2" });
});

test("/flow origin without an id prints a bounded summary", async () => {
  env = await originRoot();
  const total = FLOW_ORIGIN_RECENT_LIMIT + 5;
  for (let i = 0; i < total; i += 1) {
    await env.service.init({ cwd: env.root, title: `Flow ${i}`, slug: `flow-${i}`, ...(i % 3 === 0 ? { origin: "agent-finding", originSource: "ci" } : {}) });
  }
  const out = await runFlowOriginForShell(env.root, "/flow origin", env.service);
  expect(out).toContain(`origins of ${total} flows`);
  expect(out).toContain("agent-finding 5");
  expect(out).toContain(`older not listed`);
  // One line per listed flow, never one block per flow.
  const listed = out.split("\n").filter((line) => /^ {2}\d+ {2}\S+$/.test(line));
  expect(listed.length).toBe(FLOW_ORIGIN_RECENT_LIMIT);
  expect(out.split("\n").length).toBeLessThan(FLOW_ORIGIN_RECENT_LIMIT + 8);
});
