import { useEffect, useState } from "react";
import { observer } from "mobx-react-lite";
import { Alert, Descriptions, Skeleton, Tag } from "antd";
import { getOrder, type OrderDto } from "../../api/orders.api";
import { StatusTag } from "../../components/StatusTag";
import type { OrdersStore } from "../../stores/orders.store";

export interface OrderDrawerProps {
  orderId: string;
  store: OrdersStore;
}

export const OrderDrawer = observer(function OrderDrawer({ orderId, store }: OrderDrawerProps) {
  const [order, setOrder] = useState<OrderDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setOrder(null);
    setError(null);
    getOrder(orderId)
      .then((dto) => {
        if (!cancelled) setOrder(dto);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load order");
      });
    return () => {
      cancelled = true;
    };
  }, [orderId]);

  if (error) return <Alert type="error" message={error} />;
  if (!order) return <Skeleton active />;

  return (
    <Descriptions column={1} title={`Order ${order.number}`}>
      <Descriptions.Item label="Status">
        <StatusTag status={order.status} />
      </Descriptions.Item>
      <Descriptions.Item label="Customer">{order.customer?.name ?? "Guest"}</Descriptions.Item>
      <Descriptions.Item label="Total">{(order.totalCents / 100).toFixed(2)}</Descriptions.Item>
      <Descriptions.Item label="Bulk selection">
        {store.selectedIds.includes(order.id) ? <Tag color="blue">Selected</Tag> : "Not selected"}
      </Descriptions.Item>
    </Descriptions>
  );
});
