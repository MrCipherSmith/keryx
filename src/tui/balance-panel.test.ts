import { expect, test } from "bun:test";
import { formatBalance, mountBalancePanel, type BalancePanelHandle } from "./balance-panel";
import type { ProviderBalance } from "../commands/providers";

test("formatBalance renders currencies", () => {
  const usd: ProviderBalance = { currency: "USD", total: 6.19, exact: true };
  expect(formatBalance(usd)).toBe("$6.19");
  const eur: ProviderBalance = { currency: "EUR", total: 12, exact: true };
  expect(formatBalance(eur)).toBe("€12.00");
  const gbp: ProviderBalance = { currency: "GBP", total: 3.5, exact: true };
  expect(formatBalance(gbp)).toBe("£3.50");
  const jpy: ProviderBalance = { currency: "JPY", total: 1000, exact: true };
  expect(formatBalance(jpy)).toBe("JPY 1000.00");
  expect(formatBalance(undefined)).toBe("—");
  const remaining: ProviderBalance = { currency: "USD", total: 10, remaining: 7.5, exact: true };
  expect(formatBalance(remaining)).toBe("$7.50");
});

class FakeText {
  content: unknown;
  id: string | undefined;
  onMouseDown: (() => void) | undefined;
  constructor(_r: unknown, opts: Record<string, unknown>) {
    this.content = opts.content;
    this.id = typeof opts.id === "string" ? opts.id : undefined;
    const fn = opts.onMouseDown;
    this.onMouseDown = typeof fn === "function" ? (fn as () => void) : undefined;
  }
}

class FakeBox {
  children: FakeText[] = [];
  id: string | undefined;
  constructor(_r: unknown, opts: Record<string, unknown>) {
    this.id = typeof opts.id === "string" ? opts.id : undefined;
  }
  add(child: unknown): void {
    this.children.push(child as FakeText);
  }
  remove(child: unknown): void {
    const i = this.children.indexOf(child as FakeText);
    if (i >= 0) {
      this.children.splice(i, 1);
    }
  }
  getChildren(): readonly FakeText[] {
    return this.children;
  }
}

function tag(strings: TemplateStringsArray, ...values: unknown[]): string {
  return strings.reduce((acc, s, i) => acc + String(values[i - 1] ?? "") + s);
}

const fakeOtui = {
  TextRenderable: FakeText,
  BoxRenderable: FakeBox,
  t: tag,
  bold: (x: unknown) => x,
  dim: (x: unknown) => x,
};

interface FakeSidebar {
  children: FakeText[];
  add(child: unknown): void;
  remove(child: unknown): void;
}

function balanceBox(sidebar: FakeSidebar): FakeBox {
  const box = sidebar.children.find((c) => c.id === "sb-balance");
  if (!(box instanceof FakeBox)) {
    throw new Error("sb-balance box missing");
  }
  return box;
}

function makeSidebar(): FakeSidebar {
  const children: FakeText[] = [];
  return {
    children,
    add(child) {
      children.push(child as FakeText);
    },
    remove(child) {
      const i = children.indexOf(child as FakeText);
      if (i >= 0) {
        children.splice(i, 1);
      }
    },
  };
}

function balanceFetch(): typeof fetch {
  const fn = async (): Promise<Response> =>
    new Response(
      JSON.stringify({
        is_available: true,
        balance_infos: [{ currency: "USD", total_balance: "9.99", granted_balance: "0", topped_up_balance: "9.99" }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  return fn as unknown as typeof fetch;
}

test("mountBalancePanel mounts Balance row and fetches on start", async () => {
  const sidebar = makeSidebar();
  const handle = mountBalancePanel(sidebar, fakeOtui, {}, {
    provider: "deepseek",
    fetch: balanceFetch(),
    env: { DEEPSEEK_API_KEY: "sk-test" },
  }) as BalancePanelHandle;
  // Initial state before the fetch resolves: "…".
  expect(balanceBox(sidebar).children.some((c) => c.id === "sb-balance-k")).toBe(true);
  const value = balanceBox(sidebar).children.find((c) => c.id === "sb-balance-v");
  expect(value).toBeDefined();
  // Let the injected fetch resolve.
  await new Promise((resolve) => setTimeout(resolve, 10));
  const balance = handle.current();
  expect(balance?.total).toBe(9.99);
});

test("mountBalancePanel mounts NOTHING for providers without a balance endpoint", async () => {
  // The sidebar is a fixed-height column: three rows that permanently read "—"
  // are three rows taken off the panels below (Tools/Status/toast), which on an
  // 80x24 terminal simply fall off the screen. Nothing to show ⇒ zero height,
  // the same rule the Subagents/Background-Jobs boxes follow.
  const sidebar = makeSidebar();
  const handle = mountBalancePanel(sidebar, fakeOtui, {}, {
    provider: "zai",
    fetch: balanceFetch(),
    env: { ZAI_API_KEY: "sk-test" },
  }) as BalancePanelHandle;
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(handle.current()).toBeUndefined();
  expect(balanceBox(sidebar).children).toEqual([]);
  // …and the handle stays safe to call, so callers need no capability branch.
  await handle.refresh();
  expect(handle.current()).toBeUndefined();
});

test("clicking the balance value re-fetches", async () => {
  const sidebar = makeSidebar();
  let calls = 0;
  const fetchFn = ((async () => {
    calls += 1;
    return new Response(
      JSON.stringify({
        is_available: true,
        balance_infos: [{ currency: "USD", total_balance: "5.00", granted_balance: "0", topped_up_balance: "5.00" }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown) as typeof fetch;
  mountBalancePanel(sidebar, fakeOtui, {}, {
    provider: "deepseek",
    fetch: fetchFn,
    env: { DEEPSEEK_API_KEY: "sk-test" },
  }) as BalancePanelHandle;
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(calls).toBe(1);
  const value = balanceBox(sidebar).children.find((c) => c.id === "sb-balance-v");
  value?.onMouseDown?.();
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(calls).toBe(2);
});

test("setProvider re-fetches the NEW provider instead of the mount-time one", async () => {
  const sidebar = makeSidebar();
  const seen: string[] = [];
  const fetchFn = ((async (input: RequestInfo | URL) => {
    seen.push(String(input));
    const url = String(input);
    const total = url.includes("openrouter") ? "1.11" : "9.99";
    const body = url.includes("openrouter")
      ? { credits: { total: Number(total), used: 0, currency: "USD" } }
      : {
          is_available: true,
          balance_infos: [{ currency: "USD", total_balance: total, granted_balance: "0", topped_up_balance: total }],
        };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown) as typeof fetch;
  const handle = mountBalancePanel(sidebar, fakeOtui, {}, {
    provider: "deepseek",
    fetch: fetchFn,
    env: { DEEPSEEK_API_KEY: "ds-key", OPENROUTER_API_KEY: "or-key" },
  }) as BalancePanelHandle;
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(seen.some((u) => u.includes("deepseek"))).toBe(true);
  expect(handle.current()?.total).toBe(9.99);

  await handle.setProvider("openrouter");
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(seen.some((u) => u.includes("openrouter"))).toBe(true);
  expect(handle.current()?.total).toBe(1.11);
  expect(balanceBox(sidebar).children.some((c) => c.id === "sb-balance-v")).toBe(true);
});

test("setProvider unmounts the row when the new provider has no balance endpoint", async () => {
  const sidebar = makeSidebar();
  const handle = mountBalancePanel(sidebar, fakeOtui, {}, {
    provider: "deepseek",
    fetch: balanceFetch(),
    env: { DEEPSEEK_API_KEY: "ds-key" },
  }) as BalancePanelHandle;
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(balanceBox(sidebar).children.some((c) => c.id === "sb-balance-k")).toBe(true);

  await handle.setProvider("zai");
  expect(balanceBox(sidebar).children).toEqual([]);
  expect(handle.current()).toBeUndefined();
});

test("setProvider mounts the row when switching onto a capable provider", async () => {
  const sidebar = makeSidebar();
  const handle = mountBalancePanel(sidebar, fakeOtui, {}, {
    provider: "zai",
    fetch: balanceFetch(),
    env: { DEEPSEEK_API_KEY: "ds-key", ZAI_API_KEY: "zai-key" },
  }) as BalancePanelHandle;
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(balanceBox(sidebar).children).toEqual([]);

  await handle.setProvider("deepseek");
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(balanceBox(sidebar).children.some((c) => c.id === "sb-balance-k")).toBe(true);
  expect(handle.current()?.total).toBe(9.99);
});
