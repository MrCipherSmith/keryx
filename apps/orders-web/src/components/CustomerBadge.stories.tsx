import type { Meta, StoryObj } from "@storybook/react";
import { CustomerBadge } from "./CustomerBadge";

const meta: Meta<typeof CustomerBadge> = {
  title: "Components/CustomerBadge",
  component: CustomerBadge,
};

export default meta;
type Story = StoryObj<typeof CustomerBadge>;

export const Default: Story = {
  args: { customer: { id: "c-1", name: "Alina Petrova" } },
};

export const Guest: Story = {
  args: { customer: undefined },
};
