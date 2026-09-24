import { describe, expect, test } from "bun:test";
import { generalizeLesson, reviewerIdFor } from "./reviewer-id";

const PROJECT_IDENTITY = "a".repeat(64);

describe("reviewerIdFor", () => {
  test("stable, opaque, rv- prefixed, 16 hex chars", () => {
    const id = reviewerIdFor(PROJECT_IDENTITY, "octocat");
    expect(id).toMatch(/^rv-[0-9a-f]{16}$/);
    expect(reviewerIdFor(PROJECT_IDENTITY, "octocat")).toBe(id);
    expect(reviewerIdFor(PROJECT_IDENTITY, "OctoCat")).toBe(id); // case-insensitive login
  });

  test("never contains the literal login", () => {
    const id = reviewerIdFor(PROJECT_IDENTITY, "octocat");
    expect(id).not.toContain("octocat");
  });

  test("differs per project identity", () => {
    expect(reviewerIdFor(PROJECT_IDENTITY, "octocat")).not.toBe(reviewerIdFor("b".repeat(64), "octocat"));
  });
});

describe("generalizeLesson", () => {
  test("strips the login and mentions, and courtesy phrasing, into an imperative", () => {
    const result = generalizeLesson("@octocat could you please add a null check before dereferencing the pointer", [
      "octocat",
    ]);
    expect(result).not.toBeNull();
    expect(result?.toLowerCase()).not.toContain("octocat");
    expect(result).not.toContain("@");
  });

  test("returns null when the generalized text is too short", () => {
    expect(generalizeLesson("@octocat nit: ok", ["octocat"])).toBeNull();
  });

  test("returns null when the generalized text exceeds 260 chars", () => {
    const long = "a".repeat(300);
    expect(generalizeLesson(long, [])).toBeNull();
  });

  test("is case-insensitive on the login", () => {
    const result = generalizeLesson("OctoCat said this should use a constant instead of a magic number", ["octocat"]);
    expect(result?.toLowerCase()).not.toContain("octocat");
  });
});
