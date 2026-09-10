import { describe, expect, test } from "bun:test";
import { completionKey } from "../benchmark/retrieval-sweep";
import { ARENA_HARNESSES, CLAUDE_OPUS_DEFERRED, CLAUDE_SONNET, harnessById, modelPeers } from "./arena-harnesses";

describe("ARENA_HARNESSES", () => {
  test("three legs, each with a distinct id", () => {
    expect(ARENA_HARNESSES).toHaveLength(3);
    expect(new Set(ARENA_HARNESSES.map((spec) => spec.id)).size).toBe(3);
  });

  test("keryx-shell and grok-build share a model, which is what makes the pair a control", () => {
    // If either is ever repointed, the pair stops being a controlled comparison and
    // the failure would otherwise surface as an unexplained difference in results.
    const peers = modelPeers().get("grok-4.6") ?? [];
    expect(peers.sort()).toEqual(["grok-build", "keryx-shell"]);
  });

  test("model ids are explicit, never short aliases", () => {
    // `sonnet-5` is rejected as `unrecognized_model`, and the bare alias `sonnet`
    // resolves but billed $0.105 against `claude-sonnet-5`'s $0.0088 on the same
    // two-token prompt — so it is not the model the leg claims to measure.
    for (const spec of [...ARENA_HARNESSES, CLAUDE_OPUS_DEFERRED]) {
      if (spec.id.startsWith("claude")) expect(spec.model.startsWith("claude-")).toBe(true);
    }
  });

  test("a model is pinned per leg, never chosen from task difficulty", () => {
    // The pilot picks hard/easy from the gold-set size, which is right across 50
    // varied tasks and wrong here: a leg whose model changes between tasks cannot
    // be compared against one whose model does not.
    for (const spec of ARENA_HARNESSES) expect(spec.model.length).toBeGreaterThan(0);
    expect(new Set(ARENA_HARNESSES.map((spec) => spec.model)).size).toBe(2);
  });
});

describe("harnessById", () => {
  test("resolves a registered leg", () => {
    expect(harnessById("grok-build").model).toBe("grok-4.6");
  });

  test("resolves the deferred leg too, so adding it is a flag and not an edit", () => {
    expect(harnessById("claude-opus").model).toBe("claude-opus-5");
  });

  test("an unknown id names what is known rather than failing blankly", () => {
    expect(() => harnessById("gpt")).toThrow(/known: keryx-shell, grok-build, claude-sonnet, claude-opus/);
  });
});

describe("two specs over one adapter no longer collide", () => {
  test("sonnet and opus produce DIFFERENT harness ids from the same CLI", () => {
    // The bug this guards: the id belonged to the adapter, not the spec, so both
    // claude legs wrote "claude" on every row. Four consequences, all silent —
    // the rows merge in the results file, `completedKeys` treats the second leg as
    // already done and skips it, `decideByHarness` pools them into one verdict,
    // and their worktree paths collide.
    const sonnet = CLAUDE_SONNET.createAgent({ timeoutMs: 1000 });
    const opus = CLAUDE_OPUS_DEFERRED.createAgent({ timeoutMs: 1000 });
    expect(sonnet.harness).toBe("claude-sonnet");
    expect(opus.harness).toBe("claude-opus");
    expect(sonnet.harness).not.toBe(opus.harness);
  });

  test("their resume keys differ for the same task, so neither leg is skipped", () => {
    const task = "t1-abc12345";
    expect(completionKey("claude-sonnet", task)).not.toBe(completionKey("claude-opus", task));
  });

  test("every registered leg reports the id its spec declares", () => {
    for (const spec of ARENA_HARNESSES) {
      expect(spec.createAgent({ timeoutMs: 1000 }).harness).toBe(spec.id);
    }
  });
});
