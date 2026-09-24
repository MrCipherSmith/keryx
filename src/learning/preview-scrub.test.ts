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

// R2-F1 regression: a path embedded INSIDE a token (not at its start) used
// to survive unscrubbed — stack frames, JSON, shell redirects, file://
// URLs, backtick-quoted literals, and an unbalanced quote's tail. These all
// fail on the pre-fix classifier (only a token-START path shape was
// classified).
describe("scrubPathsInText (R2-F1: embedded paths inside a token)", () => {
  test("a stack-trace frame's path is reduced to its basename, line:col kept", () => {
    const out = scrubPathsInText("/nonexistent-root", "    at run (/Users/bob/other-client/src/x.ts:10:5)");
    expect(out).not.toContain("bob");
    expect(out).not.toContain("other-client");
    expect(out).toContain("(x.ts:10:5)");
  });

  test("a path embedded in a JSON string value is reduced to its basename", () => {
    const out = scrubPathsInText("/nonexistent-root", '{"path":"/Users/bob/secret-client/notes.md"}');
    expect(out).not.toContain("bob");
    expect(out).not.toContain("secret-client");
    expect(out).toBe('{"path":"notes.md"}');
  });

  test("shell redirect targets (< and 2>) are reduced to their basenames", () => {
    const out = scrubPathsInText("/nonexistent-root", "wc </Users/bob/secret/a.txt 2>/home/bob/err.log");
    expect(out).not.toContain("bob");
    expect(out).not.toContain("secret");
    expect(out).toContain("<a.txt");
    expect(out).toContain("2>err.log");
  });

  test("a file:// URL's path is reduced to its basename, scheme kept", () => {
    const out = scrubPathsInText("/nonexistent-root", "open file:///Users/bob/secret/a.pdf");
    expect(out).not.toContain("bob");
    expect(out).not.toContain("secret");
    expect(out).toContain("file://a.pdf");
  });

  test("a backtick-quoted path is reduced to its basename", () => {
    const out = scrubPathsInText("/nonexistent-root", "see `/Users/bob/y` for details");
    expect(out).not.toContain("bob");
    expect(out).toContain("`y`");
  });

  test("a JSON array of paths has each embedded path reduced", () => {
    const out = scrubPathsInText("/nonexistent-root", '["/Users/bob/a.txt","/Users/carol/b.txt"]');
    expect(out).not.toContain("bob");
    expect(out).not.toContain("carol");
    expect(out).toBe('["a.txt","b.txt"]');
  });

  test("an unbalanced quote's remainder is treated as one run, never leaking a space-containing directory name", () => {
    const out = scrubPathsInText("/nonexistent-root", '"unbalanced /Users/bob/Acme Merger/plan.txt');
    expect(out).not.toContain("Acme");
    expect(out).not.toContain("Merger");
    expect(out).not.toContain("bob");
    expect(out).toContain("plan.txt");
  });

  test("an in-root path still becomes a relative ./ path (regression guard)", async () => {
    await withTempRoot(async (root) => {
      const out = scrubPathsInText(root, `cd ${root}/src && ls`);
      expect(out).toContain("cd ./src");
      expect(out).not.toContain(root);
    });
  });
});
