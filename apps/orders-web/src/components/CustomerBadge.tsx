import { Avatar, Space, Typography } from "antd";
import type { OrderDto } from "../api/orders.api";

export interface CustomerBadgeProps {
  customer: OrderDto["customer"];
}

export function CustomerBadge({ customer }: CustomerBadgeProps) {
  if (!customer) {
    return <Typography.Text type="secondary">Guest</Typography.Text>;
  }

  return (
    <Space>
      <Avatar size="small">{customer.name.charAt(0).toUpperCase()}</Avatar>
      <Typography.Text>{customer.name}</Typography.Text>
    </Space>
  );
}
