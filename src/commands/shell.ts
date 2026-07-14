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
import { makeProvider } from "../harness/provider/make-provider";
import type {
  NormalizedMessage,
  NormalizedRequest,
  ProviderPort,
} from "../harness/provider/types";
import { detectProviders, pickProviderModel } from "./select";

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
  /**
   * Bundled detect+pick selector for the `/models` and `/provider` (no-arg)
   * slash commands. `/models` passes `{ onlyProvider: <current provider> }` to
   * offer only the current provider's models; `/provider` passes no opts (a
   * full re-selection across all providers). When omitted, both commands
   * write a "not available" message and no-op (they NEVER crash the loop).
   */
  selectProviderModel?: (
    io: ShellIO,
    opts?: { onlyProvider?: string },
  ) => Promise<{ provider: string; model: string; baseUrl?: string }>;
}

/** A short, trusted system instruction assembled by the (trusted) shell itself. */
const SYSTEM_INSTRUCTION = "You are the keryx interactive shell assistant. Answer concisely.";

/** Static guidance for `/connect` — never reads/echoes an actual credential. */
const CONNECT_GUIDANCE = [
  "To use Anthropic (claude-*) models, set the ANTHROPIC_API_KEY environment",
  "variable before launching keryx, e.g.:",
  "",
  "  export ANTHROPIC_API_KEY=your-anthropic-key",
  "",
  "keryx reads ANTHROPIC_API_KEY from the environment only — it never stores,",
  "logs, or echoes the key. Then run /provider to pick the anthropic provider.",
  "",
].join("\n");

/** Help text listing the slash commands (must mention /model, /clear, /exit). */
const HELP_TEXT = [
  "Commands:",
  "  /help              Show this help",
  "  /model <name>      Switch the active model for subsequent turns",
  "  /models            Pick a model for the current provider (numbered menu)",
  "  /provider [name]   Switch provider by name, or (no arg) re-run full selection",
  "  /connect           Show how to set ANTHROPIC_API_KEY for anthropic models",
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

  /**
   * Apply a `{provider, model, baseUrl?}` selection from the interactive picker
   * (shared by the `/models` and no-arg `/provider` commands): update the active
   * selection and recreate the provider. Behavior-preserving extraction.
   */
  const applySelection = (picked: { provider: string; model: string; baseUrl?: string }): void => {
    providerName = picked.provider;
    modelName = picked.model;
    baseUrl = picked.baseUrl;
    provider = makeActive();
  };

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
      if (command === "/models") {
        if (deps.selectProviderModel === undefined) {
          io.write("Interactive model selection is not available in this session.\n");
          continue;
        }
        const picked = await deps.selectProviderModel(io, { onlyProvider: providerName });
        applySelection(picked);
        continue;
      }
      if (command === "/provider") {
        if (argument.length > 0) {
          // Explicit by-name switch (keeps the model + baseUrl selection).
          providerName = argument;
          provider = makeActive();
          continue;
        }
        if (deps.selectProviderModel === undefined) {
          io.write("Interactive provider selection is not available in this session.\n");
          continue;
        }
        // Pass an empty opts object (no `onlyProvider`) → full re-selection.
        const picked = await deps.selectProviderModel(io, {});
        applySelection(picked);
        continue;
      }
      if (command === "/connect") {
        io.write(CONNECT_GUIDANCE);
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

    // Terminate the streamed reply with a blank line so consecutive turns are
    // visually separated instead of running together on one line.
    io.write("\n\n");
  }
}

/**
 * Build the `makeProvider` factory mirroring `harness.ts`'s provider selection.
 * Construction is delegated to the shared `makeProvider` factory (review-polish
 * item B); the shell adds ONLY its own UX note when anthropic is selected
 * without a credential (before falling back to the offline provider).
 */
function realMakeProvider(write: (s: string) => void): ShellDeps["makeProvider"] {
  return (name: string, model: string, baseUrl?: string): ProviderPort => {
    if (name === "anthropic") {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (apiKey === undefined || apiKey.length === 0) {
        write(
          "ANTHROPIC_API_KEY is not set: the anthropic provider needs a credential; using an offline no-op provider for this session.\n",
        );
      }
    }
    return makeProvider(name, model, {
      fetch: globalThis.fetch,
      ...(baseUrl !== undefined ? { baseUrl } : {}),
    });
  };
}

/** Build the bundled detect+pick selector wired to real `fetch` + `process.env`. */
function realSelectProviderModel(baseUrl: string | undefined): NonNullable<ShellDeps["selectProviderModel"]> {
  return async (io, opts) => {
    const detected = await detectProviders({
      fetch: globalThis.fetch,
      env: process.env,
      ...(baseUrl !== undefined ? { baseUrl } : {}),
    });
    const filtered =
      opts?.onlyProvider !== undefined ? detected.filter((d) => d.name === opts.onlyProvider) : detected;
    const list = filtered.length > 0 ? filtered : detected;
    return pickProviderModel(io, list);
  };
}

/**
 * Thin TTY wrapper (NOT unit-tested): parses `--provider` / `--model` /
 * `--base-url`, wires a real `node:readline` stdin line source + a
 * `process.stdout` sink, and runs the deterministic core.
 *
 * When `--provider` is ABSENT, it first detects the available providers and
 * runs the interactive numbered picker (replacing any hardcoded default). When
 * `--provider X` is given, the picker is skipped: the model is `--model Y` if
 * given, otherwise that provider's first detected model.
 */
export async function shellCommand(args: string[]): Promise<void> {
  let providerArg: string | undefined;
  let modelArg: string | undefined;
  let baseUrl: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--provider") {
      providerArg = args[++i] ?? providerArg;
    } else if (arg === "--model") {
      modelArg = args[++i] ?? modelArg;
    } else if (arg === "--base-url") {
      baseUrl = args[++i];
    }
  }

  const write = (s: string): void => {
    process.stdout.write(s);
  };
  const rl = readline.createInterface({ input: process.stdin });
  // A SINGLE shared line iterator so the picker and the REPL consume stdin in
  // sequence (two independent iterators would race over the same readline).
  const lineIterator = rl[Symbol.asyncIterator]();
  const sharedLines: AsyncIterable<string> = { [Symbol.asyncIterator]: () => lineIterator };
  const io: ShellIO = { lines: sharedLines, write };

  let provider: string;
  let model: string;
  try {
    if (providerArg === undefined) {
      // No provider flag: detect + interactively pick.
      const detected = await detectProviders({
        fetch: globalThis.fetch,
        env: process.env,
        ...(baseUrl !== undefined ? { baseUrl } : {}),
      });
      const picked = await pickProviderModel(io, detected);
      provider = picked.provider;
      model = picked.model;
      if (picked.baseUrl !== undefined) {
        baseUrl = picked.baseUrl;
      }
    } else {
      provider = providerArg;
      if (modelArg !== undefined) {
        model = modelArg;
      } else {
        // Resolve the provider's first detected model (no hardcoded default).
        const detected = await detectProviders({
          fetch: globalThis.fetch,
          env: process.env,
          ...(baseUrl !== undefined ? { baseUrl } : {}),
        });
        const match = detected.find((d) => d.name === providerArg);
        model = match?.models[0] ?? "fake-echo";
      }
    }

    const deps: ShellDeps = {
      makeProvider: realMakeProvider(write),
      clock: () => new Date().toISOString(),
      idSeq: () => randomUUID(),
      initial: baseUrl === undefined ? { provider, model } : { provider, model, baseUrl },
      selectProviderModel: realSelectProviderModel(baseUrl),
    };

    write(`keryx shell — ${provider}/${model}${baseUrl !== undefined ? ` (${baseUrl})` : ""}\n`);
    write("Type a message, or /help for commands.\n");

    await runShell(io, deps);
  } finally {
    rl.close();
  }
}
