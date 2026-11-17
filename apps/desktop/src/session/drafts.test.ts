import { describe, expect, test } from "bun:test";
import { adoptNoSessionDraft, draftOf, withDraft } from "./drafts";

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

describe("a draft made before the first session", () => {
  test("moves to the first session and clears the shared slot", () => {
    const d = adoptNoSessionDraft(withDraft({}, null, "from flows"), "A");
    expect(draftOf(d, "A")).toBe("from flows");
    expect(draftOf(d, null)).toBe("");
  });

  test("does not overwrite a draft the session already has", () => {
    const d = adoptNoSessionDraft(withDraft(withDraft({}, null, "pending"), "A", "mine"), "A");
    expect(draftOf(d, "A")).toBe("mine");
    expect(draftOf(d, null)).toBe("");
  });

  test("changes nothing without a session or a pending draft", () => {
    const d = withDraft({}, null, "x");
    expect(adoptNoSessionDraft(d, null)).toBe(d);
    const e = withDraft({}, "A", "a");
    expect(adoptNoSessionDraft(e, "A")).toBe(e);
  });
});
