// The two surfaces that ask before an MCP tool runs, and what they must NOT do.
//
// AC7/AC9. The class table next door proves the DESCRIPTION is right.
// This proves the description is WIRED, and — the half F-032 is actually
// about — that the shell approval machinery is not reached at all.
//
// The distinction matters because F-032 was explicitly established NOT to
// be an approval bypass: `evaluateShellApproval` gates auto-approve on
// `!destructive`, and `use_tool` is unconditionally destructive, so the
// call was always going to prompt. The defect is the SIDE EFFECT — an
// "Always allow" whose grant pattern is a qualified tool name the model
// supplied, written into the operator's permission file. So the assertion
// here is about the store, not about the answer.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describeUseToolApproval, isMcpToolCall } from "./approval-render";
import { evaluateShellApproval } from "../commands/shell-approval";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..");

function source(relative: string): string {
  return readFileSync(path.join(SRC, relative), "utf8");
}

describe("AC7 — an MCP call never reaches the shell approval machinery", () => {
  test("`use_tool` is recognised as an MCP call", () => {
    expect(isMcpToolCall("use_tool")).toBe(true);
  });

  test("BOUNDARY — and the tools that legitimately DO use the shell path are not", () => {
    // Without this, `isMcpToolCall = () => true` would route
    // `shell_exec` through the MCP renderer and pass every other test.
    for (const other of ["shell_exec", "apply_patch", "search_tool", "read_file"]) {
      expect({ tool: other, mcp: isMcpToolCall(other) }).toEqual({ tool: other, mcp: false });
    }
  });

  test("both surfaces branch on it BEFORE the shell evaluator runs", () => {
    // Ordering is the property. A branch placed after
    // `evaluateShellApproval` would render correctly and still have
    // consulted — and be able to write — the permission store.
    for (const file of ["commands/shell.ts", "tui/tui-shell.ts"]) {
      const text = source(file);
      const branch = text.indexOf("if (isMcpToolCall(tool)) {");
      const evaluator = text.indexOf("evaluateShellApproval({");
      expect({ file, hasBranch: branch >= 0 }).toEqual({ file, hasBranch: true });
      expect({ file, branchIsFirst: branch < evaluator }).toEqual({ file, branchIsFirst: true });
    }
  });

  test("neither surface offers `always` for an MCP call", () => {
    // The description says so structurally, and the type says `false`, so
    // a caller cannot offer the option by forgetting to check.
    const described = describeUseToolApproval(
      JSON.stringify({ tool_name: "linear__create_issue", tool_input: {} }),
    );
    expect(described.rememberable).toBe(false);
  });

  test("and the shell evaluator, if it HAD been reached, would have offered one", () => {
    // The counterfactual, so this file states a real difference rather
    // than asserting a property that held anyway. A non-destructive
    // shell command is rememberable; that is the machinery `use_tool`
    // was falling into.
    const evaled = evaluateShellApproval({
      inputJson: JSON.stringify({ command: "ls -la" }),
      sessionAllow: new Set<string>(),
      fingerprintAtStart: "",
    });
    expect(evaled.destructive).toBe(false);
    // `rememberable` in both surfaces is `!destructive && !credentials &&
    // !sacReviewConfirmation`, so a non-destructive command reaches the
    // `A=always` prompt — which is what would have stored model-supplied
    // text had the MCP branch not been added.
    expect(evaled.credentials).toBe(false);
  });
});

describe("AC9 — one renderer, and neither surface re-derives it", () => {
  test("both import the shared module", () => {
    for (const file of ["commands/shell.ts", "tui/tui-shell.ts"]) {
      expect({ file, imports: source(file).includes("approval-render") }).toEqual({ file, imports: true });
    }
  });

  test("neither re-implements the 117-character truncation for an MCP call", () => {
    // F-033's mechanism, specifically. The generic
    // `tool !== "shell_exec"` branch still truncates, and should — it is
    // fine for a small tool input. What must not happen is `use_tool`
    // reaching it, which the ordering test above pins.
    const shell = source("commands/shell.ts");
    // The BRANCH, not a comment mentioning it. `tool !== "shell_exec"`
    // appears earlier in prose explaining why the elicitation has its own
    // path, and matching that read the wrong position — the first version
    // of this test failed for that reason rather than for a real one.
    const mcpBranch = shell.indexOf("if (isMcpToolCall(tool)) {");
    const genericBranch = shell.indexOf('if (tool !== "shell_exec") {');
    expect(mcpBranch).toBeGreaterThanOrEqual(0);
    expect(genericBranch).toBeGreaterThan(mcpBranch);
  });

  test("the renderer needs no terminal, which is why it can be tested at all", () => {
    // Asserted by calling it with nothing mocked. If it ever grew a
    // dependency on `otui`, a renderer, or process state, this would
    // stop compiling or stop running — and the class table next door
    // would have to be rewritten as a TUI test, which is how the
    // rendering came to be untested in the first place.
    const described = describeUseToolApproval('{"tool_name":"a__b","tool_input":{"x":1}}');
    expect(described.server).toBe("a");
    expect(described.tool).toBe("b");
  });
});
