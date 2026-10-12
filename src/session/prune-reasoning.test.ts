import { expect, test } from "bun:test";
import type { NormalizedMessage } from "../harness/provider/types";
import { PRUNE_MIN_SAVING_TOKENS, REASONING_KEEP_ROUNDS, planPrune, pruneToolOutputs } from "./prune";

// Flow 387 T19: encrypted reasoning replay is kept only on the newest 3 assistant
// messages that carry it. Small tool results here, so only the reasoning batch acts.

function user(content: string): NormalizedMessage {
  return { role: "user", content, provenance: "trusted" };
}
/** Assistant call + result; `replayChars` > 0 attaches an opaque replay item with a visible text. */
function round(i: number, replayChars: number): NormalizedMessage[] {
  const assistant: NormalizedMessage = {
    role: "assistant",
    content: "",
    provenance: "model",
    toolCalls: [{ id: `r${i}`, name: "read_file", arguments: "{}" }],
    ...(replayChars > 0
      ? {
          reasoning: {
            text: `thought ${i}`,
            replay: [{ providerId: "openai-codex", kind: "encrypted_content", data: "Z".repeat(replayChars) }],
          },
        }
      : {}),
  };
  return [assistant, { role: "tool", content: "ok", provenance: "tool", toolCallId: `r${i}` }];
}
function withReplay(history: readonly NormalizedMessage[]): number[] {
  return history.flatMap((m, i) => ((m.reasoning?.replay?.length ?? 0) > 0 ? [i] : []));
}
/** 12 rounds of 10K-char replay (2.5K tokens each): the 9 oldest strip ~22K tokens. */
function session(rounds = 12, replayChars = 10_000): NormalizedMessage[] {
  const h: NormalizedMessage[] = [user("go")];
  for (let i = 0; i < rounds; i++) {
    h.push(...round(i, replayChars));
  }
  return h;
}

test("only the newest 3 reasoning-bearing messages keep their replay", async () => {
  const history = session();
  const before = history.map((m) => m);
  const result = await pruneToolOutputs(history, { sessionDir: undefined });
  expect(result.reasoningStripped).toBe(12 - REASONING_KEEP_ROUNDS);
  expect(result.collapsed).toBe(0);
  expect(withReplay(history)).toEqual([19, 21, 23]); // rounds 9, 10, 11
  // Same length and pairing; visible reasoning text survives on the stripped ones.
  expect(history.length).toBe(before.length);
  expect(history[1]?.reasoning).toEqual({ text: "thought 0" });
  expect(history[1]?.toolCalls).toEqual(before[1]?.toolCalls);
});

test("the newest reasoning-bearing message is always kept, even when it is not the last assistant message", async () => {
  const history = session(11);
  history.push(...round(99, 0)); // newest assistant message has no reasoning
  await pruneToolOutputs(history, { sessionDir: undefined });
  const kept = withReplay(history);
  expect(kept.length).toBe(REASONING_KEEP_ROUNDS);
  // The newest message that carries reasoning is the last of the kept three.
  expect(kept[kept.length - 1]).toBe(21);
});

test("below the saving threshold nothing is stripped; fewer than 3 reasoning messages are never stripped", async () => {
  const small = session(12, 1_000); // 9 x 250 tokens: under 20K
  const r = await pruneToolOutputs(small, { sessionDir: undefined });
  expect(r.reasoningStripped).toBe(0);
  expect(withReplay(small).length).toBe(12);
  const few = session(3, 400_000);
  expect((await pruneToolOutputs(few, { sessionDir: undefined })).reasoningStripped).toBe(0);
  expect(planPrune(few).strips).toEqual([]);
  expect(PRUNE_MIN_SAVING_TOKENS).toBe(20_000);
});

test("is idempotent", async () => {
  const history = session();
  await pruneToolOutputs(history, { sessionDir: undefined });
  const snapshot = JSON.stringify(history);
  const again = await pruneToolOutputs(history, { sessionDir: undefined });
  expect(again).toEqual({ pruned: 0, collapsed: 0, reasoningStripped: 0, savedTokens: 0 });
  expect(JSON.stringify(history)).toBe(snapshot);
});

test("archive keeps the original reasoning replay", async () => {
  const history = session();
  const archive = [...history];
  await pruneToolOutputs(history, { sessionDir: undefined });
  expect(withReplay(archive).length).toBe(12);
  expect(archive[1]?.reasoning?.replay?.[0]?.data).toBe("Z".repeat(10_000));
});

test("reasoning strip counts toward one batch with result clearing under the same threshold", async () => {
  // Results alone (2 x 10K tokens, 1 outside a 0-token window) save < 20K; with the
  // 9 stripped replays the batch crosses it and both happen together.
  const history = session();
  history.splice(2, 1, { role: "tool", content: "x".repeat(40_000), provenance: "tool", toolCallId: "r0" });
  const result = await pruneToolOutputs(history, { sessionDir: undefined, collapseGroups: false, protectTokens: 0 });
  expect(result.reasoningStripped).toBe(9);
  expect(result.pruned).toBeGreaterThan(0);
});
