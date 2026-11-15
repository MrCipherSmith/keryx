import { action, makeObservable, observable } from "mobx";
import type { OrderStatus } from "../api/orders.api";

export interface OrdersFilterValue {
  status: OrderStatus | undefined;
  query: string;
}

export interface OrdersFilterCallbacks {
  onStatusChange: () => void;
  onQueryChange: (query: string) => void;
}

export class OrdersFilterStore {
  @observable status: OrderStatus | undefined = undefined;
  @observable query = "";

  constructor(private readonly callbacks: OrdersFilterCallbacks) {
    makeObservable(this);
  }

  @action.bound
  setStatus(status: OrderStatus | undefined): void {
    if (status && status !== this.status) {
      this.status = status;
      this.callbacks.onStatusChange();
    }
  }

  @action.bound
  setQuery(query: string): void {
    if (query === this.query) return;
    this.query = query;
    this.callbacks.onQueryChange(query);
  }

  // Called by the orders store when a URL preset is applied. It does not fire
  // the callbacks: the caller reloads once after the whole preset is in place.
  @action.bound
  applyPreset(value: OrdersFilterValue): void {
    this.status = value.status;
    this.query = value.query;
  }
}
