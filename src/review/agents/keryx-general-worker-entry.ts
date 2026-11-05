import { readFile } from "node:fs/promises";
import { makeProvider } from "../../harness/provider/make-provider";
import { loadShellConfig } from "../../lib/shell-config";
import { providerByName } from "../../commands/providers";
import { oauthEnvKeyFor } from "../../lib/oauth/grants";
import type { ReviewAgentAdapterRequest } from "./types";
import { createExternalBridgeClientFromEnv } from "./external-transport";
import { runKeryxExternalWorker } from "./keryx-general-worker";

interface WorkerArgs { requestFile: string; configDir: string; provider: string; model: string }

function parseArgs(args: readonly string[]): WorkerArgs {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (key === undefined || value === undefined || !["--request", "--config-dir", "--provider", "--model"].includes(key)) {
      throw new Error("invalid dedicated Review agents worker arguments");
    }
    values.set(key, value);
  }
  const requestFile = values.get("--request");
  const configDir = values.get("--config-dir");
  const provider = values.get("--provider");
  const model = values.get("--model");
  if ([requestFile, configDir, provider, model].some((value) => value === undefined || value.trim() === "")) {
    throw new Error("incomplete dedicated Review agents worker arguments");
  }
  return { requestFile: requestFile!, configDir: configDir!, provider: provider!, model: model! };
}

function parseRequest(text: string, signal: AbortSignal): ReviewAgentAdapterRequest {
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid external general request");
  if (typeof Reflect.get(value, "dispatchId") !== "string" || typeof Reflect.get(value, "task") !== "string") {
    throw new Error("invalid external general request");
  }
  return { ...(value as Omit<ReviewAgentAdapterRequest, "signal">), signal };
}

/** Only the selected provider's bearer enters the dedicated worker runtime. */
export function scopedProviderCredentials(provider: string, configDir: string): Record<string, string> {
  if (provider === "openai-codex" || provider === "ollama") return {};
  const saved = loadShellConfig(configDir);
  const envKey = providerByName(provider, configDir)?.envKey ?? ({
    anthropic: "ANTHROPIC_API_KEY",
    openai: "OPENAI_API_KEY",
    gemini: "GEMINI_API_KEY",
  } as const)[provider as "anthropic" | "openai" | "gemini"];
  if (envKey === undefined) return {};
  const apiKey = saved.apiKeys?.[envKey];
  if (typeof apiKey === "string" && apiKey.length > 0) return { [envKey]: apiKey };
  if (oauthEnvKeyFor(provider) === envKey) {
    const access = saved.oauthGrants?.[provider]?.access;
    if (typeof access === "string" && access.length > 0) return { [envKey]: access };
  }
  return {};
}

export async function runKeryxExternalWorkerEntry(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  const parsed = parseArgs(args);
  const abort = new AbortController();
  const onTerm = (): void => abort.abort(new Error("external general process stopped"));
  process.once("SIGTERM", onTerm);
  try {
    const request = parseRequest(await readFile(parsed.requestFile, "utf8"), abort.signal);
    const saved = loadShellConfig(parsed.configDir);
    const credentials = scopedProviderCredentials(parsed.provider, parsed.configDir);
    const provider = makeProvider(parsed.provider, parsed.model, {
      fetch: globalThis.fetch,
      configDir: parsed.configDir,
      ...(parsed.provider === "openai-codex" ? {} : { credentials }),
      ...(saved.provider === parsed.provider && saved.baseUrl !== undefined ? { baseUrl: saved.baseUrl } : {}),
    });
    if (["fake", "fake-provider"].includes(provider.describe().descriptor.providerId)) {
      throw new Error("configured provider is not authorized");
    }
    const { client } = createExternalBridgeClientFromEnv(env);
    const result = await runKeryxExternalWorker({
      request, provider, providerId: parsed.provider, modelId: parsed.model, bridge: client, signal: abort.signal,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    process.off("SIGTERM", onTerm);
  }
}

if (import.meta.main) {
  runKeryxExternalWorkerEntry(process.argv.slice(2)).catch(() => {
    console.error("dedicated Review agents external worker failed");
    process.exitCode = 1;
  });
}
