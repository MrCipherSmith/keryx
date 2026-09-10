import { describe, expect, test } from "bun:test";
import type { RetrievalTask } from "../benchmark/retrieval-tasks";
import { mulberry32, sampleTasks } from "./arena-freeze-tasks";

function pool(size: number): RetrievalTask[] {
  return Array.from({ length: size }, (_unused, index) => ({
    id: `task${String(index).padStart(3, "0")}`,
    sha: `sha${index}`,
    parent: `parent${index}`,
    query: `subject ${index}`,
    gold: [`src/file${index}.ts`],
  }));
}

describe("mulberry32", () => {
  test("the same seed gives the same stream", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  test("different seeds diverge", () => {
    expect(mulberry32(1)()).not.toBe(mulberry32(2)());
  });
});

describe("sampleTasks", () => {
  test("draws the requested count without replacement", () => {
    const drawn = sampleTasks(pool(113), 13, 20260909);
    expect(drawn).toHaveLength(13);
    expect(new Set(drawn.map((task) => task.id)).size).toBe(13);
  });

  test("the same seed reproduces the same sample", () => {
    // The sample has to be reproducible from the artifact, or "pre-registered"
    // means nothing: a reader must be able to re-derive the 13 from the history.
    const first = sampleTasks(pool(113), 13, 20260909).map((task) => task.id);
    const second = sampleTasks(pool(113), 13, 20260909).map((task) => task.id);
    expect(second).toEqual(first);
  });

  test("a different seed gives a different sample", () => {
    const a = sampleTasks(pool(113), 13, 1).map((task) => task.id);
    const b = sampleTasks(pool(113), 13, 2).map((task) => task.id);
    expect(b).not.toEqual(a);
  });

  test("the input order does not change the draw", () => {
    // Sorted by id before shuffling, so however git happened to list commits,
    // the seed alone decides. Otherwise the "same seed" guarantee is void the
    // moment history grows a commit at the front.
    const forward = pool(50);
    const reversed = [...forward].reverse();
    expect(sampleTasks(reversed, 7, 99).map((task) => task.id)).toEqual(
      sampleTasks(forward, 7, 99).map((task) => task.id),
    );
  });

  test("asking for the whole pool returns a permutation, losing nothing", () => {
    const all = pool(20);
    const drawn = sampleTasks(all, 20, 5);
    expect(drawn.map((task) => task.id).sort()).toEqual(all.map((task) => task.id).sort());
  });

  test("the draw is not just the first N of the sorted pool", () => {
    // A shuffle that silently failed would return task000..task012, which looks
    // like a sample and is a slice — the exact defect this replaces.
    const drawn = sampleTasks(pool(113), 13, 20260909).map((task) => task.id);
    const slice = pool(113)
      .slice(0, 13)
      .map((task) => task.id);
    expect(drawn).not.toEqual(slice);
  });
});
