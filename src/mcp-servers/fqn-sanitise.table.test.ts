// D-13: a tool name the FQN pattern rejects is RENAMED, not dropped.
//
// Resolved 2026-09-11 by the operator, asked with options and a
// recommendation. The evidence that forced the question: P0 pointed
// `keryx mcp doctor` at keryx's own `keryx serve-mcp` — the one server
// whose tool list this repository controls — and got 19 reachable, 26
// skipped. Every skip was a `.` in the name. More than half a server's
// surface disappeared and the server was ours.
//
// Worth recording why nobody noticed for two phases: the catalog tests
// covered a too-long name, an unusable SERVER name and a duplicate, and
// never a dotted tool name. The behaviour that lost 26 tools was the one
// case no test pinned — the same shape as every other defect in this
// package.

import { describe, expect, test } from "bun:test";
import { classTableProblems } from "./class-table";
import { catalogForServer, sanitiseRawName } from "./catalog";
import type { McpToolDescriptor } from "../mcp-client/client";

function tool(name: string): McpToolDescriptor {
  return { name, description: `${name} does something`, inputSchema: {} } as McpToolDescriptor;
}

type Row = {
  readonly label: string;
  readonly server: string;
  readonly tools: readonly string[];
  /** FQNs the model should see, in order. */
  readonly fqns: readonly string[];
  /** Raw names that must survive on the entries, aligned with `fqns`. */
  readonly rawNames?: readonly string[];
  /** A fragment of the skip reason, when something is skipped. */
  readonly skipReason?: string;
  readonly outcome: string;
};

const TABLE: Array<{ klass: string; why: string; rows: Row[] }> = [
  {
    klass: "a name the pattern rejects is renamed rather than dropped",
    why: "the reason D-13 exists: 26 of keryx's own 45 tools were unreachable, all for a `.`",
    rows: [
      {
        label: "a dotted name — the exact case that lost 26 tools",
        server: "self",
        tools: ["sac.read"],
        fqns: ["self__sac_read"],
        rawNames: ["sac.read"],
        outcome: "renamed",
      },
      {
        label: "several dots",
        server: "self",
        tools: ["a.b.c"],
        fqns: ["self__a_b_c"],
        rawNames: ["a.b.c"],
        outcome: "renamed",
      },
      {
        label: "other punctuation the pattern forbids",
        server: "s",
        tools: ["do/thing", "with space", "at@sign"],
        fqns: ["s__do_thing", "s__with_space", "s__at_sign"],
        rawNames: ["do/thing", "with space", "at@sign"],
        outcome: "renamed",
      },
      {
        label: "BOUNDARY — a name that is ALREADY valid is left exactly alone",
        // Without this, `sanitiseRawName` could rewrite every name and
        // every row above would still pass.
        server: "linear",
        tools: ["create_issue", "search-v2"],
        fqns: ["linear__create_issue", "linear__search-v2"],
        rawNames: ["create_issue", "search-v2"],
        outcome: "untouched",
      },
      {
        label: "BOUNDARY — a name too long to fix is still SKIPPED",
        // Renaming cannot shorten it, so this really is a skip, and the
        // reason says so rather than blaming the character set.
        server: "s",
        tools: ["x".repeat(70)],
        fqns: [],
        skipReason: "characters; the limit is 64",
        outcome: "skipped",
      },
      {
        label: "BOUNDARY — an unusable SERVER name is still skipped, not renamed",
        // Sanitising the tool cannot fix the server, and silently
        // renaming somebody's server would change what `use_tool` is
        // told to call.
        server: "9bad",
        tools: ["read"],
        fqns: [],
        skipReason: "^[a-zA-Z_]",
        outcome: "skipped",
      },
    ],
  },
  {
    klass: "collisions sanitising creates are resolved first-wins, out loud",
    why: "`a.b` and `a_b` both become `a_b`; the old pattern could not produce this, so the rule is new and has to be stated",
    rows: [
      {
        label: "the dotted one first: it wins, the underscore one is skipped",
        server: "s",
        tools: ["a.b", "a_b"],
        fqns: ["s__a_b"],
        rawNames: ["a.b"],
        skipReason: 'already taken by "a.b"',
        outcome: "collided",
      },
      {
        label: "the underscore one first: the order reverses the winner",
        // Order-dependent BY DESIGN — `tools/list` order is the server's
        // own and is stable — so both directions are pinned. If this
        // ever becomes order-independent, one of these two fails.
        server: "s",
        tools: ["a_b", "a.b"],
        fqns: ["s__a_b"],
        rawNames: ["a_b"],
        skipReason: 'already taken by "a_b"',
        outcome: "collided",
      },
      {
        label: "the skip names the WINNER, so the operator knows which one answers",
        server: "s",
        tools: ["x.y", "x_y"],
        fqns: ["s__x_y"],
        rawNames: ["x.y"],
        skipReason: 'already taken by "x.y"',
        outcome: "collided",
      },
      {
        label: "BOUNDARY — two genuinely identical raw names keep the old message",
        // This collision predates sanitising and is a different fact: no
        // renaming was involved, so blaming one would be misleading.
        server: "s",
        tools: ["read", "read"],
        fqns: ["s__read"],
        skipReason: "duplicate qualified name",
        outcome: "collided",
      },
      {
        label: "BOUNDARY — names that sanitise to DIFFERENT things do not collide",
        server: "s",
        tools: ["a.b", "a.c"],
        fqns: ["s__a_b", "s__a_c"],
        rawNames: ["a.b", "a.c"],
        outcome: "renamed",
      },
    ],
  },
];

describe("FQN sanitisation, by CLASS", () => {
  for (const { klass, why, rows } of TABLE) {
    describe(`${klass} — ${why}`, () => {
      for (const row of rows) {
        test(row.label, () => {
          const { entries, skipped } = catalogForServer(row.server, row.tools.map(tool));

          expect({ label: row.label, fqns: entries.map((e) => e.fqn) }).toEqual({
            label: row.label,
            fqns: [...row.fqns],
          });
          if (row.rawNames !== undefined) {
            // The half that makes sanitising safe: the WIRE name is
            // untouched, so `tools/call` still reaches the real tool.
            expect(entries.map((e) => e.rawName)).toEqual([...row.rawNames]);
          }
          if (row.skipReason === undefined) {
            expect({ label: row.label, skipped: skipped.length }).toEqual({ label: row.label, skipped: 0 });
          } else {
            expect(skipped.map((s) => s.reason).join(" | ")).toContain(row.skipReason);
          }
        });
      }
    });
  }

  test("every class has three rows and a BOUNDARY", () => {
    expect(classTableProblems(TABLE, (row) => row.outcome)).toEqual([]);
  });
});

describe("sanitiseRawName on its own", () => {
  test("maps each forbidden character to exactly one underscore", () => {
    // One-to-one on length, deliberately. Collapsing runs would make
    // `a..b` and `a.b` collide for no benefit.
    expect(sanitiseRawName("a..b")).toBe("a__b");
    expect(sanitiseRawName("a.b")).toBe("a_b");
    expect(sanitiseRawName("a..b")).not.toBe(sanitiseRawName("a.b"));
  });

  test("leaves everything the pattern already allows", () => {
    expect(sanitiseRawName("Abc_123-x")).toBe("Abc_123-x");
  });

  test("handles unicode without producing something unreadable", () => {
    expect(sanitiseRawName("café.read")).toBe("caf__read");
  });
});

describe("the measurement D-13 was raised on", () => {
  test("a keryx-shaped tool list is now fully reachable", () => {
    // The 26 names P0 recorded as skipped, in their real shape. The
    // point is the count: 0 skipped where P0 had 26.
    const names = [
      "sac.read", "sac.write", "sac.list", "gdgraph.find", "gdgraph.affected",
      "gdgraph.dependencies", "gdgraph.dependents", "wiki.ask", "wiki.index",
      "wiki.page", "health.gate", "health.run", "flow.status", "flow.next",
      "memory.recall", "memory.remember", "ctx.rg", "ctx.read", "ctx.run",
      "review.scope", "review.ingest", "skills.verify", "test.analyze",
      "workspace.list", "workspace.show", "security.scan",
    ];
    const { entries, skipped } = catalogForServer("self", names.map(tool));
    expect(entries).toHaveLength(names.length);
    expect(skipped).toEqual([]);
    // And every one still carries the name the server actually answers to.
    expect(entries.map((e) => e.rawName)).toEqual(names);
  });
});
