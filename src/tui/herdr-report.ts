// Herdr agent-state reporter — surfaces the TUI's main-agent lifecycle to the
// `herdr` terminal workspace manager so a keryx pane shows working/idle/blocked
// in the agent panel alongside claude/opencode. Fully optional and best-effort:
// a no-op unless the pane was launched by herdr (HERDR_ENV=1 plus the pane id
// and socket path it injects).
//
// Protocol mirrors herdr's built-in integrations (e.g. its opencode plugin):
// newline-delimited JSON over the pane's unix socket. `pane.report_agent`
// carries the lifecycle state; `pane.release_agent` hands pane authority back
// when the shell exits. herdr already ships a `keryx` detection manifest, so the
// `keryx` agent id is accepted without any host-side install step. Writes are
// serialized on a single promise chain and never block or throw into the shell.

import net from "node:net";

const SOURCE = "herdr:keryx";
const AGENT = "keryx";
/** herdr's own connect+write budget for a single report (matches its plugins). */
const WRITE_TIMEOUT_MS = 500;

/** The three lifecycle states herdr renders for an agent pane. */
export type HerdrState = "working" | "idle" | "blocked";

interface HerdrEnv {
  paneId: string;
  socketPath: string;
}

/** Read herdr's pane env once. Absent (not launched by herdr) → reporter no-ops. */
function readHerdrEnv(): HerdrEnv | undefined {
  if (process.env.HERDR_ENV !== "1") return undefined;
  const paneId = process.env.HERDR_PANE_ID;
  const socketPath = process.env.HERDR_SOCKET_PATH;
  if (!paneId || !socketPath) return undefined;
  return { paneId, socketPath };
}

export interface HerdrReporter {
  /** Report the pane's main-agent lifecycle state. Deduped, fire-and-forget. */
  report(state: HerdrState): void;
  /** Hand pane authority back to herdr on shell exit. Awaitable so exit flushes it. */
  release(): Promise<void>;
}

const NOOP: HerdrReporter = {
  report: () => {},
  release: () => Promise.resolve(),
};

/**
 * Build a reporter for the current pane. `clock` is injectable for tests; the seq
 * is seeded from wall-clock (like herdr's plugins) so a fresh shell in a reused
 * pane never emits a seq below the previous process's — herdr orders by seq.
 */
export function createHerdrReporter(
  clock: () => number = () => Date.now(),
  connect: SocketWriter = writeOnce,
): HerdrReporter {
  const env = readHerdrEnv();
  if (env === undefined) return NOOP;

  let seq = clock() * 1000;
  let chain: Promise<void> = Promise.resolve();
  let last: HerdrState | undefined;

  const send = (method: string, params: Record<string, unknown>): Promise<void> => {
    seq += 1;
    const request = {
      id: `${SOURCE}:${seq}`,
      method,
      params: { pane_id: env.paneId, source: SOURCE, agent: AGENT, seq, ...params },
    };
    chain = chain.then(() => connect(env.socketPath, request)).catch(() => {});
    return chain;
  };

  return {
    report(state) {
      if (state === last) return;
      last = state;
      void send("pane.report_agent", { state });
    },
    release() {
      last = undefined;
      return send("pane.release_agent", {});
    },
  };
}

/** Map the TUI's `setMainAgent` status vocabulary onto herdr's three states. */
export function herdrStateFor(
  status: "queued" | "running" | "done" | "failed" | "blocked",
): HerdrState {
  if (status === "running") return "working";
  if (status === "blocked") return "blocked";
  // queued (pre-first-turn), done, failed → back at the prompt, awaiting input.
  return "idle";
}

export type SocketWriter = (socketPath: string, request: unknown) => Promise<void>;

/** One connect → write one JSON line → close. Resolves on completion or timeout. */
function writeOnce(socketPath: string, request: unknown): Promise<void> {
  const endpoint =
    process.platform === "win32" ? `\\\\.\\pipe\\${socketPath}` : socketPath;
  return new Promise((resolve) => {
    const client = net.createConnection(endpoint, () => {
      client.write(`${JSON.stringify(request)}\n`);
    });
    const finish = (): void => {
      client.destroy();
      resolve();
    };
    client.setTimeout(WRITE_TIMEOUT_MS, finish);
    client.on("data", finish);
    client.on("error", finish);
    client.on("end", finish);
    client.on("close", () => resolve());
  });
}
