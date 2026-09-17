import { loadShellConfig } from "./shell-config";

/** Where a caller's session provider/model came from. */
export type SessionSource = "flags" | "env" | "shell-config" | "none";

export type CallerSession = {
  readonly providerId: string;
  readonly modelId: string;
  readonly source: SessionSource;
};

export type ResolveCallerSessionInput = {
  readonly flagProvider?: string | undefined;
  readonly flagModel?: string | undefined;
  /** Opt in to the selection `keryx shell` persisted. Off by default. */
  readonly fromShellConfig?: boolean | undefined;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  /** Config directory seam for tests; the per-user directory otherwise. */
  readonly configDir?: string | undefined;
};

/** Env a host exports to name the session it runs keryx commands from. */
export const ENV_SESSION_PROVIDER = "KERYX_SESSION_PROVIDER";
export const ENV_SESSION_MODEL = "KERYX_SESSION_MODEL";

/**
 * The session a keryx command is being run FROM — the caller's provider/model,
 * from the first source that names one: flags, then
 * `KERYX_SESSION_PROVIDER`/`KERYX_SESSION_MODEL`, then — only when asked — the
 * selection `keryx shell` persisted.
 *
 * The persisted selection used to be the silent default for both
 * model-selection seams (`keryx review tier`, `keryx providers cross-family`),
 * and it is not the caller's session: it is whatever `keryx shell` was last
 * pointed at. An orchestrator running in Claude Code got a `review tier` block
 * pinning `deepseek` / `deepseek-flash` (observed), and `cross-family` would
 * classify a Claude-authored change as DeepSeek's. Knowing nothing is the
 * honest answer and both seams already handle it.
 *
 * Each source is taken as a pair: a provider from one source and a model from
 * another is a session that never existed.
 */
export function resolveCallerSession(input: ResolveCallerSessionInput = {}): CallerSession {
  const pair = (provider: string | undefined, model: string | undefined, source: SessionSource): CallerSession => ({
    providerId: (provider ?? "").trim(),
    modelId: (model ?? "").trim(),
    source,
  });
  if (input.flagProvider !== undefined || input.flagModel !== undefined) {
    return pair(input.flagProvider, input.flagModel, "flags");
  }
  const env = input.env ?? process.env;
  const envProvider = env[ENV_SESSION_PROVIDER];
  const envModel = env[ENV_SESSION_MODEL];
  if ((envProvider ?? "").trim() !== "" || (envModel ?? "").trim() !== "") {
    return pair(envProvider, envModel, "env");
  }
  if (input.fromShellConfig === true) {
    const config = loadShellConfig(input.configDir);
    return pair(config.provider, config.model, "shell-config");
  }
  return pair(undefined, undefined, "none");
}

/**
 * Publish the session keryx shell is running on, so a command it runs knows it.
 *
 * `shell_exec` builds each command's environment from this process's, so a
 * `keryx review tier` an agent runs through it reads these two variables and
 * anchors on the model the session is ACTUALLY on — updated on every `/model`
 * switch, because the caller re-exports on every rebuild. External agents never
 * see them: `buildExternalChildEnv` sweeps the whole `KERYX_` namespace, so a
 * Claude Code or Codex child cannot inherit a session that is not its own.
 */
export function exportCallerSession(
  providerId: string,
  modelId: string,
  env: Record<string, string | undefined> = process.env,
): void {
  const provider = providerId.trim();
  const model = modelId.trim();
  if (provider === "" || model === "") {
    // Half a session is a session that never existed; clear rather than publish it.
    delete env[ENV_SESSION_PROVIDER];
    delete env[ENV_SESSION_MODEL];
    return;
  }
  env[ENV_SESSION_PROVIDER] = provider;
  env[ENV_SESSION_MODEL] = model;
}
