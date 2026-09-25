// R700-01 (flow 319, lane A follow-up): a remote turn is headless by
// construction — there is no terminal for `buildRemoteHookRuntime` to ask
// "trust this?" in, so an untrusted/changed project hook must be reported on
// stderr instead, worded for that ("this session cannot ask"), and not
// repeated for every turn a long-running `keryx serve` process handles for
// the same project (`emitRemoteHookNotices`'s per-process dedupe Set in
// `./serve-turn.ts`).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveLocalProfile } from "../harness/policy/profiles";
import type {
  NormalizedEvent,
  NormalizedRequest,
  ProviderDescription,
  ProviderPort,
  StreamOptions,
} from "../harness/provider/types";
import { runRemoteTurn, type TurnRequest } from "./serve-turn";

let configDir = "";
let project = "";

/** An offline provider that answers with fixed text. No network, no transcript. */
class StubProvider implements ProviderPort {
  describe(): ProviderDescription {
    return {
      capabilities: {
        streaming: true,
        toolCalls: false,
        parallelToolCalls: false,
        structuredOutput: false,
        reasoningMetadata: false,
        promptCaching: false,
        vision: false,
        tokenCounting: false,
        modelListing: false,
      },
      descriptor: { providerId: "stub-provider" },
    };
  }
  async *stream(_request: NormalizedRequest, opts: StreamOptions): AsyncIterable<NormalizedEvent> {
    let sequence = 0;
    const next = (body: Omit<NormalizedEvent, "sequence" | "attemptId">): NormalizedEvent => ({
      ...body,
      sequence: sequence++,
      attemptId: opts.attemptId,
    });
    yield next({ kind: "model_start" });
    yield next({ kind: "text_delta", text: "hello from the stub" });
    yield next({ kind: "model_end" });
  }
}

function writeUntrustedProjectHook(): void {
  mkdirSync(path.join(project, ".metaproject"), { recursive: true });
  const doc = {
    schemaVersion: "1.0.0",
    hooks: {
      PreToolUse: [{ id: "repo-poc", matcher: "*", class: "observe", command: { argv: ["true"] } }],
    },
  };
  writeFileSync(path.join(project, ".metaproject", "hooks.json"), JSON.stringify(doc), "utf8");
}

beforeEach(() => {
  const base = mkdtempSync(path.join(tmpdir(), "keryx-remote-hook-notices-"));
  configDir = path.join(base, "config");
  project = path.join(base, "project");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(path.join(project, ".metaproject"), { recursive: true });
});

afterEach(() => {
  rmSync(path.dirname(configDir), { recursive: true, force: true });
});

function request(): TurnRequest {
  return { schemaVersion: "1.0.0", project, prompt: "hello" };
}

async function runOneTurn() {
  return runRemoteTurn({
    request: request(),
    project,
    profile: resolveLocalProfile("unattended-untrusted"),
    provider: new StubProvider(),
    providerName: "stub-provider",
    model: "stub-model",
    dir: configDir,
    scanRoot: configDir,
    containmentAvailable: () => true,
    // Real hook loading — the thing under test — unlike every other
    // `serve-turn*.test.ts` suite, which turns it off (see those files'
    // `hooksEnv` comments) because they run in-process and a spawned
    // built-in hook command would resolve to the test runner, not `keryx`.
    // This suite never lets a hook actually run (D5: untrusted project
    // hooks are dropped from `registrations` before anything fires), so
    // that hazard does not apply here.
    hooksEnv: { KERYX_HOOKS: "on" },
  });
}

describe("R700-01: buildRemoteHookRuntime reports untrusted project hooks headless", () => {
  test("the notice names the hook and says the session cannot ask; a second turn for the same project does not repeat it", async () => {
    writeUntrustedProjectHook();
    const calls: string[] = [];
    const realError = console.error;
    console.error = ((...args: unknown[]) => {
      calls.push(args.map((a) => String(a)).join(" "));
    }) as typeof console.error;
    try {
      await runOneTurn();
      const firstRunLines = [...calls];
      expect(firstRunLines.some((l) => l.includes("repo-poc") && l.includes("not trusted"))).toBe(true);
      // The headless wording, not the terminal one — no `keryx shell` is
      // present to answer "trust this?" for a remote turn.
      expect(firstRunLines.some((l) => l.includes("This session cannot ask"))).toBe(true);

      calls.length = 0;
      await runOneTurn();
      expect(calls).toEqual([]);
    } finally {
      console.error = realError;
    }
  });
});
