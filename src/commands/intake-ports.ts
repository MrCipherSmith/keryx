// Flow 403: the real ports behind a card decision. They live outside src/intake because they start processes (keryx
// itself and git), and the intake modules are scanned to stay free of any process or socket module. Serve, the TUI
// and the `keryx intake` commands install them; every intake test injects fakes instead.

import { spawn, spawnSync } from "node:child_process";
import { appendFile, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { appendJournal, flowsRoot } from "../flow/store";
import {
  type IntakeCiTriagePort,
  type IntakeFlowPort,
  type IntakeProjectFinder,
  installIntakeDefaultPorts,
  intakeDefaultPorts,
} from "../intake/ports";
import { normalizeRemoteUrl } from "../learning/identity";
import { listProjects } from "../lib/project-registry";
import { ghEnvForProject } from "../scheduler/digest-gh";
import { redactSensitiveText } from "../security/service";
import { invocationArgv, resolveKeryxInvocation } from "../trigger/schedule";

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
const FLOW_DIR = /^(\d+)-[^/\\]+$/;

function lastLine(text: string): string {
  const lines = text.replace(ANSI, "").split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  return redactSensitiveText(lines[lines.length - 1] ?? "").slice(0, 160);
}

export interface Captured {
  readonly code: number | null;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs keryx with these arguments in a project; the real one spawns a process, a test passes a fake. */
export type KeryxRunner = (args: readonly string[], cwd: string, timeoutMs: number, maxBytes: number) => Promise<Captured>;

/** After the child has exited, how long its output pipes are waited for before a grandchild holding them is cut loose. */
const PIPE_GRACE_MS = 500;

/**
 * The environment of the keryx child: the same allowlist the digest's gh calls get (no GH_TOKEN, GITHUB_TOKEN or any
 * other secret of the host, so the account the path chose cannot be overridden) plus keryx's own non-secret settings.
 * `credentials` names the few secret variables a particular child cannot work without; none is ever logged or written.
 */
export function intakeChildEnv(
  cwd: string,
  base: Record<string, string | undefined> = process.env,
  credentials: readonly string[] = [],
): Record<string, string | undefined> {
  const env = ghEnvForProject(cwd, base);
  for (const [name, value] of Object.entries(base)) {
    if (value !== undefined && name.startsWith("KERYX_") && !/TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL/i.test(name)) env[name] = value;
  }
  for (const name of credentials) {
    const value = base[name];
    if (value !== undefined && value.length > 0) env[name] = value;
  }
  return env;
}

/**
 * The environment of `keryx review ci-triage`: it sends a redacted log excerpt to Jev through OpenRouter, so it needs
 * that one credential (the key saved in the keryx shell config is found through HOME and KERYX_HOME, both kept). The
 * flow-init child never gets it.
 */
export const CI_TRIAGE_CREDENTIAL_VARS: readonly string[] = ["OPENROUTER_API_KEY"];

export function ciTriageChildEnv(cwd: string, base: Record<string, string | undefined> = process.env): Record<string, string | undefined> {
  return intakeChildEnv(cwd, base, CI_TRIAGE_CREDENTIAL_VARS);
}

/**
 * Run a process and keep at most `maxBytes` of each stream. The child leads its own process group: on a timeout the
 * whole group is killed, and the promise settles shortly after the child EXITS, not when every pipe closes, so a
 * grandchild that inherited the pipes can neither hang the caller nor keep a card in `taking`.
 */
export function runProcess(
  argv: readonly string[],
  options: {
    readonly cwd: string;
    readonly env: Record<string, string | undefined>;
    readonly timeoutMs: number;
    readonly maxBytes: number;
    readonly graceMs?: number;
    /** Where the parent's exit and termination signals are heard. Default `process`; a test passes its own emitter. */
    readonly lifecycle?: NodeJS.EventEmitter;
  },
): Promise<Captured> {
  const graceMs = options.graceMs ?? PIPE_GRACE_MS;
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const child = spawn(argv[0]!, argv.slice(1), { cwd: options.cwd, env: options.env as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"], detached: true });
    const killGroup = (): void => {
      try {
        // Only ever the child's own group (it leads it); never serve's, whatever the pid says.
        if (child.pid !== undefined && child.pid > 1 && child.pid !== process.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
      }
    };
    // The child leads its own group so that a timeout can kill the whole group without touching serve's. That also
    // means Ctrl-C or a stop of serve/the TUI no longer reaches it by itself: the parent kills the CHILD'S group when
    // it exits or is told to stop, and takes the handlers away again when the child is done.
    const lifecycle: NodeJS.EventEmitter = options.lifecycle ?? process;
    const ownsProcess = lifecycle === process;
    const onExit = (): void => killGroup();
    const onSignal = (signal: NodeJS.Signals): void => {
      killGroup();
      detach();
      // Listening for a signal removes its default effect (stop the process): put it back unless someone else listens.
      if (ownsProcess && lifecycle.listenerCount(signal) === 0) process.kill(process.pid, signal);
    };
    const onSigint = (): void => onSignal("SIGINT");
    const onSigterm = (): void => onSignal("SIGTERM");
    const detach = (): void => {
      lifecycle.removeListener("exit", onExit);
      lifecycle.removeListener("SIGINT", onSigint);
      lifecycle.removeListener("SIGTERM", onSigterm);
    };
    lifecycle.on("exit", onExit);
    lifecycle.on("SIGINT", onSigint);
    lifecycle.on("SIGTERM", onSigterm);
    const finish = (code: number | null, extra = ""): void => {
      if (settled) return;
      settled = true;
      detach();
      clearTimeout(timer);
      if (grace !== undefined) clearTimeout(grace);
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({ code, timedOut, stdout: stdout.slice(0, options.maxBytes), stderr: `${stderr}${extra}`.slice(0, options.maxBytes) });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, options.timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < options.maxBytes) stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < options.maxBytes) stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => finish(null, error.message));
    child.on("exit", (code) => {
      grace = setTimeout(() => {
        // The pipes are still open: a grandchild holds them. Cut it loose and report what the child said.
        killGroup();
        finish(code);
      }, graceMs);
    });
    child.on("close", (code) => finish(code));
  });
}

/** Run keryx itself, with the strict environment of a flow-init child unless the caller names another. */
const runKeryx = (args: readonly string[], cwd: string, timeoutMs: number, maxBytes: number, env: Record<string, string | undefined> = intakeChildEnv(cwd)): Promise<Captured> =>
  runProcess([...invocationArgv(resolveKeryxInvocation()), ...args], { cwd, env, timeoutMs, maxBytes });

async function flowDirs(projectRoot: string): Promise<string[]> {
  try {
    return (await readdir(flowsRoot(projectRoot))).filter((d) => FLOW_DIR.test(d));
  } catch {
    return [];
  }
}

async function sourceOf(projectRoot: string, dir: string): Promise<string | undefined> {
  try {
    const flow = JSON.parse(await readFile(path.join(flowsRoot(projectRoot), dir, "flow.json"), "utf8")) as { origin?: { source?: unknown } };
    return typeof flow.origin?.source === "string" ? flow.origin.source : undefined;
  } catch {
    return undefined;
  }
}

const flowIdOf = (dir: string): string => FLOW_DIR.exec(dir)![1]!;

/** Remove the directories a failed `flow init` left. Only a directory with no readable flow or one made for this card goes. */
async function cleanup(projectRoot: string, created: readonly string[], cardId: string): Promise<void> {
  for (const dir of created) {
    const source = await sourceOf(projectRoot, dir);
    if (source === undefined || source.includes(cardId)) await rm(path.join(flowsRoot(projectRoot), dir), { recursive: true, force: true });
  }
}

/** One `flow init` at a time per project: two presses at once must not each see the other's new directory. */
const initChains = new Map<string, Promise<unknown>>();

function inProject<T>(projectRoot: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(projectRoot);
  const previous = initChains.get(key) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  const tail = next.catch(() => undefined);
  initChains.set(key, tail);
  void tail.then(() => {
    if (initChains.get(key) === tail) initChains.delete(key);
  });
  return next;
}

export function createDefaultFlowPort(options: { timeoutMs?: number; run?: KeryxRunner } = {}): IntakeFlowPort {
  const timeoutMs = options.timeoutMs ?? 90_000;
  const run = options.run ?? runKeryx;
  return {
    init(projectRoot, input) {
      return inProject(projectRoot, async () => {
        const cardId = /card ([a-z0-9]+)$/.exec(input.source)?.[1] ?? input.source;
        const before = new Set(await flowDirs(projectRoot));
        const args = [
          "flow",
          "init",
          ...(input.issueUrl !== undefined ? ["--issue", input.issueUrl] : []),
          ...(input.title !== undefined ? ["--title", input.title] : []),
          "--origin",
          "agent-proposal",
          "--source",
          input.source,
        ];
        const result = await run(args, projectRoot, timeoutMs, 64_000);
        const created = (await flowDirs(projectRoot)).filter((d) => !before.has(d));
        if (result.timedOut || result.code !== 0) {
          await cleanup(projectRoot, created, cardId);
          const why = result.timedOut ? "timed out" : lastLine(result.stderr) || lastLine(result.stdout) || `exit ${result.code ?? "none"}`;
          return { ok: false as const, reason: `flow init failed: ${why}` };
        }
        // Only the directory whose origin names THIS card is this card's flow: a flow the operator made at the same
        // moment, or one another press made, is not adopted.
        let dir: string | undefined;
        for (const candidate of created) {
          const source = await sourceOf(projectRoot, candidate);
          if (source !== undefined && source.includes(cardId)) {
            dir = candidate;
            break;
          }
        }
        if (dir === undefined) return { ok: false as const, reason: "flow init finished but no flow directory for this card appeared" };
        return { ok: true as const, flowId: flowIdOf(dir), dir };
      });
    },
    async findByCard(projectRoot, cardId) {
      for (const dir of await flowDirs(projectRoot)) {
        const source = await sourceOf(projectRoot, dir);
        if (source !== undefined && source.includes(cardId)) return { flowId: flowIdOf(dir), dir };
      }
      return undefined;
    },
    async journal(projectRoot, dir, at, line) {
      await appendJournal(projectRoot, dir, at, line);
    },
    async appendDescription(projectRoot, dir, text) {
      await appendFile(path.join(flowsRoot(projectRoot), dir, "description.md"), `\n${text}\n`, "utf8");
    },
  };
}

export function createDefaultCiTriagePort(): IntakeCiTriagePort {
  return {
    async run(projectRoot, input) {
      const run = await runKeryx(["review", "ci-triage", "--run", input.runId, "--repo", input.repo], projectRoot, input.timeoutMs, input.maxBytes, ciTriageChildEnv(projectRoot));
      if (run.timedOut) return { ok: false, reason: "ci-triage timed out" };
      if (run.code !== 0) return { ok: false, reason: `ci-triage refused or failed: ${lastLine(run.stderr) || `exit ${run.code ?? "none"}`}` };
      const output = run.stdout.replace(ANSI, "").trim();
      return output.length === 0 ? { ok: false, reason: "ci-triage printed nothing" } : { ok: true, output };
    },
  };
}

function remoteOf(projectPath: string): string | undefined {
  const run = spawnSync("git", ["-C", projectPath, "remote", "get-url", "origin"], { encoding: "utf8", timeout: 5000 });
  return run.status === 0 ? run.stdout.trim() : undefined;
}

/**
 * The project a repository belongs to: the project whose `origin` ends in `/owner/name`. The project holding the
 * intake data is tried first, then every active project of the user's registry.
 */
export function createDefaultProjectFinder(intakeRoot: string): IntakeProjectFinder {
  return (repo) => {
    const wanted = `/${repo.toLowerCase()}`;
    let registered: string[];
    try {
      registered = listProjects()
        .filter((p) => p.state === "active")
        .map((p) => p.path);
    } catch {
      registered = [];
    }
    for (const candidate of [intakeRoot, ...registered]) {
      const remote = remoteOf(candidate);
      if (remote !== undefined && normalizeRemoteUrl(remote).endsWith(wanted)) return candidate;
    }
    return undefined;
  };
}

/** Make the real ports the defaults of `decideIntakeCard` and `recoverIntakeTaking`. */
export function installRealIntakePorts(): void {
  installIntakeDefaultPorts({ flows: () => createDefaultFlowPort(), ciTriage: () => createDefaultCiTriagePort(), projectFor: (root) => createDefaultProjectFinder(root) });
}

/**
 * The entry points that decide a card without serve (the TUI modal, the `keryx intake` commands) call this first: it
 * installs the real ports unless something (serve, a test) already installed ports of its own.
 */
export function ensureRealIntakePorts(): void {
  try {
    intakeDefaultPorts();
  } catch {
    installRealIntakePorts();
  }
}
