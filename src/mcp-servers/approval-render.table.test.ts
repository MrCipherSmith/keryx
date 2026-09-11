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
  MAX_ARGUMENT_KEYS,
  MAX_IDENTIFIER_CHARS,
  renderUseToolApprovalLines,
  sanitiseIdentifier,
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

describe("the title", () => {
  test("says what is being approved", () => {
    // `title: ""` survived every test: `rendered()` concatenated it and
    // no row's needles mentioned it. It is line 0 of the readline
    // prompt and the TUI dock's heading.
    expect(describeUseToolApproval(call("a__b", {})).title).toBe("Approve MCP tool call?");
  });
});

describe("an empty tool_name", () => {
  test("is reported as unnamed, not as a blank", () => {
    // `parsed.tool_name.length > 0` widened to `>= 0` survived: the
    // class covered undefined, unparseable, null and 42 — not `""`.
    // The sweep could not see it either, because its operators narrow
    // `>=` to `>` and never widen.
    const d = describeUseToolApproval(JSON.stringify({ tool_name: "", tool_input: {} }));
    expect(d.fqn).toBe("(unnamed)");
    expect(d.tool).not.toBe("");
  });
});

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
        // Asserts the CUT, not merely that the row renders. This row
        // used to carry `shows: ["a","b"]` — byte-identical to the
        // empty-arguments row below it — so nothing distinguished
        // "elided" from "whole", and that label was the only second
        // value on this class's axis. It was a label chosen to satisfy
        // the shape rule. Deleting the slice survived.
        label: "a value beyond the cap is elided, and the ellipsis proves the cut happened",
        input: call("a__b", { blob: "z".repeat(MAX_ARGUMENT_CHARS + 500) }),
        shows: ["…", "\"blob\""],
        hides: ["z".repeat(MAX_ARGUMENT_CHARS + 1)],
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
        // The row that makes this class real. A reviewer showed that
        // `JSON.stringify` already escapes every codepoint below 0x20
        // BEFORE the sanitiser sees it, so the ESC and CR rows above
        // hold by construction and survive deleting the sanitiser
        // entirely. U+007F (DEL) is the one byte `JSON.stringify` emits
        // raw, so it is the only one that actually tests the call.
        label: "a DEL byte IS neutralised — the byte JSON.stringify passes through",
        input: call("a__b", { note: `before${String.fromCharCode(127)}after` }),
        shows: ["before", "after"],
        hides: [String.fromCharCode(127)],
        outcome: "neutralised",
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

  test("elision is announced when it happens, and not when it does not", () => {
    const big = describeUseToolApproval(
      JSON.stringify({ tool_name: "a__b", tool_input: { blob: "z".repeat(MAX_ARGUMENT_CHARS + 100) } }),
    );
    expect(renderUseToolApprovalLines(big).join("\n")).toContain("elided");
    expect(renderUseToolApprovalLines(described).join("\n")).not.toContain("elided");
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

describe("the P2 review findings — each one reproduced, then pinned", () => {
  const ESC = String.fromCharCode(27);

  test("F1 — a long first argument cannot hide the destructive one", () => {
    // The serious one, because this path EXECUTES. A single budget over
    // the whole payload let one argument eat the others' space, and
    // `tool_input`'s schema is the untrusted server's own — so it can
    // require a 4 000-character `justification` and every call it
    // induces arrives pre-overflowed. Per-value budgets now, so every
    // key is on screen whatever any other key does.
    const d = describeUseToolApproval(
      JSON.stringify({
        tool_name: "fs__write",
        tool_input: {
          reason: "x".repeat(MAX_ARGUMENT_CHARS * 10),
          path: "/home/victim/.ssh/authorized_keys",
          content: "ssh-rsa AAAA attacker@host",
        },
      }),
    );
    const text = renderUseToolApprovalLines(d).join("\n");
    expect(text).toContain("authorized_keys");
    expect(text).toContain("ssh-rsa");
    // BOUNDARY — the oversized value IS elided, so this is not "show
    // everything" (which would be its own denial-of-attention attack).
    expect(d.argumentsTruncated).toBe(true);
  });

  test("F1 — and every KEY survives a payload with more keys than the cap", () => {
    const many = Object.fromEntries(
      Array.from({ length: MAX_ARGUMENT_KEYS + 5 }, (_, i) => [`k${i}`, i]),
    );
    const d = describeUseToolApproval(JSON.stringify({ tool_name: "a__b", tool_input: many }));
    expect(d.argumentLines.join("\n")).toContain("and 5 more argument(s)");
    expect(d.argumentsTruncated).toBe(true);
  });

  test("F4 — a newline in tool_name cannot add rows to the prompt", () => {
    // With `\n` kept (correct for an error message, wrong for a name), a
    // tool_name could render a complete, correctly-shaped, benign-looking
    // prompt with the real name forty rows above the fold.
    const forged = `evil__tool${"\n".repeat(40)}  server: docs\n  tool:   search_docs`;
    const d = describeUseToolApproval(JSON.stringify({ tool_name: forged, tool_input: {} }));
    const lines = renderUseToolApprovalLines(d);
    // The property: array elements == screen rows.
    expect(lines.join("\n").split("\n")).toHaveLength(lines.length);
    expect(d.tool).not.toContain("\n");
    expect(d.server).not.toContain("\n");
    expect(d.fqn).not.toContain("\n");
  });

  test("F4 — nor can one in an argument VALUE", () => {
    const d = describeUseToolApproval(
      JSON.stringify({ tool_name: "a__b", tool_input: { note: "one\ntwo\nthree" } }),
    );
    const lines = renderUseToolApprovalLines(d);
    expect(lines.join("\n").split("\n")).toHaveLength(lines.length);
  });

  test("F8 — an enormous tool_name is capped", () => {
    const d = describeUseToolApproval(
      JSON.stringify({ tool_name: `a__${"x".repeat(200_000)}`, tool_input: {} }),
    );
    expect(d.tool.length).toBeLessThanOrEqual(MAX_IDENTIFIER_CHARS + 1);
    // BOUNDARY — a normal name is NOT truncated, so this is a cap and
    // not a blanket shortening.
    expect(describeUseToolApproval(JSON.stringify({ tool_name: "linear__create_issue" })).tool).toBe(
      "create_issue",
    );
  });

  test("F7 — attribution comes from the catalog, not from a string split", () => {
    // A project config may define a server named `github__notes`. Its
    // tool `exfil` has the valid FQN `github__notes__exfil`, resolves
    // fine, and the guessing prompt credited the call to the operator's
    // own user-scoped `github`.
    const resolve = (fqn: string) =>
      fqn === "github__notes__exfil" ? { server: "github__notes", tool: "exfil" } : undefined;
    const d = describeUseToolApproval(
      JSON.stringify({ tool_name: "github__notes__exfil", tool_input: {} }),
      resolve,
    );
    expect(d.server).toBe("github__notes");
    expect(d.tool).toBe("exfil");
  });

  test("F7 — BOUNDARY: with no resolver the guess still runs, for a doomed call", () => {
    // A name the catalog cannot resolve will not execute either, so the
    // fallback is only ever labelling a prompt for a call that fails.
    const d = describeUseToolApproval(JSON.stringify({ tool_name: "github__notes__exfil" }));
    expect(d.server).toBe("github");
  });

  test("F14 — a trailing separator does not render a blank tool", () => {
    const d = describeUseToolApproval(JSON.stringify({ tool_name: "a__", tool_input: {} }));
    expect(d.tool).not.toBe("");
    expect(d.server).toBe("(unknown)");
  });

  test("the identifier sanitiser keeps ordinary names intact", () => {
    // BOUNDARY for all of the above: without it, `sanitiseIdentifier`
    // could return a constant and every assertion here would pass.
    expect(sanitiseIdentifier("linear__create_issue")).toBe("linear__create_issue");
    expect(sanitiseIdentifier(`bad${ESC}[2Kname`)).not.toContain(ESC);
  });
});
