// R700-01 (flow 319, lane A follow-up): ACP has no terminal to ask "trust
// this?" in, so an untrusted/changed project hook must be reported to the
// client — the operator is looking at the ACP thread, not a shell's stderr.
// `ensureShellHooksAndFireStart` (`./server.ts`) now builds its
// `ShellHookContext` with `noticeSurface: "headless"` and reports every
// notice through `reportHookNotices`: an `agent_message_chunk` (so every
// client renders it) plus a `logError` line (this harness's `stderr`).
//
// This test proves the ACP-specific wiring, not the underlying trust/notice
// logic — that is covered by `harness/hooks/trust.test.ts`,
// `harness/hooks/config.test.ts` and `commands/hook-trust.probe.test.ts`.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import type { ProviderPort } from "../harness/provider/types";
import { harness } from "./server-harness.test-helpers";
import { ACP_PROTOCOL_VERSION } from "./protocol";

const PROVIDER = {} as ProviderPort;

function writeUntrustedProjectHook(projectDir: string): void {
  mkdirSync(path.join(projectDir, ".metaproject"), { recursive: true });
  const doc = {
    schemaVersion: "1.0.0",
    hooks: {
      SessionStart: [
        {
          id: "repo-poc",
          matcher: "*",
          class: "observe",
          command: { argv: ["true"] },
        },
      ],
    },
  };
  writeFileSync(path.join(projectDir, ".metaproject", "hooks.json"), JSON.stringify(doc), "utf8");
}

describe("R700-01: ACP session-start hook notices", () => {
  test("an untrusted project hook is reported as an agent_message_chunk and on stderr, not run", async () => {
    const h = harness({ provider: PROVIDER, hooksEnv: { KERYX_HOOKS: "on" } });
    writeUntrustedProjectHook(h.projectDir);

    const init = h.request("initialize", { protocolVersion: ACP_PROTOCOL_VERSION });
    await h.waitFor((f) => f.id === init);

    const created = h.request("session/new", { cwd: h.projectDir, mcpServers: [] });
    const reply = await h.waitFor((f) => f.id === created);
    const sessionId = reply.result?.["sessionId"] as string;
    expect(typeof sessionId).toBe("string");

    // `ensureShellHooksAndFireStart` reports every notice line as its own
    // `agent_message_chunk` BEFORE `session/new` replies — both lines are
    // already in `h.frames` by the time the reply above resolved.
    const noticeText = h.frames
      .filter((f) => f.params?.sessionId === sessionId && f.params?.update?.sessionUpdate === "agent_message_chunk")
      .map((f) => f.params?.update?.content?.text ?? "")
      .join("");
    expect(noticeText).toContain("not trusted");
    expect(noticeText).toContain("repo-poc");
    expect(noticeText).toContain("keryx hooks trust");

    expect(h.stderr.some((line) => line.includes(`acp: session ${sessionId}:`) && line.includes("not trusted"))).toBe(true);

    await h.end();
  });
});
