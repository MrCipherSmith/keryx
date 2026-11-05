import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import type { ReviewV3SpawnInput } from "./v3/types";
import type {
  ExternalBridgeRequest,
  ExternalBridgeResponse,
  ExternalGeneralBridge,
} from "./v3-external-adapter";

export const REVIEW_V3_BRIDGE_SOCKET_ENV = "KERYX_REVIEW_V3_BRIDGE_SOCKET";
export const REVIEW_V3_BRIDGE_TOKEN_ENV = "KERYX_REVIEW_V3_BRIDGE_TOKEN";
export const REVIEW_V3_BRIDGE_RUN_DIR_ENV = "KERYX_REVIEW_V3_BRIDGE_RUN_DIR";
export const DEFAULT_EXTERNAL_BRIDGE_MAX_LINE_BYTES = 1024 * 1024;

interface BridgeWireRequest {
  readonly v: 1;
  readonly id: string;
  readonly token: string;
  readonly request: ExternalBridgeRequest;
}

interface BridgeWireResponse {
  readonly v: 1;
  readonly id: string;
  readonly response: ExternalBridgeResponse;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key)) && keys.every((key) => key in value);
}

function parseWireRequest(line: string): BridgeWireRequest | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || !exactKeys(value, ["v", "id", "token", "request"])) return undefined;
  if (value.v !== 1 || typeof value.id !== "string" || value.id.length < 1 || value.id.length > 200) return undefined;
  if (typeof value.token !== "string" || value.token.length < 32 || !isRecord(value.request)) return undefined;
  const operation = value.request.operation;
  if (operation === "spawn") {
    if (!exactKeys(value.request, ["operation", "input"]) || !isRecord(value.request.input)) return undefined;
  } else if (["status", "wait", "result"].includes(String(operation))) {
    if (!exactKeys(value.request, ["operation", "dispatchId"]) || typeof value.request.dispatchId !== "string" || value.request.dispatchId.trim() === "") return undefined;
  } else if (operation === "cancel") {
    if (!exactKeys(value.request, ["operation", "dispatchId", "reason"]) || typeof value.request.dispatchId !== "string" || value.request.dispatchId.trim() === "" || typeof value.request.reason !== "string" || value.request.reason.trim() === "") return undefined;
  } else return undefined;
  return value as unknown as BridgeWireRequest;
}

function writeResponse(socket: Socket, response: BridgeWireResponse): void {
  if (!socket.destroyed) socket.write(`${JSON.stringify(response)}\n`);
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

export interface ExternalBridgeSocketServer {
  readonly socketPath: string;
  readonly runDir: string;
  readonly envFor: (token: string) => Readonly<Record<string, string>>;
  readonly close: () => Promise<void>;
}

/**
 * A local-only bridge endpoint. Filesystem permissions and the scoped bearer
 * both gate entry; the bridge still rechecks live host authority on every op.
 */
export async function startExternalBridgeSocketServer(options: {
  readonly bridge: Pick<ExternalGeneralBridge, "invoke">;
  readonly runDir: string;
  readonly tempParent?: string;
  readonly maxLineBytes?: number;
}): Promise<ExternalBridgeSocketServer> {
  const runDir = await realpath(options.runDir);
  const root = await mkdtemp(path.join(options.tempParent ?? tmpdir(), "keryx-review-v3-bridge-"));
  const socketPath = path.join(root, "bridge.sock");
  const maxLineBytes = options.maxLineBytes ?? DEFAULT_EXTERNAL_BRIDGE_MAX_LINE_BYTES;
  const sockets = new Set<Socket>();
  let closed = false;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    let buffered = "";
    socket.on("data", (chunk: string) => {
      buffered += chunk;
      if (Buffer.byteLength(buffered, "utf8") > maxLineBytes) {
        socket.destroy(new Error("bridge request exceeded line limit"));
        return;
      }
      for (;;) {
        const newline = buffered.indexOf("\n");
        if (newline < 0) break;
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        const wire = parseWireRequest(line);
        if (wire === undefined) {
          socket.destroy(new Error("invalid review V3 bridge request"));
          return;
        }
        void options.bridge.invoke(wire.token, wire.request).then(
          (response) => writeResponse(socket, { v: 1, id: wire.id, response }),
          () => writeResponse(socket, {
            v: 1,
            id: wire.id,
            response: { ok: false, code: "controller_error", message: "bridge invocation failed" },
          }),
        );
      }
    });
    socket.on("close", () => sockets.delete(socket));
    // Invalid client input is handled by destroying only that connection.
    socket.on("error", () => undefined);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    await chmod(socketPath, 0o600);
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  return {
    socketPath,
    runDir,
    envFor(token) {
      if (token.length < 32) throw new Error("bridge token is invalid");
      return {
        [REVIEW_V3_BRIDGE_SOCKET_ENV]: socketPath,
        [REVIEW_V3_BRIDGE_TOKEN_ENV]: token,
        [REVIEW_V3_BRIDGE_RUN_DIR_ENV]: runDir,
      };
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy();
      await closeServer(server).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    },
  };
}

export interface ExternalBridgeSocketClient {
  readonly invoke: (request: ExternalBridgeRequest, options?: { readonly signal?: AbortSignal }) => Promise<ExternalBridgeResponse>;
}

export function createExternalBridgeSocketClient(options: {
  readonly socketPath: string;
  readonly token: string;
  readonly timeoutMs?: number;
}): ExternalBridgeSocketClient {
  if (!path.isAbsolute(options.socketPath)) throw new Error("bridge socket path must be absolute");
  if (options.token.length < 32) throw new Error("bridge token is invalid");
  const timeoutMs = options.timeoutMs ?? 30_000;
  return {
    invoke(request, invokeOptions = {}) {
      return new Promise<ExternalBridgeResponse>((resolve, reject) => {
        const id = randomUUID();
        const socket = createConnection(options.socketPath);
        socket.setEncoding("utf8");
        let buffered = "";
        let settled = false;
        const finish = (error?: Error, response?: ExternalBridgeResponse): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          invokeOptions.signal?.removeEventListener("abort", onAbort);
          socket.destroy();
          if (error !== undefined) reject(error);
          else resolve(response!);
        };
        const onAbort = (): void => finish(new Error("review V3 bridge request aborted"));
        const timer = setTimeout(() => finish(new Error("review V3 bridge request timed out")), timeoutMs);
        socket.on("connect", () => {
          socket.write(`${JSON.stringify({ v: 1, id, token: options.token, request })}\n`);
        });
        socket.on("data", (chunk: string) => {
          buffered += chunk;
          const newline = buffered.indexOf("\n");
          if (newline < 0) return;
          let wire: unknown;
          try {
            wire = JSON.parse(buffered.slice(0, newline));
          } catch {
            finish(new Error("review V3 bridge returned invalid JSON"));
            return;
          }
          if (!isRecord(wire) || wire.v !== 1 || wire.id !== id || !isRecord(wire.response)) {
            finish(new Error("review V3 bridge returned an invalid response"));
            return;
          }
          finish(undefined, wire.response as unknown as ExternalBridgeResponse);
        });
        socket.on("error", (error) => finish(error));
        invokeOptions.signal?.addEventListener("abort", onAbort, { once: true });
        if (invokeOptions.signal?.aborted) onAbort();
      });
    },
  };
}

export function createExternalBridgeClientFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): { readonly client: ExternalBridgeSocketClient; readonly runDir: string } {
  const socketPath = env[REVIEW_V3_BRIDGE_SOCKET_ENV];
  const token = env[REVIEW_V3_BRIDGE_TOKEN_ENV];
  const runDir = env[REVIEW_V3_BRIDGE_RUN_DIR_ENV];
  if (socketPath === undefined || token === undefined || runDir === undefined) {
    throw new Error("review V3 bridge environment is incomplete");
  }
  return { client: createExternalBridgeSocketClient({ socketPath, token }), runDir };
}

/** Structural ReviewV3CliController wrapper used by an external Keryx child. */
export function createExternalBridgeCliController(client: ExternalBridgeSocketClient) {
  const unwrap = async (request: ExternalBridgeRequest): Promise<unknown> => {
    const response = await client.invoke(request);
    if (response.ok) return response.value;
    const error = new Error(response.message);
    Object.assign(error, { code: response.code });
    throw error;
  };
  return {
    capabilities: async () => ({ bridge: true, operations: ["spawn", "status", "wait", "result", "cancel"] }),
    status: (dispatchId?: string) => {
      if (dispatchId === undefined) throw new Error("bridge status requires a dispatch id");
      return unwrap({ operation: "status", dispatchId });
    },
    spawn: (input: ReviewV3SpawnInput, parentDispatchId?: string) => {
      if (parentDispatchId !== undefined) throw new Error("bridge parent is bound by its scoped token");
      return unwrap({ operation: "spawn", input });
    },
    wait: (dispatchId: string) => unwrap({ operation: "wait", dispatchId }),
    cancel: (dispatchId: string | undefined, reason: string) => {
      if (dispatchId === undefined) throw new Error("bridge cancel requires a dispatch id");
      return unwrap({ operation: "cancel", dispatchId, reason });
    },
    result: (dispatchId: string) => unwrap({ operation: "result", dispatchId }),
  };
}
