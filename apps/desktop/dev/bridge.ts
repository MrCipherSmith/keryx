// Browser dev mode bridge: a local stand-in for the Tauri Rust core.
//
// `bun run dev:browser` starts this next to Vite. The web view (only in a Vite
// dev build, outside Tauri) connects to ws://127.0.0.1:1421 and calls the same
// commands the Rust core exposes:
//
//   acp_start(cwd, noProfile) / acp_send(message) / acp_stop()
//   settings_get / settings_set / settings_add_recent / version_check(found)
//   flows_list(cwd) / flows_get(cwd, id) / flows_action(cwd, id, action) / flows_watch(cwd)
//
// and receives the same events: acp://message, acp://exit, acp://error,
// flows://changed. One WebSocket connection is one "window" with its own
// keryx process. Development only: it listens on loopback and is never bundled.

import { existsSync, readdirSync, readFileSync, realpathSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import type { ServerWebSocket, Subprocess } from "bun";

const PORT = 1421;
const REPO_ROOT = resolve(import.meta.dir, "../../..");
const KERYX_CMD = (process.env.KERYX_DEV_CMD ?? `bun run ${join(REPO_ROOT, "src/cli.ts")}`)
  .split(/\s+/)
  .filter(Boolean);
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
  keryxSource: "bundled" | "path" | "custom";
  customPath: string | null;
  recentProjects: string[];
}

function loadSettings(): Settings {
  const fallback: Settings = {
    keryxSource: "bundled",
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
  id: string;
  dir: string;
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

function flowDirs(cwd: string): string[] {
  const root = flowsRoot(cwd);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d+-/.test(d.name))
    .map((d) => d.name);
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

function cardFor(cwd: string, dir: string): { card: FlowCard; state: Json | null; criteria: ReturnType<typeof parseCriteria> } {
  const base = join(flowsRoot(cwd), dir);
  const idFromDir = /^(\d+)-/.exec(dir)?.[1] ?? dir;
  const criteria = parseCriteria(readOptional(join(base, "acceptance-criteria.md")));
  const empty: FlowCard = {
    id: idFromDir,
    dir,
    title: dir.replace(/^\d+-\d{4}-\d{2}-\d{2}-/, "").replace(/-/g, " "),
    status: "unknown",
    previousStatus: null,
    blocked: false,
    owner: null,
    prUrl: null,
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
      id: str(state.id) ?? idFromDir,
      title: str(state.title) ?? empty.title,
      status,
      previousStatus: str(state.previousStatus),
      blocked: status === "blocked",
      owner: str(owner?.value),
      prUrl: str(pr?.url),
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

function findDir(cwd: string, id: string): string {
  const dir = flowDirs(cwd).find((d) => d.startsWith(`${id}-`));
  if (!dir) throw new Error(`No flow #${id} in this project`);
  return dir;
}

function flowsGet(cwd: string, id: string): Json {
  const dir = findDir(cwd, id);
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
function flowArgv(id: string, action: Json): string[] {
  if (!/^\d+$/.test(id)) throw new Error(`Not a flow id: ${id}`);
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
      return ["flow", "start", id];
    case "block":
      return ["flow", "block", id, "--reason", text("reason")];
    case "unblock":
      return ["flow", "unblock", id];
    case "taskAdd": {
      const kind = text("kind");
      if (!TASK_KINDS.has(kind)) throw new Error(`Unknown task kind: ${kind}`);
      return ["flow", "task", "add", id, "--title", text("title"), "--kind", kind];
    }
    case "taskAttempt": {
      const outcome = text("outcome");
      if (!OUTCOMES.has(outcome)) throw new Error(`Unknown outcome: ${outcome}`);
      return ["flow", "task", "attempt", id, task(), "--outcome", outcome, "--detail", text("detail")];
    }
    case "taskDone":
      return ["flow", "task", "done", id, task()];
    case "freeze":
      return ["flow", "freeze", id];
    case "next":
      return ["flow", "next", id, "--json"];
    default:
      throw new Error(`Action not allowed: ${String(action.type)}`);
  }
}

async function flowsAction(cwd: string, id: string, action: Json) {
  const argv = flowArgv(id, action);
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
  };
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
    real = realpathSync(cwd);
  } catch {
    throw new Error(`The project folder is not available (${cwd})`);
  }
  if (!conn.root || real !== conn.root) throw new Error("flows are only available for the project this window started");
  return conn.root;
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
    case "flows_list":
      return flowsList(await projectCwd(ws.data, cwd));
    case "flows_get":
      return flowsGet(await projectCwd(ws.data, cwd), String(args.id));
    case "flows_action":
      return flowsAction(await projectCwd(ws.data, cwd), String(args.id), (args.action ?? {}) as Json);
    case "flows_watch": {
      const root = await projectCwd(ws.data, cwd);
      const w = watched.get(root) ?? { sig: flowsSignature(root), sockets: new Set() };
      w.sockets.add(ws);
      watched.set(root, w);
      return null;
    }
    default:
      throw new Error(`Unknown command: ${cmd}`);
  }
}

Bun.serve<Conn, undefined>({
  hostname: "127.0.0.1",
  port: PORT,
  fetch(req, server) {
    // Only the Vite dev origin may drive keryx through this bridge.
    const origin = req.headers.get("origin") ?? "";
    if (!/^http:\/\/(localhost|127\.0\.0\.1):1420$/.test(origin)) {
      return new Response("forbidden origin", { status: 403 });
    }
    if (server.upgrade(req, { data: { proc: null, root: null, gen: 0, rootWaiters: [] } })) return undefined;
    return new Response("keryx desktop dev bridge", { status: 426 });
  },
  websocket: {
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
      stopProc(ws.data);
      for (const w of watched.values()) w.sockets.delete(ws);
    },
  },
});

console.log(`[bridge] keryx desktop dev bridge on ws://127.0.0.1:${PORT}`);
console.log(`[bridge] keryx command: ${KERYX_CMD.join(" ")}`);
