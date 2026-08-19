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

test("formatMainQueueMarker renders qN (N)", () => {
  expect(formatMainQueueMarker(0)).toBe("> q1 (1)");
  expect(formatMainQueueMarker(1)).toBe("> q2 (2)");
  expect(formatMainQueueMarker(2)).toBe("> q3 (3)");
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

// Flow 176 T16: the three moves were WIDENED, not copied, so a per-addressee
// queue carrying a richer item runs the same remove/edit/reinsert code and
// cannot drift from the main queue on the next bug fix.
test("flow 176: the moves keep the item type, extra fields included", () => {
  type Addressed = QueuedMainQuestion & { addressee: string };
  const items: Addressed[] = [
    { ...q("a", "A"), addressee: "ext:1" },
    { ...q("b", "B"), addressee: "ext:1" },
  ];
  const removed = removeMainQueueItem(items, 0);
  expect(removed[0]?.addressee).toBe("ext:1");

  const edited = editMainQueueItem(items, 1)!;
  expect(edited.removed.addressee).toBe("ext:1");
  const back = reinsertMainQueueItem(edited.rest, 1, edited.removed);
  expect(back.map((item) => item.id)).toEqual(["a", "b"]);
  expect(back[1]?.addressee).toBe("ext:1");
});

test("parseQueueCommand rejects unknown actions and malformed positions", () => {
  expect(parseQueueCommand("")).toBeUndefined();
  expect(parseQueueCommand("bogus")).toBeUndefined();
  expect(parseQueueCommand("remove 0")).toBeUndefined();
  expect(parseQueueCommand("remove -1")).toBeUndefined();
  expect(parseQueueCommand("remove abc")).toBeUndefined();
  expect(parseQueueCommand("remove 1.5")).toBeUndefined();
});
