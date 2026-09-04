import { describe, expect, test } from "bun:test";
import { resolveServeRoot } from "./mcp-serve-root";

// Measured against Claude Code 2.1.220, not assumed: a `${CLAUDE_PROJECT_DIR}`
// placeholder in `.mcp.json` args reaches the server VERBATIM, and the `:-.`
// form expands to its fallback rather than to the project. The runtime hands the
// project root over through the ENVIRONMENT instead. These tests pin the
// precedence that follows from that measurement.

describe("resolveServeRoot", () => {
  test("an explicit --cwd wins over everything", () => {
    expect(
      resolveServeRoot("/named/by/a/human", "/process/cwd", { CLAUDE_PROJECT_DIR: "/runtime/root" }),
    ).toBe("/named/by/a/human");
  });

  test("without --cwd, the runtime's project root is used", () => {
    expect(resolveServeRoot(undefined, "/process/cwd", { CLAUDE_PROJECT_DIR: "/runtime/root" })).toBe(
      "/runtime/root",
    );
  });

  test("without --cwd and without the variable, the process cwd is unchanged behaviour", () => {
    expect(resolveServeRoot(undefined, "/process/cwd", {})).toBe("/process/cwd");
  });

  test("an empty or blank variable is ignored, not treated as a root", () => {
    // `path.resolve("")` is the process cwd, so honouring a blank value would
    // look identical to the fallback while claiming to be the runtime's answer.
    expect(resolveServeRoot(undefined, "/process/cwd", { CLAUDE_PROJECT_DIR: "" })).toBe("/process/cwd");
    expect(resolveServeRoot(undefined, "/process/cwd", { CLAUDE_PROJECT_DIR: "   " })).toBe("/process/cwd");
  });

  test("a blank --cwd falls through rather than resolving to the process cwd", () => {
    expect(resolveServeRoot("", "/process/cwd", { CLAUDE_PROJECT_DIR: "/runtime/root" })).toBe(
      "/runtime/root",
    );
  });

  test("the literal placeholder is NOT special-cased — it is a real measured input", () => {
    // If a config still carries the unexpanded placeholder, it arrives as this
    // exact string. Treating it as a path is wrong, but so is silently
    // rewriting it: the caller asked for a directory that does not exist, and
    // the honest outcome is the same "no .metaproject here" the server already
    // handles by exposing zero tools. This test records the decision rather
    // than leaving the behaviour undiscovered.
    expect(
      resolveServeRoot("${CLAUDE_PROJECT_DIR}", "/process/cwd", { CLAUDE_PROJECT_DIR: "/runtime/root" }),
    ).toBe("${CLAUDE_PROJECT_DIR}");
  });
});
