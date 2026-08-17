import { expect, test } from "bun:test";
import {
  editMainQueueItem,
  formatMainQueueMarker,
  parseQueueCommand,
  QueuedMainQuestion,
  reinsertMainQueueItem,
  removeMainQueueItem,
} from "./main-queue";

const q = (id: string, question: string): QueuedMainQuestion => ({ id, question, displayQuestion: question });

test("formatMainQueueMarker renders qN (behind)", () => {
  expect(formatMainQueueMarker(0, 3)).toBe("> q1 (2)");
  expect(formatMainQueueMarker(1, 3)).toBe("> q2 (1)");
  expect(formatMainQueueMarker(2, 3)).toBe("> q3 (0)"); // head drains next
  expect(formatMainQueueMarker(0, 1)).toBe("> q1 (0)");
});

test("removeMainQueueItem is non-destructive and splices", () => {
  const items = [q("a", "A"), q("b", "B"), q("c", "C")];
  const out = removeMainQueueItem(items, 1);
  expect(items).toHaveLength(3); // original untouched
  expect(out.map((i) => i.id)).toEqual(["a", "c"]);
  // Out of range is a copy, not a throw.
  expect(removeMainQueueItem(items, 99)).toHaveLength(3);
  expect(removeMainQueueItem(items, -1)).toHaveLength(3);
});

test("editMainQueueItem pulls text out and returns rest + removed", () => {
  const items = [q("a", "A"), q("b", "B"), q("c", "C")];
  const edited = editMainQueueItem(items, 1)!;
  expect(edited.text).toBe("B");
  expect(edited.rest.map((i) => i.id)).toEqual(["a", "c"]);
  expect(edited.removed.id).toBe("b");
  expect(editMainQueueItem(items, 99)).toBeUndefined();
});

test("reinsertMainQueueItem puts an edited item back at its position (clamped)", () => {
  const rest = [{ ...q("a", "A") }, { ...q("c", "C") }];
  const re = reinsertMainQueueItem(rest, 1, { id: "b", question: "B2", displayQuestion: "B2" });
  expect(re.map((i) => i.id)).toEqual(["a", "b", "c"]);
  expect(re[1]!.question).toBe("B2");
  // Clamped: at beyond length appends, at negative prepends, never throws.
  expect(reinsertMainQueueItem(rest, 99, q("z", "Z")).map((i) => i.id)).toEqual(["a", "c", "z"]);
  expect(reinsertMainQueueItem(rest, -1, q("z", "Z")).map((i) => i.id)).toEqual(["z", "a", "c"]);
});

test("parseQueueCommand accepts remove/edit/force with an optional position (defaults to 1)", () => {
  expect(parseQueueCommand("remove")).toEqual({ action: "remove", position: 1 });
  expect(parseQueueCommand("remove 3")).toEqual({ action: "remove", position: 3 });
  expect(parseQueueCommand("  edit   2  ")).toEqual({ action: "edit", position: 2 });
  expect(parseQueueCommand("FORCE 1")).toEqual({ action: "force", position: 1 });
});

test("parseQueueCommand rejects unknown actions and malformed positions", () => {
  expect(parseQueueCommand("")).toBeUndefined();
  expect(parseQueueCommand("bogus")).toBeUndefined();
  expect(parseQueueCommand("remove 0")).toBeUndefined();
  expect(parseQueueCommand("remove -1")).toBeUndefined();
  expect(parseQueueCommand("remove abc")).toBeUndefined();
  expect(parseQueueCommand("remove 1.5")).toBeUndefined();
});
