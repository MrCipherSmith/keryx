import { expect, test } from "bun:test";
import { githubPrUrl, githubRepositoryFromOrigin } from "./githubPr";

test("a PR link keeps its subpage and fragment and drops the query", () => {
  expect(githubPrUrl("https://github.com/o/r/pull/12")).toBe("https://github.com/o/r/pull/12");
  expect(githubPrUrl("https://github.com/o/r/pull/12/files#diff-abc")).toBe("https://github.com/o/r/pull/12/files#diff-abc");
  expect(githubPrUrl("https://github.com/o/r/pull/12#issuecomment-5")).toBe("https://github.com/o/r/pull/12#issuecomment-5");
  expect(githubPrUrl("https://github.com/o/r/pull/12/commits?tracking=1")).toBe("https://github.com/o/r/pull/12/commits");
});

test("a PR of any repository is accepted, whatever the project's own remote says", () => {
  expect(githubPrUrl("https://github.com/other/fork/pull/3")).toBe("https://github.com/other/fork/pull/3");
});

test("lookalike hosts, other schemes, credentials, ports and bad paths are refused", () => {
  for (const bad of [
    "https://github.com.example/o/r/pull/1",
    "http://github.com/o/r/pull/1",
    "https://user@github.com/o/r/pull/1",
    "https://github.com:8443/o/r/pull/1",
    "https://github.com/o/r/pull/0",
    "https://github.com/o/r/pull/1/../../x",
    "https://github.com/o/r/issues/1",
    "https://github.com/o/r/pull/1/other",
    "javascript:alert(1)",
    "",
  ]) expect(githubPrUrl(bad)).toBeNull();
  expect(githubPrUrl(null)).toBeNull();
});

test("only owner/repo is taken from a remote, never credentials or other hosts", () => {
  expect(githubRepositoryFromOrigin("git@github.com:o/r.git")).toBe("o/r");
  expect(githubRepositoryFromOrigin("https://github.com/o/r/")).toBe("o/r");
  expect(githubRepositoryFromOrigin("https://token@github.com/o/r")).toBeNull();
  expect(githubRepositoryFromOrigin("https://example.com/o/r")).toBeNull();
});
