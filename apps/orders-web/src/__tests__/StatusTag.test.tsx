import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { OrderStatus } from "../api/orders.api";
import { StatusTag } from "../components/StatusTag";

const statuses: OrderStatus[] = ["new", "paid", "shipped", "delivered", "cancelled"];

describe("StatusTag", () => {
  it.each(statuses)("renders the %s status", (status) => {
    const { container } = render(<StatusTag status={status} />);

    expect(container).toBeDefined();
  });

  it("shows the status text when there is no label", () => {
    render(<StatusTag status="paid" />);

    expect(screen.getByText("paid")).toBeInTheDocument();
  });

  it("prefers the label over the raw status", () => {
    render(<StatusTag status="paid" label="Paid in full" />);

    expect(screen.getByText("Paid in full")).toBeInTheDocument();
    expect(screen.queryByText("paid")).not.toBeInTheDocument();
  });
});
