// Browser dev mode bridge: a local stand-in for the Tauri Rust core.
//
// `bun run dev:browser` starts this next to Vite. The web view (only in a Vite
// dev build, outside Tauri) connects to ws://127.0.0.1:1421 and calls the same
// commands the Rust core exposes:
//
//   acp_start(cwd, noProfile) / acp_send(message) / acp_stop()
//   settings_get / settings_set / settings_add_recent / version_check(found)
//   app_update_check (always null: dev mode runs no Keryx.app) / app_update_run (refused)
//   flows_list(cwd) / flows_get(cwd, dir) / flows_action(cwd, dir, action) / flows_watch(cwd)
//
// and receives the same events: acp://message, acp://exit, acp://error,
// flows://changed. One WebSocket connection is one "window" with its own
// keryx process. Development only: it listens on loopback and is never bundled.

import { reviewBoardArgs } from "./reviewBoard";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { rmSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import type { ServerWebSocket, Subprocess } from "bun";
import { createChatAttachmentStore, type ChatOwner } from "./chatAttachments";
import { githubRepositoryFromOrigin } from "../src/lib/githubPr";

import { reviewWatcherArgs, reviewRuleArgs } from "./reviewWatcher";
import { reviewRunArgs } from "./reviewRun";
import { parsePublicationRequest, publicationArgs } from "../../../src/commands/review-desk-publish";
import { SAFE_BUN_SPAWN_ARGS } from "../../../src/lib/safe-exec";

const runFile = promisify(execFile);
const PORT = 1421;
const REPO_ROOT = resolve(import.meta.dir, "../../..");
const KERYX_CMD = process.env.KERYX_DEV_CMD?.split(/\s+/).filter(Boolean)
  ?? ["bun", ...SAFE_BUN_SPAWN_ARGS, join(REPO_ROOT, "src/cli.ts")];
const MIN_KERYX_VERSION = readMinVersion();
const SETTINGS_PATH = join(homedir(), ".keryx-desktop-dev", "settings.json");
const MAX_FILE_BYTES = 16 * 1024 * 1024;

function readMinVersion(): string {
  try {
    const src = readFileSync(join(import.meta.dir, "../src-tauri/src/version.rs"), "utf8");
    return /MIN_KERYX_VERSION: &str = "([^"]+)"/.exec(src)?.[1] ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// ---- settings --------------------------------------------------------------

interface Settings {
  keryxSource: "auto" | "bundled" | "path" | "custom";
  customPath: string | null;
  recentProjects: string[];
}

function loadSettings(): Settings {
  const fallback: Settings = {
    keryxSource: "auto",
    customPath: null,
    recentProjects: [process.env.KERYX_DEV_PROJECT ?? REPO_ROOT],
  };
  try {
    return { ...fallback, ...(JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) as Partial<Settings>) };
  } catch {
    return fallback;
  }
}

function saveSettings(s: Settings): Settings {
  mkdirSync(join(homedir(), ".keryx-desktop-dev"), { recursive: true });
  writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2));
  return s;
}

function semverAtLeast(found: string, required: string): boolean {
  const parse = (v: string) => /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim())?.slice(1).map(Number);
  const a = parse(found);
  const b = parse(required);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! > b[i]!;
  }
  return true;
}

// ---- fs/read_text_file (confined to the session cwd) -------------------------

function readTextFile(root: string, params: Record<string, unknown>): { content: string } {
  const path = typeof params.path === "string" ? params.path : "";
  if (!path) throw rpcError(-32602, "`path` must be a non-empty string");
  const line = params.line == null ? null : Number(params.line);
  const limit = params.limit == null ? null : Number(params.limit);
  if (line !== null && (!Number.isInteger(line) || line < 1)) throw rpcError(-32602, "`line` is 1-based");
  if (limit !== null && (!Number.isInteger(limit) || limit < 0)) throw rpcError(-32602, "`limit` must be a non-negative integer");
  let resolved: string;
  try {
    resolved = realpathSync(isAbsolute(path) ? path : join(root, path));
  } catch {
    throw rpcError(-32002, `file not found: ${path}`);
  }
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    throw rpcError(-32602, `path is outside the project folder: ${path}`);
  }
  const st = statSync(resolved);
  if (!st.isFile()) throw rpcError(-32602, `not a file: ${path}`);
  if (st.size > MAX_FILE_BYTES) throw rpcError(-32602, `file is larger than 16 MiB: ${path}`);
  const text = readFileSync(resolved, "utf8");
  if (line === null && limit === null) return { content: text };
  const lines = text.split(/(?<=\n)/);
  const start = (line ?? 1) - 1;
  return { content: lines.slice(start, limit === null ? undefined : start + limit).join("") };
}

function rpcError(code: number, message: string): Error & { code: number } {
  return Object.assign(new Error(message), { code });
}

// ---- flows (same JSON as the Rust core, flows-board.md §6) -------------------

interface FlowCard {
  hasIssue: boolean;
  id: string;
  idValid: boolean;
  dir: string;
  commandRef: string | null;
  title: string;
  status: string;
  previousStatus: string | null;
  blocked: boolean;
  owner: string | null;
  prUrl: string | null;
  baseBranch: string | null;
  tasksDone: number;
  tasksTotal: number;
  acTotal: number;
  acConfirmed: number;
  updatedAt: string | null;
  completionExceptions: boolean;
  error: string | null;
}

type Json = Record<string, unknown>;

function flowsRoot(cwd: string): string {
  return join(cwd, ".metaproject", "flows");
}

/**
 * Same rule as the Rust `is_flow_dir_name` and keryx's own listing: `^\d{3}-`, one path component, no NUL,
 * `/` or control characters. keryx resolves such a name by exact match.
 */
// eslint-disable-next-line no-control-regex
const FLOW_DIR = /^\d{3}-[^/\u0000-\u001f\u007f]*$/;
/** The names that may be pasted into a shell command unquoted. */
const COMMAND_DIR = /^\d{3}-[A-Za-z0-9._+-]*$/;

/** Flow packages only: real directories (a Dirent of a symlink is not one) with a package name. */
function flowDirs(cwd: string): string[] {
  const root = flowsRoot(cwd);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && FLOW_DIR.test(d.name))
    .map((d) => d.name)
    .sort();
}

function readOptional(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

const AC_LINE = /^- (AC\d+):\s*(.*)$/;
const VERIFY_TAG = /\s*\[verify:\s*([^\]]*)\]\s*$/;

function parseCriteria(text: string | null): Array<{ id: string; text: string; verify: string | null }> {
  if (!text) return [];
  const out: Array<{ id: string; text: string; verify: string | null }> = [];
  for (const raw of text.split("\n")) {
    const m = AC_LINE.exec(raw.trimEnd());
    if (!m) continue;
    const body = m[2] ?? "";
    const v = VERIFY_TAG.exec(body);
    out.push({ id: m[1]!, text: v ? body.slice(0, v.index).trim() : body.trim(), verify: v ? v[1]!.trim() : null });
  }
  return out;
}

const JOURNAL_LINE = /^- (\d{4}-\d{2}-\d{2}T[^\s]+) - (.*)$/;

function parseJournal(text: string | null): Array<{ at: string; event: string; detail: string | null }> {
  if (!text) return [];
  const out: Array<{ at: string; event: string; detail: string | null }> = [];
  for (const raw of text.split("\n")) {
    const m = JOURNAL_LINE.exec(raw.trimEnd());
    if (!m) continue;
    const rest = m[2]!;
    const colon = rest.indexOf(": ");
    out.push(
      colon > 0
        ? { at: m[1]!, event: rest.slice(0, colon), detail: rest.slice(colon + 2) }
        : { at: m[1]!, event: rest, detail: null },
    );
  }
  return out;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

/** Same rule as the Rust `is_command_id`: an id fit for a command is 1 to 9 ASCII digits. */
const COMMAND_ID = /^\d{1,9}$/;

/** The flow id as the Rust core reads it: a string, or a number written as one. */
function idOf(v: unknown): string | null {
  return typeof v === "number" && Number.isFinite(v) ? String(v) : str(v);
}

function cardFor(cwd: string, dir: string): { card: FlowCard; state: Json | null; criteria: ReturnType<typeof parseCriteria> } {
  const base = join(flowsRoot(cwd), dir);
  const idFromDir = /^(\d+)-/.exec(dir)?.[1] ?? dir;
  const criteria = parseCriteria(readOptional(join(base, "acceptance-criteria.md")));
  const empty: FlowCard = {
    id: idFromDir,
    idValid: COMMAND_ID.test(idFromDir),
    dir,
    commandRef: COMMAND_DIR.test(dir) ? dir : null,
    title: dir.replace(/^\d+-\d{4}-\d{2}-\d{2}-/, "").replace(/-/g, " "),
    status: "unknown",
    previousStatus: null,
    blocked: false,
    owner: null,
    prUrl: null,
    hasIssue: false,
    baseBranch: null,
    tasksDone: 0,
    tasksTotal: 0,
    acTotal: criteria.length,
    acConfirmed: 0,
    updatedAt: null,
    completionExceptions: false,
    error: null,
  };
  let state: Json;
  try {
    state = JSON.parse(readFileSync(join(base, "flow.json"), "utf8")) as Json;
    if (typeof state !== "object" || state === null || Array.isArray(state)) throw new Error("flow.json is not an object");
  } catch (e) {
    return { card: { ...empty, error: e instanceof Error ? e.message : String(e) }, state: null, criteria };
  }
  const tasks = Array.isArray(state.tasks) ? (state.tasks as Json[]) : [];
  const acConfirmed = (state.acConfirmed ?? {}) as Json;
  const owner = state.owner as { value?: unknown } | undefined;
  const pr = state.pr as { url?: unknown } | undefined;
  const signatures = Array.isArray(state.signatures) ? (state.signatures as Json[]) : [];
  const status = str(state.status) ?? "unknown";
  return {
    card: {
      ...empty,
      id: idOf(state.id) ?? idFromDir,
      idValid: COMMAND_ID.test(idOf(state.id) ?? idFromDir),
      title: str(state.title) ?? empty.title,
      status,
      previousStatus: str(state.previousStatus),
      blocked: status === "blocked",
      owner: str(owner?.value),
      prUrl: str(pr?.url),
      hasIssue: (state.source as Json | undefined)?.type === "github-issue",
      baseBranch: str(state.baseBranch),
      tasksDone: tasks.filter((t) => t.status === "done").length,
      tasksTotal: tasks.length,
      acConfirmed: Object.keys(acConfirmed).length,
      updatedAt: str(state.updatedAt),
      completionExceptions: signatures.some(
        (s) => s.cleanCompletion === false || (Array.isArray(s.exceptions) && s.exceptions.length > 0),
      ),
    },
    state,
    criteria,
  };
}

function flowsList(cwd: string): FlowCard[] {
  return flowDirs(cwd).map((d) => cardFor(cwd, d).card);
}

/** A flow is addressed by its directory name (ids are shared across packages): exact match only. */
function findDir(cwd: string, dir: string): string {
  if (!FLOW_DIR.test(dir)) throw new Error(`Invalid flow directory: ${JSON.stringify(dir)}`);
  if (!flowDirs(cwd).includes(dir)) throw new Error(`Flow ${dir} was not found in this project`);
  return dir;
}

function flowsGet(cwd: string, dirName: string): Json {
  const dir = findDir(cwd, dirName);
  const base = join(flowsRoot(cwd), dir);
  const { card, state, criteria } = cardFor(cwd, dir);
  const s = state ?? {};
  const acConfirmed = (s.acConfirmed ?? {}) as Record<string, { at?: string; note?: string }>;
  const acKinds = (s.acKinds ?? {}) as Record<string, { kind?: string }>;
  const tasks = Array.isArray(s.tasks) ? (s.tasks as Json[]) : [];
  const history = Array.isArray(s.history) ? (s.history as Json[]) : [];
  const journal = parseJournal(readOptional(join(base, "journal.md")));
  const seen = new Set(journal.map((j) => `${j.at}|${j.event}`));
  for (const h of history) {
    const at = str(h.at);
    const event = str(h.event);
    if (!at || !event || seen.has(`${at}|${event}`)) continue;
    seen.add(`${at}|${event}`);
    journal.push({ at, event, detail: str(h.detail) });
  }
  journal.sort((a, b) => b.at.localeCompare(a.at));
  return {
    card,
    criteria: criteria.map((c) => {
      const conf = acConfirmed[c.id];
      return {
        ...c,
        kind: acKinds[c.id]?.kind ?? null,
        confirmed: conf ? { at: conf.at ?? "", note: conf.note ?? null } : null,
      };
    }),
    tasks: tasks.map((t) => {
      const attempts = (t.attempts ?? {}) as { count?: number; log?: Json[] };
      const last = attempts.log?.[attempts.log.length - 1];
      return {
        id: str(t.id) ?? "?",
        title: str(t.title) ?? "",
        kind: str(t.kind) ?? "implement",
        status: str(t.status) ?? "todo",
        dependsOn: Array.isArray(t.dependsOn) ? (t.dependsOn as string[]) : [],
        attempts: attempts.count ?? attempts.log?.length ?? 0,
        lastAttempt: last ? { at: str(last.at) ?? "", outcome: str(last.outcome) ?? "", detail: str(last.detail) } : null,
        disposition: str(t.disposition),
        dispositionReason: str(t.dispositionReason),
      };
    }),
    journal,
    docs: {
      description: readOptional(join(base, "description.md")),
      plan: readOptional(join(base, "plan.md")),
      context: readOptional(join(base, "context.md")),
    },
    signatures: Array.isArray(s.signatures) ? s.signatures : [],
    completionAttempts: Array.isArray(s.completionAttempts) ? s.completionAttempts : [],
  };
}

const TASK_KINDS = new Set(["context", "implement", "test", "verify", "review", "docs"]);
const OUTCOMES = new Set(["started", "failed", "blocked"]);

/** The allowlist: argv is built here, never from a client string. */
function flowArgv(dir: string, action: Json): string[] {
  if (!FLOW_DIR.test(dir)) throw new Error(`Invalid flow directory: ${dir}`);
  const text = (k: string) => {
    const v = action[k];
    if (typeof v !== "string" || v.trim() === "") throw new Error(`\`${k}\` is required`);
    if (v.startsWith("-")) throw new Error(`\`${k}\` must not start with "-"`);
    if (v.length > 4000) throw new Error(`\`${k}\` is longer than 4000 characters`);
    return v;
  };
  const task = () => {
    const t = text("taskId");
    if (!/^T\d+$/.test(t)) throw new Error(`Not a task id: ${t}`);
    return t;
  };
  switch (action.type) {
    case "start":
      return ["flow", "start", dir];
    case "block":
      return ["flow", "block", dir, "--reason", text("reason")];
    case "unblock":
      return ["flow", "unblock", dir];
    case "taskAdd": {
      const kind = text("kind");
      if (!TASK_KINDS.has(kind)) throw new Error(`Unknown task kind: ${kind}`);
      return ["flow", "task", "add", dir, "--title", text("title"), "--kind", kind];
    }
    case "taskAttempt": {
      const outcome = text("outcome");
      if (!OUTCOMES.has(outcome)) throw new Error(`Unknown outcome: ${outcome}`);
      return ["flow", "task", "attempt", dir, task(), "--outcome", outcome, "--detail", text("detail")];
    }
    case "taskDone":
      return ["flow", "task", "done", dir, task()];
    case "freeze":
      return ["flow", "freeze", dir];
    case "next":
      return ["flow", "next", dir, "--json"];
    default:
      throw new Error(`Action not allowed: ${String(action.type)}`);
  }
}

async function flowsAction(cwd: string, dirName: string, action: Json) {
  const argv = flowArgv(findDir(cwd, dirName), action);
  const proc = Bun.spawn([...KERYX_CMD, ...argv], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { ok: exitCode === 0, exitCode, stdout, stderr };
}

// ---- watch: poll flow.json mtimes per watched project -----------------------

const watched = new Map<string, { sig: string; sockets: Set<ServerWebSocket<Conn>> }>();

function flowsSignature(cwd: string): string {
  let sig = "";
  for (const d of flowDirs(cwd)) {
    try {
      sig += `${d}:${statSync(join(flowsRoot(cwd), d, "flow.json")).mtimeMs};`;
    } catch {
      sig += `${d}:x;`;
    }
  }
  return sig;
}

setInterval(() => {
  for (const [cwd, w] of watched) {
    if (w.sockets.size === 0) {
      watched.delete(cwd);
      continue;
    }
    const sig = flowsSignature(cwd);
    if (sig === w.sig) continue;
    w.sig = sig;
    for (const ws of w.sockets) emit(ws, "flows://changed", { cwd });
  }
}, 2000);

// ---- ACP process per connection --------------------------------------------

interface Conn {
  attachmentOwner: ChatOwner;
  proc: Subprocess<"pipe", "pipe", "pipe"> | null;
  root: string | null;
  gen: number;
  /** Resolved when acp_start sets the project root (flows requests may race ahead of it). */
  rootWaiters: Array<() => void>;
}

function emit(ws: ServerWebSocket<Conn>, event: string, payload: unknown): void {
  ws.send(JSON.stringify({ event, payload }));
}

function stopProc(conn: Conn): void {
  conn.gen++;
  conn.proc?.kill();
  conn.proc = null;
}

async function pumpLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of stream) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      if (line.trim()) onLine(line);
    }
  }
  if (buf.trim()) onLine(buf);
}

function acpStart(ws: ServerWebSocket<Conn>, cwd: string, noProfile: boolean) {
  const conn = ws.data;
  stopProc(conn);
  let root: string;
  try {
    root = realpathSync(cwd);
  } catch (e) {
    throw new Error(`The project folder is not available (${cwd}): ${e instanceof Error ? e.message : e}`);
  }
  if (!statSync(root).isDirectory()) throw new Error(`Not a folder: ${cwd}`);
  // Settings' keryx source is the native app's concern; the bridge always runs KERYX_DEV_CMD.
  const settings = loadSettings();
  const cmd = KERYX_CMD;
  const args = ["acp", ...(noProfile ? [] : ["--profile", "shell"])];
  const proc = Bun.spawn([...cmd, ...args], { cwd: root, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const gen = conn.gen;
  conn.proc = proc;
  if (conn.root !== null && conn.root !== root) {
    const oldOwner = conn.attachmentOwner;
    conn.attachmentOwner = { closed: false };
    void chatStore.cleanupChatOwner(oldOwner).catch((error: unknown) => {
      console.error("[bridge] could not clean up drafts on project switch", error);
    });
  }
  conn.root = root;
  for (const wake of conn.rootWaiters.splice(0)) wake();
  let stderrTail = "";

  void pumpLines(proc.stdout, (line) => {
    if (conn.gen !== gen) return;
    let msg: Json | null = null;
    try {
      msg = JSON.parse(line) as Json;
    } catch {
      /* not JSON: forward as is, the client ignores it */
    }
    if (msg && msg.method === "fs/read_text_file" && msg.id !== undefined) {
      let reply: Json;
      try {
        reply = { jsonrpc: "2.0", id: msg.id, result: readTextFile(root, (msg.params ?? {}) as Json) };
      } catch (e) {
        const err = e as Error & { code?: number };
        reply = { jsonrpc: "2.0", id: msg.id, error: { code: err.code ?? -32603, message: err.message } };
      }
      proc.stdin.write(`${JSON.stringify(reply)}\n`);
      proc.stdin.flush();
      return;
    }
    emit(ws, "acp://message", line);
  });
  void pumpLines(proc.stderr, (line) => {
    process.stderr.write(`[keryx] ${line}\n`);
    stderrTail = `${stderrTail}${line}\n`.slice(-4000);
  });
  void proc.exited.then((code) => {
    if (conn.gen !== gen) return;
    conn.proc = null;
    emit(ws, "acp://exit", { code, stderrTail });
  });

  return {
    keryxPath: cmd.join(" "),
    source: settings.keryxSource,
    note: "Browser dev mode: keryx runs under dev/bridge.ts, not the Tauri core.",
    logPath: "(bridge stderr)",
    minKeryxVersion: MIN_KERYX_VERSION,
    canFallBack: false,
  };
}

// ---- temporary chat images ---------------------------------------------------

const chatStore = createChatAttachmentStore({
  onRoot(dir) { process.once("exit", () => rmSync(dir, { recursive: true, force: true })); },
});

const execGitFile = promisify(execFile);
const MAX_GIT_REPOSITORY_CHILDREN = 4;
let gitRepositoryChildren = 0;

async function gitRepository(cwd: string): Promise<string | null> {
  if (gitRepositoryChildren >= MAX_GIT_REPOSITORY_CHILDREN) throw new Error("busy: too many repository lookups; try again");
  gitRepositoryChildren++;
  try {
    const { stdout } = await execGitFile("git", ["config", "--local", "--get", "remote.origin.url"], {
      cwd,
      encoding: "utf8",
      timeout: 3000,
      maxBuffer: 16 * 1024,
      killSignal: "SIGKILL",
    });
    return githubRepositoryFromOrigin(stdout);
  } catch {
    // Match native behavior when git is missing, times out, or has no usable origin.
    return null;
  } finally {
    gitRepositoryChildren--;
  }
}

// ---- dispatch ----------------------------------------------------------------

/**
 * flows_* may only touch the project this connection started (acp_start). The view requests flows
 * in parallel with starting keryx, so wait briefly for the root before refusing.
 */
async function projectCwd(conn: Conn, cwd: string): Promise<string> {
  if (!conn.root) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 5000);
      conn.rootWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  let real: string;
  try {
    real = await realpath(cwd);
  } catch {
    throw new Error(`The project folder is not available (${cwd})`);
  }
  if (!conn.root || real !== conn.root) throw new Error("flows are only available for the project this window started");
  return conn.root;
}

let reviewReaders = 0;
async function runReviewCli(root: string, argv: string[], readOnly: boolean): Promise<unknown> {
  if (readOnly && reviewReaders >= 8) throw new Error("unavailable: Too many Review reads are running. Retry shortly.");
  if (readOnly) reviewReaders++;
  let stdout: string;
  try {
    const desktopAction = argv[0] === "review" && argv[1] === "desk-run" && ["start", "continue", "decide"].includes(argv[2] ?? "");
    ({ stdout } = await runFile(KERYX_CMD[0]!, [...KERYX_CMD.slice(1), ...argv], { cwd: root, timeout: 150_000, maxBuffer: 32 * 1024 * 1024,
      ...(desktopAction && { env: { ...process.env, KERYX_DESKTOP_REVIEW_ACTION: "1" } }) }));
  } catch (error) {
    const reason = (error as { stderr?: string }).stderr?.trim();
    throw new Error(reason || "unavailable: Could not run the Review reader");
  } finally {
    if (readOnly) reviewReaders--;
  }
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error("unavailable: The selected Keryx CLI did not return a valid Review response.");
  }
}

let reviewTerminalBusy = false;

async function submitReviewInTerminal(root: string, argv: string[]): Promise<unknown> {
  if (process.stdin.isTTY !== true || process.stderr.isTTY !== true) {
    throw new Error("permission: Run the browser dev bridge in an interactive terminal to confirm GitHub publication.");
  }
  if (reviewTerminalBusy) throw new Error("unavailable: Complete the pending review confirmation in the dev terminal.");
  reviewTerminalBusy = true;
  try {
    const child = Bun.spawn([...KERYX_CMD, ...argv], {
      cwd: root, stdin: "inherit", stdout: "pipe", stderr: "inherit",
      signal: AbortSignal.timeout(150_000),
    });
    const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    if (exitCode !== 0) throw new Error("See the dev terminal for the Review publication result.");
    return JSON.parse(stdout);
  } finally {
    reviewTerminalBusy = false;
  }
}

async function runReviewPublication(root: string, target: unknown, request: unknown): Promise<unknown> {
  const raw = JSON.stringify(request);
  if (raw === undefined) throw new Error("configuration: Missing Review publication request.");
  const { kind } = parsePublicationRequest(raw);
  const dir = await mkdtemp(join(tmpdir(), "keryx-review-"));
  try {
    const file = join(dir, "request.json");
    const argv = publicationArgs(target, file);
    await writeFile(file, raw, { flag: "wx", mode: 0o600 });
    return kind === "submit"
      ? await submitReviewInTerminal(root, argv)
      : await runReviewCli(root, argv, kind === "preview");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function handle(ws: ServerWebSocket<Conn>, cmd: string, args: Json): Promise<unknown> {
  const cwd = typeof args.cwd === "string" ? args.cwd : "";
  switch (cmd) {
    case "acp_start":
      return acpStart(ws, cwd, args.noProfile === true);
    case "acp_send": {
      const proc = ws.data.proc;
      if (!proc) throw new Error("keryx is not running in this window");
      proc.stdin.write(`${String(args.message)}\n`);
      proc.stdin.flush();
      return null;
    }
    case "acp_stop":
      stopProc(ws.data);
      return null;
    case "save_chat_file":
      if (!ws.data.root) throw new Error("Open a project before attaching files.");
      return chatStore.saveChatFile(ws.data.attachmentOwner, args);
    case "save_chat_image":
      if (!ws.data.root) throw new Error("Open a project before pasting images.");
      return chatStore.saveChatImage(ws.data.attachmentOwner, args);
    case "discard_chat_attachment":
      return chatStore.discardChatAttachment(ws.data.attachmentOwner, args.path);
    case "commit_chat_attachments":
      return chatStore.commitChatAttachments(ws.data.attachmentOwner, args.paths, ws.data.root);
    case "local_image": {
      return chatStore.localImage(ws.data.attachmentOwner, ws.data.root, args.path);
    }
    case "settings_get":
      return loadSettings();
    case "settings_set": {
      const next = args.settings as Settings;
      return saveSettings({ ...next, recentProjects: loadSettings().recentProjects });
    }
    case "settings_add_recent": {
      const s = loadSettings();
      const project = String(args.project);
      return saveSettings({ ...s, recentProjects: [project, ...s.recentProjects.filter((p) => p !== project)].slice(0, 10) });
    }
    case "version_check": {
      const found = String(args.found);
      return { ok: semverAtLeast(found, MIN_KERYX_VERSION), found, required: MIN_KERYX_VERSION };
    }
    case "app_update_check":
      return null;
    case "app_update_run":
      throw new Error("Browser dev mode runs no Keryx.app; use `keryx app update` in a terminal.");
    case "github_accounts": {
      const { action, login, skip = false } = args;
      if (action === "list" && args.cwd === undefined && login === undefined && skip === false) {
        return runReviewCli(homedir(), ["review", "accounts", "list", "--json"], true);
      }
      if (action === "project" && cwd && login === undefined && skip === false) {
        return runReviewCli(await projectCwd(ws.data, cwd), ["review", "accounts", "project", "--json"], true);
      }
      if (action === "bind" && cwd) {
        const argv = ["review", "accounts", "bind", "--json"];
        if (skip === true && login === undefined) argv.push("--skip");
        else if (skip === false && typeof login === "string" && /^[a-z0-9][a-z0-9_-]{0,99}$/i.test(login)) argv.push("--login", login);
        else throw new Error("configuration: Invalid GitHub account request.");
        return runReviewCli(await projectCwd(ws.data, cwd), argv, false);
      }
      throw new Error("configuration: Invalid GitHub account request.");
    }
    case "github_login":
      throw new Error("In browser dev mode, run `gh auth login --hostname github.com --web` in a terminal, then refresh accounts.");
    case "issues_request": {
      const {action, login, request} = args;
      if (typeof action !== "string" || !["origin","viewer","list","detail","comments","project","move","workspace","open-session","prepare-flow"].includes(action)
        || typeof login !== "string" || !/^[a-z0-9][a-z0-9_-]{0,99}$/i.test(login)
        || !request || typeof request !== "object" || Array.isArray(request) || JSON.stringify(request).length > 32768) {
        throw new Error("Invalid Issues request.");
      }
      return runReviewCli(await projectCwd(ws.data, cwd), ["issues", action, "--login", login, "--request", JSON.stringify(request), "--json"],
        !["move","open-session","prepare-flow"].includes(action));
    }
    case "review_board": {
      const root = await projectCwd(ws.data, cwd);
      const argv = reviewBoardArgs(args);
      return runReviewCli(root, argv, true);
    }
    case "review_rules": {
      const root = await projectCwd(ws.data, cwd);
      return runReviewCli(root, reviewRuleArgs(args.target, args.action), (args.action as Json)?.kind === "status");
    }
    case "review_watcher": {
      const root = await projectCwd(ws.data, cwd);
      return runReviewCli(root, reviewWatcherArgs(args.target, args.action), (args.action as Json)?.kind === "status");
    }
    case "review_run": {
      const root = await projectCwd(ws.data, cwd);
      const argv = reviewRunArgs(args.target, args.action);
      return runReviewCli(root, argv, argv[2] === "status" || argv[2] === "readiness");
    }
    case "review_publish": {
      const root = await projectCwd(ws.data, cwd);
      return runReviewPublication(root, args.target, args.request);
    }
    case "flows_list":
      return flowsList(await projectCwd(ws.data, cwd));
    case "flows_get":
      return flowsGet(await projectCwd(ws.data, cwd), String(args.dir));
    case "flows_action":
      return flowsAction(await projectCwd(ws.data, cwd), String(args.dir), (args.action ?? {}) as Json);
    case "flows_watch": {
      const root = await projectCwd(ws.data, cwd);
      const w = watched.get(root) ?? { sig: flowsSignature(root), sockets: new Set() };
      w.sockets.add(ws);
      watched.set(root, w);
      return null;
    }
    case "git_repository":
      return gitRepository(await projectCwd(ws.data, cwd));
    case "git_info": {
      // Same parse as src-tauri/src/gitinfo.rs, for the browser dev mode.
      const r = Bun.spawnSync(["git", "status", "--porcelain=v2", "--branch"], { cwd: await projectCwd(ws.data, cwd), env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
      if (r.exitCode !== 0) return null;
      const info = { branch: null as string | null, commit: null as string | null, upstream: null as string | null, ahead: 0, behind: 0, changed: 0, worktree: null as string | null };
      // A linked worktree has its own git dir under the common one: name it after its folder.
      const dirs = Bun.spawnSync(["git", "rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir", "--show-toplevel"], { cwd: await projectCwd(ws.data, cwd) });
      if (dirs.exitCode === 0) {
        const [gitDir, commonDir, top] = dirs.stdout.toString().trim().split("\n");
        if (gitDir && commonDir && top && gitDir !== commonDir) info.worktree = top.split("/").pop() ?? null;
      }
      for (const line of r.stdout.toString().split("\n")) {
        if (line.startsWith("# branch.head ")) info.branch = line.slice(14) === "(detached)" ? null : line.slice(14);
        else if (line.startsWith("# branch.oid ")) info.commit = line.slice(13) === "(initial)" ? null : line.slice(13, 22);
        else if (line.startsWith("# branch.upstream ")) info.upstream = line.slice(18);
        else if (line.startsWith("# branch.ab ")) {
          const [a, b] = line.slice(12).split(" ");
          info.ahead = Number(a?.slice(1)) || 0;
          info.behind = Number(b?.slice(1)) || 0;
        } else if (line && !line.startsWith("#")) info.changed += 1;
      }
      return info;
    }
    case "pr_info": {
      // Same summary as src-tauri/src/pullrequest.rs, for the browser dev mode.
      return prInfo(await projectCwd(ws.data, cwd));
    }
    default:
      throw new Error(`Unknown command: ${cmd}`);
  }
}

const GH_ENV = { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" };
const THREADS_QUERY =
  "query($o:String!,$n:String!,$num:Int!){repository(owner:$o,name:$n){pullRequest(number:$num){reviewThreads(first:100){nodes{isResolved}}}}}";

function gh(args: string[], dir: string, timeout: number): string | null {
  try {
    const r = Bun.spawnSync(["gh", ...args], { cwd: dir, env: GH_ENV, timeout, stdin: "ignore" });
    return r.exitCode === 0 ? r.stdout.toString() : null;
  } catch {
    return null; // no gh on PATH
  }
}

// biome-ignore lint/suspicious/noExplicitAny: gh's JSON is read field by field below
type Gh = Record<string, any>;

function prInfo(dir: string): Json | null {
  const text = gh(["pr", "view", "--json", "number,url,state,isDraft,reviewDecision,statusCheckRollup"], dir, 8000);
  if (!text) return null;
  let v: Gh;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (v.state !== "OPEN") return null;
  let passed = 0;
  let failed = 0;
  let pending = 0;
  for (const c of (v.statusCheckRollup ?? []) as Gh[]) {
    if (c.status !== undefined) {
      if (c.status !== "COMPLETED") pending++;
      else if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(c.conclusion)) passed++;
      else failed++;
    } else if (c.state === "SUCCESS") passed++;
    else if (c.state === "PENDING" || c.state === "EXPECTED") pending++;
    else failed++;
  }
  let unresolvedThreads = 0;
  const m = /^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\//.exec(v.url);
  if (m) {
    const t = gh(["api", "graphql", "-f", `query=${THREADS_QUERY}`, "-f", `o=${m[1]}`, "-f", `n=${m[2]}`, "-F", `num=${v.number}`], dir, 8000);
    try {
      const nodes = (JSON.parse(t ?? "{}").data?.repository?.pullRequest?.reviewThreads?.nodes ?? []) as Gh[];
      unresolvedThreads = nodes.filter((n) => n.isResolved === false).length;
    } catch {
      /* no thread count */
    }
  }
  return {
    number: v.number,
    url: v.url,
    isDraft: !!v.isDraft,
    reviewDecision: v.reviewDecision ?? "",
    ci: failed ? "failed" : pending ? "pending" : passed ? "passed" : "none",
    checksPassed: passed,
    checksFailed: failed,
    checksPending: pending,
    unresolvedThreads,
  };
}

Bun.serve<Conn>({
  hostname: "127.0.0.1",
  port: PORT,
  fetch(req, server) {
    // Only the Vite dev origin may drive keryx through this bridge.
    const origin = req.headers.get("origin") ?? "";
    if (!/^http:\/\/(localhost|127\.0\.0\.1):1420$/.test(origin)) {
      return new Response("forbidden origin", { status: 403 });
    }
    if (server.upgrade(req, { data: { proc: null, root: null, gen: 0, rootWaiters: [], attachmentOwner: { closed: false } } })) return undefined;
    return new Response("keryx desktop dev bridge", { status: 426 });
  },
  websocket: {
    // 5 MiB attachment as base64 (~6.7 MiB) plus JSON overhead fits comfortably.
    maxPayloadLength: 12 * 1024 * 1024,
    async message(ws, raw) {
      let msg: { id?: number; cmd?: string; args?: Json };
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      const id = msg.id ?? 0;
      try {
        const result = await handle(ws, String(msg.cmd), msg.args ?? {});
        ws.send(JSON.stringify({ id, ok: true, result: result ?? null }));
      } catch (e) {
        ws.send(JSON.stringify({ id, ok: false, error: e instanceof Error ? e.message : String(e) }));
      }
    },
    close(ws) {
      void chatStore.cleanupChatOwner(ws.data.attachmentOwner).catch((error) => {
        console.error("[bridge] chat attachment cleanup failed", error);
      });
      stopProc(ws.data);
      for (const w of watched.values()) w.sockets.delete(ws);
    },
  },
});

// These signals skip the "exit" event by default; exiting explicitly runs the chat image root cleanup.
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]] as const) {
  process.on(signal, () => process.exit(code));
}

console.log(`[bridge] keryx desktop dev bridge on ws://127.0.0.1:${PORT}`);
console.log(`[bridge] keryx command: ${KERYX_CMD.join(" ")}`);
