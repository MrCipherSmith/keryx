import { Empty, Space, Typography } from "antd";
import type { OrderDto } from "../api/orders.api";
import { OrderCard } from "./OrderCard";

export interface OrderListProps {
  orders: OrderDto[];
  onSelect?: (id: string) => void;
}

export function OrderList({ orders, onSelect }: OrderListProps) {
  if (orders.length === 0) {
    return <Empty description="No orders match the current filter" />;
  }

  const withCustomer = orders.filter((order) => order.customer);
  // Every entry in withCustomer passed the filter above, so customer is set;
  // TypeScript does not narrow the element type through filter().
  const customerIds = new Set(withCustomer.map((order) => order.customer!.id));

  return (
    <Space direction="vertical" style={{ width: "100%" }}>
      <Typography.Text type="secondary">
        {orders.length} orders from {customerIds.size} customers
      </Typography.Text>
      {orders.map((order) => (
        <OrderCard key={order.id} order={order} onSelect={onSelect} />
      ))}
    </Space>
  );
}
