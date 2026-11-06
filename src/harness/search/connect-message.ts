/**
 * The one sentence both `/search-provider <id>` surfaces print after a
 * successful connect. Kept here, as a pure function, because it is the
 * operator's only warning that a page-capable provider took `web_fetch` over —
 * and a fact that exists only inside two command handlers is a fact no test
 * can pin.
 */
export interface ConnectOutcome {
  active: boolean;
  servesPages: boolean;
}

export function connectedMessage(providerId: string, outcome: ConnectOutcome): string {
  const scope = outcome.servesPages ? " (web_search and web_fetch)" : "";
  return outcome.active
    ? `Connected '${providerId}' and made it the active search provider${scope}. /search-connect duckduckgo switches back.`
    : `Configured and tested '${providerId}' successfully. Use /search-connect ${providerId} to make it active.`;
}
