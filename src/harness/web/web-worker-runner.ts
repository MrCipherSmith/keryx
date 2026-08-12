import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { wrapWithSandbox } from "../process/sandbox/wrap";
import type { SandboxProfile } from "../process/sandbox/profile";
import type { WebPolicyResult } from "./web-policy";
import type { WebWorkerRequest, WebWorkerResponse, WebWorkerRunner } from "./sandboxed-web-transport";

const WORKER_TIMEOUT_MS = 10_000;
const MAX_WORKER_OUTPUT_BYTES = 192_000;

// This source intentionally uses built-in modules only. It is passed with
// `bun --eval`, so the child never imports code from the project worktree.
const WORKER_SOURCE = String.raw`
const { request: httpsRequest } = await import("node:https");
const { request: httpRequest } = await import("node:http");
const { isIP } = await import("node:net");
const input = JSON.parse(await Bun.stdin.text());
const fail = () => process.stdout.write(JSON.stringify({ ok: false, reason: "request failed or timed out" }));
try {
  const timer = setTimeout(() => req.destroy(new Error("timeout")), input.timeoutMs);
  const headers = { accept: "text/html, text/plain, application/json, application/xml, application/xhtml+xml" };
  const payload = input.body && typeof input.body === "object" ? { ...input.body } : undefined;
  if (input.credential && input.credential.injection === "header") headers[input.credential.name] = input.credential.value;
  if (input.credential && input.credential.injection === "json-body") {
    if (!payload) throw new Error("missing JSON request payload");
    payload[input.credential.name] = input.credential.value;
  }
  const encoded = payload ? JSON.stringify(payload) : undefined;
  if (encoded) { headers["content-type"] = "application/json"; headers["content-length"] = String(Buffer.byteLength(encoded)); }
  const request = input.url.startsWith("http:") ? httpRequest : httpsRequest;
  const req = request(input.url, {
    method: input.method,
    lookup: (_host, options, callback) => {
      const record = { address: input.address, family: isIP(input.address) };
      // Bun's HTTPS client may request all=true for its connection strategy.
      // Return the same prevalidated pinned address in the exact callback shape
      // requested, never delegate another DNS lookup to the worker.
      if (options && options.all) callback(null, [record]);
      else callback(null, record.address, record.family);
    },
    ...(input.url.startsWith("https:") ? { servername: input.hostname } : {}),
    headers,
  }, (res) => {
    const chunks = []; let size = 0;
    res.on("data", (chunk) => {
      size += chunk.length;
      if (size > input.maxBytes) req.destroy(new Error("output overflow"));
      else chunks.push(chunk);
    });
    res.on("end", () => {
      clearTimeout(timer);
      process.stdout.write(JSON.stringify({ ok: true, value: {
        status: res.statusCode || 502,
        contentType: String(res.headers["content-type"] || ""),
        ...(typeof res.headers.location === "string" ? { location: res.headers.location } : {}),
        body: Buffer.concat(chunks).toString("utf8"),
      }}));
    });
  });
  req.on("error", () => { clearTimeout(timer); fail(); });
  req.end(encoded);
} catch { fail(); }
`;

function webSandboxProfile(workspace: string, home: string): SandboxProfile {
  return {
    mode: "read-only",
    network: "on",
    writableRoots: [],
    // The worker is evaluated from stdin, not loaded from the project. Mask its
    // parent workspace and home even where the platform launcher otherwise needs
    // system runtime files readable.
    readDenyList: [workspace, home],
    allowedDomains: [],
    required: true,
  };
}

async function readBounded(stream: ReadableStream<Uint8Array> | null): Promise<string | undefined> {
  if (!stream) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_WORKER_OUTPUT_BYTES) return undefined;
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export class SystemWebWorkerRunner implements WebWorkerRunner {
  private readonly workspace: string;
  private readonly home: string;
  private readonly platform: string;

  constructor(options: { workspace?: string; home?: string; platform?: string } = {}) {
    this.workspace = options.workspace ?? process.cwd();
    this.home = options.home ?? homedir();
    this.platform = options.platform ?? process.platform;
  }

  async run(request: WebWorkerRequest, signal?: AbortSignal): Promise<WebPolicyResult<WebWorkerResponse>> {
    const launcherAvailable = this.platform === "darwin"
      ? existsSync("/usr/bin/sandbox-exec")
      : this.platform === "linux"
        ? Bun.which("bwrap") !== null
        : false;
    if (!launcherAvailable) return { ok: false, reason: "web sandbox launcher is unavailable" };

    const bwrapPath = this.platform === "linux" ? Bun.which("bwrap") : null;
    const wrapOptions = bwrapPath === null ? { platform: this.platform } : { platform: this.platform, bwrapPath };
    const wrapped = wrapWithSandbox(
      {
        path: process.execPath,
        argv: [process.execPath, "--eval", WORKER_SOURCE],
        env: {},
        cwd: "/",
      },
      webSandboxProfile(this.workspace, this.home),
      wrapOptions,
    );
    if (!wrapped.ok || !wrapped.wrapped) return { ok: false, reason: "web sandbox could not be constructed" };

    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn([wrapped.command.path, ...wrapped.command.argv.slice(1)], {
        cwd: "/",
        env: {},
        stdin: "pipe",
        stdout: "pipe",
        stderr: "ignore",
      });
    } catch {
      return { ok: false, reason: "web sandbox failed to start" };
    }
    const abort = () => proc.kill();
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, WORKER_TIMEOUT_MS);
    try {
      const stdin = proc.stdin;
      const stdout = proc.stdout;
      if (stdin === undefined || typeof stdin === "number" || stdout === undefined || typeof stdout === "number") {
        proc.kill();
        return { ok: false, reason: "web sandbox has invalid stdio" };
      }
      stdin.write(JSON.stringify({ ...request, timeoutMs: WORKER_TIMEOUT_MS, maxBytes: 128_000 }));
      stdin.end();
      const output = await readBounded(stdout);
      if (output === undefined) {
        proc.kill();
        await proc.exited;
        return { ok: false, reason: "web sandbox returned oversized output" };
      }
      const exit = await proc.exited;
      if (exit !== 0) return { ok: false, reason: "web sandbox request failed" };
      try {
        const parsed = JSON.parse(output) as WebPolicyResult<WebWorkerResponse>;
        if (!parsed || typeof parsed !== "object" || typeof parsed.ok !== "boolean") {
          return { ok: false, reason: "web sandbox returned malformed output" };
        }
        return parsed;
      } catch {
        return { ok: false, reason: "web sandbox returned malformed output" };
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }
}

/** Production construction is deliberately the only non-test runner factory. */
export function createSystemWebWorkerRunner(): SystemWebWorkerRunner {
  return new SystemWebWorkerRunner({ workspace: process.cwd(), home: homedir() });
}
