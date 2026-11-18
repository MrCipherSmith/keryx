// Session trust grants for MCP tools over ACP (D-13).
//
// The shell keeps `trustedMcpTools` per shell session: an operator's "trust this
// tool for the session" answer, bound to the tool's definition fingerprint. An
// ACP session gets the same map. One difference: a grant for a tool of a
// FIRST-PARTY server (one the client runs as part of itself and marked
// `_meta.keryx.firstParty`, the desktop app's side panel) covers every tool of
// that server, so trust mode asks once for the panel, not once per tool. Each
// covered tool is still bound to its own fingerprint, so a changed definition
// asks again.

import { catalogFingerprintResolver } from "../mcp-servers/approval-render";
import { firstPartyServerOf } from "./session-mcp";

export interface GrantCatalog {
  readonly entries: readonly { fqn: string; description?: string | undefined; inputSchema?: Record<string, unknown> | undefined }[];
}

export class SessionMcpGrants extends Map<string, string> {
  constructor(
    private readonly firstParty: () => ReadonlyMap<string, ReadonlySet<string>> | undefined,
    private readonly catalog: () => GrantCatalog,
  ) {
    super();
  }

  override set(fqn: string, fingerprint: string): this {
    super.set(fqn, fingerprint);
    // `Map`'s constructor may call `set` before the fields exist.
    if (this.firstParty === undefined) return this;
    const server = firstPartyServerOf(this.firstParty(), fqn);
    if (server === undefined) return this;
    const catalog = this.catalog();
    const resolve = catalogFingerprintResolver(catalog);
    for (const entry of catalog.entries) {
      if (entry.fqn === fqn || !entry.fqn.startsWith(`${server}__`) || super.has(entry.fqn)) continue;
      const fp = resolve(entry.fqn);
      if (fp !== undefined) super.set(entry.fqn, fp);
    }
    return this;
  }
}
