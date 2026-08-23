// Sidebar balance panel (flow 174 follow-up): shows the ACTIVE provider's
// balance under the Model row, fetched live on mount and on click.
//
// Only providers with a real balance endpoint (DeepSeek /user/balance,
// OpenRouter /api/v1/credits) show a number; the rest render "—". The fetch
// is fail-closed and never throws — a slow or down balance API must not hang
// the shell or spam the transcript. Clicking the value re-fetches.
import { balanceCapableProvider, fetchProviderBalance, providerApiKey, providerBaseUrlEnvKey, resolveProviderBaseUrl, type ProviderBalance } from "../commands/providers";
import { envWithSavedApiKeys } from "../lib/shell-config";

type OpenTui = typeof import("@opentui/core");
type Renderer = Awaited<ReturnType<OpenTui["createCliRenderer"]>>;
type Text = InstanceType<OpenTui["TextRenderable"]>;

/** Format a balance for the sidebar (e.g. "$6.19" / "€12.00"). */
export function formatBalance(balance: ProviderBalance | undefined): string {
  if (balance === undefined) {
    return "—";
  }
  const amount = balance.remaining ?? balance.total;
  const symbol =
    balance.currency === "USD"
      ? "$"
      : balance.currency === "EUR"
        ? "€"
        : balance.currency === "GBP"
          ? "£"
          : `${balance.currency} `;
  return `${symbol}${amount.toFixed(2)}`;
}

export interface BalancePanelOptions {
  /** Provider id of the ACTIVE model selection (e.g. "deepseek"). */
  provider: string;
  /** Timeout for the fetch, ms. Default 8000. */
  timeoutMs?: number;
  /** Injectable fetch (tests). Default globalThis.fetch. */
  fetch?: typeof fetch;
  /** Env override (tests). Default merged shell auth keys. */
  env?: Record<string, string | undefined>;
}

export interface BalancePanelHandle {
  /** Re-fetch the active provider's balance and repaint. */
  refresh(): Promise<void>;
  /** The last successfully fetched balance (undefined before/if none). */
  current(): ProviderBalance | undefined;
}

/**
 * Mount the Balance row into `sidebarTop` and start the initial fetch.
 * Returns a handle for re-fetching / reading the value. When the provider has
 * no balance endpoint the row still mounts, showing "—".
 */
export function mountBalancePanel(
  sidebarTop: { add(child: unknown): void },
  otui: unknown,
  renderer: unknown,
  options: BalancePanelOptions,
): BalancePanelHandle {
  const core = otui as OpenTui;
  const r = renderer as Renderer;
  const env = envWithSavedApiKeys(options.env ?? process.env);
  let current: ProviderBalance | undefined;
  let textNode: Text | undefined;

  const label = new core.TextRenderable(r, {
    id: "sb-balance-k",
    content: core.t`${core.dim("Balance")}`,
    marginTop: 1,
  });
  sidebarTop.add(label);
  const value = new core.TextRenderable(r, {
    id: "sb-balance-v",
    content: core.t`${core.dim("…")}`,
    onMouseDown: () => {
      void refresh();
    },
  });
  textNode = value;
  sidebarTop.add(value);

  const paint = (balance: ProviderBalance | undefined): void => {
    current = balance;
    if (textNode !== undefined) {
      textNode.content = core.t`${core.dim(formatBalance(balance))}`;
    }
  };

  const refresh = async (): Promise<void> => {
    const provider = balanceCapableProvider(options.provider);
    if (provider === undefined) {
      paint(undefined);
      return;
    }
    const apiKey = providerApiKey(provider, env);
    if (apiKey === undefined) {
      paint(undefined);
      return;
    }
    // Honour KERYX_<NAME>_BASE_URL overrides the same way /models does.
    const base = resolveProviderBaseUrl(provider, env);
    const withBase = { ...provider, baseUrl: base };
    const balance = await fetchProviderBalance(
      options.fetch ?? globalThis.fetch,
      withBase,
      apiKey,
      { ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}) },
    );
    paint(balance);
  };

  void refresh();
  return { refresh, current: () => current };
}
