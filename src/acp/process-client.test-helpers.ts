// The `AcpProcessClient` harness shared by every ACP process test that drives
// a REAL `keryx acp` subprocess over stdin/stdout — T9's
// `permission.process.test.ts`, T10/T11's `cancel-list-load.process.test.ts`
// and `capability-matrix.process.test.ts`, and T12's
// `conformance.process.test.ts`.
//
// This is not a mock: it is the actual process, the actual newline framing
// (`./framing.ts`), and the actual scheduler race between a `session/update`
// notification and a `session/prompt` reply — the properties AC8 exists to
// prove end to end. `messages()` records every frame in ARRIVAL order, so a
// test can assert not just that a frame exists but where it landed relative
// to others (see `permission.process.test.ts`'s header comment on why that
// matters for F-4's failure-in-the-safe-direction).
//
// Previously copied byte-for-byte into three test files; factored out here
// (flow 285, T12) so a fourth conformance test does not become a fourth copy.

import path from "node:path";
import type { Subprocess } from "bun";
import { ACP_CLIENT_METHODS } from "./protocol";

/** `src/cli.ts`, resolved relative to this file so every caller in `src/acp/` gets the same path. */
export const ACP_CLI = path.join(import.meta.dir, "..", "cli.ts");

export interface WireMessage {
  readonly jsonrpc?: "2.0";
  readonly id?: string | number | null;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
  readonly result?: Record<string, unknown>;
  readonly error?: { code: number; message: string; data?: unknown };
}

export interface AcpProcessClientOptions {
  /** Defaults to `ACP_CLI`; override only for a test that needs a different build. */
  readonly cli?: string;
  /**
   * The `--fixture` scripted provider. Omitted ONLY by a test of provider
   * resolution itself (flow 287): without it `keryx acp` resolves a real
   * provider the way `keryx shell` does, so such a test must also point
   * `homeRoot` at a config directory it controls.
   */
  readonly fixture?: string;
  /** The subprocess's cwd — normally the sandboxed project directory. */
  readonly cwd: string;
  readonly dataDir: string;
  /** `XDG_DATA_HOME` / `APPDATA` for the subprocess — normally the sandbox root. */
  readonly homeRoot: string;
  /** Extra argv appended after `acp --fixture <fixture> --data-dir <dataDir>`. */
  readonly extraArgs?: readonly string[];
  /** Overrides/additions to the inherited `process.env`. */
  readonly env?: Record<string, string>;
}

/** One `keryx acp` subprocess, driven as a client would drive it. */
export class AcpProcessClient {
  private readonly proc: Subprocess<"pipe", "pipe", "pipe">;
  private readonly seen: WireMessage[] = [];
  private readonly waiters: { match: (m: WireMessage) => boolean; settle: (m: WireMessage) => void }[] = [];
  private readonly stderr: string[] = [];
  private readonly stderrDone: Promise<void>;
  private nextId = 1;

  constructor(options: AcpProcessClientOptions) {
    const cli = options.cli ?? ACP_CLI;
    const args = [
      "bun",
      "run",
      cli,
      "acp",
      ...(options.fixture !== undefined ? ["--fixture", options.fixture] : []),
      "--data-dir",
      options.dataDir,
      ...(options.extraArgs ?? []),
    ];
    this.proc = Bun.spawn(args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        XDG_DATA_HOME: options.homeRoot,
        APPDATA: options.homeRoot,
        ...(options.env ?? {}),
      } as Record<string, string>,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    void this.pump();
    this.stderrDone = this.pumpStderr();
  }

  private async pump(): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of this.proc.stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (line.trim().length === 0) {
          continue;
        }
        const message = JSON.parse(line) as WireMessage;
        this.seen.push(message);
        for (const waiter of [...this.waiters]) {
          if (waiter.match(message)) {
            this.waiters.splice(this.waiters.indexOf(waiter), 1);
            waiter.settle(message);
          }
        }
      }
    }
  }

  private async pumpStderr(): Promise<void> {
    const decoder = new TextDecoder();
    for await (const chunk of this.proc.stderr) {
      this.stderr.push(decoder.decode(chunk, { stream: true }));
    }
  }

  send(message: Record<string, unknown>): void {
    this.proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    void this.proc.stdin.flush();
  }

  /** Sends a request and returns its id (the caller waits for the matching reply). */
  request(method: string, params: Record<string, unknown>): number {
    const id = this.nextId++;
    this.send({ id, method, params });
    return id;
  }

  async waitFor(match: (m: WireMessage) => boolean, what: string, timeoutMs = 30_000): Promise<WireMessage> {
    const already = this.seen.find(match);
    if (already !== undefined) {
      return already;
    }
    return await new Promise<WireMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((w) => w.settle === settle);
        if (index >= 0) {
          this.waiters.splice(index, 1);
        }
        reject(new Error(`timed out waiting for ${what}; saw:\n${this.transcript()}\nstderr:\n${this.stderr.join("")}`));
      }, timeoutMs);
      const settle = (message: WireMessage): void => {
        clearTimeout(timer);
        resolve(message);
      };
      this.waiters.push({ match, settle });
    });
  }

  /** Every frame received so far, in ARRIVAL order — the evidence a test reasons over. */
  messages(): readonly WireMessage[] {
    return this.seen;
  }

  /** `session/update` frames whose `update.sessionUpdate` is `kind`. */
  updates(kind: string): WireMessage[] {
    return this.seen.filter(
      (m) =>
        m.method === ACP_CLIENT_METHODS.sessionUpdate &&
        (m.params?.["update"] as { sessionUpdate?: string })?.sessionUpdate === kind,
    );
  }

  /** `session/update` frames for one `sessionId`. */
  updatesForSession(sessionId: string): WireMessage[] {
    return this.seen.filter((m) => m.method === ACP_CLIENT_METHODS.sessionUpdate && m.params?.["sessionId"] === sessionId);
  }

  /** Every `session/request_permission` request seen so far. */
  permissionRequests(): WireMessage[] {
    return this.seen.filter((m) => m.method === ACP_CLIENT_METHODS.sessionRequestPermission);
  }

  /** Everything the process has written to stderr so far. */
  stderrText(): string {
    return this.stderr.join("");
  }

  /** Resolves once stderr has reached EOF — after this, `stderrText()` is complete. */
  stderrClosed(): Promise<void> {
    return this.stderrDone;
  }

  /** Resolves when the process exits — a real event, not a timer. */
  exited(): Promise<number> {
    return this.proc.exited;
  }

  transcript(): string {
    return this.seen.map((m) => JSON.stringify(m)).join("\n");
  }

  /** Closes stdin (the client going away) and waits for the process to finish. */
  async end(): Promise<void> {
    try {
      this.proc.stdin.end();
    } catch {
      // already closed
    }
    await this.proc.exited;
  }

  async kill(): Promise<void> {
    this.proc.kill();
    await this.proc.exited;
  }
}
