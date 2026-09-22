// `keryx acp` — Agent Client Protocol agent server over stdio (flow 285).
//
// Speaks newline-delimited JSON-RPC 2.0 on stdin/stdout (`../acp/framing.ts`)
// and answers `initialize`, `session/new`, `session/prompt`, `session/cancel`,
// `session/list` and `session/load` (`../acp/server.ts`); every other agent
// method ACP defines is refused with `-32601` (`../acp/protocol.ts`'s
// `ACP_REFUSED_AGENT_METHODS`). Nothing but protocol frames may ever reach
// stdout — every diagnostic below goes to stderr, matching the transport's
// own MUST NOT ("a stray console.log corrupts the stream", `context.md` §0).

import { randomUUID } from "node:crypto";
import { runAcpServer, type AcpTurnSettings } from "../acp/server";
import { loadAcpFixtureProvider } from "../acp/fixture-provider";
import { FakeProvider } from "../harness/provider/fake-provider";
import type { ProviderPort } from "../harness/provider/types";
import { loadShellConfig, shellConfigPath } from "../lib/shell-config";
import { resolveAgentMaxOutputTokens, resolveReasoningEffort } from "./agent";
import { resolveProviderModelParamsByName } from "./providers";
import { GRANT_REFRESH_TIMEOUT_MS, realMakeProvider, resolveTuiStartup } from "./shell";
import packageJson from "../../package.json" with { type: "json" };

export interface ParsedAcpArgs {
  /** `undefined` = no flag: resolved the way `keryx shell` resolves it (see `resolveAcpProvider`). */
  provider?: string;
  model?: string;
  baseUrl?: string;
  /** Test-only: a deterministic scripted provider (`../acp/fixture-provider.ts`), never used in production. */
  fixture?: string;
  dataDir?: string;
}

export function parseAcpArgs(args: readonly string[]): ParsedAcpArgs {
  const parsed: ParsedAcpArgs = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const value = args[i + 1];
    if (arg === "--provider") {
      if (value !== undefined) parsed.provider = value;
      i += 1;
    } else if (arg === "--model") {
      if (value !== undefined) parsed.model = value;
      i += 1;
    } else if (arg === "--base-url") {
      if (value !== undefined) parsed.baseUrl = value;
      i += 1;
    } else if (arg === "--fixture") {
      if (value !== undefined) parsed.fixture = value;
      i += 1;
    } else if (arg === "--data-dir") {
      if (value !== undefined) parsed.dataDir = value;
      i += 1;
    }
  }
  return parsed;
}

/**
 * What `keryx acp` will run turns against — or why it will run none.
 *
 * `unconfigured` is a first-class outcome, not an exception: the server still
 * starts and still answers `initialize` (a client that cannot even initialise
 * shows the operator nothing), and refuses `session/new`/`session/load` with
 * `message`, which names what to configure and how (flow 287, AC2).
 */
export type AcpProviderResolution =
  | {
      readonly kind: "ready";
      readonly provider: ProviderPort;
      readonly providerId: string;
      readonly modelId: string;
      /** Where the pair came from — for the stderr line and for tests. */
      readonly source: "flags" | "shell-config" | "fixture";
      /**
       * The per-turn settings `keryx shell` applies to this provider, resolved
       * by the shell's own resolvers (see `resolveAcpTurnSettings`).
       */
      readonly turnSettings: AcpTurnSettings;
    }
  | { readonly kind: "unconfigured"; readonly message: string };

export interface ResolveAcpProviderDeps {
  /** `auth.json`'s directory; the per-user config directory otherwise. The test seam. */
  readonly configDir?: string | undefined;
  /** Provider construction; `keryx shell`'s own factory (`realMakeProvider`) otherwise. */
  readonly makeProvider?: (name: string, model: string, baseUrl?: string) => ProviderPort;
  /**
   * Refreshes saved OAuth grants BEFORE the selection is resolved; returns
   * warnings. `provider` is the flag's provider, or `undefined` for "every
   * grant a session refreshes" — exactly the list `keryx shell` passes.
   */
  readonly refreshGrants?: (provider: string | undefined, configDir: string | undefined) => Promise<readonly string[]>;
  /** Where refresh warnings go. stderr in the CLI. */
  readonly warn?: (line: string) => void;
  /** Fixture loading, for `--fixture` only. */
  readonly loadFixture?: (path: string) => ProviderPort;
}

/**
 * Resolve the provider and model for `keryx acp` (flow 287, AC1/AC2).
 *
 * THE SAME PATH `keryx shell` TAKES, CALLED — NOT COPIED. `resolveTuiStartup`
 * (`./shell.ts`) is what the default (TUI) shell surface resolves its first
 * selection with: `--provider` + `--model` when both are given, otherwise the
 * provider/model `keryx shell` persisted in `auth.json` the last time the
 * operator picked one, with saved API keys loaded into the environment the same
 * way. The provider is then built by the shell's own factory
 * (`realMakeProvider`), which is what hands a saved OAuth grant to the
 * provider as its credential — so a login done in the shell works here too.
 *
 * The one step of the shell's path this does NOT take is its last one: with no
 * flags and no saved selection the shell DETECTS providers and asks the
 * operator to pick. There is no one to ask over this wire — an ACP client is
 * mid-`initialize` and has no picker — so `detect` answers nothing and "no
 * selection" becomes `unconfigured` with the remedy spelled out, instead of a
 * guess.
 *
 * NEVER A FAKE (AC1/AC2). `makeProvider` fails closed to the offline
 * `FakeProvider` for a name it does not know or a provider with no credential;
 * that object answers nothing and is exactly what the first live client hit.
 * Such a result is discarded here and reported as `unconfigured` — no turn is
 * ever run against it. `--provider fake` is refused the same way: the scripted
 * provider is reachable only through the explicit, test-only `--fixture`.
 */
export async function resolveAcpProvider(
  parsed: ParsedAcpArgs,
  deps: ResolveAcpProviderDeps = {},
): Promise<AcpProviderResolution> {
  if (parsed.fixture !== undefined) {
    const load = deps.loadFixture ?? loadAcpFixtureProvider;
    return {
      kind: "ready",
      provider: load(parsed.fixture),
      providerId: parsed.provider ?? "fixture",
      modelId: parsed.model ?? "fixture-model",
      source: "fixture",
      turnSettings: {},
    };
  }

  const configFile = shellConfigPath(deps.configDir);
  const remedy =
    "run `keryx shell` once in a terminal and pick a provider and model (the choice is saved to " +
    `${configFile} and reused here), or add \`--provider <name> --model <model>\` to the args your ACP client ` +
    "launches `keryx acp` with";

  // Half a pair is a selection that never existed (same rule as
  // `resolveCallerSession`). The shell would silently fall back to its saved
  // selection and ignore the flag; here the operator typed the flag into their
  // editor's agent settings, so saying so beats quietly running something else.
  if ((parsed.provider === undefined) !== (parsed.model === undefined)) {
    const given = parsed.provider !== undefined ? "--provider" : "--model";
    const missing = parsed.provider !== undefined ? "--model" : "--provider";
    return {
      kind: "unconfigured",
      message: `keryx acp: ${given} was given without ${missing}; pass both, or neither to use keryx shell's saved selection`,
    };
  }

  // REFRESH FIRST, the shell's order (`shellCommand` refreshes before any
  // surface resolves its selection). `resolveTuiStartup` below runs
  // `applySavedApiKeys`, which copies a saved grok/copilot access token into
  // `process.env` (`XAI_API_KEY`/`GITHUB_COPILOT_TOKEN`); a refresh AFTER it
  // writes the new token only to `auth.json`, the provider factory then sees a
  // non-empty env key and uses the stale token, and the first turn fails.
  const refresh = deps.refreshGrants;
  if (refresh !== undefined) {
    for (const warning of await refresh(parsed.provider, deps.configDir)) {
      deps.warn?.(warning);
    }
  }

  const startup = await resolveTuiStartup({
    providerArg: parsed.provider,
    modelArg: parsed.model,
    baseUrl: parsed.baseUrl,
    // No picker over this wire — see the doc comment above.
    detect: async () => [],
    configDir: deps.configDir,
  });
  const initial = startup.initial;
  if (initial === undefined) {
    return {
      kind: "unconfigured",
      message: `keryx acp: no provider is configured — ${remedy}`,
    };
  }
  const source = parsed.provider !== undefined ? "flags" : "shell-config";
  const sourceLabel = source === "flags" ? "from --provider/--model" : `saved by keryx shell in ${configFile}`;

  if (initial.provider === "fake") {
    return {
      kind: "unconfigured",
      message:
        `keryx acp: provider "fake" (${sourceLabel}) is an offline test double and is never used to answer an ` +
        `editor; ${remedy}`,
    };
  }

  const make = deps.makeProvider ?? realMakeProvider(() => {});
  const provider = make(initial.provider, initial.model, initial.baseUrl);
  if (provider instanceof FakeProvider) {
    return {
      kind: "unconfigured",
      message:
        `keryx acp: provider "${initial.provider}" (model "${initial.model}", ${sourceLabel}) has no usable ` +
        "credential or is not a provider keryx knows — export its API key, or save one with `/connect` or " +
        `\`keryx auth login ${initial.provider}\`; otherwise ${remedy}`,
    };
  }
  return {
    kind: "ready",
    provider,
    providerId: initial.provider,
    modelId: initial.model,
    source,
    turnSettings: resolveAcpTurnSettings(initial.provider, deps.configDir),
  };
}

/**
 * The per-turn settings `keryx shell` applies at launch for `provider`, by the
 * same three resolvers its `makeAgentDeps` calls: per-provider
 * `temperature`/`maxOutputTokens`/`timeoutMs` (`resolveProviderModelParamsByName`),
 * the output-token budget (`resolveAgentMaxOutputTokens`: env > provider >
 * saved global > default) and the reasoning effort (`resolveReasoningEffort`:
 * env > saved global > off). The shell's in-session `/reasoning` override has
 * no ACP equivalent, so it is simply absent here.
 */
export function resolveAcpTurnSettings(provider: string, configDir?: string): AcpTurnSettings {
  const saved = loadShellConfig(configDir);
  const modelParams = resolveProviderModelParamsByName(provider, saved, configDir);
  return {
    ...(Object.keys(modelParams).length > 0 ? { modelParams } : {}),
    maxOutputTokens: resolveAgentMaxOutputTokens({
      providerMaxOutputTokens: modelParams.maxOutputTokens,
      globalMaxOutputTokens: saved.maxOutputTokens,
    }),
    reasoningEffort: resolveReasoningEffort({ globalEffort: saved.reasoningEffort }),
  };
}

/**
 * The CLI's grant refresh: `keryx shell`'s own `refreshSavedGrants`, bounded
 * by the shell's own timeout, for the flag's provider or — with no flag — the
 * shell's default list. `fetchImpl` is the test seam for the token endpoint.
 */
export function shellGrantRefresh(
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response> = (input, init) => globalThis.fetch(input, init),
  now?: () => number,
): NonNullable<ResolveAcpProviderDeps["refreshGrants"]> {
  return async (provider, configDir) => {
    const { refreshSavedGrants } = await import("../lib/oauth/login");
    return refreshSavedGrants(
      { fetch: fetchImpl, signal: AbortSignal.timeout(GRANT_REFRESH_TIMEOUT_MS), ...(now !== undefined ? { now } : {}) },
      configDir,
      ...(provider === undefined ? [] : [[provider]]),
    );
  };
}

export async function acpCommand(args: string[]): Promise<void> {
  if (args[0] === "help" || args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }
  const parsed = parseAcpArgs(args);
  const logError = (line: string): void => {
    process.stderr.write(`${line}\n`);
  };
  const resolution = await resolveAcpProvider(parsed, {
    // The same bounded refresh `keryx shell` runs before any surface builds a
    // provider from a stored grant (K-013).
    refreshGrants: shellGrantRefresh(),
    warn: (line) => logError(`keryx: ${line}`),
  });
  if (resolution.kind === "unconfigured") {
    // AC2: said ONCE, at startup, on stderr — and again, on the wire, to every
    // session/new or session/load the client sends.
    logError(resolution.message);
  }

  // SIGTERM/SIGINT (flow 287): an editor stops its agent by signalling it more
  // often than by closing stdin. The default action would kill keryx at once
  // and leave every client MCP server it started running. Instead the server
  // is told to shut down — which stops those servers and waits for them — and
  // the process then exits with the conventional 128+signal status. A second
  // signal while that runs exits immediately.
  //
  // SIGKILL cannot be handled, and a process-group sweep is not cheap here: the
  // SDK spawns each server in keryx's own process group (not detached), so a
  // client that kills the GROUP takes them down too, and one that kills only
  // keryx's pid closes their stdin — a conforming stdio MCP server exits on
  // EOF. A server that ignores EOF outlives a SIGKILL; that limit is documented.
  const shutdown = new AbortController();
  let signalled: NodeJS.Signals | undefined;
  const onSignal = (signal: NodeJS.Signals): void => {
    if (signalled !== undefined) {
      process.exit(signal === "SIGINT" ? 130 : 143);
    }
    signalled = signal;
    shutdown.abort();
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  try {
    await runAcpServer({
      shutdown: shutdown.signal,
      input: process.stdin,
      write: (chunk) => {
        process.stdout.write(chunk);
      },
      logError,
      ...(resolution.kind === "ready"
        ? {
            provider: resolution.provider,
            providerId: resolution.providerId,
            modelId: resolution.modelId,
            turnSettings: resolution.turnSettings,
          }
        : { providerUnavailable: resolution.message, providerId: "", modelId: "" }),
      agentInfo: { name: "keryx", version: packageJson.version },
      ...(parsed.dataDir !== undefined ? { dataDir: parsed.dataDir } : {}),
      idSeq: () => randomUUID(),
    });
  } finally {
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
  }
  if (signalled !== undefined) {
    // stdin is still being read by nothing that will return; exit explicitly.
    process.exit(signalled === "SIGINT" ? 130 : 143);
  }
}

function printHelp(): void {
  console.log(`keryx acp

Speak the Agent Client Protocol (ACP) v1 over stdio: newline-delimited
JSON-RPC 2.0 on stdin, the same framing on stdout. Launch this as a
subprocess from an ACP client (an editor, e.g.) — it answers initialize,
session/new, session/prompt (streaming session/update notifications as a
turn runs rather than only at the end), session/cancel, session/list and
session/load; every other agent method ACP defines is refused with -32601.

Provider and model: --provider and --model (both, or neither) pick the
backend. Without them keryx acp uses the provider and model keryx shell
last saved, with the shell's saved per-provider settings — run keryx shell
once and pick one. With nothing saved or no
credential for it, initialize still works and session/new is refused with
a message saying what to configure.

MCP servers: stdio entries in session/new / session/load mcpServers are
started (sessions sending the same list share one set) and stopped when
the connection closes or keryx acp gets SIGTERM/SIGINT; their
tools are offered through search_tool/use_tool, and every use_tool call is
asked through session/request_permission. http/sse entries are not started
and are reported, as is a server that fails to start.

A gated tool call is asked through session/request_permission — only an
explicit allow runs it. Writes and shell execution always stay local; there
is no fs/write_text_file or terminal/* call in this release. Nothing but
protocol frames is ever written to stdout; every diagnostic goes to stderr.

Usage:
  keryx acp [--provider <p> --model <m>] [--base-url <url>] [--data-dir <dir>]
`);
}
