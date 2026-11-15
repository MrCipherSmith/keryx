import { createContext, useContext } from "react";
import {
  action,
  computed,
  makeObservable,
  observable,
  runInAction,
  type IObservableArray,
} from "mobx";
import type {
  ListOrdersParams,
  ListOrdersResponse,
  OrderDto,
  OrderStatus,
} from "../api/orders.api";

export const PAGE_SIZE = 2000;

export interface OrdersApi {
  listOrders(params: ListOrdersParams): Promise<ListOrdersResponse>;
  updateStatus(id: string, status: OrderStatus): Promise<OrderDto>;
}

export class OrdersStore {
  @observable.ref items: OrderDto[] = [];
  @observable loading = false;
  @observable updating = false;
  @observable error: string | null = null;
  @observable status: OrderStatus | undefined = undefined;
  @observable.shallow selectedIds: IObservableArray<string> = observable.array<string>([]);

  private disposed = false;

  constructor(private readonly api: OrdersApi) {
    makeObservable(this);
  }

  @computed get selectedCount(): number {
    return this.selectedIds.length;
  }

  onMount(): void {
    this.disposed = false;
    void this.fetchOrders();
  }

  onUnmount(): void {
    this.dispose();
  }

  dispose(): void {
    this.disposed = true;
  }

  @action.bound
  loadOrders(): Promise<void> {
    return this.fetchOrders();
  }

  @action.bound
  setStatus(status: OrderStatus | undefined): void {
    this.status = status;
    void this.fetchOrders();
  }

  @action.bound
  toggleSelected(id: string, selected: boolean): void {
    if (selected) {
      if (!this.selectedIds.includes(id)) this.selectedIds.push(id);
    } else {
      this.selectedIds.remove(id);
    }
  }

  @action.bound
  clearSelection(): void {
    this.selectedIds.clear();
  }

  @action.bound
  markSelectedPaid(): Promise<void> {
    return this.updateSelected("paid");
  }

  private fetchOrders = async (): Promise<void> => {
    runInAction(() => {
      this.loading = true;
      this.error = null;
    });
    try {
      const res = await this.api.listOrders({ status: this.status, page: 1, pageSize: PAGE_SIZE });
      runInAction(() => {
        if (this.disposed) return;
        this.items = res.items;
      });
    } catch (err: unknown) {
      runInAction(() => {
        if (this.disposed) return;
        this.error = err instanceof Error ? err.message : "Failed to load orders";
      });
    } finally {
      runInAction(() => {
        if (this.disposed) return;
        this.loading = false;
      });
    }
  };

  private updateSelected = async (status: OrderStatus): Promise<void> => {
    const ids = [...this.selectedIds];
    runInAction(() => {
      this.updating = true;
    });
    try {
      const updated = await Promise.all(ids.map((id) => this.api.updateStatus(id, status)));
      runInAction(() => {
        if (this.disposed) return;
        const byId = new Map(updated.map((order): [string, OrderDto] => [order.id, order]));
        this.items = this.items.map((order) => byId.get(order.id) ?? order);
        this.selectedIds.clear();
      });
    } catch (err: unknown) {
      runInAction(() => {
        if (this.disposed) return;
        this.error = err instanceof Error ? err.message : "Failed to update orders";
      });
    } finally {
      runInAction(() => {
        if (this.disposed) return;
        this.updating = false;
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
