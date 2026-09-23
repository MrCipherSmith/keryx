// Flow 299, AC4: no agent path can mint the completion confirmation token or
// get around it.
//
// - No MCP tool and no agent-native tool mints one. Enforced two ways: by the
//   tool names, and by a scan of every production file that calls the mint.
// - The approval floor forces `ask` for `flow confirm` in every mode, through
//   the ACP classifier here. The agent loop and the supervised-codex path are
//   covered in their own test files.
// - The unattended floor refuses `flow confirm` and `flow recover`, and any
//   command or patch that names a token store.
import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { buildToolRegistry } from "../mcp/tools";
import { builtinReadOnlyTools } from "../harness/tool/builtin/interactive-tools";
import { shellExecTool } from "../harness/tool/builtin/shell-exec-tool";
import { classifyAcpToolCall, decideAcpPermission } from "../harness/external/acp-permission";
import { isManagedFlowFile } from "../harness/policy/engine";
import { resolveApprovalDecision, type PermissionMode } from "../commands/permission-mode";
import { touchesFlowConfirm, touchesHumanConfirmation, touchesSacConfirmReview } from "../lib/command-risk";
import { isUnattendedProtectedPath, unattendedRefusal } from "../trigger/unattended";

const SRC = path.resolve(import.meta.dir, "..");
const MODES: readonly PermissionMode[] = ["ask", "trust", "auto"];

async function productionFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
    out.push(path.join(entry.parentPath, entry.name));
  }
  return out;
}

describe("AC4: nothing but the CLI verb mints a token", () => {
  test("no MCP tool is a flow confirm/recover verb, and flow exposes only its read-only status tool", () => {
    const names = buildToolRegistry().map((tool) => tool.name);
    expect(names.filter((name) => /flow[._-]?(confirm|recover|complete)/i.test(name))).toEqual([]);
    expect(names.filter((name) => name.startsWith("flow."))).toEqual(["flow.status"]);
  });

  test("no agent-native tool in the base roster is a flow confirm verb", () => {
    const roster = [...builtinReadOnlyTools(SRC), shellExecTool(SRC)].map((tool) => tool.definition.name);
    expect(roster.filter((name) => /confirm|recover/i.test(name))).toEqual([]);
  });

  test("the mint is CALLED from exactly two production files: the service, and the CLI verb", async () => {
    const callers: string[] = [];
    for (const file of await productionFiles(SRC)) {
      const text = await readFile(file, "utf8");
      // A call, not the declaration: `.confirmMint(` on a service, or
      // `mintConfirmationToken(` anywhere but its own `function` line.
      if (/\.confirmMint\s*\(|(?<!function )\bmintConfirmationToken\s*\(/.test(text)) {
        callers.push(path.relative(SRC, file));
      }
    }
    expect(callers.sort()).toEqual(["commands/flow.ts", "flow/service.ts"]);
  });
});

describe("AC4: the approval floor asks for `flow confirm` in every mode", () => {
  test("the marker matches `flow confirm` and not `flow ac confirm`, and joins SAC's", () => {
    expect(touchesFlowConfirm("keryx flow confirm 299")).toBe(true);
    expect(touchesFlowConfirm("bun run src/cli.ts flow  confirm 299 --merged")).toBe(true);
    expect(touchesFlowConfirm("keryx flow ac confirm 299 AC1")).toBe(false);
    expect(touchesHumanConfirmation("keryx flow confirm 299")).toBe(true);
    expect(touchesHumanConfirmation("keryx workspace confirm-review ws p")).toBe(true);
    expect(touchesSacConfirmReview("keryx flow confirm 299")).toBe(false);
  });

  test("resolveApprovalDecision: `ask` in every mode for a shell command naming `flow confirm`", () => {
    for (const mode of MODES) {
      expect(
        resolveApprovalDecision({
          mode,
          risk: "shell",
          destructive: false,
          credentials: false,
          sacReviewConfirmation: touchesHumanConfirmation("keryx flow confirm 299"),
          readOnly: false,
        }),
      ).toBe("ask");
    }
  });

  test("ACP: an execute call naming `flow confirm` is classified onto the floor and asked in every mode", () => {
    const classification = classifyAcpToolCall(
      { toolCallId: "t1", kind: "execute", rawInput: { command: "keryx flow confirm 299" } } as never,
      SRC,
    );
    expect(classification.sacReviewConfirmation).toBe(true);
    for (const mode of MODES) {
      expect(decideAcpPermission(classification, mode)).toBe("ask");
    }
  });

  test("ACP and the harness policy: the token store is a managed flow file, never editable", () => {
    expect(isManagedFlowFile(".metaproject/flows/299-x/confirm-token.json")).toBe(true);
  });
});

describe("AC4: the unattended floor", () => {
  test("refuses `flow confirm` and `flow recover`", () => {
    expect(unattendedRefusal("shell_exec", { command: "keryx flow confirm 299" })).toMatch(/flow confirm/);
    expect(unattendedRefusal("shell_exec", { command: "bun run src/cli.ts flow recover 299 --reason x" })).toMatch(
      /flow recover/,
    );
  });

  test("refuses a command or a patch that names a token store, flow or SAC", () => {
    expect(
      unattendedRefusal("shell_exec", { command: "echo '{}' > .metaproject/flows/299-x/confirm-token.json" }),
    ).toMatch(/confirm-token/);
    expect(isUnattendedProtectedPath(".metaproject/flows/299-x/confirm-token.json")).toBe(true);
    expect(isUnattendedProtectedPath(".metaproject/workspaces/ws/proposals/p1.confirm-token.json")).toBe(true);
    const patch = [
      "--- /dev/null",
      "+++ b/.metaproject/flows/299-x/confirm-token.json",
      "@@ -0,0 +1 @@",
      '+{"hash":"forged"}',
      "",
    ].join("\n");
    expect(unattendedRefusal("apply_patch", { patch })).toMatch(/confirm-token\.json/);
  });
});
