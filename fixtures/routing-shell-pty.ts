// Flow 411 real-TTY fixture. Only network/executor dependencies are fake.
import { mock } from "bun:test";
import { appendFileSync } from "node:fs";
import * as routing from "../src/tui/routing-classifier-source";
import { saveRoutingConfig } from "../src/harness/routing/config";
import { keryxConfigDir } from "../src/lib/config-dir";
import { loadShellConfig, saveShellConfig } from "../src/lib/shell-config";
import { makeDeps, scriptedProvider, okReply } from "../src/commands/agent.test-helpers";
const scenario = process.env.FLOW411_SCENARIO!;
const log = (event: string, detail?: unknown) => appendFileSync(process.env.FLOW411_LOG!, JSON.stringify({ event, detail }) + "\n");
const realRoute = routing.runRoutingClassifierForTurn;
const detected = [{ name: "pty-test", models: ["base-a", "base-b", "executor", "quick-executor"] },
  { name: "anthropic", models: ["claude-sonnet-5"] }];
// Fail closed on any accidental external fetch (JEV uses the injected seam).
globalThis.fetch = (async () => { throw new Error("PTY fixture prohibits network"); }) as typeof fetch;
await saveRoutingConfig("user", { cwd: process.cwd(), userConfigDir: keryxConfigDir() }, {
  review: { kind: "model", providerId: "pty-test", modelId: "executor" },
  quick: { kind: "model", providerId: "pty-test", modelId: "quick-executor" },
  coding: { kind: "model", providerId: "pty-test", modelId: "executor" },
});
// Exact serialized settings must survive /model and /route commands.
const initialRouting = JSON.stringify(loadShellConfig().routing);
saveShellConfig({ routingClassifier: { enabled: true }, turnGuard: { enabled: false } });
mock.module("../src/tui/routing-classifier-source", () => ({
  ...routing,
  runRoutingClassifierForTurn: async (line: string, opts: routing.RoutingClassifierTurnOptions) => {
    log("classify-start", { model: opts.sessionModel, aborted: opts.signal?.aborted });
    const result = await realRoute(line, { ...opts, env: scenario.startsWith("jev-") ? { OPENROUTER_API_KEY: "sk-or-fixture-not-a-secret" } : {},
      classifierAllowed: () => scenario === "jev-fallback",
      providerFactory: (providerId, modelId) => ({
        describe: () => ({ descriptor: { providerId }, capabilities: {
          streaming: true, toolCalls: false, parallelToolCalls: false, structuredOutput: false,
          reasoningMetadata: false, promptCaching: false, vision: false, tokenCounting: false, modelListing: false,
        } }),
        async *stream(_request, streamOpts) {
          log("fallback-classifier", { providerId, modelId });
          yield { kind: "text_delta" as const, sequence: 0, attemptId: streamOpts.attemptId, text: "coding" };
          yield { kind: "model_end" as const, sequence: 1, attemptId: streamOpts.attemptId };
        },
      }),
      fetch: (async (_url: unknown, init?: RequestInit) => {
        log("jev-start");
        if (scenario === "jev-fallback") return new Response(JSON.stringify({ answers: {}, usage: {} }));
        if (scenario === "jev-success") return new Response(JSON.stringify({ answers: {
          category: { type: "choice", choice: "coding" }, confidence: { type: "noul", noul: 0.99 },
        }, usage: {} }));
        return await new Promise<Response>((resolve) => {
          init?.signal?.addEventListener("abort", () => log("jev-abort"), { once: true });
          // Deliberately uncooperative transport; its late success must be ignored.
          setTimeout(() => { log("jev-late"); resolve(new Response(JSON.stringify({ answers: { category: { type: "choice", choice: "review" }, confidence: { type: "noul", noul: 0.99 } }, usage: {} }))); }, 1800);
        });
      }) as typeof fetch,
    });
    log("classify-end", { aborted: opts.signal?.aborted, routed: result?.routed });
    return result;
  },
}));
const { launchTuiAgentShell } = await import("../src/tui/tui-shell");
log("tty", { stdin: process.stdin.isTTY, stdout: process.stdout.isTTY });
const launched = await launchTuiAgentShell({
  detected, initial: { provider: "pty-test", model: "base-a" }, session: { cwd: process.cwd() },
  makeAgentDeps: async (sel) => {
    log("prepare", sel);
    if (sel.model === "executor" && scenario.startsWith("prep-")) {
      await new Promise((resolve) => setTimeout(resolve, 1800));
      log("prepare-late", sel);
      if (scenario === "prep-fail-cancel") throw new Error("fixture preparation rejected");
    }
    const { provider } = scriptedProvider([okReply]);
    const stream = provider.stream.bind(provider);
    provider.stream = (request, opts) => { log("dispatch", { model: request.modelId, selected: sel.model }); return stream(request, opts); };
    return makeDeps(provider, { providerId: sel.provider, modelId: sel.model });
  },
});
log("config-preserved", { same: JSON.stringify(loadShellConfig().routing) === initialRouting });
log("exit", { launched });
