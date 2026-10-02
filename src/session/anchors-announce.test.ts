import { expect, test } from "bun:test";
import type { NormalizedMessage } from "../harness/provider/types";
import { compactMessages } from "./compact";
import { anchorsAnnouncement, isFullAnchorsContent } from "./anchors-announce";
import { renderAnchorsBlock, type SlateAnchors } from "./slate";

function anchorsWith(touched: string[]): SlateAnchors {
  return { root: "/work/repo", tree: "main", runtime: { provider: "p", model: "m" }, touched };
}

const fullBlocks = (h: readonly NormalizedMessage[]): number =>
  h.filter((m) => m.role === "user" && isFullAnchorsContent(m.content)).length;

// flow 387 T9 (AC4)
test("20 touched changes leave exactly one full block; the rest grows by deltas only", () => {
  const history: NormalizedMessage[] = [{ role: "user", content: "do the thing", provenance: "project" }];
  const touched: string[] = [];
  let firstBytes = 0;
  let deltaBytes = 0;
  for (let i = 0; i < 20; i++) {
    touched.push(`src/file-${i}.ts`);
    const msg = anchorsAnnouncement(history, anchorsWith([...touched]));
    expect(msg).toBeDefined();
    if (msg === undefined) {
      continue;
    }
    expect(msg.injected).toBe(true);
    history.push(msg);
    if (i === 0) {
      firstBytes = msg.content.length;
    } else {
      expect(msg.content.startsWith("Anchors update:")).toBe(true);
      expect(msg.content).toContain(`+ src/file-${i}.ts`);
      // only the changed entry, never the earlier ones
      expect(msg.content).not.toContain(`src/file-${i - 1}.ts`);
      deltaBytes += msg.content.length;
    }
  }
  expect(fullBlocks(history)).toBe(1);
  const anchorBytes = history.slice(1).reduce((n, m) => n + m.content.length, 0);
  expect(anchorBytes).toBe(firstBytes + deltaBytes);
  // far below what 20 full blocks (the old behaviour) would have cost
  const naive = Array.from({ length: 20 }, (_, i) =>
    renderAnchorsBlock(anchorsWith(touched.slice(0, i + 1))).length,
  ).reduce((n, len) => n + len, 0);
  expect(anchorBytes).toBeLessThan(naive / 2);
});

test("an unchanged anchors state announces nothing", () => {
  const history: NormalizedMessage[] = [];
  const first = anchorsAnnouncement(history, anchorsWith(["a.ts"]));
  if (first !== undefined) {
    history.push(first);
  }
  expect(anchorsAnnouncement(history, anchorsWith(["a.ts"]))).toBeUndefined();
});

test("a runtime switch is a one-line delta", () => {
  const history: NormalizedMessage[] = [];
  const first = anchorsAnnouncement(history, anchorsWith(["a.ts"]));
  if (first !== undefined) {
    history.push(first);
  }
  const msg = anchorsAnnouncement(history, { ...anchorsWith(["a.ts"]), runtime: { provider: "q", model: "n" } });
  expect(msg?.content).toBe("Anchors update:\nruntime: q/n");
});

// flow 387 T9 (AC4): a compaction drops older anchor messages and re-emits one full block
test("a compaction leaves one consolidated full block and later changes stay deltas", () => {
  const history: NormalizedMessage[] = [];
  const touched: string[] = [];
  for (let i = 0; i < 6; i++) {
    history.push({ role: "user", content: `request ${i}`, provenance: "project" });
    history.push({ role: "assistant", content: `ok ${i}`, provenance: "model" });
    touched.push(`src/f${i}.ts`);
    const msg = anchorsAnnouncement(history, anchorsWith([...touched]));
    if (msg !== undefined) {
      history.push(msg);
    }
  }
  const compacted = compactMessages(history, { keepLastUserTurns: 2 });
  expect(compacted.noop).toBe(false);
  expect(fullBlocks(compacted.context)).toBe(1);
  const full = compacted.context.find((m) => isFullAnchorsContent(m.content));
  // the removed prefix held f0..f3; the kept window's own deltas (f4, f5) stay as deltas
  expect(full?.content).toContain("- src/f3.ts");
  expect(full?.content).toContain("- src/f0.ts");

  touched.push("src/f6.ts");
  const next = anchorsAnnouncement(compacted.context, anchorsWith([...touched]));
  expect(next?.content).toBe("Anchors update:\n+ src/f6.ts");
});
