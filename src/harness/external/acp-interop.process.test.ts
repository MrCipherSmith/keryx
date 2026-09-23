// keryx-as-client drives keryx-as-agent, end to end (flow 292, AC9).
//
// The outer keryx is `superviseAcpRun`; the inner one is a real `keryx acp`
// subprocess on the `--fixture` scripted provider (offline, no model). The
// inner turn calls `shell_exec`, a gated tool, so the inner keryx sends a REAL
// `session/request_permission` across the pipe — and the outer keryx answers it
// by its own policy. The inner session's persisted transcript is what shows the
// outcome, not the outer side's belief about it.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentIO } from "../../commands/agent";
import { listSessions, loadTranscript } from "../../session/store";
import { superviseAcpRun, type SuperviseAcpOutcome } from "./acp-client";
import { clampForeignMode } from "./acp-permission";
import { createBunSpawnPort } from "./bun-spawn-port";

const CLI = path.join(import.meta.dir, "..", "..", "cli.ts");
const TIMEOUT_MS = 90_000;
/** What the inner keryx's `executeCall` returns when its client says no — verbatim. */
const LOCAL_DENIAL = "command not approved by the user; not executed";

let root = "";
let workdir = "";
let innerData = "";

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "keryx-acp-interop-")));
  workdir = path.join(root, "work");
  innerData = path.join(root, "inner-data");
  mkdirSync(workdir, { recursive: true });
  mkdirSync(innerData, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const file = path.join(root, "fixture.json");
  writeFileSync(
    file,
    JSON.stringify({
      turns: [
        [
          { kind: "tool_call_start", toolCallId: "c0", toolName: "shell_exec" },
          { kind: "tool_call_end", toolCallId: "c0", input: JSON.stringify({ command: "echo keryx-inner-$((40+2))" }) },
          { kind: "model_end" },
        ],
        [{ kind: "text_delta", text: "inner turn done." }, { kind: "model_end" }],
      ],
    }),
  );
  return file;
}

async function drive(requestApproval: AgentIO["requestApproval"] | undefined): Promise<SuperviseAcpOutcome> {
  return superviseAcpRun(
    {
      argv: [process.execPath, "run", CLI, "acp", "--fixture", fixture(), "--data-dir", innerData],
      cwd: workdir,
      env: { ...(process.env as Record<string, string>), XDG_DATA_HOME: root, APPDATA: root },
      prompt: "run the command",
      mcpServers: [],
      write: false,
      timeoutMs: 60_000,
      killGraceMs: 2_000,
      permission: { mode: clampForeignMode("ask"), unattended: requestApproval === undefined },
    },
    { spawn: createBunSpawnPort(), ...(requestApproval === undefined ? {} : { requestApproval }) },
  );
}

/** The inner keryx's own persisted transcript for this run. */
function innerTranscript(): string {
  const sessions = listSessions(workdir, innerData);
  expect(sessions.length).toBeGreaterThan(0);
  return sessions.map((session) => JSON.stringify(loadTranscript(workdir, session.id, innerData))).join("\n");
}

describe("AC9 — keryx answers keryx's own permission question", () => {
  test(
    "unattended: the outer keryx denies, and the inner turn records the command as not executed",
    async () => {
      const outcome = await drive(undefined);
      expect(outcome.status).toBe("completed");
      expect(outcome.agentInfo?.name).toBe("keryx");
      expect(outcome.decisions).toHaveLength(1);
      expect(outcome.decisions[0]).toMatchObject({ kind: "execute", verdict: "deny", reason: "unattended", outcome: "selected" });
      const transcript = innerTranscript();
      expect(transcript).toContain(LOCAL_DENIAL);
      // The command text is on the record; its OUTPUT (the arithmetic, evaluated) is not.
      expect(transcript).not.toContain("keryx-inner-42");
    },
    TIMEOUT_MS,
  );

  test(
    "with an injected approval that echoes the fingerprint, the inner command runs and its output is on the inner record",
    async () => {
      const outcome = await drive(async (_tool, _input, meta) => ({ approved: true, fingerprint: meta?.fingerprint ?? "" }));
      expect(outcome.status).toBe("completed");
      expect(outcome.decisions[0]).toMatchObject({ kind: "execute", verdict: "approve", reason: "human", optionId: "allow_once" });
      const transcript = innerTranscript();
      expect(transcript).toContain("keryx-inner-42");
      expect(transcript).not.toContain(LOCAL_DENIAL);
    },
    TIMEOUT_MS,
  );
});
