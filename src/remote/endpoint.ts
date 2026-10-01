// Where a running serve listens, for the shells that want to reach it (flow 376, block 2).
//
// `keryx serve` writes `<user-global dir>/remote/endpoint.json` once its listener
// and hub are up and removes it on a clean stop. A shell reads it on EVERY
// connection attempt, so a serve that restarted on another port is followed.
// Kept apart from `service.ts` so the shell-side client does not pull the hub
// and the Telegram client into its own import graph.

import path from "node:path";
import { readConfigFile } from "../lib/config-dir";
import { remoteDirPath } from "./paths";

export const ENDPOINT_FILE = "endpoint.json";

export function endpointPath(dir?: string): string {
  return path.join(remoteDirPath(dir), ENDPOINT_FILE);
}

export interface RemoteEndpoint {
  address: string;
  port: number;
  pid: number;
}

/** Shell side: where is serve? */
export function readEndpoint(dir?: string): { ok: true; value: RemoteEndpoint } | { ok: false; reason: string } {
  const file = endpointPath(dir);
  const read = readConfigFile(file);
  if (!read.ok) {
    return { ok: false, reason: `no running serve found (${file}: ${read.reason}); is \`keryx serve\` running with remote control configured?` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text);
  } catch {
    return { ok: false, reason: `${file} is not valid JSON` };
  }
  const candidate = parsed as Partial<RemoteEndpoint> | null;
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    typeof candidate.address !== "string" ||
    typeof candidate.port !== "number" ||
    !Number.isInteger(candidate.port) ||
    candidate.port < 1 ||
    candidate.port > 65535 ||
    typeof candidate.pid !== "number"
  ) {
    return { ok: false, reason: `${file} does not describe a serve endpoint` };
  }
  return { ok: true, value: { address: candidate.address, port: candidate.port, pid: candidate.pid } };
}
