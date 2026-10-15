import { describe, expect, test } from "bun:test";
import type { LayersFile } from "../review/layers";
import { createReviewLayersActions } from "./review-layers-actions";

const row = { reviewId: "r1", layersView: { dir: "/tmp/pkg" } } as never;

describe("the /reviews layers refresh action", () => {
  test("it hands the refresh to the injected runner (a child process in production), not to this process", async () => {
    const seen: string[] = [];
    const actions = createReviewLayersActions(process.cwd(), async (_root, dir) => {
      seen.push(dir);
      const head = "a".repeat(40);
      const divergence = { state: "none" as const, workingCopyCommit: head, prHead: head, commitsBetween: 0, changedPaths: [] };
      return {
        version: 1,
        refreshedAt: "2026-10-13T00:00:00.000Z",
        prHead: head,
        base: null,
        graphCommit: head,
        graph: { status: "ok", commit: head, builtAt: null, nodes: 3, edges: 2 },
        wiki: { status: "ok", commit: head, builtAt: null, pagesRefreshed: 0, pagesStaleProse: 0, written: false, divergence },
        memory: { status: "ok", commit: head, builtAt: null, entries: 1, divergence },
      } satisfies LayersFile;
    });
    const message = await actions.refreshLayers(row);
    expect(seen).toEqual(["/tmp/pkg"]);
    expect(message).toContain("Layers refreshed for r1");
  });

  test("a runner failure is reported as text, never thrown", async () => {
    const actions = createReviewLayersActions(process.cwd(), async () => {
      throw new Error("child exited 1");
    });
    expect(await actions.refreshLayers(row)).toBe("Layers refresh failed for r1: child exited 1");
  });

  test("a row with no package has nothing to refresh", async () => {
    const actions = createReviewLayersActions(process.cwd(), async () => {
      throw new Error("must not run");
    });
    expect(await actions.refreshLayers({ reviewId: "r1" } as never)).toBe("No package to refresh.");
  });
});
