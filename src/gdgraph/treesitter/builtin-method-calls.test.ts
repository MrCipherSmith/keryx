// Regression cover for the false-callee defect (flow 238 / T11).
//
// `keryx gdgraph symbol wikiAsk` used to list
//   - test (src/harness/search/controller.ts:40)
// among `wikiAsk`'s callees. There is no function named `test` at that call
// site: `src/wiki/ask.ts` calls `<regexp>.test(...)`, and the resolver matched
// the call by its last dotted segment alone, so the RegExp method landed on the
// unrelated project method `SearchController.test`.
//
// These tests pin the three halves of the contract:
//   1. a built-in method reached through an untyped receiver is NOT resolved to
//      a project symbol — in BOTH the per-file pass and the cross-file pass;
//   2. it is not dropped either: it survives as an `unresolved-call` edge that
//      still carries the full source expression (`SEMVER_RE.test`), which is
//      what `querySymbol` marks `resolved: false` and the CLI prints as
//      `(unresolved)`;
//   3. genuine method calls (`controller.probe()`, `this.emit()`) still resolve
//      — the fix must not be "stop recording member calls".
//
// The first test runs the REAL production path (`resolveTreesitterCapability` →
// grammar → `extractSymbolLayer` → `resolveCrossFileCalls`) over real
// TypeScript source; the rest drive the same extraction functions with mock
// trees so they cannot be skipped by a missing optional grammar.

import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import { extractSymbolLayer, resolveCrossFileCalls, type TsNode } from "./extract";
import type { CallEdge, SymbolNode } from "../types";

// --- mock syntax-tree helpers (same shape as extract.test.ts) ---------------

interface MockOptions {
  type: string;
  line?: number;
  endLine?: number;
  text?: string;
  fields?: Record<string, TsNode | null>;
  namedChildren?: TsNode[];
}

function mk(o: MockOptions): TsNode {
  const line = o.line ?? 1;
  const endLine = o.endLine ?? line;
  const named = o.namedChildren ?? [];
  return {
    type: o.type,
    text: o.text ?? "",
    startPosition: { row: line - 1, column: 0 },
    endPosition: { row: endLine - 1, column: 0 },
    childForFieldName: (field: string) => o.fields?.[field] ?? null,
    namedChildren: named,
    children: named,
  };
}

const idNode = (text: string): TsNode => mk({ type: "identifier", text });
const paramsNode = (): TsNode => mk({ type: "formal_parameters", text: "()" });

// `<calleeExpression>(value)` — `calleeExpression` may be a bare identifier or a
// member expression such as `SEMVER_RE.test`.
const callNode = (calleeExpression: string, line = 1): TsNode =>
  mk({
    type: "call_expression",
    line,
    text: `${calleeExpression}(value)`,
    fields: {
      function: mk({
        type: calleeExpression.includes(".") ? "member_expression" : "identifier",
        text: calleeExpression,
      }),
    },
  });

// A file with one function `caller` whose body makes the given calls, plus (when
// asked) a sibling method that the calls could be mis-matched to by name.
function fileTree(options: {
  callees: string[];
  siblingMethod?: string;
}): TsNode {
  const body = mk({
    type: "statement_block",
    line: 2,
    endLine: 2,
    namedChildren: options.callees.map((callee, index) => callNode(callee, 2 + index)),
  });
  const caller = mk({
    type: "function_declaration",
    line: 1,
    endLine: 20,
    fields: { name: idNode("caller"), parameters: paramsNode() },
    namedChildren: [body],
  });
  const children: TsNode[] = [caller];
  if (options.siblingMethod) {
    const method = mk({
      type: "method_definition",
      line: 22,
      endLine: 24,
      fields: { name: idNode(options.siblingMethod), parameters: paramsNode() },
    });
    const classBody = mk({ type: "class_body", line: 21, endLine: 25, namedChildren: [method] });
    children.push(
      mk({
        type: "class_declaration",
        line: 21,
        endLine: 25,
        fields: { name: idNode("SearchController") },
        namedChildren: [classBody],
      }),
    );
  }
  return mk({ type: "program", line: 1, endLine: 25, namedChildren: children });
}

const callKeys = (calls: CallEdge[], kind: CallEdge["kind"]): string[] =>
  calls.filter((call) => call.kind === kind).map((call) => `${call.from}=>${call.to}`);

// --- 1. real grammar, real TypeScript source, real adapter ------------------

const CONTROLLER_SOURCE = [
  "export class SearchController {",
  "  async test(providerId: string): Promise<boolean> {",
  "    return providerId.length > 0;",
  "  }",
  "",
  "  probe(providerId: string): string {",
  "    return providerId;",
  "  }",
  "}",
  "",
].join("\n");

const CALLER_SOURCE = [
  'const SEMVER_RE = /^\\d+\\.\\d+\\.\\d+$/;',
  "",
  "export function validateVersion(controller: SearchController, value: string): string {",
  // The defect: a RegExp method, NOT a call to `SearchController.test`.
  "  if (!SEMVER_RE.test(value)) {",
  '    return "";',
  "  }",
  // A genuine cross-file method call that must STILL resolve.
  "  return controller.probe(value);",
  "}",
  "",
].join("\n");

const CONTROLLER_PATH = "fixtures/treesitter/t11-search-controller.ts";
const CALLER_PATH = "fixtures/treesitter/t11-version-check.ts";

// The real-grammar run happens in a CLEAN SUBPROCESS, not in this process.
// `adapter.test.ts` registers a process-wide `mock.module("web-tree-sitter")`
// at its module top level, so in a whole-directory `bun test` run whichever
// file loads first decides whether the real runtime or the mock parser serves
// the import. A real-grammar assertion in this process therefore passes or
// fails on test-file ordering — it silently degraded to zero symbols the first
// time it ran alongside `adapter.test.ts`. A subprocess is immune to that and
// is no less real: it calls the same production entry point
// (`resolveTreesitterCapability` → grammar → `extractSymbolLayer` →
// `resolveCrossFileCalls`) over the same fixture source.
interface ProbeResult {
  available: boolean;
  symbols: string[];
  resolved: string[];
  unresolved: string[];
}

const ADAPTER_MODULE = fileURLToPath(new URL("./adapter.ts", import.meta.url));
const PROJECT_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

function runRealGrammarProbe(): ProbeResult {
  const script = [
    `const { resolveTreesitterCapability } = await import(${JSON.stringify(ADAPTER_MODULE)});`,
    `const adapter = await resolveTreesitterCapability(${JSON.stringify(PROJECT_ROOT)}, { languages: ["typescript"], grammarsPath: null });`,
    `if (!adapter) { console.log("@@" + JSON.stringify({ available: false, symbols: [], resolved: [], unresolved: [] })); process.exit(0); }`,
    `const layer = await adapter.run({ files: ${JSON.stringify([
      { path: CONTROLLER_PATH, content: CONTROLLER_SOURCE },
      { path: CALLER_PATH, content: CALLER_SOURCE },
    ])} });`,
    `const keys = (kind) => layer.calls.filter((c) => c.kind === kind).map((c) => c.from + "=>" + c.to);`,
    `console.log("@@" + JSON.stringify({ available: layer.symbols.length > 0, symbols: layer.symbols.map((s) => s.id), resolved: keys("calls"), unresolved: keys("unresolved-call") }));`,
  ].join("\n");

  const proc = Bun.spawnSync([process.execPath, "-e", script], { cwd: PROJECT_ROOT });
  const stdout = proc.stdout.toString();
  const line = stdout.split("\n").find((l) => l.startsWith("@@"));
  if (!line) {
    throw new Error(
      `real-grammar probe subprocess produced no result (exit ${proc.exitCode}).\n` +
        `stdout: ${stdout}\nstderr: ${proc.stderr.toString()}`,
    );
  }
  return JSON.parse(line.slice(2)) as ProbeResult;
}

const probe = runRealGrammarProbe();
const skipReason = probe.available
  ? ""
  : "no working web-tree-sitter runtime + verified typescript grammar in this environment";

test.skipIf(!probe.available)(
  skipReason
    ? `real grammar: <regexp>.test() is not recorded as a call to a project 'test' [SKIPPED: ${skipReason}]`
    : "real grammar: <regexp>.test() is not recorded as a call to a project 'test'",
  () => {
    // The fixture really parsed: both project symbols are present.
    expect(probe.symbols).toContain(`${CONTROLLER_PATH}#SearchController.test`);
    expect(probe.symbols).toContain(`${CONTROLLER_PATH}#SearchController.probe`);

    const resolved = probe.resolved;
    const unresolved = probe.unresolved;

    // (1) the false edge is gone — this is the row `gdgraph symbol` printed.
    expect(resolved).not.toContain(
      `${CALLER_PATH}#validateVersion=>${CONTROLLER_PATH}#SearchController.test`,
    );
    expect(resolved.filter((key) => key.endsWith("SearchController.test"))).toEqual([]);

    // (2) and it did not vanish: the call is still there, marked unresolved,
    //     carrying the receiver the resolver could not type.
    expect(unresolved).toContain(`${CALLER_PATH}#validateVersion=>SEMVER_RE.test`);

    // (3) a real cross-file method call still resolves.
    expect(resolved).toContain(
      `${CALLER_PATH}#validateVersion=>${CONTROLLER_PATH}#SearchController.probe`,
    );
  },
);

// --- 2. per-file pass -------------------------------------------------------

test("per-file: a built-in method on an untyped receiver never matches a same-file symbol", () => {
  const layer = extractSymbolLayer(
    fileTree({ callees: ["SEMVER_RE.test"], siblingMethod: "test" }),
    "src/version.ts",
    "typescript",
  );

  expect(callKeys(layer.calls, "calls")).toEqual([]);
  expect(callKeys(layer.calls, "unresolved-call")).toEqual(["src/version.ts#caller=>SEMVER_RE.test"]);
  const edge = layer.calls.find((call) => call.kind === "unresolved-call");
  expect(edge?.resolved).toBe(false);
});

// --- 3. cross-file pass -----------------------------------------------------

const symbol = (id: string, name: string, path: string): SymbolNode => ({
  id,
  kind: "method",
  path,
  name,
  container: "SearchController",
  startLine: 40,
  endLine: 50,
  language: "typescript",
  signature: `SearchController.${name}()`,
});

const unresolvedEdge = (from: string, to: string): CallEdge => ({
  id: `unresolved-call:${from}=>${to}`,
  from,
  to,
  kind: "unresolved-call",
  resolved: false,
});

test("cross-file: a unique project 'test' does not capture <regexp>.test() from other files", () => {
  const symbols = [symbol("src/harness/search/controller.ts#SearchController.test", "test", "src/harness/search/controller.ts")];
  const out = resolveCrossFileCalls(symbols, [unresolvedEdge("src/wiki/ask.ts#wikiAsk", "SEMVER_RE.test")]);

  expect(callKeys(out, "calls")).toEqual([]);
  expect(callKeys(out, "unresolved-call")).toEqual(["src/wiki/ask.ts#wikiAsk=>SEMVER_RE.test"]);
});

test("cross-file: a real method call on an ordinary receiver still resolves", () => {
  const symbols = [symbol("src/wiki/service.ts#WikiService.wikiAsk", "wikiAsk", "src/wiki/service.ts")];
  const out = resolveCrossFileCalls(symbols, [unresolvedEdge("src/harness/tool/adapter.ts#ask", "service.wikiAsk")]);

  expect(callKeys(out, "calls")).toEqual([
    "src/harness/tool/adapter.ts#ask=>src/wiki/service.ts#WikiService.wikiAsk",
  ]);
});

// --- 4. the rule is not one spelling ---------------------------------------

// One representative name per intrinsic family, each measured on this
// repository as a real false-resolution source (`.test` 272 edges, `.log` 254,
// `.entries` 174, `.isInteger` 35, `.at` 32, `.get` 23, `.push` 20, `.parse`
// 11, `.add` 10, `.reject` 7 before the fix).
const BUILTIN_CASES: Array<[receiver: string, method: string]> = [
  ["SEMVER_RE", "test"],
  ["console", "log"],
  ["Object", "entries"],
  ["Number", "isInteger"],
  ["messages", "at"],
  ["byId", "get"],
  ["out", "push"],
  ["JSON", "parse"],
  ["seen", "add"],
  ["Promise", "reject"],
  ["items", "map"],
  ["items", "filter"],
  ["seenPages", "has"],
  ["Math", "max"],
  ["value", "toString"],
  ["text", "startsWith"],
  ["proc", "then"],
  ["fn", "apply"],
  ["Date", "now"],
  ["this.tools", "get"],
];

for (const [receiver, method] of BUILTIN_CASES) {
  test(`built-in guard: ${receiver}.${method}() is not a call to a project '${method}'`, () => {
    const layer = extractSymbolLayer(
      fileTree({ callees: [`${receiver}.${method}`], siblingMethod: method }),
      "src/sample.ts",
      "typescript",
    );
    expect(callKeys(layer.calls, "calls")).toEqual([]);
    expect(callKeys(layer.calls, "unresolved-call")).toEqual([
      `src/sample.ts#caller=>${receiver}.${method}`,
    ]);
  });
}

// --- 5. what the guard must NOT break --------------------------------------

// `this`/`self`/`super` name the enclosing object, so the method behind them is
// project-defined by construction even when it shares a name with a built-in
// (`this.emit()`, `this.get()`); and any method name outside the intrinsic
// surface keeps resolving on any receiver.
const RESOLVABLE_CASES: string[] = [
  "this.probe",
  "self.probe",
  "super.probe",
  "this.get",
  "this.clear",
  "service.wikiAsk",
  "deps.readSlate",
  "chrome.setHeaderMeta",
  "probe",
];

for (const callee of RESOLVABLE_CASES) {
  const method = callee.includes(".") ? callee.slice(callee.lastIndexOf(".") + 1) : callee;
  test(`kept: ${callee}() still resolves to the project '${method}'`, () => {
    const layer = extractSymbolLayer(
      fileTree({ callees: [callee], siblingMethod: method }),
      "src/sample.ts",
      "typescript",
    );
    expect(callKeys(layer.calls, "calls")).toEqual([
      `src/sample.ts#caller=>src/sample.ts#SearchController.${method}`,
    ]);
    expect(callKeys(layer.calls, "unresolved-call")).toEqual([]);
  });
}
