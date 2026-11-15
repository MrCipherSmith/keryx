import type { Meta, StoryObj } from "@storybook/react";
import type { OrderStatus } from "../api/orders.api";
import { StatusTag } from "./StatusTag";

const meta: Meta<typeof StatusTag> = {
  title: "Components/StatusTag",
  component: StatusTag,
};

export default meta;
type Story = StoryObj<typeof StatusTag>;

const ALL_STATUSES: OrderStatus[] = ["new", "paid", "shipped", "delivered", "cancelled"];

export const Default: Story = {
  args: { status: "paid" },
};

export const AllStatuses: Story = {
  render: () => (
    <div style={{ display: "flex", gap: 8 }}>
      {ALL_STATUSES.map((status) => (
        <StatusTag key={status} status={status} />
      ))}
    </div>
  ),
};

export const LongLabel: Story = {
  args: {
    status: "shipped",
    label: "Shipped to a pickup point, awaiting collection by the recipient",
  },
};
