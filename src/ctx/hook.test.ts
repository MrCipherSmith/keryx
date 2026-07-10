import { expect, test } from "bun:test";
import { classifyCommand } from "./hook-classify";
import { CLAUDE_RUNTIME } from "./runtimes";

const extractBashCommand = (payload: string) => CLAUDE_RUNTIME.parseCommand(payload);

test("blocks raw rg and suggests ctx rg", () => {
  const result = classifyCommand('rg "getDetails" src');
  expect(result.block).toBe(true);
  expect(result.matched).toBe("rg");
  expect(result.suggestion).toContain("keryx ctx rg");
});

test("blocks grep family (grep/egrep/fgrep)", () => {
  for (const cmd of ["grep foo file", "egrep foo file", "fgrep foo file"]) {
    expect(classifyCommand(cmd).block).toBe(true);
  }
});

test("blocks cat/head/tail and suggests ctx read", () => {
  for (const cmd of ["cat big.log", "head -n 200 big.log", "tail -f app.log"]) {
    const result = classifyCommand(cmd);
    expect(result.block).toBe(true);
    expect(result.suggestion).toContain("keryx ctx read");
  }
});

test("blocks git diff/log/show, allows other git subcommands", () => {
  expect(classifyCommand("git diff HEAD~1").block).toBe(true);
  expect(classifyCommand("git log --oneline").block).toBe(true);
  expect(classifyCommand("git show HEAD").block).toBe(true);
  expect(classifyCommand("git status").block).toBe(false);
  expect(classifyCommand("git commit -m x").block).toBe(false);
});

test("does not block already-routed keryx ctx / rtk commands", () => {
  expect(classifyCommand('keryx ctx rg "foo"').block).toBe(false);
  expect(classifyCommand("rtk grep foo").block).toBe(false);
  expect(classifyCommand("keryx ctx read x --mode compact").block).toBe(false);
});

test("allows unrelated commands (defer to generic proxy)", () => {
  for (const cmd of ["ls -la", "echo hi", "bun test", "node script.js", "mkdir -p x"]) {
    expect(classifyCommand(cmd).block).toBe(false);
  }
});

test("escape marker allows a raw command and captures the reason", () => {
  const result = classifyCommand('rg "foo" # keryx:raw need PCRE lookbehind');
  expect(result.block).toBe(false);
  expect(result.escapeReason).toBe("need PCRE lookbehind");
});

test("escape marker with no reason still allows (empty reason)", () => {
  const result = classifyCommand("cat big.log # keryx:raw");
  expect(result.block).toBe(false);
  expect(result.escapeReason).toBe("");
});

test("detects raw command inside a compound / piped segment", () => {
  expect(classifyCommand("cd src && rg foo").block).toBe(true);
  expect(classifyCommand("cat f | rg bar").block).toBe(true);
});

test("skips leading env assignments and wrappers", () => {
  expect(classifyCommand("FOO=bar rg baz").block).toBe(true);
  expect(classifyCommand("sudo cat /etc/hosts").block).toBe(true);
});

test("empty / whitespace command does not block", () => {
  expect(classifyCommand("").block).toBe(false);
  expect(classifyCommand("   ").block).toBe(false);
});

test("extractBashCommand: valid Bash payload", () => {
  const payload = JSON.stringify({
    tool_name: "Bash",
    tool_input: { command: "rg foo" },
  });
  expect(extractBashCommand(payload)).toBe("rg foo");
});

test("extractBashCommand: non-Bash tool -> null (fail-open)", () => {
  const payload = JSON.stringify({ tool_name: "Read", tool_input: { file_path: "x" } });
  expect(extractBashCommand(payload)).toBeNull();
});

test("extractBashCommand: malformed JSON -> null (fail-open)", () => {
  expect(extractBashCommand("{not json")).toBeNull();
  expect(extractBashCommand("")).toBeNull();
});
