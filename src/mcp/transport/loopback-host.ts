import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { isLoopbackAddress } from "../../lib/serve-config";

type HostLookup = (host: string) => Promise<Array<{ address: string; family: number }>>;

export class McpHttpConfigError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "McpHttpConfigError";
  }
}

function canonicalAddress(address: string): string | null {
  if (address.includes("%")) return null;
  const family = isIP(address);
  if (family === 4) return address;
  if (family === 6) return new URL(`http://[${address}]/`).hostname.slice(1, -1);
  return null;
}

/** Resolve once and bind the returned numeric address, never the original name. */
export async function resolveMcpLoopbackHost(
  host: string,
  resolve: HostLookup = (name) => lookup(name, { all: true, verbatim: true }),
): Promise<string> {
  if (!host || host !== host.trim() || host.length > 253) {
    throw new McpHttpConfigError("MCP_HTTP_INVALID_HOST", "MCP HTTP requires an explicit loopback host.");
  }
  const literal = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const address = canonicalAddress(literal);
  if (address !== null) {
    if (!isLoopbackAddress(address)) {
      throw new McpHttpConfigError("MCP_HTTP_LOOPBACK_REQUIRED", "MCP HTTP only accepts loopback addresses.");
    }
    return address;
  }
  if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9.])?$/.test(host)) {
    throw new McpHttpConfigError("MCP_HTTP_INVALID_HOST", "MCP HTTP requires a valid loopback host.");
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let answers: Awaited<ReturnType<HostLookup>>;
  try {
    answers = await Promise.race([
      resolve(host),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("lookup timed out")), 3000);
      }),
    ]);
  } catch {
    throw new McpHttpConfigError("MCP_HTTP_RESOLUTION_FAILED", "MCP HTTP could not verify the loopback hostname.");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }

  const addresses = new Set<string>();
  for (const answer of answers) {
    const resolved = canonicalAddress(answer.address);
    if (resolved === null || isIP(answer.address) !== answer.family || !isLoopbackAddress(resolved)) {
      throw new McpHttpConfigError("MCP_HTTP_LOOPBACK_REQUIRED", "MCP HTTP hostname must resolve only to loopback.");
    }
    addresses.add(resolved);
  }
  if (addresses.size !== 1) {
    throw new McpHttpConfigError("MCP_HTTP_AMBIGUOUS_HOST", "MCP HTTP requires one unambiguous loopback address.");
  }
  return addresses.values().next().value!;
}
