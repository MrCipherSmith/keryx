import { isIP } from "node:net";

export type WebPolicyResult<T> = { ok: true; value: T } | { ok: false; reason: string };

export type HostLookup = (hostname: string) => Promise<readonly { address: string }[]>;

export interface PinnedPublicTarget {
  url: string;
  hostname: string;
  address: string;
}

function isPrivateIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = octets as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 2) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && octets[2] === 100) ||
    (a === 203 && b === 0 && octets[2] === 113) ||
    a >= 224
  );
}

/** True for every address which cannot be a public remote web destination. */
export function isBlockedRemoteAddress(input: string): boolean {
  const address = input.replace(/^\[|\]$/g, "").toLowerCase();
  const kind = isIP(address);
  if (kind === 4) return isPrivateIpv4(address);
  if (kind !== 6) return false;
  if (address.startsWith("::ffff:")) return isBlockedRemoteAddress(address.slice(7));
  return (
    address === "::" ||
    address === "::1" ||
    address.startsWith("fc") ||
    address.startsWith("fd") ||
    address.startsWith("ff") ||
    address.startsWith("fe8") ||
    address.startsWith("fe9") ||
    address.startsWith("fea") ||
    address.startsWith("feb")
  );
}

/** Parse the only URL shape permitted to a remote web operation. */
export function parsePublicHttpsUrl(raw: string): WebPolicyResult<URL> {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username.length > 0 || url.password.length > 0) {
      return { ok: false, reason: "url must be absolute HTTPS without credentials" };
    }
    if (isBlockedRemoteAddress(url.hostname)) {
      return { ok: false, reason: "private or loopback destination is not allowed" };
    }
    return { ok: true, value: url };
  } catch {
    return { ok: false, reason: "url must be absolute HTTPS without credentials" };
  }
}

/** Resolve every DNS answer, deny a mixed set, and choose the address to pin. */
export async function validatePublicTarget(
  url: URL,
  lookup: HostLookup,
): Promise<WebPolicyResult<PinnedPublicTarget>> {
  try {
    const answers = await lookup(url.hostname);
    if (answers.length === 0 || answers.some(({ address }) => isBlockedRemoteAddress(address))) {
      return { ok: false, reason: "destination does not resolve exclusively to public addresses" };
    }
    const address = answers[0]?.address;
    if (address === undefined) return { ok: false, reason: "destination DNS lookup failed" };
    return {
      ok: true,
      value: { url: url.toString(), hostname: url.hostname, address },
    };
  } catch {
    return { ok: false, reason: "destination DNS lookup failed" };
  }
}
