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

function tag(strings: TemplateStringsArray, ...values: unknown[]): string {
  return strings.reduce((acc, s, i) => acc + String(values[i - 1] ?? "") + s);
}

const fakeOtui = {
  TextRenderable: FakeText,
  t: tag,
  bold: (x: unknown) => x,
  dim: (x: unknown) => x,
};

interface FakeSidebar {
  children: FakeText[];
  add(child: unknown): void;
}

function makeSidebar(): FakeSidebar {
  const children: FakeText[] = [];
  return {
    children,
    add(child) {
      children.push(child as FakeText);
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
  expect(sidebar.children.some((c) => c.id === "sb-balance-k")).toBe(true);
  const value = sidebar.children.find((c) => c.id === "sb-balance-v");
  expect(value).toBeDefined();
  // Let the injected fetch resolve.
  await new Promise((resolve) => setTimeout(resolve, 10));
  const balance = handle.current();
  expect(balance?.total).toBe(9.99);
});

test("mountBalancePanel shows — for providers without a balance endpoint", async () => {
  const sidebar = makeSidebar();
  const handle = mountBalancePanel(sidebar, fakeOtui, {}, {
    provider: "zai",
    fetch: balanceFetch(),
    env: { ZAI_API_KEY: "sk-test" },
  }) as BalancePanelHandle;
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(handle.current()).toBeUndefined();
  const value = sidebar.children.find((c) => c.id === "sb-balance-v");
  expect(value?.content).toContain("—");
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
  const handle = mountBalancePanel(sidebar, fakeOtui, {}, {
    provider: "deepseek",
    fetch: fetchFn,
    env: { DEEPSEEK_API_KEY: "sk-test" },
  }) as BalancePanelHandle;
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(calls).toBe(1);
  const value = sidebar.children.find((c) => c.id === "sb-balance-v");
  value?.onMouseDown?.();
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(calls).toBe(2);
});
