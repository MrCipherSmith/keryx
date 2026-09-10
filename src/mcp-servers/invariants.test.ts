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

describe("the class-based tests exist and are load-bearing", () => {
  test("spawn-env is covered by a class table, not a list of reported names", () => {
    // Recorded as an invariant because the lesson was learned three times:
    // a filter tested by the names in the last report cannot fail on the
    // names in the next one.
    const table = readFileSync(path.join(HERE, "spawn-env.table.test.ts"), "utf8");
    expect(table).toContain("klass");
    expect(table).toContain("every class carries a BOUNDARY");
  });

  test("readOverlay is covered per STATE, not only on its success path", () => {
    const states = readFileSync(path.join(HERE, "config.overlay-states.test.ts"), "utf8");
    expect(states).toContain("absent");
    expect(states).toContain("unreadable");
  });
});
