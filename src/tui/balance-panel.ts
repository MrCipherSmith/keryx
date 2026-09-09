// Sidebar balance panel (flow 174 follow-up): shows the ACTIVE provider's
// balance under the Model row, fetched live on mount, on click, and when
// the operator switches provider mid-session (`setProvider`).
//
// Only providers with a real balance endpoint (DeepSeek /user/balance,
// OpenRouter /api/v1/credits) get the row at all; for the rest the panel is
// absent rather than a permanent "—" occupying rows in a fixed-height
// column (see `mountBalancePanel`). A capable provider whose fetch fails
// still renders "—" — that is a live reading that did not arrive, not a
// provider that has no reading. The fetch
// is fail-closed and never throws — a slow or down balance API must not hang
// the shell or spam the transcript. Clicking the value re-fetches.
import { balanceCapableProvider, fetchProviderBalance, providerApiKey, resolveProviderBaseUrl, type ProviderBalance } from "../commands/providers";
import { envWithSavedApiKeys } from "../lib/shell-config";

type OpenTui = typeof import("@opentui/core");
type Renderer = Awaited<ReturnType<OpenTui["createCliRenderer"]>>;
type Box = InstanceType<OpenTui["BoxRenderable"]>;
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
  /** Point the panel at a new provider (mid-session `/model` / `/provider`). */
  setProvider(provider: string): Promise<void>;
  /** The last successfully fetched balance (undefined before/if none). */
  current(): ProviderBalance | undefined;
}

/**
 * Mount the Balance row into `sidebarTop` and start the initial fetch.
 * Returns a handle for re-fetching / retargeting / reading the value.
 *
 * The panel lives in a hug-content box so a later `setProvider` can grow or
 * shrink the row IN PLACE (under Usage) instead of appending at the bottom of
 * `sidebarTop`. A provider with NO balance endpoint leaves the box empty —
 * zero height, the same idiom as the Workspace/Subagents boxes in
 * `tui-shell.ts`. A capable provider whose fetch fails still renders "—" —
 * that is a live reading that did not arrive, not a provider that has no
 * reading.
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
  let activeProvider = options.provider;
  let current: ProviderBalance | undefined;
  let textNode: Text | undefined;
  const box = new core.BoxRenderable(r, {
    id: "sb-balance",
    flexDirection: "column",
    flexShrink: 0,
  }) as Box;
  sidebarTop.add(box);

  const clearRow = (): void => {
    for (const child of [...box.getChildren()]) {
      box.remove(child);
    }
    textNode = undefined;
  };

  const mountRow = (): void => {
    if (textNode !== undefined) {
      return;
    }
    const label = new core.TextRenderable(r, {
      id: "sb-balance-k",
      content: core.t`${core.dim("Balance")}`,
      marginTop: 1,
    });
    box.add(label);
    const value = new core.TextRenderable(r, {
      id: "sb-balance-v",
      content: core.t`${core.dim("…")}`,
      onMouseDown: () => {
        void refresh();
      },
    });
    textNode = value;
    box.add(value);
  };

  const paint = (balance: ProviderBalance | undefined): void => {
    current = balance;
    if (textNode !== undefined) {
      textNode.content = core.t`${core.dim(formatBalance(balance))}`;
    }
  };

  const refresh = async (): Promise<void> => {
    const provider = balanceCapableProvider(activeProvider);
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

  const setProvider = async (provider: string): Promise<void> => {
    activeProvider = provider;
    if (balanceCapableProvider(provider) !== undefined) {
      mountRow();
    } else {
      clearRow();
      current = undefined;
    }
    await refresh();
  };

  if (balanceCapableProvider(activeProvider) !== undefined) {
    mountRow();
  }
  void refresh();
  return { refresh, setProvider, current: () => current };
}
