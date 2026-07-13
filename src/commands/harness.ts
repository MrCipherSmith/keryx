// `keryx harness run` CLI command (flow 020, T6 / AC4).
//
// `harnessCommand` parses `run --provider <fake|anthropic|ollama> --model <m>
// [--base-url <url>] "<prompt>"`, selects the provider, assembles the W7
// `runOffline` loop with real (or injected) clock/id deps + a read-only policy
// profile, and prints ONE JSON blob `{events, text, completion, evidence}` as
// its LAST `console.log`.
//
// Fail-closed posture: the `anthropic` provider without `ANTHROPIC_API_KEY`
// (read from `deps.env ?? process.env`) prints a clear message and RETURNS
// before any network or `runOffline` call. Any thrown error from a live run is
// caught into a structured (non-throwing) result. This command NEVER persists
// managed flow state.
//
// Determinism: `fetch`/`clock`/`idSeq`/`env` are injectable via `deps` so a test
// invocation stays fully offline; a real CLI invocation supplies none and falls
// back to `globalThis.fetch` / wall-clock / a uuid sequence / `process.env`.

import { createHash, randomUUID } from "node:crypto";
import type { HarnessConfig } from "../harness/config";
import { AnthropicProvider } from "../harness/provider/anthropic/anthropic-provider";
import { FakeProvider } from "../harness/provider/fake-provider";
import { OllamaProvider } from "../harness/provider/ollama/ollama-provider";
import type { NormalizedEvent, ProviderPort } from "../harness/provider/types";
import type { PolicyProfile } from "../harness/policy/types";
import { type RunDeps, type RunResult, runOffline } from "../harness/run/run";
import { ToolRegistry } from "../harness/tool/registry";
import type { ToolExecutorPort, ToolInvocation, ToolResult } from "../harness/tool/types";
import type { HarnessRunInput } from "../harness/types";

/** Injected, all-optional dependencies keeping a test run offline + deterministic. */
export interface HarnessCommandDeps {
  fetch?: typeof fetch;
  clock?: () => string;
  idSeq?: () => string;
  env?: Record<string, string | undefined>;
}

/** The structured result the command prints as its final JSON blob. */
interface StructuredResult {
  events: NormalizedEvent[];
  text: string;
  completion: unknown;
  evidence: string[];
}

interface ParsedArgs {
  provider: string;
  model: string;
  baseUrl?: string;
  prompt: string;
}

function sha256Hex(input: string): string {
  // Small stable fingerprint for the read-only profile — node built-in only.
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** A read-only-review profile (defaults.read = "allow"), per policy-profile.schema.json. */
function readOnlyProfile(): PolicyProfile {
  return {
    schemaVersion: 1,
    profileId: "read-only-review",
    profileVersion: "1.0.0",
    fingerprint: sha256Hex("read-only-review:1.0.0"),
    trustMode: "read-only",
    defaults: { read: "allow", write: "deny", shell: "deny", network: "deny", delegate: "deny" },
    requiredControls: { isolation: "not-required", redactionFailure: "deny", networkBrokerFailure: "deny" },
  };
}

/**
 * A minimal tool executor. Release 0 CLI runs register no tools, so a model that
 * requests one produces an unregistered call the run loop skips; this executor is
 * the fail-closed floor if one is ever reached (it never succeeds silently).
 */
const denyingExecutor: ToolExecutorPort = {
  invoke: async (invocation: ToolInvocation): Promise<ToolResult> => {
    throw new Error(`no tool executor is configured for the harness CLI: ${invocation.call.toolName}`);
  },
};

/** Parse `run --provider <p> --model <m> [--base-url <url>] "<prompt>"`. */
function parseArgs(args: string[]): ParsedArgs {
  let provider = "";
  let model = "";
  let baseUrl: string | undefined;
  const positional: string[] = [];

  // args[0] is the "run" subcommand.
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--provider") {
      provider = args[++i] ?? "";
    } else if (arg === "--model") {
      model = args[++i] ?? "";
    } else if (arg === "--base-url") {
      baseUrl = args[++i];
    } else if (arg !== undefined) {
      positional.push(arg);
    }
  }

  const parsed: ParsedArgs = { provider, model, prompt: positional.join(" ") };
  if (baseUrl !== undefined) parsed.baseUrl = baseUrl;
  return parsed;
}

/** Fold the terminal `RunResult` into the printed structured result. */
function toStructured(result: RunResult): StructuredResult {
  const text = result.events
    .filter((event) => event.kind === "text_delta")
    .map((event) => event.text ?? "")
    .join("");
  return {
    events: result.events,
    text,
    completion: result.output.gate,
    evidence: result.output.artifacts,
  };
}

export async function harnessCommand(args: string[], deps?: HarnessCommandDeps): Promise<void> {
  const subcommand = args[0];
  if (subcommand !== "run") {
    console.log('Usage: keryx harness run --provider <fake|anthropic|ollama> --model <m> [--base-url <url>] "<prompt>"');
    return;
  }

  const { provider, model, baseUrl, prompt } = parseArgs(args);

  // UX guard (flow 021, T5 / AC4): an invalid/empty --provider or an empty
  // prompt prints the usage line and returns BEFORE building input or running
  // runOffline — never a blocked/failed structured run result.
  const validProviders = new Set(["fake", "anthropic", "ollama"]);
  if (!validProviders.has(provider) || prompt.length === 0) {
    console.log('Usage: keryx harness run --provider <fake|anthropic|ollama> --model <m> [--base-url <url>] "<prompt>"');
    return;
  }

  const env = deps?.env ?? process.env;
  const clock = deps?.clock ?? (() => new Date().toISOString());
  let idCounter = 0;
  const idSeq = deps?.idSeq ?? (() => `${randomUUID()}-${idCounter++}`);
  const fetchImpl = deps?.fetch ?? globalThis.fetch;

  // Select the provider (fail-closed BEFORE any network for anthropic w/o key).
  let providerPort: ProviderPort;
  if (provider === "anthropic") {
    const apiKey = env.ANTHROPIC_API_KEY;
    if (apiKey === undefined || apiKey.length === 0) {
      console.log(
        "ANTHROPIC_API_KEY is not set: the anthropic provider is required to have a credential and fails closed (no network was contacted).",
      );
      return;
    }
    providerPort = new AnthropicProvider({ fetch: fetchImpl, grant: { network: true, apiKey } });
  } else if (provider === "ollama") {
    providerPort = new OllamaProvider({
      fetch: fetchImpl,
      grant: { network: true, allowLoopback: true, ...(baseUrl !== undefined ? { baseUrl } : {}) },
    });
  } else {
    // Default / "fake": the offline W6 replay provider (no transcripts wired in
    // the CLI, so a missing-fixture match surfaces as a caught structured result).
    providerPort = new FakeProvider([]);
  }

  const input: HarnessRunInput = {
    schemaVersion: 1,
    request: prompt,
    projectRoot: process.cwd(),
    role: "build",
    policy: "read-only-review",
    budget: { maxSeconds: 60, maxToolCalls: 5, maxRetries: 1 },
    provider,
    model,
    // A local-only startup precondition (never schema-validated); its presence
    // lets startup proceed so the selected provider actually streams.
    credentialRef: provider === "anthropic" ? "anthropic-key" : `${provider}-local`,
  };
  const config: HarnessConfig = {
    schemaVersion: 1,
    enabled: true,
    defaultRole: "build",
    defaultProvider: provider,
    defaultModel: model,
    policyProfile: "read-only-review",
    limits: { maxRunSeconds: 300, maxConcurrentChildren: 1, maxToolOutputBytes: 65_536, maxRetries: 1 },
  };
  const runDeps: RunDeps = {
    provider: providerPort,
    toolRegistry: new ToolRegistry(),
    toolExecutor: denyingExecutor,
    policyProfile: readOnlyProfile(),
    clock,
    idSeq,
    interactive: false,
  };

  let structured: StructuredResult;
  try {
    const result = await runOffline(input, config, runDeps);
    structured = toStructured(result);
  } catch (error) {
    // Never let a live/replay failure escape as an uncaught exception: fold it
    // into a structured, non-throwing result.
    structured = {
      events: [],
      text: "",
      completion: { status: "failed", passed: false, reason: error instanceof Error ? error.message : String(error) },
      evidence: [],
    };
  }

  console.log(JSON.stringify(structured));
}
