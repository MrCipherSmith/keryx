import { test, expect } from "bun:test";
import { githubAdapter } from "./github";

test("parseRef extracts repo and issue number from GitHub URLs", () => {
  expect(githubAdapter.parseRef("https://github.com/acme/my-app/issues/123")).toEqual({
    repo: "acme/my-app",
    number: 123,
  });
  expect(
    githubAdapter.parseRef("https://github.com/a-b/c.d/issues/7#issuecomment-1"),
  ).toEqual({ repo: "a-b/c.d", number: 7 });
});

test("parseRef rejects non-issue URLs", () => {
  expect(githubAdapter.parseRef("https://github.com/acme/my-app/pull/123")).toBe(null);
  expect(githubAdapter.parseRef("https://example.com/issues/1")).toBe(null);
  expect(githubAdapter.parseRef("just a description of a problem")).toBe(null);
});
