// Unit coverage for the token-based path classifier (`classifyPath` and its
// two renderers) that replaced the old regex-only free-text scrubber. Each
// scenario here mirrors a case from the W3 flow-312 T19 re-plan and is
// exercised directly against `scrubPathsInText`/`relativizePathForPreview`
// rather than through the full observation sink (see `observe.test.ts` for
// the end-to-end versions of the same scenarios).
import { realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { classifyPath, relativizePathForPreview, scrubPathsInText } from "./preview-scrub";

async function withTempRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-preview-scrub-"));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("classifyPath", () => {
  test("the root itself -> root", async () => {
    await withTempRoot(async (root) => {
      expect(classifyPath(root, root)).toEqual({ kind: "root" });
    });
  });

  test("inside the root -> relative", async () => {
    await withTempRoot(async (root) => {
      expect(classifyPath(root, path.join(root, "src", "a.ts"))).toEqual({ kind: "relative", value: "src/a.ts" });
    });
  });

  test("a home-shaped path with no further segments -> home", () => {
    expect(classifyPath("/nonexistent-root", "/Users/bob")).toEqual({ kind: "home" });
    expect(classifyPath("/nonexistent-root", "/home/alice/")).toEqual({ kind: "home" });
    expect(classifyPath("/nonexistent-root", "~")).toEqual({ kind: "home" });
  });

  test("a home-shaped path with further segments -> basename", () => {
    expect(classifyPath("/nonexistent-root", "/Users/bob/secretproj/include")).toEqual({ kind: "basename", value: "include" });
    expect(classifyPath("/nonexistent-root", "/home/alice/lib")).toEqual({ kind: "basename", value: "lib" });
    expect(classifyPath("/nonexistent-root", "~bob/secret.txt")).toEqual({ kind: "basename", value: "secret.txt" });
    expect(classifyPath("/nonexistent-root", "C:\\Users\\carol\\secret.txt")).toEqual({ kind: "basename", value: "secret.txt" });
  });

  test("a relative path that climbs outside the root -> basename", async () => {
    await withTempRoot(async (root) => {
      expect(classifyPath(root, "../other-client-repo/secrets.env")).toEqual({ kind: "basename", value: "secrets.env" });
    });
  });

  test("any other absolute path -> basename", () => {
    expect(classifyPath("/nonexistent-root", "/etc/some-other-user-home/secrets.env")).toEqual({ kind: "basename", value: "secrets.env" });
  });

  test("a sibling that shares the root as a text prefix is not treated as inside the root", async () => {
    await withTempRoot(async (root) => {
      expect(classifyPath(root, `${root}@old/f`)).toEqual({ kind: "basename", value: "f" });
      expect(classifyPath(root, `${root}+x/f`)).toEqual({ kind: "basename", value: "f" });
      expect(classifyPath(root, `${root}-secret/file.txt`)).toEqual({ kind: "basename", value: "file.txt" });
    });
  });

  test("resolves against the root's realpath as well as its resolved form", async () => {
    await withTempRoot(async (root) => {
      const real = realpathSync(root);
      expect(classifyPath(root, path.join(real, "src", "b.ts"))).toEqual({ kind: "relative", value: "src/b.ts" });
    });
  });
});

describe("relativizePathForPreview (structured path-valued fields, e.g. file_path)", () => {
  test("a relative path climbing outside the root is reduced to its basename only", async () => {
    await withTempRoot(async (root) => {
      expect(relativizePathForPreview(root, "../other-client-repo/secrets.env")).toBe("secrets.env");
    });
  });

  test("~user/... is reduced to its basename only", async () => {
    await withTempRoot(async (root) => {
      expect(relativizePathForPreview(root, "~bob/secret.txt")).toBe("secret.txt");
    });
  });

  test("a Windows path is reduced to its basename only", async () => {
    await withTempRoot(async (root) => {
      expect(relativizePathForPreview(root, "C:\\Users\\carol\\secret.txt")).toBe("secret.txt");
    });
  });

  test("a project-relative field never carries a './' prefix", async () => {
    await withTempRoot(async (root) => {
      expect(relativizePathForPreview(root, path.join(root, "src", "a.ts"))).toBe("src/a.ts");
    });
  });
});

describe("scrubPathsInText (free text — commands, stdout/stderr)", () => {
  test("bare home directories never leak the username", () => {
    const out = scrubPathsInText("/nonexistent-root", "ls /Users/bob && ls /home/alice/");
    expect(out).not.toContain("bob");
    expect(out).not.toContain("alice");
  });

  test("-I/-L flag-prefixed paths never leak the username or intermediate directory names", () => {
    const out = scrubPathsInText("/nonexistent-root", "gcc -I/Users/bob/secretproj/include -L/home/alice/lib");
    expect(out).not.toContain("bob");
    expect(out).not.toContain("alice");
    expect(out).not.toContain("secretproj");
  });

  test("a host: prefix keeps the host but never leaks the username", () => {
    const out = scrubPathsInText("/nonexistent-root", "scp host:/home/alice/k .");
    expect(out).not.toContain("alice");
  });

  test("a quoted path with spaces is treated as one token and reduced to a quoted basename", () => {
    const out = scrubPathsInText("/nonexistent-root", '"/Users/bob/Acme Merger Docs/plan.txt"');
    expect(out).not.toContain("Acme");
    expect(out).not.toContain("bob");
    expect(out).toContain('"plan.txt"');
  });

  test("a bare ~user path is reduced to its basename", () => {
    const out = scrubPathsInText("/nonexistent-root", "cat ~bob/secret.txt");
    expect(out).not.toContain("bob");
    expect(out).toContain("secret.txt");
  });

  test("a Windows path is reduced to its basename", () => {
    const out = scrubPathsInText("/nonexistent-root", "type C:\\Users\\carol\\secret.txt");
    expect(out).not.toContain("carol");
    expect(out).toContain("secret.txt");
  });

  test("root@old and root+x siblings are never rewritten as if they were the root", async () => {
    await withTempRoot(async (root) => {
      const outOld = scrubPathsInText(root, `cat ${root}@old/f`);
      const outPlus = scrubPathsInText(root, `cat ${root}+x/f`);
      expect(outOld).not.toContain(".@old");
      expect(outPlus).not.toContain(".+x");
      expect(outOld).not.toContain(root);
      expect(outPlus).not.toContain(root);
    });
  });

  test("a project-relative path inside a command keeps its shell-visible './' form", async () => {
    await withTempRoot(async (root) => {
      const out = scrubPathsInText(root, `cd ${root}/src && ls`);
      expect(out).not.toContain(root);
      expect(out).toContain("cd ./src");
    });
  });

  test("tokens with no path shape are left completely unchanged (extract signals still see them)", () => {
    const out = scrubPathsInText("/nonexistent-root", "bun test ./src/a.test.ts");
    expect(out).toContain("bun test ./src/a.test.ts");
    const failOut = scrubPathsInText("/nonexistent-root", "(fail) some assertion, 1 fail");
    expect(failOut).toBe("(fail) some assertion, 1 fail");
  });

  test("a URL is left untouched (never mistaken for a host: prefix)", () => {
    const out = scrubPathsInText("/nonexistent-root", "curl https://example.com/Users/bob/api");
    expect(out).toBe("curl https://example.com/Users/bob/api");
  });
});
