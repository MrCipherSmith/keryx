// `keryx mcp --help` describes what `keryx mcp` MEANS.
//
// It described only the retired publisher spellings — `serve-mcp` and
// `integrate` — so an operator typing `keryx mcp --help` to discover
// `list` or `doctor`, both of which work and are the point of the verb
// since D-04, was sent to the surface the rename moved away from.
//
// That is the same defect as `/mcp` opening the installer, which P2 also
// fixes: the name moved and one surface was not told. Found by writing
// the release smoke test rather than by the suite, which is the second
// time that exercise has turned up something no test was watching — and
// the reason AC13 exists at all.
//
// `printMcpHelp` writes to the console, so the test captures it. That is
// worth doing rather than skipping: help text IS the feature for a
// discovery surface, and this one was wrong for two releases.

import { afterEach, describe, expect, test } from "bun:test";
import { printMcpHelp } from "./mcp";

const realLog = console.log;
afterEach(() => {
  console.log = realLog;
});

function captureHelp(): string {
  const lines: string[] = [];
  console.log = (...args: unknown[]): void => {
    lines.push(args.map((a) => String(a)).join(" "));
  };
  printMcpHelp();
  return lines.join("\n");
}

describe("keryx mcp --help leads with the consumer surface", () => {
  const help = captureHelp();

  test("it names every consumer subcommand that exists", () => {
    // From MCP_CONSUMER_SUBCOMMANDS. A subcommand that works and is not
    // documented here is one an operator cannot find.
    for (const sub of ["list", "add", "remove", "enable", "disable", "trust", "untrust", "doctor"]) {
      expect({ sub, documented: help.includes(`keryx mcp ${sub}`) || help.includes(`|${sub}`) }).toEqual({
        sub,
        documented: true,
      });
    }
  });

  test("the title says what the verb means, not that it is retired", () => {
    expect(help).toContain("the MCP servers keryx connects to");
    // BOUNDARY — the publisher spellings are still documented, further
    // down and under their own heading. Dropping them would break the
    // promise that every `keryx mcp …` invocation still works.
    expect(help).toContain("serve-mcp");
    expect(help).toContain("integrate");
  });

  test("and it points at the in-session equivalents, both of them", () => {
    // The distinction is the whole reason there are two commands.
    expect(help).toContain("/mcp");
    expect(help).toContain("/integrations");
  });
});
