import { createContext, useContext } from "react";
import {
  action,
  computed,
  makeObservable,
  observable,
  reaction,
  runInAction,
  type IObservableArray,
  type IReactionDisposer,
} from "mobx";
import type { ListOrdersParams, ListOrdersResponse, OrderDto } from "../api/orders.api";
import { OrdersFilterStore, type OrdersFilterValue } from "./orders-filter.store";

export const PAGE_SIZE = 2000;

export interface OrdersApi {
  listOrders(params: ListOrdersParams): Promise<ListOrdersResponse>;
}

export class OrdersStore {
  @observable.ref items: OrderDto[] = [];
  @observable loading = false;
  @observable error: string | null = null;
  @observable page = 1;
  @observable total = 0;
  @observable selectedIds: IObservableArray<string> = observable<string>([]);

  readonly filter: OrdersFilterStore;

  private disposed = false;
  private disposers: IReactionDisposer[] = [];

  constructor(private readonly api: OrdersApi) {
    makeObservable(this);
    this.filter = new OrdersFilterStore({
      onStatusChange: this.onFilterChange,
      onQueryChange: this.onChangeQuery,
    });
    reaction(
      () => this.page,
      () => void this.loadOrders(),
    );
  }

  @computed get selectedCount(): number {
    return this.selectedIds.length;
  }

  @computed get pageCount(): number {
    return Math.max(1, Math.ceil(this.total / PAGE_SIZE));
  }

  getTotalCents(): number {
    return this.items.reduce((sum, order) => sum + order.totalCents, 0);
  }

  getById = (id: string): OrderDto | undefined => this.items.find((order) => order.id === id);

  onMount(): void {
    this.disposed = false;
    this.disposers.push(
      reaction(
        () => this.total,
        (total) => {
          if ((this.page - 1) * PAGE_SIZE >= total) this.page = 1;
        },
      ),
    );
    void this.loadOrders();
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
  setPage(page: number): void {
    this.page = page;
  }

  @action.bound
  onSelect(id: string, selected: boolean): void {
    if (selected) {
      if (!this.selectedIds.includes(id)) this.selectedIds.push(id);
    } else {
      this.selectedIds.remove(id);
    }
  }

  @action.bound
  selectAllOnPage(): void {
    this.selectedIds = observable(this.items.map((order) => order.id));
  }

  @action.bound
  clearSelection(): void {
    this.selectedIds.clear();
  }

  @action.bound
  applyUrlPreset(preset: OrdersFilterValue): void {
    this.filter.applyPreset(preset);
    this.reload();
  }

  @action.bound
  private onFilterChange(): void {
    this.reload();
  }

  onChangeQuery = (query: string): void => {
    // One character matches almost every order, not worth a 2,000-row fetch.
    if (query.length === 1) return;
    this.reload();
  };

  private reload = (): void => {
    if (this.page === 1) {
      void this.loadOrders();
    } else {
      this.setPage(1);
    }
  };

  private loadOrders = async (): Promise<void> => {
    runInAction(() => {
      this.loading = true;
      this.error = null;
    });
    try {
      const res = await this.api.listOrders({
        status: this.filter.status,
        query: this.filter.query || undefined,
        page: this.page,
        pageSize: PAGE_SIZE,
      });
      if (this.disposed) return;
      this.items = res.items;
      runInAction(() => {
        this.total = res.total;
        this.loading = false;
      });
    } catch (err: unknown) {
      runInAction(() => {
        if (this.disposed) return;
        this.error = err instanceof Error ? err.message : "Failed to load orders";
      });
    }
  };
}

export const OrdersStoreContext = createContext<OrdersStore | null>(null);

export function useOrdersStore(): OrdersStore {
  const store = useContext(OrdersStoreContext);
  if (!store) {
    throw new Error("useOrdersStore must be used inside OrdersStoreContext.Provider");
  }
  return store;
}
