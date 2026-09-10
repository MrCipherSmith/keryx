import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertKeryxAbsent, buildArenaEnv, pathWithoutKeryx } from "./arena-env";

/** A directory holding an executable called `keryx`, like a real PATH entry would. */
function binWithKeryx(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "arena-bin-"));
  const file = path.join(dir, "keryx");
  writeFileSync(file, "#!/bin/sh\nexit 0\n");
  chmodSync(file, 0o755);
  return dir;
}

function binWithout(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "arena-bin-plain-"));
  mkdirSync(path.join(dir, "keryx-notes"), { recursive: true });
  writeFileSync(path.join(dir, "git"), "#!/bin/sh\nexit 0\n");
  return dir;
}

describe("pathWithoutKeryx", () => {
  test("drops the entry that resolves the binary, keeps the rest", () => {
    const withKeryx = binWithKeryx();
    const plain = binWithout();
    const stripped = pathWithoutKeryx([plain, withKeryx].join(path.delimiter));
    expect(stripped.split(path.delimiter)).toEqual([plain]);
  });

  test("judges by resolution, not by spelling", () => {
    // A directory called `keryx-notes` holds no binary and must survive; a
    // directory with an innocuous name that DOES hold one must not. Matching on
    // the path string would get both backwards.
    const plain = binWithout();
    expect(pathWithoutKeryx(plain)).toBe(plain);
  });

  test("an empty PATH stays empty rather than becoming a bare separator", () => {
    expect(pathWithoutKeryx("")).toBe("");
  });
});

describe("assertKeryxAbsent", () => {
  test("the context-on arm is allowed to resolve it — that is the point of the arm", () => {
    const dir = binWithKeryx();
    expect(() => assertKeryxAbsent({ PATH: dir }, "context-on")).not.toThrow();
  });

  test("the context-off arm is refused, and the message says why it matters", () => {
    // Not "the binary is present" but "the capability is present": on a tree with
    // no .metaproject, `keryx ctx rg` still searches and `keryx ctx read` still
    // compacts, so the ablation did not remove what it claims to have removed.
    const dir = binWithKeryx();
    expect(() => assertKeryxAbsent({ PATH: dir }, "context-off")).toThrow(/not inert/);
  });

  test("a clean control arm passes, so the refusal above is not vacuous", () => {
    expect(() => assertKeryxAbsent({ PATH: binWithout() }, "context-off")).not.toThrow();
  });
});

describe("buildArenaEnv", () => {
  test("strips PATH BEFORE asserting, so the assertion is about what the arm gets", () => {
    // Order matters and the bug is invisible in a passing test: asserting a PATH
    // you then modify proves nothing about the environment handed over.
    const withKeryx = binWithKeryx();
    const plain = binWithout();
    const env = buildArenaEnv({
      parent: { PATH: [plain, withKeryx].join(path.delimiter) },
      home: "/tmp/h",
      arm: "context-off",
      harness: "grok",
    });
    expect(env.PATH).toBe(plain);
  });

  test("the context-on arm keeps its PATH intact", () => {
    const withKeryx = binWithKeryx();
    const env = buildArenaEnv({ parent: { PATH: withKeryx }, home: "/tmp/h", arm: "context-on", harness: "keryx" });
    expect(env.PATH).toBe(withKeryx);
  });

  test("the shared isolation rules still apply on top", () => {
    const env = buildArenaEnv({
      parent: { PATH: binWithout(), GH_TOKEN: "t", CLAUDE_CONFIG_DIR: "/x", EDITOR: "vim" },
      home: "/tmp/isolated",
      arm: "context-off",
      harness: "claude",
    });
    expect(env.HOME).toBe("/tmp/isolated");
    expect("GH_TOKEN" in env).toBe(false);
    expect("CLAUDE_CONFIG_DIR" in env).toBe(false);
    expect("EDITOR" in env).toBe(false);
  });

  test("a deliberate override is exempt by value, so the keryx leg can isolate itself", () => {
    const env = buildArenaEnv({
      parent: { PATH: binWithout(), XDG_DATA_HOME: "/Users/real/.local/share" },
      home: "/tmp/h",
      arm: "context-on",
      harness: "keryx",
      overrides: { XDG_DATA_HOME: "/tmp/h/.local/share" },
    });
    expect(env.XDG_DATA_HOME).toBe("/tmp/h/.local/share");
  });
});
