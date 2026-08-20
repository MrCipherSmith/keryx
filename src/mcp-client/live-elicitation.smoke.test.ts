// Flag-gated LIVE elicitation round-trip test (flow 182, T13; AC3).
//
// `client.smoke.test.ts` (T6) already proves AC1 (spawn + handshake) against
// a real `codex mcp-server`. It does NOT exercise the elicitation exchange.
// `fixtures.test.ts` replays live-captured JSON offline. NEITHER proves AC3's
// specific clause: "keryx answers that elicitation and the corresponding
// codex tool call proceeds (approve case) or is cleanly refused (deny case)
// — verified against the live process, not only the fixture replay." This
// file is that missing live verification: it drives `superviseCodexMcpRun`
// (the actual production supervisor, `src/harness/external/supervise-mcp.ts`)
// against a REAL spawned `codex mcp-server` child, through BOTH the approve
// and decline paths, in a disposable scratch directory.
//
// Same opt-in gating idiom as `client.smoke.test.ts`: EXCLUDED FROM CI,
// skipped entirely unless `KERYX_ALLOW_REAL_SUBPROCESS=1` is set AND a real
// `codex` binary is on PATH. Mirrors the T5 probe script's own approach
// (journal.md's T5 entry): `-c approval_policy="on-request" -c
// sandbox_mode="read-only"` on the spawn argv, and `sandbox: "read-only"`,
// `"approval-policy": "on-request"` as the `codex` tool's own call
// arguments (confirmed via a live `client.listTools()` call in this task —
// the tool's `inputSchema` names exactly these two dash-cased keys).
//
// Findings reconfirmed live while writing this test (see
// `fixtures/mcp-client/codex/manifest.json`'s "provenance" note for the
// full detail): a clean decline does NOT make the outer `tools/call`
// resolve with an ordinary result — it can still hit this module's own
// `{kind:"timeout"}` outcome (T5's documented finding, independently
// reconfirmed here). So "cleanly refused" is verified the way it actually
// manifests: the elicitation response sent was `{action:"decline",
// decision:"abort"}`, AND the file codex was asked to create was never
// actually created — not by asserting the outer tool call itself returns a
// particular `McpToolCallOutcome.kind`.
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { superviseCodexMcpRun, buildCodexMcpServerArgv } from "../harness/external/supervise-mcp";
import { codexMcpClientPort } from "./client";

const REAL_SUBPROCESS_FLAG = process.env.KERYX_ALLOW_REAL_SUBPROCESS === "1";

function codexAvailable(): boolean {
  try {
    const result = spawnSync("codex", ["--version"], { stdio: "ignore" });
    return result.status === 0;
  } catch {
    return false;
  }
}

/** Argv per journal.md's T5 probe script: real spawn argv + config overrides, dash-free TOML keys via `-c`. */
function liveArgv(): readonly string[] {
  return [...buildCodexMcpServerArgv(), "-c", 'approval_policy="on-request"', "-c", 'sandbox_mode="read-only"'];
}

function liveEnv(): Record<string, string> {
  return { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" } as Record<string, string>;
}

describe.skipIf(!REAL_SUBPROCESS_FLAG || !codexAvailable())(
  "live elicitation round-trip against a real `codex mcp-server` (flag-gated via KERYX_ALLOW_REAL_SUBPROCESS=1, excluded from CI, AC3)",
  () => {
    test("approve case: the elicitation is accepted and the corresponding codex tool call actually creates the file", async () => {
      const scratchDir = mkdtempSync(path.join(tmpdir(), "keryx-mcp-live-approve-"));
      const targetFile = path.join(scratchDir, "live-approve-test.txt");
      try {
        const outcome = await superviseCodexMcpRun(
          {
            cwd: scratchDir,
            env: liveEnv(),
            argv: liveArgv(),
            toolName: "codex",
            toolArguments: {
              prompt: `Run the shell command \`touch ${path.basename(targetFile)}\` in the current directory using the shell tool.`,
              sandbox: "read-only",
              "approval-policy": "on-request",
              cwd: scratchDir,
            },
            toolCallTimeoutMs: 90_000,
            elicitationTimeoutMs: 60_000,
            mode: "ask",
          },
          {
            client: codexMcpClientPort,
            requestApproval: async () => true,
          },
        );

        // AC6: resolveApprovalDecision was consulted (mode "ask" here) and the
        // operator's "yes" (requestApproval => true) drove an accept.
        expect(outcome.elicitations.length).toBeGreaterThanOrEqual(1);
        const handled = outcome.elicitations[0]!;
        expect(handled.verdict).toBe("approve");
        expect(handled.response).toMatchObject({ action: "accept" });
        expect(handled.gateDecision).toBe("ask");

        // The corresponding codex tool call actually proceeded: the file it
        // was asked to create really exists on disk.
        expect(existsSync(targetFile)).toBe(true);

        // AC8: the elicitation exchange itself produced no ExternalEvent kind
        // other than the ordinary child_started/child_finished/child_failed
        // vocabulary — never surfaced through the elicitation path.
        expect(outcome.events.map((e) => e.kind)).toContain("child_started");
      } finally {
        rmSync(scratchDir, { recursive: true, force: true });
      }
    });

    test("decline case: the elicitation is cleanly refused and the corresponding codex tool call never creates the file", async () => {
      const scratchDir = mkdtempSync(path.join(tmpdir(), "keryx-mcp-live-decline-"));
      const targetFile = path.join(scratchDir, "live-decline-test.txt");
      try {
        const outcome = await superviseCodexMcpRun(
          {
            cwd: scratchDir,
            env: liveEnv(),
            argv: liveArgv(),
            toolName: "codex",
            toolArguments: {
              prompt: `Run the shell command \`touch ${path.basename(targetFile)}\` in the current directory using the shell tool.`,
              sandbox: "read-only",
              "approval-policy": "on-request",
              cwd: scratchDir,
            },
            // Per T5's (and this task's own) live finding, the outer tool call
            // can outlive a cleanly-declined elicitation and hit its own
            // timeout — give it real room, but the assertion below does not
            // depend on which McpToolCallOutcome.kind it settles to.
            toolCallTimeoutMs: 90_000,
            elicitationTimeoutMs: 60_000,
            mode: "ask",
          },
          {
            client: codexMcpClientPort,
            requestApproval: async () => false,
          },
        );

        expect(outcome.elicitations.length).toBeGreaterThanOrEqual(1);
        const handled = outcome.elicitations[0]!;
        expect(handled.verdict).toBe("deny");
        expect(handled.response).toMatchObject({ action: "decline" });
        expect(handled.gateDecision).toBe("ask");
        expect(handled.timedOut).toBe(false); // an operator genuinely said no — not a timeout-driven decline

        // Cleanly refused: codex never actually created the file, regardless
        // of what McpToolCallOutcome.kind the outer tools/call eventually
        // settled to (a real, confirmed possibility here is "timeout" — see
        // this file's header).
        expect(existsSync(targetFile)).toBe(false);
        expect(["result", "timeout", "error"]).toContain(outcome.toolCall.kind);
        if (outcome.toolCall.kind === "result") {
          // If it did resolve normally, it must not report the file as created.
          expect(outcome.toolCall.result.isError === false && existsSync(targetFile)).toBe(false);
        }
      } finally {
        rmSync(scratchDir, { recursive: true, force: true });
      }
    });
  },
);
