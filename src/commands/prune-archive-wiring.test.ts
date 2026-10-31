// Flow 387 review r2 F-023: `runAgentTurn` prunes/collapses old tool output only for a host that
// passes `pruneArchive: true` (it keeps the originals in an archive). Dropping the flag at one
// host site silently turns pruning off there, and no behaviour test reaches those turn calls
// (they sit inside the shells' REPL closures), so each site is pinned at source level. The
// patterns tolerate whitespace and line breaks, unlike a literal-text match. The readline
// operator turn is pinned separately by shell.test.ts.
//
// Flow 387 review r3 F-032: the shell and TUI pins read the two shell god-files as text, so they are
// recorded in docs/requirements/keryx-shell-split/source-text-audit-inventory.md (manifest row and
// the "flow 387" section), which src/shell-source-audits.test.ts re-derives. Changing the number of
// lines that name those files here changes the manifest count.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const SRC = path.resolve(import.meta.dir, "..");
const read = (relative: string): string => readFileSync(path.join(SRC, relative), "utf8");

// Select the actual call, not a character window that unrelated options can outgrow.
function turnOptions(source: string, prompt: string): ts.ObjectLiteralExpression {
  const file = ts.createSourceFile("prune-wiring.ts", source, ts.ScriptTarget.Latest, true);
  const matches: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(file) === "runAgentTurn"
      && node.arguments.slice(0, 4).map((arg) => arg.getText(file)).join(",") === `agentIo,deps,history,${prompt}`) {
      matches.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  expect(matches).toHaveLength(1);
  const options = matches[0]!.arguments[4];
  if (options === undefined || !ts.isObjectLiteralExpression(options)) throw new Error("missing turn options");
  return options;
}

function expectArchivedPruning(options: ts.ObjectLiteralExpression): void {
  const archive = options.properties.filter((property) => ts.isSpreadAssignment(property)
    && ts.isParenthesizedExpression(property.expression)
    && ts.isConditionalExpression(property.expression.expression)
    && property.expression.expression.condition.getText().replace(/\s/g, "") === "slateSession!==undefined");
  expect(archive).toHaveLength(1);
  // A later property/spread must not override the archived turn's pruning flag.
  expect(options.properties.at(-1)).toBe(archive[0]);
  // Pin the archive and literal true together in the enabled branch. A flag in recovery,
  // a different call, or the no-archive branch cannot satisfy this requirement.
  expect(archive[0]!.getText()).toMatch(
    /^\.\.\.\(slateSession\s*!==\s*undefined\s*\?\s*\{\s*slateSession,\s*pruneArchive:\s*true\s*,?\s*\}\s*:\s*\{\s*\}\s*\)$/,
  );
}

describe("pruneArchive wiring at every host that keeps an archive", () => {
  test("the parsed guard tolerates extra options but rejects absent, false or misplaced pruning", () => {
    const call = (branch: string): string => `runAgentTurn(agentIo, deps, history, operatorLine, {
      recovery: { note: "${"x".repeat(1_000)}", pruneArchive: true },
      ...(slateSession !== undefined ? ${branch} : {})
    });`;
    expectArchivedPruning(turnOptions(call("{ slateSession, pruneArchive: true }"), "operatorLine"));
    for (const branch of ["{ slateSession }", "{ slateSession, pruneArchive: false }"]) {
      expect(() => expectArchivedPruning(turnOptions(call(branch), "operatorLine"))).toThrow();
    }
    const wrongBranch = call("{}").replace(": {})", ": { slateSession, pruneArchive: true })");
    expect(() => expectArchivedPruning(turnOptions(wrongBranch, "operatorLine"))).toThrow();
    const overridden = call("{ slateSession, pruneArchive: true }").replace(": {})", ": {}), pruneArchive: false");
    expect(() => expectArchivedPruning(turnOptions(overridden, "operatorLine"))).toThrow();
  });

  test("the readline shell's task-notification turn opts into pruning", () => {
    const source = read("commands/shell.ts");
    const options = turnOptions(source, '""');
    expect(options.properties.some((property) => ts.isPropertyAssignment(property)
      && property.name.getText() === "origin" && property.initializer.getText() === '"task-notification"')).toBe(true);
    expectArchivedPruning(options);
  });

  test("the readline shell's operator turn opts into pruning", () => {
    const source = read("commands/shell.ts");
    expectArchivedPruning(turnOptions(source, "operatorLine"));
  });

  test("the TUI foreground turn opts into pruning", () => {
    const source = read("tui/tui-shell.ts");
    expect(source).toMatch(
      /runAgentTurn\(\s*foregroundIo,\s*deps,\s*history,\s*line,\s*\{[\s\S]{0,400}?pruneArchive:\s*true[\s\S]{0,40}?\}\)\)?\s*\.finally/,
    );
  });

  // The three turns share one `runTurn` helper since the remote-session prototype; goal-command.test.ts ("F-001: every
  // /goal turn") proves each of them offers the working-memory tools, which only a pruneArchive turn is given.
  test("/goal builds turnOptions with pruneArchive and passes them to all three turns", () => {
    const source = read("commands/goal-command.ts");
    const file = ts.createSourceFile("goal-command.ts", source, ts.ScriptTarget.Latest, true);
    const declarations: ts.VariableDeclaration[] = [];
    const calls: ts.CallExpression[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node)) declarations.push(node);
      if (ts.isCallExpression(node)) calls.push(node);
      ts.forEachChild(node, visit);
    };
    visit(file);
    const declared = (name: string): ts.Expression => {
      const found = declarations.filter((declaration) => declaration.name.getText(file) === name);
      expect(found).toHaveLength(1);
      if (found[0]?.initializer === undefined) throw new Error(`${name} has no initializer`);
      return found[0].initializer;
    };
    const callsOf = (callee: string): ts.CallExpression[] => calls.filter((call) => call.expression.getText(file) === callee);
    const compact = (node: ts.Node): string => node.getText(file).replace(/\s/g, "");

    // The slate branch carries the literal flag and is the last property, so a caller's turnOptions cannot override it.
    const options = declared("turnOptions");
    if (!ts.isObjectLiteralExpression(options)) throw new Error("turnOptions is not an object literal");
    expect(compact(options.properties.at(-1)!)).toBe(
      "...(slateSession===undefined?{}:{slateSession,skipCloseTrigger:true,pruneArchive:true})",
    );
    // runAgentTurn is called once, inside runTurn, with those options.
    const turns = callsOf("runAgentTurn");
    expect(turns.map(compact)).toEqual(["runAgentTurn(io,deps,history,text,turnOptions)"]);
    const runTurn = declared("runTurn");
    expect(turns[0]!.getStart(file)).toBeGreaterThan(runTurn.getStart(file));
    expect(turns[0]!.getEnd()).toBeLessThan(runTurn.getEnd());
    // Every turn goes through runTurn: the first, the round loop's and the verifier's extra round.
    expect(callsOf("runTurn").map(compact)).toEqual(["runTurn(parsed.text)", "runTurn(continuationText)", "runTurn(continuationText)"]);
  });

  test("the ACP host does not opt into pruning", () => {
    const source = read("acp/server.ts");
    expect(source).not.toMatch(/pruneArchive:\s*true/);
  });
});
