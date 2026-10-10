import { loadOAuthGrant } from "../lib/oauth/grants";
import { fetchOpenAiCodexModels } from "./subscription-models";

interface DetectedLike {
  readonly name: string;
  readonly models?: readonly string[];
}

export interface LiveCodexModels {
  /** Fetches once; never throws, never blocks the shell. Failure keeps the curated list. */
  start(): Promise<void>;
  /** The live list, or undefined while unfetched or after a failure. */
  models(): readonly string[] | undefined;
}

export interface LiveCodexModelsDeps {
  hasGrant?: () => boolean;
  fetchModels?: () => Promise<{ models: readonly string[]; source: string }>;
}

/**
 * The shell's detected catalogue names a single stale `openai-codex` model; the
 * live `/models` list (what the picker uses) is the only place the current
 * lineup exists. Tier resolution and routing check models against the detected
 * catalogue, so without this the live models are invisible to them.
 */
export function createLiveCodexModels(configDir?: string, deps: LiveCodexModelsDeps = {}): LiveCodexModels {
  const hasGrant =
    deps.hasGrant ?? (() => process.env.NODE_ENV !== "test" && loadOAuthGrant("openai-codex", configDir) !== undefined);
  const fetchModels =
    deps.fetchModels ?? (() => fetchOpenAiCodexModels(fetch, configDir === undefined ? {} : { configDir }));
  let live: readonly string[] | undefined;
  return {
    async start() {
      try {
        if (!hasGrant()) return;
        const result = await fetchModels();
        if (result.source === "live" && result.models.length > 0) live = [...result.models];
      } catch {
        // keep the curated list
      }
    },
    models: () => live,
  };
}

let shared: LiveCodexModels | undefined;

/** The process-wide instance; the first call starts the fetch in the background. */
export function startLiveCodexModels(): LiveCodexModels {
  if (shared === undefined) {
    shared = createLiveCodexModels();
    void shared.start();
  }
  return shared;
}

/** `detected` with the live Codex list replacing the curated one; the provider set itself is never widened. */
export function mergeLiveCodexModels(
  detected: readonly DetectedLike[],
  live: readonly string[] | undefined,
): { name: string; models: readonly string[] }[] {
  const out = detected.map((d) => ({ name: d.name, models: d.models ?? [] }));
  if (live === undefined || live.length === 0) return out;
  const at = out.findIndex((d) => d.name === "openai-codex");
  if (at !== -1) out[at] = { name: "openai-codex", models: live };
  return out;
}
