import { canonicalDigest } from "../../remote-control/protocol";

/** Additional models are named only in the local owner policy. The wire sees opaque IDs. */
export function encodeLocalModelCandidate(provider: string, model: string): string | undefined {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/.test(model)) return;
  return "model:" + canonicalDigest(provider).slice(0, 24) + ":" + Buffer.from(model).toString("base64url");
}

export function decodeLocalModelCandidate(provider: string, id: string): string | undefined {
  const match = /^model:[a-f0-9]{24}:([A-Za-z0-9_-]{1,160})$/.exec(id);
  if (!match) return;
  const model = Buffer.from(match[1]!, "base64url").toString("utf8");
  return encodeLocalModelCandidate(provider, model) === id ? model : undefined;
}
