import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { normalizeRemoteUrl, resolveProjectIdentity } from "./identity";

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

describe("normalizeRemoteUrl", () => {
  test.each([
    ["https://github.com/Org/Repo.git", "github.com/org/repo"],
    ["https://github.com/org/repo", "github.com/org/repo"],
    ["https://github.com/org/repo/", "github.com/org/repo"],
    ["https://user:pass@github.com/org/repo.git", "github.com/org/repo"],
    ["https://user@github.com/org/repo.git", "github.com/org/repo"],
    ["https://github.com/org/repo.git?ref=main", "github.com/org/repo"],
    ["https://github.com/org/repo#readme", "github.com/org/repo"],
    ["git@github.com:org/repo.git", "github.com/org/repo"],
    ["GIT@GITHUB.COM:ORG/REPO.GIT", "github.com/org/repo"],
    ["  https://github.com/org/repo.git  ", "github.com/org/repo"],
    ["ssh://git@github.com/org/repo.git", "github.com/org/repo"],
    ["ssh://git@github.com:22/org/repo", "github.com/org/repo"],
  ])("normalizes %s -> %s", (input, expected) => {
    expect(normalizeRemoteUrl(input)).toBe(expected);
  });

  // R1-F6: the whole point of normalization is that the SAME remote hashes
  // the same way regardless of which spelling a remote happens to be
  // configured with — a project with `origin` over `https` and `upstream`
  // over `ssh` must not look like two different projects to
  // `resolveProjectIdentity`/the promotion rule's ">= 2 distinct identities"
  // count.
  test("https, scp-style, ssh://, and ssh://host:22 spellings of the same remote all converge on one form", () => {
    const forms = [
      normalizeRemoteUrl("https://github.com/Owner/Repo.git"),
      normalizeRemoteUrl("git@github.com:owner/repo.git"),
      normalizeRemoteUrl("ssh://git@github.com/owner/repo.git"),
      normalizeRemoteUrl("ssh://git@github.com:22/owner/repo"),
    ];
    expect(new Set(forms).size).toBe(1);
    expect(forms[0]).toBe("github.com/owner/repo");
  });
});

describe("resolveProjectIdentity", () => {
  test("remote-hash: uses injected gitRemoteUrl, sha256 of the normalized URL", () => {
    const result = resolveProjectIdentity("/some/root", {
      gitRemoteUrl: () => "https://user:pass@github.com/Org/Repo.git",
    });
    expect(result.identityKind).toBe("remote-hash");
    expect(result.identity).toBe(sha256Hex("github.com/org/repo"));
    expect(result.identity).toMatch(/^[a-f0-9]{64}$/);
    expect(result.displayName).toBe("repo");
  });

  test("path-hash fallback: no remote, uses injected realpath", () => {
    const result = resolveProjectIdentity("/some/root", {
      gitRemoteUrl: () => null,
      realpath: () => "/resolved/root",
    });
    expect(result.identityKind).toBe("path-hash");
    expect(result.identity).toBe(sha256Hex("/resolved/root"));
    expect(result.displayName).toBe("root");
  });

  test("real temp git repo with origin remote resolves remote-hash", () => {
    const hasGit = spawnSync("git", ["--version"]).status === 0;
    if (!hasGit) return;
    const dir = mkdtempSync(path.join(tmpdir(), "keryx-learning-identity-"));
    try {
      spawnSync("git", ["-C", dir, "init", "-q"]);
      spawnSync("git", ["-C", dir, "remote", "add", "origin", "https://github.com/org/repo.git"]);
      const result = resolveProjectIdentity(dir);
      expect(result.identityKind).toBe("remote-hash");
      expect(result.identity).toBe(sha256Hex("github.com/org/repo"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("real temp git repo with no remote falls back to path-hash", () => {
    const hasGit = spawnSync("git", ["--version"]).status === 0;
    if (!hasGit) return;
    const dir = mkdtempSync(path.join(tmpdir(), "keryx-learning-identity-"));
    try {
      spawnSync("git", ["-C", dir, "init", "-q"]);
      const result = resolveProjectIdentity(dir);
      expect(result.identityKind).toBe("path-hash");
      expect(result.identity).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("non-git directory falls back to path-hash without throwing", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "keryx-learning-identity-nogit-"));
    try {
      expect(() => resolveProjectIdentity(dir)).not.toThrow();
      const result = resolveProjectIdentity(dir);
      expect(result.identityKind).toBe("path-hash");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
