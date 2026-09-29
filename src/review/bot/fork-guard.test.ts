import { describe, expect, test } from "bun:test";
import { checkPullForBot, checkPullOpen, checkSameRepo, readPullFacts } from "./fork-guard";

function pull(overrides: Record<string, unknown> = {}): unknown {
  return {
    state: "open",
    merged_at: null,
    head: { sha: "ABC1234567", ref: "feat/x", repo: { full_name: "acme/app", id: 7 } },
    base: { sha: "def4567890", ref: "main", repo: { full_name: "acme/app", id: 7 } },
    ...overrides,
  };
}

describe("readPullFacts", () => {
  test("reads state, shas, refs and both repositories", () => {
    expect(readPullFacts(pull())).toMatchObject({
      state: "open",
      merged: false,
      mergedAt: null,
      headSha: "abc1234567",
      baseSha: "def4567890",
      baseRef: "main",
      headRepo: "acme/app",
      baseRepo: "acme/app",
    });
  });

  test("a deleted fork reads as a null head repository, never as the base", () => {
    const facts = readPullFacts(pull({ head: { sha: "abc1234567", repo: null } }));
    expect(facts.headRepo).toBeNull();
  });

  test("something that is not a pull object reads as unknown with nothing filled in", () => {
    const facts = readPullFacts([]);
    expect(facts.state).toBe("unknown");
    expect(facts.headRepo).toBeNull();
    expect(facts.baseRepo).toBeNull();
    expect(facts.headSha).toBeNull();
  });
});

describe("checkSameRepo", () => {
  test("the same repository passes, compared case-insensitively", () => {
    expect(checkSameRepo(readPullFacts(pull()))).toEqual({ ok: true });
    const facts = readPullFacts(pull({ head: { sha: "abc1234567", repo: { full_name: "ACME/App", id: 7 } } }));
    expect(checkSameRepo(facts)).toEqual({ ok: true });
  });

  test("a fork is refused with a reason that names both repositories", () => {
    const facts = readPullFacts(pull({ head: { sha: "abc1234567", repo: { full_name: "mallory/app", id: 99 } } }));
    const verdict = checkSameRepo(facts);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toContain("mallory/app");
    expect(verdict.reason).toContain("acme/app");
    expect(verdict.reason).toMatch(/fork/i);
  });

  test("a fork that shares the base's name is still refused when the repository id differs", () => {
    const facts = readPullFacts(pull({ head: { sha: "abc1234567", repo: { full_name: "acme/app", id: 99 } } }));
    expect(checkSameRepo(facts).ok).toBe(false);
  });

  test("an unreadable head repository is refused, not waved through", () => {
    const facts = readPullFacts(pull({ head: { sha: "abc1234567", repo: null } }));
    const verdict = checkSameRepo(facts);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toMatch(/head repository/i);
  });

  test("an unreadable base repository is refused", () => {
    expect(checkSameRepo(readPullFacts([])).ok).toBe(false);
  });
});

describe("checkPullOpen", () => {
  test("open passes; closed, merged and unknown are refused", () => {
    expect(checkPullOpen(readPullFacts(pull()))).toEqual({ ok: true });
    expect(checkPullOpen(readPullFacts(pull({ state: "closed" }))).ok).toBe(false);
    const merged = checkPullOpen(readPullFacts(pull({ state: "closed", merged_at: "2026-09-01T00:00:00Z" })));
    expect(merged.ok).toBe(false);
    if (!merged.ok) expect(merged.reason).toContain("merged");
    expect(checkPullOpen(readPullFacts([])).ok).toBe(false);
  });
});

describe("checkPullForBot", () => {
  test("the fork reason comes first, so a fork PR is never described as merely closed", () => {
    const facts = readPullFacts(
      pull({ state: "closed", head: { sha: "abc1234567", repo: { full_name: "mallory/app", id: 99 } } }),
    );
    const verdict = checkPullForBot(facts);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toMatch(/fork/i);
  });

  test("a same-repo open pull passes", () => {
    expect(checkPullForBot(readPullFacts(pull()))).toEqual({ ok: true });
  });
});
