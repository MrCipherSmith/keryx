import { Alert, Card, Skeleton, Typography } from "antd";
import type { OrderDto } from "src/api/orders.api";
import { formatDate, toMoney } from "../lib/format";
import { StatusTag } from "./StatusTag";

export interface IOrderCardProps {
  order: OrderDto;
  loading?: boolean;
  error?: string;
  onSelect?: (id: string) => void;
}

export function OrderCard({ order, loading, error, onSelect }: IOrderCardProps) {
  if (loading) {
    return (
      <Card>
        <Skeleton active />
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <Alert type="error" message={error} />
      </Card>
    );
  }

  return (
    <Card
      hoverable={onSelect !== undefined}
      title={`Order ${order.number}`}
      extra={<StatusTag status={order.status} />}
      onClick={() => onSelect?.(order.id)}
    >
      <Typography.Text strong>{order.customer!.name}</Typography.Text>
      <div>{toMoney(order.totalCents)}</div>
      <Typography.Text type="secondary">{formatDate(order.createdAt)}</Typography.Text>
    </Card>
  );
}
