import { describe, expect, test } from "bun:test";
import { draftOf, withDraft } from "./drafts";

describe("per-session drafts", () => {
  test("a draft typed for one session is not the draft of another", () => {
    const a = withDraft({}, "A", "hello A");
    expect(draftOf(a, "A")).toBe("hello A");
    expect(draftOf(a, "B")).toBe("");
    expect(draftOf(a, null)).toBe("");
  });

  test("switching back restores the draft; clearing one leaves the others", () => {
    let d = withDraft({}, "A", "a");
    d = withDraft(d, "B", "b");
    d = withDraft(d, "A", "");
    expect(draftOf(d, "A")).toBe("");
    expect(draftOf(d, "B")).toBe("b");
    expect(Object.keys(d)).toEqual(["B"]);
  });

  test("an unchanged draft keeps the same record", () => {
    const d = withDraft({}, "A", "a");
    expect(withDraft(d, "A", "a")).toBe(d);
  });
});
