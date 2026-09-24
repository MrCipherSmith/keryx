// Flow 308 (W8, T12) — unit tests for the dependency-free `.codex/config.toml`
// reader that replaced the `mcp-servers/compat.ts#parseGrokToml` import
// (a core-zone module reaching into a client-zone one).

import { expect, test } from "bun:test";
import { parseCodexToml } from "./codex-toml";

test("a single-line args array parses, with the table's header line", () => {
  const toml = ["[mcp_servers.some-mcp]", 'command = "npx"', 'args = ["-y", "some-mcp"]', ""].join("\n");
  const result = parseCodexToml(toml);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.servers).toEqual([{ name: "some-mcp", command: "npx", args: ["-y", "some-mcp"], line: 1 }]);
});

test("a multi-line args array parses, trailing comma included", () => {
  const toml = [
    "[mcp_servers.postgres]",
    'command = "npx"',
    "args = [",
    '  "-y",',
    '  "mcp-postgres",',
    '  "--read-only",',
    '  "postgres://user@host/db",',
    "]",
    "",
  ].join("\n");
  const result = parseCodexToml(toml);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.servers).toEqual([
    {
      name: "postgres",
      command: "npx",
      args: ["-y", "mcp-postgres", "--read-only", "postgres://user@host/db"],
      line: 1,
    },
  ]);
});

test("comment lines and inline comments are ignored, including a '#' inside a quoted arg", () => {
  const toml = [
    "# a leading comment",
    "[mcp_servers.docs]  # trailing comment on the header",
    'command = "npx" # trailing comment on a scalar',
    "args = [",
    '  "--tag", # keep this one',
    '  "release#1", # a literal hash inside the string, not a comment',
    "]",
    "",
  ].join("\n");
  const result = parseCodexToml(toml);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.servers).toEqual([{ name: "docs", command: "npx", args: ["--tag", "release#1"], line: 2 }]);
});

test("a quoted table name is understood", () => {
  const toml = ["[mcp_servers.\"my server\"]", 'command = "npx"', 'args = ["-y", "x"]', ""].join("\n");
  const result = parseCodexToml(toml);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.servers).toEqual([{ name: "my server", command: "npx", args: ["-y", "x"], line: 1 }]);
});

test("an unrelated top-level table is skipped without affecting scanning", () => {
  const toml = [
    "[profile]",
    'name = "default"',
    "",
    "[mcp_servers.some-mcp]",
    'command = "npx"',
    'args = ["-y", "some-mcp"]',
    "",
  ].join("\n");
  const result = parseCodexToml(toml);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.servers).toEqual([{ name: "some-mcp", command: "npx", args: ["-y", "some-mcp"], line: 4 }]);
});

test("a server with no command is reported with an empty command, not dropped", () => {
  const toml = ["[mcp_servers.no-command]", 'args = ["-y", "x"]', ""].join("\n");
  const result = parseCodexToml(toml);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.servers).toEqual([{ name: "no-command", command: "", args: ["-y", "x"], line: 1 }]);
});

test("an array that never closes is a parse error naming the line, not a silent partial read", () => {
  const toml = ["[mcp_servers.broken]", 'command = "npx"', "args = [", '  "--read-only",', ""].join("\n");
  const result = parseCodexToml(toml);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toContain("line 3");
});

test("a malformed key/value line is a parse error", () => {
  const toml = ["[mcp_servers.broken]", "this is not toml at all", ""].join("\n");
  const result = parseCodexToml(toml);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toContain("line 2");
});

test("a table header with no server name is a parse error", () => {
  const toml = ["[mcp_servers.]", ""].join("\n");
  const result = parseCodexToml(toml);
  expect(result.ok).toBe(false);
});

test("an array assigned to a value other than strings is refused", () => {
  const toml = ["[mcp_servers.broken]", "args = [1, 2, 3]", ""].join("\n");
  const result = parseCodexToml(toml);
  expect(result.ok).toBe(false);
});
