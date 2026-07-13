// Interactive `keryx` shell REPL (flow 021, T6 / AC1-AC4).
//
// `runShell(io, deps)` is the injectable, deterministic REPL core: it reaches NO
// real `process.stdin`/`process.stdout`/TTY. `io` supplies an async line source
// + a write sink; `deps` supplies a `ProviderPort` factory + `clock`/`idSeq` +
// the initial provider/model selection. It keeps an in-memory
// `history: NormalizedMessage[]` (empty at start) and turns each non-slash line
// into one provider streaming turn — see `.metaproject/flows/
// 021-2026-07-13-keryx-interactive-shell/acceptance-criteria.md` (AC1-AC2).
//
// `shellCommand(args)` is the thin TTY wrapper (NOT unit-tested): it wires a real
// `node:readline` line source over `process.stdin`, a `process.stdout` write
// sink, a wall-clock `clock`, a uuid `idSeq`, and a `makeProvider` factory that
// mirrors `harness.ts`'s provider selection (fake / ollama loopback grant /
// anthropic-with-ANTHROPIC_API_KEY). It writes NO managed flow state.
//
// Determinism: `runShell` uses ONLY `deps.clock`/`deps.idSeq` (never `Date.now`
// / `Math.random`). Offline: the core never imports a provider SDK or touches
// the network directly; all provider I/O flows through the injected port.

import { randomUUID } from "node:crypto";
import * as readline from "node:readline";
import { AnthropicProvider } from "../harness/provider/anthropic/anthropic-provider";
import { FakeProvider } from "../harness/provider/fake-provider";
import { OllamaProvider } from "../harness/provider/ollama/ollama-provider";
import type {
  NormalizedMessage,
  NormalizedRequest,
  ProviderPort,
} from "../harness/provider/types";

/** Async line source + write sink; no real stdio is reached by `runShell`. */
export interface ShellIO {
  lines: AsyncIterable<string>;
  write: (s: string) => void;
}

/** Injected dependencies keeping `runShell` deterministic + offline. */
export interface ShellDeps {
  makeProvider: (name: string, model: string, baseUrl?: string) => ProviderPort;
  clock: () => string;
  idSeq: () => string;
  initial: { provider: string; model: string; baseUrl?: string };
}

/** A short, trusted system instruction assembled by the (trusted) shell itself. */
const SYSTEM_INSTRUCTION = "You are the keryx interactive shell assistant. Answer concisely.";

/** Help text listing the slash commands (must mention /model, /clear, /exit). */
const HELP_TEXT = [
  "Commands:",
  "  /help              Show this help",
  "  /model <name>      Switch the active model for subsequent turns",
  "  /provider <name>   Switch the active provider for subsequent turns",
  "  /clear             Clear the conversation history",
  "  /exit, /quit       Leave the shell",
  "",
].join("\n");

/**
 * The injectable REPL core. Iterates `io.lines`; slash commands are handled
 * inline (never call `provider.stream`), every other non-blank line is one
 * streaming turn whose request carries the FULL accumulated history.
 */
export async function runShell(io: ShellIO, deps: ShellDeps): Promise<void> {
  const history: NormalizedMessage[] = [];
  let providerName = deps.initial.provider;
  let modelName = deps.initial.model;
  let baseUrl = deps.initial.baseUrl;
  const parentRunId = deps.idSeq();

  const makeActive = (): ProviderPort =>
    baseUrl === undefined
      ? deps.makeProvider(providerName, modelName)
      : deps.makeProvider(providerName, modelName, baseUrl);

  // Create once at start; recreated on `/model` / `/provider` switches below.
  let provider = makeActive();

  for await (const line of io.lines) {
    // Slash commands FIRST — a slash line NEVER reaches `provider.stream`.
    if (line.startsWith("/")) {
      const parts = line.trim().split(/\s+/);
      const command = parts[0] ?? "";
      const argument = parts[1] ?? "";

      if (command === "/exit" || command === "/quit") {
        return;
      }
      if (command === "/help") {
        io.write(HELP_TEXT);
        continue;
      }
      if (command === "/clear") {
        history.length = 0;
        continue;
      }
      if (command === "/model") {
        if (argument.length > 0) {
          modelName = argument;
          provider = makeActive();
        }
        continue;
      }
      if (command === "/provider") {
        if (argument.length > 0) {
          providerName = argument;
          provider = makeActive();
        }
        continue;
      }
      io.write(`Unknown command: ${command}. Type /help for commands.\n`);
      continue;
    }

    // A blank line is a no-op (never an empty model turn).
    if (line.trim().length === 0) {
      continue;
    }

    // A normal line is one turn: push the user message, then stream a reply.
    history.push({ role: "user", content: line, provenance: "project" });

    const request: NormalizedRequest = {
      providerId: providerName,
      modelId: modelName,
      systemInstruction: SYSTEM_INSTRUCTION,
      messages: [...history],
      budget: { maxOutputTokens: 1024, runReservation: 1024 },
      stream: true,
      requestId: deps.idSeq(),
      parentRunId,
    };

    let accumulated = "";
    let errored = false;
    try {
      for await (const event of provider.stream(request, { attemptId: deps.idSeq() })) {
        if (event.kind === "text_delta") {
          const text = event.text ?? "";
          io.write(text);
          accumulated += text;
        } else if (event.kind === "provider_error") {
          const detail = event.error?.message ?? event.error?.kind ?? "provider error";
          io.write(`\n[error] ${detail}\n`);
          errored = true;
          break;
        } else if (event.kind === "model_end") {
          break;
        }
      }
    } catch (cause) {
      // A reused adapter emits `provider_error` events rather than throwing, but
      // guard against an unexpected throw so one bad turn never ends the session.
      io.write(`\n[error] ${cause instanceof Error ? cause.message : String(cause)}\n`);
      errored = true;
    }

    if (!errored) {
      history.push({ role: "assistant", content: accumulated, provenance: "model" });
    } else if (accumulated.length > 0) {
      // A partial reply streamed before the error: keep it so the history stays
      // strictly alternating (user → assistant).
      history.push({ role: "assistant", content: accumulated, provenance: "model" });
    } else {
      // No reply at all: drop the just-pushed user message so a failed turn leaves
      // no dangling user message (two consecutive user-role messages are rejected
      // by strict providers like the Anthropic Messages API).
      history.pop();
    }
  }
}

/** Build the `makeProvider` factory mirroring `harness.ts`'s provider selection. */
function realMakeProvider(write: (s: string) => void): ShellDeps["makeProvider"] {
  return (name: string, _model: string, baseUrl?: string): ProviderPort => {
    if (name === "anthropic") {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (apiKey === undefined || apiKey.length === 0) {
        write(
          "ANTHROPIC_API_KEY is not set: the anthropic provider needs a credential; using an offline no-op provider for this session.\n",
        );
        return new FakeProvider([]);
      }
      return new AnthropicProvider({ fetch: globalThis.fetch, grant: { network: true, apiKey } });
    }
    if (name === "ollama") {
      return new OllamaProvider({
        fetch: globalThis.fetch,
        grant: { network: true, allowLoopback: true, ...(baseUrl !== undefined ? { baseUrl } : {}) },
      });
    }
    return new FakeProvider([]);
  };
}

/**
 * Thin TTY wrapper (NOT unit-tested): parses `--provider` / `--model` /
 * `--base-url`, wires a real `node:readline` stdin line source + a
 * `process.stdout` sink, and runs the deterministic core.
 */
export async function shellCommand(args: string[]): Promise<void> {
  let provider = "ollama";
  let model = "llama3.1:latest";
  let baseUrl: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--provider") {
      provider = args[++i] ?? provider;
    } else if (arg === "--model") {
      model = args[++i] ?? model;
    } else if (arg === "--base-url") {
      baseUrl = args[++i];
    }
  }

  const write = (s: string): void => {
    process.stdout.write(s);
  };
  const rl = readline.createInterface({ input: process.stdin });
  const io: ShellIO = { lines: rl, write };
  const deps: ShellDeps = {
    makeProvider: realMakeProvider(write),
    clock: () => new Date().toISOString(),
    idSeq: () => randomUUID(),
    initial: baseUrl === undefined ? { provider, model } : { provider, model, baseUrl },
  };

  write(`keryx shell — ${provider}/${model}${baseUrl !== undefined ? ` (${baseUrl})` : ""}\n`);
  write("Type a message, or /help for commands.\n");

  try {
    await runShell(io, deps);
  } finally {
    rl.close();
  }
}
