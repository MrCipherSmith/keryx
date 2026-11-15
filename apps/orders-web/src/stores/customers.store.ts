import { createContext, useContext } from "react";
import {
  action,
  computed,
  makeObservable,
  observable,
  reaction,
  runInAction,
  type IReactionDisposer,
} from "mobx";
import type { CustomerDto, CustomersApi } from "../api/customers.api";

export class CustomersStore {
  @observable.ref items: CustomerDto[] = [];
  @observable loading = false;
  @observable error: string | null = null;
  @observable query = "";
  @observable minOrders = 0;

  private disposed = false;
  private disposers: IReactionDisposer[] = [];

  constructor(private readonly api: CustomersApi) {
    makeObservable(this);
  }

  /** Customers at or above the minimum order count, most orders first. */
  @computed get visibleItems(): CustomerDto[] {
    return this.items
      .filter((customer) => customer.ordersCount >= this.minOrders)
      .sort((a, b) => b.ordersCount - a.ordersCount || a.name.localeCompare(b.name));
  }

  @computed get isEmpty(): boolean {
    return !this.loading && this.visibleItems.length === 0;
  }

  @computed get totalOrders(): number {
    return this.items.reduce((sum, customer) => sum + customer.ordersCount, 0);
  }

  onMount(): void {
    this.disposed = false;
    this.disposers.push(
      reaction(
        () => this.query,
        () => void this.loadCustomers(),
        { delay: 300 },
      ),
    );
    void this.loadCustomers();
  }

  onUnmount(): void {
    this.dispose();
  }

  dispose(): void {
    this.disposed = true;
    this.disposers.forEach((dispose) => dispose());
    this.disposers = [];
  }

  @action.bound
  setQuery(query: string): void {
    this.query = query;
  }

  @action.bound
  setMinOrders(value: number): void {
    this.minOrders = Math.max(0, Math.floor(value));
  }

  @action.bound
  refresh(): Promise<void> {
    return this.loadCustomers();
  }

  private loadCustomers = async (): Promise<void> => {
    runInAction(() => {
      this.loading = true;
      this.error = null;
    });
    try {
      const items = await this.api.listCustomers(this.query);
      runInAction(() => {
        if (this.disposed) return;
        this.items = items;
      });
    } catch (err: unknown) {
      runInAction(() => {
        if (this.disposed) return;
        this.error = err instanceof Error ? err.message : "Failed to load customers";
      });
    } finally {
      runInAction(() => {
        if (this.disposed) return;
        this.loading = false;
      });
    }
  };
}

export const CustomersStoreContext = createContext<CustomersStore | null>(null);

export function useCustomersStore(): CustomersStore {
  const store = useContext(CustomersStoreContext);
  if (!store) {
    throw new Error("useCustomersStore must be used inside CustomersStoreContext.Provider");
  }
  return store;
}
