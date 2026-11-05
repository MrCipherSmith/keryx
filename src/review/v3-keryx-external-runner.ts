import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { detectSandboxLauncher, wrapWithSandbox, type SandboxLauncherInfo, type SandboxProfile } from "../harness/process/sandbox";
import type { ExternalBridgeSocketServer } from "./v3-external-transport";
import type { ExternalGeneralRunner, ExternalGeneralStopEvidence } from "./v3-external-adapter";
import type { ReviewV3AdapterRequest } from "./v3/types";

const SAFE_INHERITED_ENV = [
  "PATH", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "COLORTERM", "NO_COLOR",
] as const;

export interface KeryxExternalChild {
  readonly stdout: Promise<string>;
  readonly stderr: Promise<string>;
  readonly exited: Promise<number>;
  readonly terminateGroup: (signal: "SIGTERM" | "SIGKILL") => void;
  readonly groupAlive: () => boolean;
}

export interface KeryxExternalProcessPort {
  readonly spawn: (input: {
    readonly argv: readonly string[];
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
    readonly maxOutputBytes: number;
  }) => KeryxExternalChild;
}

export interface KeryxExternalGeneralRunnerOptions {
  readonly runDir: string;
  readonly configDir: string;
  readonly bridgeServer: ExternalBridgeSocketServer;
  /** Test-only executable override; production uses the dedicated worker entry. */
  readonly workerCommand?: readonly [string, ...string[]];
  readonly provider: string;
  readonly model: string;
  /** Host-owned compiler for trusted entity/skill instructions; the worker has no filesystem tools. */
  readonly compileInstructions: (request: ReviewV3AdapterRequest) => string | Promise<string>;
  readonly processPort?: KeryxExternalProcessPort;
  readonly launcher?: SandboxLauncherInfo;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly maxOutputBytes?: number;
  readonly stopGraceMs?: number;
  readonly now?: () => Date;
}

interface ActiveChild { readonly child: KeryxExternalChild; cancelled: boolean }

function inside(parent: string, candidate: string): boolean {
  return candidate === parent || candidate.startsWith(`${parent}${path.sep}`);
}

async function boundedText(stream: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<string> {
  if (stream === null) return "";
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes) throw new Error(`external Keryx output exceeded ${maxBytes} bytes`);
      parts.push(decoder.decode(next.value, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join("");
  } finally {
    reader.releaseLock();
  }
}

export function createKeryxExternalProcessPort(): KeryxExternalProcessPort {
  return {
    spawn(input) {
      const child = Bun.spawn([...input.argv], {
        cwd: input.cwd, env: { ...input.env }, stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true,
      });
      const terminateGroup = (signal: "SIGTERM" | "SIGKILL"): void => {
        try { process.kill(-child.pid, signal); }
        catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
        }
      };
      const read = (stream: ReadableStream<Uint8Array> | null): Promise<string> =>
        boundedText(stream, input.maxOutputBytes).catch((error: unknown) => {
          terminateGroup("SIGKILL");
          throw error;
        });
      return {
        stdout: read(child.stdout),
        stderr: read(child.stderr),
        exited: child.exited,
        terminateGroup,
        groupAlive() {
          try { process.kill(-child.pid, 0); return true; }
          catch (error) { return !(error instanceof Error && "code" in error && error.code === "ESRCH"); }
        },
      };
    },
  };
}

function cleanEnvironment(
  source: Readonly<Record<string, string | undefined>>,
  tempDir: string,
  bridgeEnv: Readonly<Record<string, string>>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of SAFE_INHERITED_ENV) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  env.HOME = tempDir;
  env.PATH ??= process.env.PATH ?? "";
  env.TMPDIR = tempDir;
  Object.assign(env, bridgeEnv);
  return env;
}

async function waitForStop(child: KeryxExternalChild, graceMs: number): Promise<boolean> {
  const exited = await Promise.race([
    child.exited.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), graceMs)),
  ]);
  if (!exited) {
    child.terminateGroup("SIGKILL");
    await Promise.race([child.exited, new Promise<void>((resolve) => setTimeout(resolve, graceMs))]);
  }
  return !child.groupAlive();
}

/**
 * Verified production factory. The source boundary is backed by Seatbelt or
 * bwrap, never by a capability claim supplied in dispatch JSON.
 */
export async function createKeryxExternalGeneralRunner(
  options: KeryxExternalGeneralRunnerOptions,
): Promise<ExternalGeneralRunner> {
  const runDir = await realpath(options.runDir);
  const configDir = await realpath(options.configDir);
  if (!options.provider.trim() || !options.model.trim()) throw new Error("external Keryx provider and model must be preflighted explicitly");
  if (path.basename(configDir) !== "keryx") {
    throw new Error("external Keryx configDir must be the canonical keryx directory");
  }
  if (inside(runDir, configDir) || inside(configDir, runDir)) {
    throw new Error("external Keryx state directory must be outside the read-only review source");
  }
  const launcher = options.launcher ?? detectSandboxLauncher();
  if (!launcher.available) throw new Error(`external Keryx containment unavailable: ${launcher.reason ?? "unknown"}`);
  if (options.workerCommand !== undefined && options.processPort === undefined) {
    throw new Error("external worker command override is available only with an injected process port");
  }
  const workerCommand: readonly [string, ...string[]] = options.workerCommand ?? [
    process.execPath,
    fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./v3-keryx-external-worker-entry.ts" : "./v3-keryx-external-worker-entry.js", import.meta.url)),
  ];
  const processPort = options.processPort ?? createKeryxExternalProcessPort();
  const active = new Map<string, ActiveChild>();
  const starting = new Set<string>();
  const cancelBeforeStart = new Set<string>();
  const cancelled = new Set<string>();
  const maxOutputBytes = options.maxOutputBytes ?? 16 * 1024 * 1024;
  const stopGraceMs = options.stopGraceMs ?? 5_000;
  const now = options.now ?? (() => new Date());

  const cancelChild = async (dispatchId: string): Promise<ExternalGeneralStopEvidence> => {
    const state = active.get(dispatchId);
    if (state === undefined) {
      if (starting.has(dispatchId)) {
        cancelBeforeStart.add(dispatchId);
        cancelled.add(dispatchId);
        return { stopped: true, observedAt: now().toISOString(), exitCode: null };
      }
      return cancelled.has(dispatchId)
        ? { stopped: true, observedAt: now().toISOString(), exitCode: null }
        : { stopped: false, reason: "external Keryx process is not owned by this runner" };
    }
    state.cancelled = true;
    state.child.terminateGroup("SIGTERM");
    const stopped = await waitForStop(state.child, stopGraceMs);
    if (!stopped) return { stopped: false, reason: "process group remained alive after TERM and KILL" };
    cancelled.add(dispatchId);
    return { stopped: true, observedAt: now().toISOString(), exitCode: await state.child.exited };
  };

  return {
    enforcement: {
      sourceSandbox: "read-only",
      resultWrites: "controller-only",
      hierarchy: "scoped-bridge",
      processCancellation: "handle",
      usageAccounting: false,
      toolProfile: "bridge-only",
      sourceRead: false,
      authRefresh: false,
    },
    async execute(input) {
      const dispatchId = input.request.dispatchId;
      if (active.has(dispatchId) || starting.has(dispatchId)) throw new Error(`external Keryx dispatch ${dispatchId} is already active`);
      starting.add(dispatchId);
      let tempDir: string | undefined;
      try {
        tempDir = await mkdtemp(path.join(tmpdir(), "keryx-review-v3-general-"));
        if (cancelBeforeStart.delete(dispatchId) || input.signal.aborted) {
          throw new Error("external Keryx general was cancelled before process start");
        }
        const env = cleanEnvironment(options.env ?? process.env, tempDir, options.bridgeServer.envFor(input.grant.token));
        const requestFile = path.join(tempDir, "request.json");
        const { signal: _signal, ...requestWire } = input.request;
        const instructions = await options.compileInstructions(input.request);
        if (!instructions.trim()) throw new Error("external Keryx trusted entity/skill instructions are empty");
        const compiledRequest = { ...requestWire, task: `${instructions.trim()}\n\nAssigned review task:\n${requestWire.task}` };
        await writeFile(requestFile, `${JSON.stringify(compiledRequest)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
        const workerArgs = [
          ...workerCommand, "--request", requestFile, "--config-dir", configDir,
          "--provider", options.provider, "--model", options.model,
        ];
        const profile: SandboxProfile = {
          mode: "workspace-write",
          network: "on",
          writableRoots: [tempDir],
          readDenyList: [],
          allowedDomains: [],
          required: true,
        };
        const wrapped = wrapWithSandbox(
          { path: workerArgs[0]!, argv: workerArgs, env, cwd: runDir },
          profile,
          { platform: launcher.platform, ...(launcher.path === undefined ? {} : { bwrapPath: launcher.path }) },
        );
        if (!wrapped.ok || !wrapped.wrapped) {
          throw new Error(`external Keryx containment refused${wrapped.ok ? "" : `: ${wrapped.reason}`}`);
        }
        if (cancelBeforeStart.delete(dispatchId) || input.signal.aborted) {
          throw new Error("external Keryx general was cancelled before process start");
        }
        const child = processPort.spawn({
          argv: [wrapped.command.path, ...wrapped.command.argv.slice(1)],
          cwd: runDir,
          env: wrapped.command.env,
          maxOutputBytes,
        });
        const state: ActiveChild = { child, cancelled: false };
        active.set(dispatchId, state);
        starting.delete(dispatchId);
        const onAbort = (): void => {
          state.cancelled = true;
          child.terminateGroup("SIGTERM");
          void waitForStop(child, stopGraceMs);
        };
        input.signal.addEventListener("abort", onAbort, { once: true });
        if (input.signal.aborted) onAbort();
        try {
          const [exitCode, stdout] = await Promise.all([child.exited, child.stdout, child.stderr]);
          if (state.cancelled || input.signal.aborted) throw new Error("external Keryx general was cancelled");
          if (exitCode !== 0) throw new Error(`external Keryx general exited with code ${exitCode}`);
          const parsed: unknown = JSON.parse(stdout);
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) ||
            Object.keys(parsed).sort().join(",") !== "content,metadata" ||
            typeof Reflect.get(parsed, "content") !== "string" || (Reflect.get(parsed, "content") as string).trim() === "" ||
            typeof Reflect.get(parsed, "metadata") !== "object" || Reflect.get(parsed, "metadata") === null ||
            Reflect.get(Reflect.get(parsed, "metadata") as object, "harness") !== "keryx-dedicated-review-v3-worker") {
            throw new Error("dedicated external Keryx worker returned an invalid or empty result");
          }
          return {
            content: Reflect.get(parsed, "content"),
            metadata: { externalHarness: "keryx-dedicated-review-v3-worker", exitCode, containment: launcher.platform },
          };
        } catch (error) {
          state.cancelled = true;
          child.terminateGroup("SIGTERM");
          if (!(await waitForStop(child, stopGraceMs))) {
            throw new AggregateError([error], "external Keryx process failed and its process group could not be stopped", { cause: error });
          }
          throw error;
        } finally {
          input.signal.removeEventListener("abort", onAbort);
          active.delete(dispatchId);
        }
      } finally {
        starting.delete(dispatchId);
        cancelBeforeStart.delete(dispatchId);
        if (tempDir !== undefined) await rm(tempDir, { recursive: true, force: true });
      }
    },
    cancel(request) { return cancelChild(request.dispatchId); },
    async reconcile(request) {
      if (active.has(request.dispatchId)) return "running";
      return cancelled.has(request.dispatchId) ? "cancelled" : "unknown";
    },
  };
}
