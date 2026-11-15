import type { Meta, StoryObj } from "@storybook/react";
import { Testimonial } from "./Testimonial";

const meta: Meta<typeof Testimonial> = {
  title: "Launch/Testimonial (sample data)",
  component: Testimonial,
};

export default meta;
type Story = StoryObj<typeof Testimonial>;

// Sample data: placeholder names for Storybook only, never rendered on the page.
export const Default: Story = {
  args: {
    quote: "Sample data: the quote text wraps to a few lines in the card.",
    author: "Jane Doe, Acme (sample data)",
  },
};
