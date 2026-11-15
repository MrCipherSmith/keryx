import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "@storybook/test";
import type { OrderDto } from "../api/orders.api";
import { OrderList } from "./OrderList";

const ORDERS: OrderDto[] = [
  {
    id: "o-1001",
    number: "A-1001",
    status: "paid",
    totalCents: 12990,
    createdAt: "2026-10-12T09:30:00Z",
    customer: { id: "c-1", name: "Alina Petrova" },
  },
  {
    id: "o-1002",
    number: "A-1002",
    status: "shipped",
    totalCents: 4500,
    createdAt: "2026-10-13T14:05:00Z",
    customer: { id: "c-2", name: "Marek Novak" },
  },
  {
    id: "o-1003",
    number: "A-1003",
    status: "new",
    totalCents: 78000,
    createdAt: "2026-10-14T08:00:00Z",
    customer: { id: "c-1", name: "Alina Petrova" },
  },
];

const meta: Meta<typeof OrderList> = {
  title: "Components/OrderList",
  component: OrderList,
  args: { orders: ORDERS, onSelect: fn() },
};

export default meta;
type Story = StoryObj<typeof OrderList>;

export const Default: Story = {};

export const SingleOrder: Story = {
  args: { orders: ORDERS.slice(0, 1) },
};
