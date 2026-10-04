// Flow 403: the real ports behind a card decision. They live outside src/intake because they start processes (keryx
// itself and git), and the intake modules are scanned to stay free of any process or socket module. Serve installs
// them once; every intake test injects fakes instead.

import { spawn, spawnSync } from "node:child_process";
import { appendFile, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { appendJournal, flowsRoot } from "../flow/store";
import {
  type IntakeCiTriagePort,
  type IntakeFlowPort,
  type IntakeProjectFinder,
  installIntakeDefaultPorts,
} from "../intake/ports";
import { normalizeRemoteUrl } from "../learning/identity";
import { listProjects } from "../lib/project-registry";
import { ghAccountForPath } from "../scheduler/digest-gh";
import { redactSensitiveText } from "../security/service";
import { invocationArgv, resolveKeryxInvocation } from "../trigger/schedule";

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
const FLOW_DIR = /^(\d+)-[^/\\]+$/;

function lastLine(text: string): string {
  const lines = text.replace(ANSI, "").split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  return redactSensitiveText(lines[lines.length - 1] ?? "").slice(0, 160);
}

interface Captured {
  readonly code: number | null;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

/** Run keryx itself and keep at most `maxBytes` of each stream. */
function runKeryx(args: readonly string[], cwd: string, timeoutMs: number, maxBytes: number): Promise<Captured> {
  const argv = [...invocationArgv(resolveKeryxInvocation()), ...args];
  const env = { ...process.env, GH_ACCOUNT: ghAccountForPath(cwd) };
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const child = spawn(argv[0]!, argv.slice(1), { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < maxBytes) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < maxBytes) stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, timedOut, stdout, stderr: `${stderr}${error.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, timedOut, stdout: stdout.slice(0, maxBytes), stderr: stderr.slice(0, maxBytes) });
    });
  });
}

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

export function createDefaultFlowPort(options: { timeoutMs?: number } = {}): IntakeFlowPort {
  const timeoutMs = options.timeoutMs ?? 90_000;
  return {
    async init(projectRoot, input) {
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
      const run = await runKeryx(args, projectRoot, timeoutMs, 64_000);
      const created = (await flowDirs(projectRoot)).filter((d) => !before.has(d));
      if (run.timedOut || run.code !== 0) {
        await cleanup(projectRoot, created, cardId);
        const why = run.timedOut ? "timed out" : lastLine(run.stderr) || lastLine(run.stdout) || `exit ${run.code ?? "none"}`;
        return { ok: false, reason: `flow init failed: ${why}` };
      }
      const dir = created.find((d) => d.length > 0);
      if (dir === undefined) return { ok: false, reason: "flow init finished but no flow directory appeared" };
      return { ok: true, flowId: flowIdOf(dir), dir };
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
      const run = await runKeryx(["review", "ci-triage", "--run", input.runId, "--repo", input.repo], projectRoot, input.timeoutMs, input.maxBytes);
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
    let registered: string[] = [];
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
