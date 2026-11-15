import { describe, expect, it, vi, type Mock } from "vitest";
import type { CustomerDto, CustomersApi } from "../api/customers.api";
import { CustomersStore } from "./customers.store";

const ada: CustomerDto = { id: "c1", name: "Ada", email: "ada@example.com", ordersCount: 4 };
const grace: CustomerDto = { id: "c2", name: "Grace", email: "grace@example.com", ordersCount: 9 };
const linus: CustomerDto = { id: "c3", name: "Linus", email: "linus@example.com", ordersCount: 1 };
const barbara = { id: "c4", name: "Barbara", email: "barbara@example.com", ordersCount: null } as unknown as CustomerDto;

type FakeApi = CustomersApi & { listCustomers: Mock<CustomersApi["listCustomers"]> };

function makeApi(rows: CustomerDto[] = [ada, grace, linus]): FakeApi {
  return { listCustomers: vi.fn(async () => rows) };
}

describe("visibleItems", () => {
  const store = new CustomersStore(makeApi());

  it("sorts by order count, most orders first", async () => {
    await store.refresh();

    expect(store.visibleItems.map((customer) => customer.name)).toEqual(["Grace", "Ada", "Linus"]);
  });

  it("hides customers under the minimum", () => {
    store.setMinOrders(2);

    expect(store.visibleItems.map((customer) => customer.name)).toEqual(["Grace", "Ada"]);
  });

  it("reports empty when nobody passes the minimum", () => {
    store.setMinOrders(50);

    expect(store.isEmpty).toBe(true);
  });
});

describe("totalOrders", () => {
  it("adds up the order counts", async () => {
    const store = new CustomersStore(makeApi());
    await store.refresh();

    expect(store.totalOrders).toBe(14);
  });

  it("counts a customer without orders as zero", async () => {
    const store = new CustomersStore(makeApi([ada, barbara]));
    await store.refresh();

    expect(store.totalOrders).toBe(4);
  });
});

describe("loading", () => {
  it("turns the spinner off and fills the list after a load", async () => {
    const store = new CustomersStore(makeApi());

    const pending = store.refresh();
    expect(store.loading).toBe(true);
    await pending;

    expect(store.loading).toBe(false);
    expect(store.items).toHaveLength(3);
  });

  it("keeps the message of a failed load", async () => {
    const api = makeApi();
    api.listCustomers.mockRejectedValue(new Error("boom"));
    const store = new CustomersStore(api);

    await store.refresh();

    expect(api.listCustomers).toHaveBeenCalled();
  });
});

describe("search", () => {
  it("reloads with the query once typing pauses", async () => {
    const api = makeApi();
    const store = new CustomersStore(api);
    store.onMount();

    store.setQuery("gra");
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(api.listCustomers).toHaveBeenLastCalledWith("gra");
    store.dispose();
  });

  it("sends one request for a burst of keystrokes", async () => {
    vi.useFakeTimers();
    const api = makeApi();
    const store = new CustomersStore(api);
    store.onMount();

    store.setQuery("g");
    store.setQuery("gr");
    store.setQuery("gra");
    await vi.advanceTimersByTimeAsync(300);

    expect(api.listCustomers).toHaveBeenCalledTimes(2);
    expect(api.listCustomers).toHaveBeenLastCalledWith("gra");
    store.dispose();
  });

  it("stops reloading after unmount", async () => {
    vi.useFakeTimers();
    const api = makeApi();
    const store = new CustomersStore(api);
    store.onMount();
    store.onUnmount();

    store.setQuery("late");
    await vi.advanceTimersByTimeAsync(1000);

    expect(api.listCustomers).toHaveBeenCalledTimes(1);
  });
});
