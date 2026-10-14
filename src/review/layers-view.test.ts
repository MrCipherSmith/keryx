import { expect, test } from "bun:test";
import { layersDetailLines } from "./layers-view";

const layers = (graph: Record<string, unknown>): never =>
  ({
    prHead: "abcdef1234",
    graphCommit: null,
    graph,
    wiki: { status: "ok", commit: null, divergence: { state: "none", changedPaths: [] }, pagesRefreshed: 0, written: false, pagesStaleProse: null },
    memory: { status: "ok", commit: null, divergence: { state: "none", changedPaths: [] }, entries: 0 },
  }) as never;

test("a failed graph line says it is not retried for a few minutes and names --force", () => {
  const [line] = layersDetailLines(layers({ status: "failed", error: "could not check out" }));
  expect(line).toContain("graph: failed — could not check out");
  expect(line).toContain("not retried automatically for a few minutes");
  expect(line).toContain("refresh --force");
});

test("a graph that is not failed carries no retry hint", () => {
  const [line] = layersDetailLines(layers({ status: "unavailable" }));
  expect(line).toBe("graph: unavailable");
});
