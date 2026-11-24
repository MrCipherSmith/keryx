import { describe, expect, test } from "bun:test";
import { sameSubject, sessionFlags, type SessionSubject } from "./types";

const pr: SessionSubject = { kind: "pr", repo: "Org/Repo", number: 5, url: "https://github.com/Org/Repo/pull/5" };

describe("sameSubject", () => {
  test("matches kind, number and repo without case; the url and repositoryId do not matter", () => {
    expect(sameSubject(pr, { ...pr, repo: "org/repo", url: "https://github.com/org/repo/pull/5", repositoryId: "R_1" })).toBe(true);
  });

  test("a different kind, number or repo is another subject; a missing one matches nothing", () => {
    expect(sameSubject(pr, { ...pr, kind: "issue", url: "https://github.com/Org/Repo/issues/5" })).toBe(false);
    expect(sameSubject(pr, { ...pr, number: 6 })).toBe(false);
    expect(sameSubject(pr, { ...pr, repo: "Org/Other" })).toBe(false);
    expect(sameSubject(pr, undefined)).toBe(false);
    expect(sameSubject(null, null)).toBe(false);
  });

  test("session/list reports the subject in _meta.keryx", () => {
    expect(sessionFlags({ sessionId: "s", cwd: "/p", _meta: { keryx: { subject: pr } } }).subject).toEqual(pr);
    expect(sessionFlags({ sessionId: "s", cwd: "/p" }).subject).toBeUndefined();
  });
});
