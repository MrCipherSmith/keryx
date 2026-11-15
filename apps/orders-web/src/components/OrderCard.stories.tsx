import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "@storybook/test";
import type { OrderDto } from "../api/orders.api";
import { OrderCard } from "./OrderCard";

const ORDER: OrderDto = {
  id: "o-1001",
  number: "A-1001",
  status: "paid",
  totalCents: 12990,
  createdAt: "2026-10-12T09:30:00Z",
  customer: { id: "c-1", name: "Alina Petrova" },
};

const meta: Meta<typeof OrderCard> = {
  title: "Components/OrderCard",
  component: OrderCard,
  args: { order: ORDER },
};

export default meta;
type Story = StoryObj<typeof OrderCard>;

export const Default: Story = {
  args: { onSelect: fn() },
};

export const Cancelled: Story = {
  args: { order: { ...ORDER, status: "cancelled" } },
};

export const Selectable: Story = {
  args: {
    onSelect: (id) => console.log("selected order", id),
  },
};
