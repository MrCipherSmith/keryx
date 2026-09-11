// The approval renderer, as a TABLE — one row per case, organised by CLASS.
//
// AC10. The unit is the class, every class carries members nobody
// reported plus its BOUNDARY, and the shape is checked by the shared
// `classTableProblems` rule rather than by a hand-written meta-assertion —
// because in P1 the hand-written one read `refused > 0 || allowed > 0`
// and asserted nothing at all.
//
// What the classes are FOR, in one line each: the operator must always be
// able to see which server, which tool, and what arguments; and nothing
// the model writes may push any of those three out of view or draw on the
// terminal.

import { describe, expect, test } from "bun:test";
import { classTableProblems } from "./class-table";
import {
  describeUseToolApproval,
  MAX_ARGUMENT_CHARS,
  renderUseToolApprovalLines,
  splitFqn,
  summariseUseToolApproval,
} from "./approval-render";

type Row = {
  readonly label: string;
  /** Raw tool input, as the agent loop hands it over. */
  readonly input: string;
  /** Substrings the rendering MUST contain, wherever they land. */
  readonly shows: readonly string[];
  /** Substrings that must NOT appear anywhere in the rendering. */
  readonly hides?: readonly string[];
  /**
   * What this row comes out as, ON THIS CLASS'S OWN AXIS.
   *
   * Not one global vocabulary. The first version used "named"/"unnamed"
   * for all three classes, and the shape rule immediately failed two of
   * them — correctly: identifiability is what class one decides, and the
   * other two decide whether a payload is elided and whether text is
   * neutralised. A class whose rows all come out the same way has no
   * boundary, and forcing an axis that does not belong to it manufactures
   * exactly that.
   */
  readonly outcome: string;
};

function call(toolName: unknown, toolInput: unknown): string {
  return JSON.stringify({ tool_name: toolName, tool_input: toolInput });
}

/** Everything the renderer would put on screen, as one string. */
function rendered(input: string): string {
  const d = describeUseToolApproval(input);
  return [d.title, d.server, d.tool, d.fqn, summariseUseToolApproval(d), ...d.argumentLines].join("\n");
}

const TABLE: Array<{ klass: string; why: string; rows: Row[] }> = [
  {
    klass: "the server and the tool are always identifiable",
    why: "the operator is deciding whether to let a THIRD PARTY act; a prompt that does not say which one is not a decision",
    rows: [
      {
        label: "a qualified name splits into server and tool",
        input: call("linear__create_issue", { title: "x" }),
        shows: ["linear", "create_issue"],
        outcome: "named",
      },
      {
        label: "a tool name containing the separator keeps the REST as the tool",
        // `a__b__c` is tool `b__c` on server `a`. Splitting on the last
        // separator instead would attribute the call to the wrong server.
        input: call("gh__repo__create", {}),
        shows: ["gh", "repo__create"],
        outcome: "named",
      },
      {
        label: "an unqualified name is reported as unknown, not guessed",
        input: call("bare_tool", {}),
        shows: ["(unknown)", "bare_tool"],
        outcome: "named",
      },
      {
        label: "BOUNDARY — a leading separator does not make an empty server name",
        input: call("__weird", {}),
        shows: ["(unknown)"],
        outcome: "named",
      },
      {
        label: "BOUNDARY — a missing tool_name still produces a prompt",
        // Refusing to render would mean refusing to ask, and an approval
        // prompt that fails to draw is an approval that silently does not
        // happen.
        input: call(undefined, { a: 1 }),
        shows: ["(unnamed)"],
        outcome: "unnamed",
      },
      {
        label: "BOUNDARY — unparseable input still produces a prompt",
        input: "{not json",
        shows: ["(unnamed)"],
        outcome: "unnamed",
      },
      {
        // Found by the mutation sweep. `typeof value === "object" &&
        // value !== null` inverted to `||` is TRUE for JSON `null`
        // (because `typeof null === "object"`), so `parsed` becomes null
        // and reading `parsed.tool_name` throws — an approval prompt
        // that crashes instead of asking. No row covered bare `null`.
        label: "BOUNDARY — a payload that is literally `null` still produces a prompt",
        input: "null",
        shows: ["(unnamed)"],
        outcome: "unnamed",
      },
      {
        label: "BOUNDARY — so does a payload that is a bare number",
        input: "42",
        shows: ["(unnamed)"],
        outcome: "unnamed",
      },
    ],
  },
  {
    klass: "no key order can hide the tool or its arguments",
    why: "F-033 exactly: `use_tool`'s schema does not constrain key order, and the old renderer truncated the whole payload at 117 characters",
    rows: [
      {
        label: "a long reassuring first key does not push the tool name out of view",
        input: call("db__drop_table", {
          reason: "This is a routine, fully reversible maintenance operation approved by the team ".repeat(3),
          table: "customers",
        }),
        shows: ["db", "drop_table", "customers"],
        outcome: "whole",
      },
      {
        label: "and the destructive argument survives however late it appears",
        input: call("shell__run", {
          note: "x".repeat(400),
          summary: "y".repeat(400),
          command: "rm -rf /important",
        }),
        shows: ["rm -rf /important"],
        outcome: "whole",
      },
      {
        label: "arguments beyond the cap are elided, and the flag says so",
        input: call("a__b", { blob: "z".repeat(MAX_ARGUMENT_CHARS + 500) }),
        shows: ["a", "b"],
        outcome: "elided",
      },
      {
        label: "BOUNDARY — a call with no arguments renders an empty object, not an error",
        input: call("a__b", {}),
        shows: ["a", "b", "{}"],
        outcome: "whole",
      },
      {
        label: "BOUNDARY — tool_input of the wrong TYPE is treated as no arguments",
        input: call("a__b", "not an object"),
        shows: ["a", "b"],
        outcome: "whole",
      },
      {
        // The sibling of the `null` payload row above, and the same
        // mutant one line down: with `||`, `tool_input: null` passes the
        // guard and the prompt renders the word "null" where the
        // arguments should be.
        label: "BOUNDARY — tool_input of `null` renders an empty object, not the word null",
        input: call("a__b", null),
        shows: ["a", "b", "{}"],
        hides: ["null"],
        outcome: "whole",
      },
    ],
  },
  {
    klass: "the model cannot draw on the terminal through this prompt",
    why: "every field here is third-party text on its way to a screen, and the prompt it would deface is the one guarding the call",
    rows: [
      {
        label: "an escape sequence in an argument is neutralised",
        input: call("a__b", { note: "[2K\r[32m✓ auto-approved" }),
        shows: ["auto-approved"],
        hides: ["", "\r"],
        outcome: "neutralised",
      },
      {
        label: "and one in the TOOL NAME is too",
        input: call("evil[2K__tool\r", {}),
        shows: ["tool"],
        hides: ["", "\r"],
        outcome: "neutralised",
      },
      {
        label: "a bare carriage return cannot redraw the line naming the tool",
        // The line above the arguments is the one that says what is being
        // called. A lone `\r` returns the cursor to column 0 and is most
        // of the forgery on its own.
        input: call("a__b", { x: "harmless\rmalicious" }),
        shows: ["harmless", "malicious"],
        hides: ["\r"],
        outcome: "neutralised",
      },
      {
        label: "BOUNDARY — a newline inside an argument is KEPT, because JSON is multi-line",
        input: call("a__b", { text: "line one\nline two" }),
        shows: ["line one", "line two"],
        outcome: "preserved",
      },
      {
        label: "BOUNDARY — ordinary punctuation is not mangled",
        input: call("a__b", { path: "/usr/bin/env", flags: "--x=1 --y=2" }),
        shows: ["/usr/bin/env", "--x=1 --y=2"],
        outcome: "preserved",
      },
    ],
  },
];

describe("the MCP approval rendering, by CLASS", () => {
  for (const { klass, why, rows } of TABLE) {
    describe(`${klass} — ${why}`, () => {
      for (const row of rows) {
        test(row.label, () => {
          const text = rendered(row.input);
          for (const needle of row.shows) {
            expect({ label: row.label, needle, present: text.includes(needle) }).toEqual({
              label: row.label,
              needle,
              present: true,
            });
          }
          for (const needle of row.hides ?? []) {
            expect({ label: row.label, needle: JSON.stringify(needle), absent: !text.includes(needle) }).toEqual({
              label: row.label,
              needle: JSON.stringify(needle),
              absent: true,
            });
          }
        });
      }
    });
  }

  test("every class has three rows and a BOUNDARY", () => {
    expect(classTableProblems(TABLE, (row) => row.outcome)).toEqual([]);
  });
});

describe("an MCP call is never rememberable", () => {
  // F-032. The grant pattern would be a qualified tool name the MODEL
  // supplied, written into the operator's permission file. The field is
  // typed `false` so a caller cannot offer the option by forgetting to
  // check, and asserted here so it cannot be widened later without a
  // test going red.
  test("the description says so, for every shape of call", () => {
    for (const { rows } of TABLE) {
      for (const row of rows) {
        expect(describeUseToolApproval(row.input).rememberable).toBe(false);
      }
    }
  });
});

describe("the printed lines, not just the description", () => {
  // Found by the mutation sweep. With the prompt inlined in `shell.ts`,
  // inverting `if (meta?.destructive === true)` survived — nothing in
  // the suite drives the readline approval path, because every test
  // stubs `requestApproval` wholesale. The same is quietly true of the
  // `apply_patch` and elicitation branches beside it; this one is now
  // the exception rather than another instance.

  const described = describeUseToolApproval(
    JSON.stringify({ tool_name: "linear__create_issue", tool_input: { title: "x" } }),
  );

  test("the tool and server come BEFORE any argument line", () => {
    const lines = renderUseToolApprovalLines(described);
    const server = lines.findIndex((l) => l.includes("server:"));
    const tool = lines.findIndex((l) => l.includes("tool:"));
    const firstArg = lines.findIndex((l) => l.includes("title"));
    expect(server).toBeGreaterThanOrEqual(0);
    expect(tool).toBeGreaterThan(server);
    expect(firstArg).toBeGreaterThan(tool);
  });

  test("a destructive call says so", () => {
    expect(renderUseToolApprovalLines(described, { destructive: true }).join("\n")).toContain("destructive");
  });

  test("BOUNDARY — a non-destructive one does NOT", () => {
    // The mutant that survived. Without this row, inverting the check
    // adds the warning to every call and nothing notices — which is
    // worse than it sounds: a warning on everything is a warning on
    // nothing.
    expect(renderUseToolApprovalLines(described, { destructive: false }).join("\n")).not.toContain("destructive");
    expect(renderUseToolApprovalLines(described).join("\n")).not.toContain("destructive");
  });

  test("truncation is announced when it happens, and not when it does not", () => {
    const big = describeUseToolApproval(
      JSON.stringify({ tool_name: "a__b", tool_input: { blob: "z".repeat(MAX_ARGUMENT_CHARS + 100) } }),
    );
    expect(renderUseToolApprovalLines(big).join("\n")).toContain("truncated");
    expect(renderUseToolApprovalLines(described).join("\n")).not.toContain("truncated");
  });
});

describe("splitFqn", () => {
  test("splits on the FIRST separator", () => {
    expect(splitFqn("a__b__c")).toEqual({ server: "a", tool: "b__c" });
  });

  test("reports an unqualified name rather than inventing a server", () => {
    expect(splitFqn("plain")).toEqual({ server: "(unknown)", tool: "plain" });
    expect(splitFqn("__lead")).toEqual({ server: "(unknown)", tool: "__lead" });
  });

  test("BOUNDARY — a normal two-part name is not treated as unqualified", () => {
    expect(splitFqn("linear__search")).toEqual({ server: "linear", tool: "search" });
  });
});

describe("the one-line summary", () => {
  test("names the tool and the server and nothing the model supplied", () => {
    const d = describeUseToolApproval(
      call("linear__create_issue", { reason: "totally safe", title: "x".repeat(300) }),
    );
    const line = summariseUseToolApproval(d);
    expect(line).toBe("create_issue on linear");
    // The whole point: no payload prefix can occupy this line.
    expect(line).not.toContain("totally safe");
    expect(line).not.toContain("xxx");
  });
});
