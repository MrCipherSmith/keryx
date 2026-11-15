import { useEffect } from "react";
import { observer } from "mobx-react-lite";
import { observe } from "mobx";
import { Space, Statistic } from "antd";
import type { OrdersStore } from "../../stores/orders.store";

export interface OrdersSummaryProps {
  store: OrdersStore;
}

export const OrdersSummary = observer(function OrdersSummary({ store }: OrdersSummaryProps) {
  useEffect(() => {
    const ids = store.selectedIds;
    return observe(ids, () => {
      document.title = ids.length > 0 ? `Orders (${ids.length} selected)` : "Orders";
    });
  }, [store]);

  return (
    <Space size="large">
      <Statistic title="Orders" value={store.total} />
      <Statistic title="Selected" value={store.selectedCount} />
      <Statistic title="Page total" value={store.getTotalCents() / 100} precision={2} />
    </Space>
  );
});
