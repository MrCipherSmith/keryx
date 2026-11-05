import path from "node:path";
import type { AgentIO } from "./agent";
import { makeProvider } from "../harness/provider/make-provider";
import type { ProviderPort } from "../harness/provider/types";
import { loadShellConfig } from "../lib/shell-config";
import { createReviewV3Host, type ReviewV3Host, type ReviewV3HostOptions } from "../review/v3-host";
import { scopedProviderCredentials } from "../review/v3-keryx-external-worker-entry";
import {
  startReviewV3TerminalHost,
  type ReviewV3TerminalHost,
} from "../review/v3-terminal-host";

const OPTIONS = new Set([
  "--project",
  "--runs-root",
  "--provider",
  "--model",
  "--config-dir",
  "--cost-mode",
  "--permission-mode",
]);

export interface ReviewV3ServeDeps {
  readonly makeProvider?: (name: string, model: string, options: Parameters<typeof makeProvider>[2]) => ProviderPort;
  readonly createHost?: (options: ReviewV3HostOptions) => ReviewV3Host;
  readonly startHost?: typeof startReviewV3TerminalHost;
  readonly waitForStop?: () => Promise<void>;
  readonly log?: (line: string) => void;
  readonly error?: (line: string) => void;
}

function parseArgs(args: readonly string[]): ReadonlyMap<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (!token.startsWith("--")) throw new Error(`Unexpected argument "${token}"`);
    const equals = token.indexOf("=");
    const key = equals === -1 ? token : token.slice(0, equals);
    if (!OPTIONS.has(key)) throw new Error(`Unknown option for review v3 serve: ${key}`);
    if (values.has(key)) throw new Error(`Option ${key} may only be supplied once`);
    const value = equals === -1 ? args[index + 1] : token.slice(equals + 1);
    if (value === undefined || value === "" || (equals === -1 && value.startsWith("--"))) throw new Error(`${key} needs a value`);
    values.set(key, value);
    if (equals === -1) index += 1;
  }
  return values;
}

function required(values: ReadonlyMap<string, string>, key: string): string {
  const value = values.get(key);
  if (value === undefined || value.trim() === "") throw new Error(`${key} is required`);
  return value;
}

function waitForTermination(): Promise<void> {
  return new Promise((resolve) => {
    const stop = (): void => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

function explicitTrustIo(): Pick<AgentIO, "beforeAction" | "requestApproval" | "permissionMode"> {
  return {
    async beforeAction(action) {
      if (action.signal?.aborted) throw action.signal.reason ?? new Error("review V3 host action aborted");
    },
    async requestApproval() { return true; },
    permissionMode: () => "trust",
  };
}

/**
 * Run the ordinary-terminal Review V3 controller host in the foreground.
 * Authority is selected only by the explicit startup flags below; request JSON
 * can operate inside that ceiling but can never widen it.
 */
export async function runReviewV3ServeCommand(
  args: readonly string[],
  deps: ReviewV3ServeDeps = {},
): Promise<number> {
  const log = deps.log ?? console.log;
  const error = deps.error ?? console.error;
  let terminal: ReviewV3TerminalHost | undefined;
  let reviewSessionOpen = false;
  let exitCode = 0;
  try {
    const values = parseArgs(args);
    const projectRoot = path.resolve(required(values, "--project"));
    const configDir = path.resolve(required(values, "--config-dir"));
    const providerName = required(values, "--provider");
    const modelId = required(values, "--model");
    const runsRoot = path.resolve(values.get("--runs-root") ?? path.join(projectRoot, ".metaproject", "reviews", "v3"));
    const costMode = required(values, "--cost-mode");
    const permissionMode = required(values, "--permission-mode");
    if (costMode !== "cost-unknown") {
      throw new Error("review v3 serve currently requires --cost-mode cost-unknown; measured cost accounting is unavailable");
    }
    if (permissionMode !== "trust") {
      throw new Error("review v3 serve requires explicit --permission-mode trust; no authority is granted by default or by request JSON");
    }

    const saved = loadShellConfig(configDir);
    const credentials = scopedProviderCredentials(providerName, configDir);
    const provider = (deps.makeProvider ?? makeProvider)(providerName, modelId, {
      fetch: globalThis.fetch,
      configDir,
      ...(providerName === "openai-codex" ? {} : { credentials }),
      ...(saved.provider === providerName && saved.baseUrl !== undefined ? { baseUrl: saved.baseUrl } : {}),
    });
    if (["fake", "fake-provider"].includes(provider.describe().descriptor.providerId)) {
      throw new Error(`configured provider ${providerName} is not authorized`);
    }

    const host = (deps.createHost ?? createReviewV3Host)({
      projectRoot,
      configDir,
      runsRoot,
    });
    const trustIo = explicitTrustIo();
    reviewSessionOpen = true;
    terminal = await (deps.startHost ?? startReviewV3TerminalHost)({
      host,
      runsRoot,
      runtime: {
        provider,
        providerId: providerName,
        modelId,
        io: () => trustIo,
        authorizeReviewV3Action: ({ signal }) => reviewSessionOpen && signal?.aborted !== true,
      },
    });
    log(JSON.stringify({
      schemaVersion: 1,
      transport: "unix",
      socketPath: terminal.socketPath,
      bearerToken: terminal.token,
      env: terminal.env,
      projectRoot,
      provider: providerName,
      model: modelId,
      costMode,
      permissionMode,
    }));
    await (deps.waitForStop ?? waitForTermination)();
  } catch (cause) {
    error(cause instanceof Error ? cause.message : String(cause));
    exitCode = 1;
  } finally {
    reviewSessionOpen = false;
    if (terminal !== undefined) {
      try {
        const result = await terminal.close();
        if (!result.stopped) {
          exitCode = 1;
          error(`review v3 serve shutdown incomplete; active runs: ${result.activeRunIds.join(", ") || "unknown"}; durable evidence and the local endpoint directory were preserved for shutdown retry`);
        }
      } catch (cause) {
        exitCode = 1;
        error(`review v3 serve shutdown failed: ${cause instanceof Error ? cause.message : String(cause)}; durable evidence and the local endpoint directory were preserved for shutdown retry`);
      }
    }
  }
  return exitCode;
}
