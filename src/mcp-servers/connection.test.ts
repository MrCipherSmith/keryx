// The generic stdio connection, and what it deliberately does not do.
//
// P0 item 2. The connection itself needs a subprocess, which is AC2's
// flag-gated live test; what is unit-testable is the decision inside
// `listTools` and the separation from the Codex specialist. Both are here,
// because both are things that could silently stop being true.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { toToolDescriptors } from "../mcp-client/client";

const CLIENT_SOURCE = readFileSync(
  path.join(import.meta.dir, "..", "mcp-client", "client.ts"),
  "utf8",
);

describe("tools/list normalization", () => {
  test("a well-formed tool survives with its description and schema", () => {
    expect(
      toToolDescriptors([
        { name: "read_file", description: "Read a file", inputSchema: { type: "object" } },
      ]),
    ).toEqual([{ name: "read_file", description: "Read a file", inputSchema: { type: "object" } }]);
  });

  test("a nameless entry is dropped, not carried with an undefined name", () => {
    // A catalog key that is not a string cannot be called. Keeping the entry
    // would put a row in the catalog and in `doctor` that fails when someone
    // uses it rather than when it was listed.
    expect(toToolDescriptors([{ description: "no name" }, { name: "", description: "empty" }])).toEqual([]);
  });

  test("one bad entry does not discard its good siblings", () => {
    const tools = toToolDescriptors([{ name: "good" }, null, "nonsense", { name: 7 }]);
    expect(tools.map((t) => t.name)).toEqual(["good"]);
  });

  test("a non-array result yields nothing rather than throwing", () => {
    // A server that answers `tools/list` with the wrong shape must leave the
    // session usable; AC8's partial-failure rule, one layer down.
    expect(toToolDescriptors(undefined)).toEqual([]);
    expect(toToolDescriptors({ tools: [] })).toEqual([]);
  });

  test("an array inputSchema is rejected — a schema is an object", () => {
    const [tool] = toToolDescriptors([{ name: "t", inputSchema: [] }]);
    expect(tool?.inputSchema).toBeUndefined();
  });

  test("a non-string description is dropped rather than coerced", () => {
    const [tool] = toToolDescriptors([{ name: "t", description: 42 }]);
    expect(tool?.description).toBeUndefined();
  });
});

/**
 * The body of a top-level `export function`, to its closing brace.
 *
 * The first version of these guards sliced a flat 2 000 characters from the
 * signature. The audit of PR #522 pushed a violation past that window with
 * thirty lines of filler and it survived — a guard that silently stops
 * covering the tail of the thing it guards. And in one test the `indexOf`
 * result was not checked, so a rename made `slice(-1, 1999)` return the
 * file's last character and the assertion passed over an empty body.
 *
 * Brace-matched instead, so the window is the function.
 */
function functionBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  if (start === -1) return "";
  const open = source.indexOf("{", start);
  if (open === -1) return "";
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return source.slice(start);
}

describe("the generic connection stays separate from the Codex specialist", () => {
  // These read the source, which is weaker than executing it — and this
  // repository spent today proving how much weaker. They are here because the
  // property is structural: the connection needs a live subprocess to drive,
  // and what must not change is which internals it reaches for. Each is a
  // claim the module header makes, so a claim that stops being true fails
  // rather than merely becoming wrong.

  const SIGNATURE = "export async function connectStdioMcpServer";

  test("the body this suite inspects is actually found", () => {
    // The precondition every assertion below depends on. Without it a
    // rename turns them all into claims about an empty string.
    const body = functionBody(CLIENT_SOURCE, SIGNATURE);
    expect(body.length).toBeGreaterThan(200);
    expect(body).toContain(SIGNATURE);
    // And it ends where the function does, rather than at a fixed offset.
    expect(body.endsWith("}")).toBe(true);
  });

  test("connectStdioMcpServer loads the core SDK, not the Protocol internals", () => {
    const body = functionBody(CLIENT_SOURCE, SIGNATURE);

    expect(body).toContain("await loadCoreSdk()");
    // `loadSdk` reaches into `Protocol.prototype`, which the SDK's `^1.0.0`
    // range does not oblige it to keep stable. A user's server must not fail
    // to connect because an elicitation-only internal moved.
    expect(body).not.toContain("await loadSdk()");
  });

  test("it installs no transport.onmessage tap", () => {
    const body = functionBody(CLIENT_SOURCE, SIGNATURE);

    // The Codex path taps this because it must correlate an elicitation
    // before the SDK consumes it. A user server has no such requirement, and
    // the tap would put keryx between a server and its own protocol.
    expect(body).not.toContain("transport.onmessage");
  });

  test("the Codex specialist still exists and still reaches Protocol.prototype", () => {
    // The other direction: this phase generalizes BESIDE the specialist, and
    // a refactor that quietly rewrote the specialist would pass every
    // assertion above while breaking the thing they protect.
    expect(CLIENT_SOURCE).toContain("export async function connectCodexMcpClient");
    expect(CLIENT_SOURCE).toContain("sdk.ProtocolPrototype.setRequestHandler.call");
  });

  test("both paths share ONE tool-call outcome helper — exactly one definition", () => {
    // Two copies would drift on the distinction that matters — a wire
    // timeout versus a refusal, which the SDK reports with the same code.
    //
    // The old assertion counted OCCURRENCES and required `>= 3`, which is
    // monotone the wrong way: it notices the helper being deleted and never
    // notices a path quietly stopping using it. Both halves are asserted
    // now, and both were verified to fail — inlining the outcome in one
    // connect function fails the second assertion, and a second definition
    // of the same name fails the first.
    const definitions = CLIENT_SOURCE.match(/\bfunction\s+callToolWithOutcome\b/g) ?? [];
    expect(definitions).toHaveLength(1);

    for (const signature of [SIGNATURE, "export async function connectCodexMcpClient"]) {
      expect(functionBody(CLIENT_SOURCE, signature)).toContain("callToolWithOutcome(");
    }
  });
});
