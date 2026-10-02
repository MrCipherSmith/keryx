// Flow 387 review r2 F-023: `runAgentTurn` prunes/collapses old tool output only for a host that
// passes `pruneArchive: true` (it keeps the originals in an archive). Dropping the flag at one
// host site silently turns pruning off there, and no behaviour test reaches those turn calls
// (they sit inside the shells' REPL closures), so each site is pinned at source level. The
// patterns tolerate whitespace and line breaks, unlike a literal-text match. The readline
// operator turn is pinned separately by shell.test.ts.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const SRC = path.resolve(import.meta.dir, "..");
const read = (relative: string): string => readFileSync(path.join(SRC, relative), "utf8");

describe("pruneArchive wiring at every host that keeps an archive", () => {
  test("the readline shell's task-notification turn opts into pruning", () => {
    const source = read("commands/shell.ts");
    expect(source).toMatch(
      /runAgentTurn\(\s*agentIo,\s*deps,\s*history,\s*"",\s*\{\s*origin:\s*"task-notification",[\s\S]{0,200}?pruneArchive:\s*true/,
    );
  });

  test("the readline shell's operator turn opts into pruning", () => {
    const source = read("commands/shell.ts");
    expect(source).toMatch(/runAgentTurn\(\s*agentIo,\s*deps,\s*history,\s*operatorLine,[\s\S]{0,120}?pruneArchive:\s*true/);
  });

  test("the TUI foreground turn opts into pruning", () => {
    const source = read("tui/tui-shell.ts");
    expect(source).toMatch(
      /runAgentTurn\(\s*foregroundIo,\s*deps,\s*history,\s*line,\s*\{[\s\S]{0,400}?pruneArchive:\s*true[\s\S]{0,40}?\}\)\s*\.finally/,
    );
  });

  test("/goal builds turnOptions with pruneArchive and passes them to all three turns", () => {
    const source = read("commands/goal-command.ts");
    expect(source).toMatch(/const turnOptions\s*=[\s\S]{0,120}?pruneArchive:\s*true/);
    const turnCalls = source.match(/runAgentTurn\(io,\s*deps,\s*history,\s*[^,]+,\s*turnOptions\)/g) ?? [];
    expect(turnCalls).toHaveLength(3);
    expect(source.match(/runAgentTurn\(/g) ?? []).toHaveLength(3);
  });

  test("the ACP host does not opt into pruning", () => {
    const source = read("acp/server.ts");
    expect(source).not.toMatch(/pruneArchive:\s*true/);
  });
});
