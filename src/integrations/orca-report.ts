import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

export type OrcaState = "idle" | "working" | "blocked" | "stopped";
export interface OrcaReporter {
  report(state: OrcaState): void;
  release(): Promise<void>;
}

/** Literal data only: never source/eval Orca's endpoint environment file. */
export function parseOrcaEndpoint(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const match = /^(?:export\s+)?(ORCA_AGENT_HOOK_(?:PORT|TOKEN|ENV|VERSION|TRANSPORT|OPENCODE_TUI))=(?:'([^'\r\n]*)'|"([^"$`\\\r\n]*)"|([A-Za-z0-9_.:/+-]+))\s*$/.exec(line);
    if (match === null) throw new Error("nonliteral endpoint assignment");
    const key = match[1];
    if (key === undefined || result[key] !== undefined) throw new Error("duplicate endpoint key");
    result[key] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return result;
}

/** Experimental native contract; stock Orca 1.4.227 has no /hook/keryx route. */
export function createOrcaReporter(options: {
  env?: NodeJS.ProcessEnv;
  post?: (url: string, init: RequestInit) => Promise<Response>;
  onError?: () => void;
} = {}): OrcaReporter {
  const env = { ...(options.env ?? process.env) };
  const noop: OrcaReporter = { report() {}, async release() {} };
  if (env.KERYX_ORCA_HOOKS !== "1") return noop;
  const warn = (): void => { try { options.onError?.(); } catch { /* observation only */ } };
  let endpoint: Record<string, string> = {};
  try {
    if (env.ORCA_AGENT_HOOK_ENDPOINT !== undefined) {
      const fd = openSync(env.ORCA_AGENT_HOOK_ENDPOINT, constants.O_RDONLY | constants.O_NONBLOCK);
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.size > 16_384) throw new Error("invalid endpoint file");
        const buffer = Buffer.alloc(16_385);
        const size = readSync(fd, buffer, 0, buffer.length, 0);
        if (size > 16_384) throw new Error("endpoint file grew");
        endpoint = parseOrcaEndpoint(buffer.toString("utf8", 0, size));
      } finally { closeSync(fd); }
    }
  } catch { warn(); return noop; }
  const port = endpoint.ORCA_AGENT_HOOK_PORT ?? env.ORCA_AGENT_HOOK_PORT;
  const token = endpoint.ORCA_AGENT_HOOK_TOKEN ?? env.ORCA_AGENT_HOOK_TOKEN;
  if (port === undefined || !/^[1-9]\d{0,4}$/.test(port) || Number(port) > 65535 ||
      token === undefined || !/^[\x21-\x7e]{1,4096}$/.test(token) ||
      !env.ORCA_PANE_KEY || !env.ORCA_AGENT_LAUNCH_TOKEN) {
    warn(); return noop;
  }
  const url = `http://127.0.0.1:${port}/hook/keryx`;
  const post = options.post ?? ((target, init) => fetch(target, init));
  let disabled = false;
  let closed = false;
  let last: OrcaState | undefined;
  let queue: OrcaState[] = [];
  let flight: Promise<void> | undefined;
  let releaseFlight: Promise<void> | undefined;
  const fail = (): void => {
    if (!disabled) { disabled = true; queue = []; warn(); }
  };
  const send = async (state: OrcaState): Promise<void> => {
    const body = JSON.stringify({
      paneKey: env.ORCA_PANE_KEY ?? "", tabId: env.ORCA_TAB_ID ?? "",
      worktreeId: env.ORCA_WORKTREE_ID ?? "", launchToken: env.ORCA_AGENT_LAUNCH_TOKEN ?? "",
      env: endpoint.ORCA_AGENT_HOOK_ENV ?? env.ORCA_AGENT_HOOK_ENV ?? "", version: endpoint.ORCA_AGENT_HOOK_VERSION ?? env.ORCA_AGENT_HOOK_VERSION ?? "1",
      payload: { event: "keryx_state", protocolVersion: 1, state },
    });
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { abort.abort(); reject(new Error("timeout")); }, 500);
      });
      const response = await Promise.race([post(url, {
        method: "POST", redirect: "error", signal: abort.signal,
        headers: { "Content-Type": "application/json", "X-Orca-Agent-Hook-Token": token },
        body,
      }), timeout]);
      void response.body?.cancel().catch(() => {});
      if (!response.ok) fail();
    } catch { fail(); }
    finally { if (timer !== undefined) clearTimeout(timer); }
  };
  const drain = (): void => {
    if (flight !== undefined) return;
    flight = (async () => {
      while (!disabled && queue.length > 0) {
        const state = queue.shift();
        if (state !== undefined) await send(state);
      }
    })().finally(() => {
      flight = undefined;
      if (!disabled && queue.length > 0) drain();
    });
  };
  return {
    report(state) {
      if (closed || disabled || state === last) return;
      last = state;
      if (queue.length >= 16) { fail(); return; }
      queue.push(state); drain();
    },
    release() {
      releaseFlight ??= (async () => {
        closed = true;
        queue = [];
        await flight;
        // Supersede unsent states: shutdown waits at most two 500ms deadlines.
        if (!disabled) await send("stopped");
      })();
      return releaseFlight;
    },
  };
}
