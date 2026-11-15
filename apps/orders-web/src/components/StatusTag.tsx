import { Tag } from "antd";
import type { OrderStatus } from "../api/orders.api";

export interface StatusTagProps {
  status: OrderStatus;
  label?: string;
}

const COLORS: Record<OrderStatus, string> = {
  new: "blue",
  paid: "green",
  shipped: "geekblue",
  delivered: "success",
  cancelled: "default",
};

export function StatusTag({ status, label }: StatusTagProps) {
  return (
    <Tag color={COLORS[status]} style={{ maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis" }}>
      {label ?? status}
    </Tag>
  );
}
