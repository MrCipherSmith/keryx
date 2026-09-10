// Invariants over the MODULE, not over reported reproductions.
//
// The third structural test, and the one that generalises furthest. Four
// rounds of review produced the same shape of defect every time: a fix
// correct at the site it was given and wrong one step to the side. The
// clearest instance —
//
//   the BOM-tolerant parse was added to `parseConfigFile`, then to
//   `readOverlay` and `readForWrite` when a verifier pointed at them, and
//   `setServerEnabled` — a WRITE path in a file that already imports
//   `parseJsonTolerant` for a different function — was still calling bare
//   `JSON.parse`. A BOM'd overlay therefore fell into its catch, reset the
//   map to `{}`, wrote it back, and reported success. Every other override
//   the operator had set was destroyed.
//
// Enumerating readers one report at a time cannot close that. Asserting
// that NO call site anywhere in the module uses the unsafe form can.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classTableProblems } from "./class-table";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function productionFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".ts") && !e.name.endsWith(".test.ts"))
    .map((e) => path.join(dir, e.name));
}

/**
 * Source with comments and string/template literals blanked, one character
 * at a time.
 *
 * A regex stripper was tried and audited: `"/*"` inside a string opened a
 * comment that swallowed the next violation, and `"a//b"` deleted the rest
 * of its line.
 */
function code(source: string, keepStrings = false): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === "//") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (two === "/*") {
      i += 2;
      while (i < source.length && source.slice(i, i + 2) !== "*/") i++;
      i += 2;
      continue;
    }
    const ch = source[i] as string;
    if (ch === '"' || ch === "'" || ch === "`") {
      const start = i;
      const quote = ch;
      i++;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === "\\") i++;
        i++;
      }
      i++;
      // For the signal checks the string CONTENTS are the evidence — a
      // blanked `"SIGINT"` cannot be matched — so they are kept there and
      // dropped everywhere else.
      out += keepStrings ? source.slice(start, i) : " ";
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

describe("every reader and writer of these files parses JSON the same way", () => {
  test("no production file in src/mcp-servers/ calls bare JSON.parse", () => {
    // `parseJsonTolerant` exists precisely so a BOM is not a syntax error
    // the operator made. A second parser is a second answer about the same
    // file, and that is what shipped: `list` read a BOM'd config that `add`
    // refused, and `disable` reported success while destroying the
    // operator's other overrides.
    const offenders: string[] = [];
    for (const file of productionFiles(HERE)) {
      let body = code(readFileSync(file, "utf8"));
      // The ONE legitimate call: the body of `parseJsonTolerant` itself,
      // which is what every other site is required to use instead.
      body = body.replace(/export function parseJsonTolerant[\s\S]*?\n\}/, "");
      if (/\bJSON\s*\.\s*parse\s*\(/.test(body)) {
        offenders.push(path.basename(file));
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the tolerant parser is actually used, so the rule above is not vacuous", () => {
    // A module that parsed no JSON at all would pass the assertion above.
    const users = productionFiles(HERE).filter((file) =>
      code(readFileSync(file, "utf8")).includes("parseJsonTolerant"),
    );
    expect(users.length).toBeGreaterThanOrEqual(3);
  });

  test("and it really does tolerate a BOM — the rule points at something that works", () => {
    const { parseJsonTolerant } = require("./config") as typeof import("./config");
    expect(parseJsonTolerant('﻿{"a":1}')).toEqual({ a: 1 });
    expect(() => parseJsonTolerant("{ not json")).toThrow();
  });
});

describe("every signal handler survives the signal arriving twice", () => {
  test("no production file registers a teardown handler with process.once", () => {
    // `doctor` used `once`, so a SECOND Ctrl-C took Node's default
    // disposition and killed the parent mid-teardown, orphaning the child.
    // Two seconds of apparent silence is exactly when someone presses it
    // again. `shell.ts` already used `on` for the same scenario.
    const offenders: string[] = [];
    for (const file of [
      ...productionFiles(HERE),
      path.join(HERE, "..", "commands", "mcp-servers.ts"),
      path.join(HERE, "..", "commands", "shell.ts"),
    ]) {
      const body = code(readFileSync(file, "utf8"), true);
      if (/process\s*\.\s*once\s*\(\s*["']SIG/.test(body)) offenders.push(path.basename(file));
    }
    expect(offenders).toEqual([]);
  });

  test("the handlers that exist are registered with process.on", () => {
    // Non-vacuity for the rule above: a module with no handlers would pass
    // it, and the point is that these two HAVE handlers and register them
    // the durable way.
    for (const file of ["../commands/mcp-servers.ts", "../commands/shell.ts"]) {
      const body = code(readFileSync(path.join(HERE, file), "utf8"), true);
      expect({ file, on: /process\s*\.\s*on\s*\(\s*["']SIG/.test(body) }).toEqual({ file, on: true });
    }
  });

  test("a repeated signal is idempotent, not a second teardown", () => {
    // The guard that makes `on` safe: without it the second signal starts
    // another abort-and-exit race against the first.
    const body = code(readFileSync(path.join(HERE, "..", "commands", "mcp-servers.ts"), "utf8"));
    expect(body).toContain("if (exiting) return;");
  });
});

describe("P1 additions obey the same module rules", () => {
  test("no unbounded wait was introduced on the HTTP path", () => {
    // `connectHttpMcpServer` takes a handshake budget for the same reason
    // the stdio one does: a server that accepts a socket and never answers
    // must not hold a session open. Asserted structurally because the
    // behavioural proof needs a listener, and lives in `http.live.test.ts`.
    const client = code(readFileSync(path.join(HERE, "..", "mcp-client", "client.ts"), "utf8"));
    const start = client.indexOf("export async function connectHttpMcpServer");
    expect(start).toBeGreaterThanOrEqual(0);
    const body = client.slice(start, client.indexOf("\n}", start));
    expect(body).toContain("withHandshakeTimeout");
    expect(body).toContain("signal");
  });

  test("the HTTP path refuses an empty header value in its own right", () => {
    // A rule enforced in one place is a rule with one bug between it and
    // failure. `http-headers.ts` produces the actionable message; the
    // transport refuses independently so a caller that builds headers by
    // hand cannot route around it.
    // `keepStrings`, because the refusal IS a string literal and the
    // default stripper blanks it.
    const client = code(readFileSync(path.join(HERE, "..", "mcp-client", "client.ts"), "utf8"), true);
    expect(client).toContain("refusing to send an empty");
  });

  test("header resolution is covered by a CLASS table, like the environment filter", () => {
    // AC10. This asserted the STRING `"every class carries a BOUNDARY"`
    // appeared in the file — the P0 pattern verbatim, correct at the site
    // it was given: renaming the test satisfied it, and gutting the
    // assertion inside the test did not break it. It was also true at the
    // moment it was written of a table whose boundary check was a
    // tautology.
    //
    // What can be checked cheaply from here is WIRING: that the table
    // hands its rows to the shared rule rather than re-deriving one. The
    // rule itself is enforced when the table runs, and proven to have
    // teeth by "the shared class-table rule bites" below.
    const table = readFileSync(path.join(HERE, "http-headers.table.test.ts"), "utf8");
    expect(table).toContain("classTableProblems");
  });

  test("the HTTP handshake is proved against a real listener, not a stub", () => {
    const live = readFileSync(path.join(HERE, "http.live.test.ts"), "utf8");
    expect(live).toContain("startMockHttpMcpServer");
    // And the mock records what it RECEIVED, which is the half that makes
    // a header assertion mean anything.
    expect(live).toContain("server.requests()");
  });
});

describe("the class-based tests exist and are load-bearing", () => {
  test("spawn-env is covered by a class table, not a list of reported names", () => {
    // Recorded as an invariant because the lesson was learned three times:
    // a filter tested by the names in the last report cannot fail on the
    // names in the next one.
    const table = readFileSync(path.join(HERE, "spawn-env.table.test.ts"), "utf8");
    expect(table).toContain("klass");
    expect(table).toContain("classTableProblems");
  });

  test("the shared class-table rule BITES — it is not a function returning []", () => {
    // The point of the two assertions above is that both tables submit to
    // one rule. That is worth nothing if the rule accepts everything, and
    // the two hand-written versions it replaced did very nearly that: one
    // read `refused > 0 || allowed > 0`, true of any non-empty class; the
    // other read `kept > 0`, which passes a class that is entirely kept.
    //
    // So: give it tables that violate each rule and require it to say so.
    // This is the assertion a string match cannot make.
    const outcome = (row: { ok: boolean }): string => (row.ok ? "allowed" : "refused");
    const ok = { ok: true };
    const no = { ok: false };

    // A class with only one outcome — the tautology, caught.
    expect(
      classTableProblems([{ klass: "all-allowed", rows: [ok, ok, ok] }], outcome),
    ).toEqual(["all-allowed: every row comes out \"allowed\" — no BOUNDARY, so the rule could be a constant"]);
    expect(classTableProblems([{ klass: "all-refused", rows: [no, no, no] }], outcome)).toHaveLength(1);

    // A class too small to be a class.
    expect(classTableProblems([{ klass: "thin", rows: [ok, no] }], outcome)).toEqual([
      "thin: 2 row(s), fewer than the 3 a class needs",
    ]);

    // Both at once are both reported, rather than the first stopping the
    // check — an operator fixing one problem per run is the pattern this
    // package keeps producing.
    expect(classTableProblems([{ klass: "both", rows: [ok] }], outcome)).toHaveLength(2);

    // An empty table is not a passing table.
    expect(classTableProblems([], outcome)).toHaveLength(1);

    // Two classes with one name are one class with a spelling mistake.
    expect(
      classTableProblems(
        [
          { klass: "same", rows: [ok, no, ok] },
          { klass: "same", rows: [ok, no, no] },
        ],
        outcome,
      ),
    ).toHaveLength(1);

    // BOUNDARY — a table that satisfies every rule passes clean. Without
    // this, `classTableProblems = () => ["problem"]` passes everything
    // above.
    expect(classTableProblems([{ klass: "good", rows: [ok, no, ok] }], outcome)).toEqual([]);
  });

  test("readOverlay is covered per STATE, not only on its success path", () => {
    const states = readFileSync(path.join(HERE, "config.overlay-states.test.ts"), "utf8");
    expect(states).toContain("absent");
    expect(states).toContain("unreadable");
  });
});
