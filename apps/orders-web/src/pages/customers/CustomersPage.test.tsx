import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CustomersPage } from "./CustomersPage";

describe("CustomersPage", () => {
  it("shows the heading and the search field", () => {
    render(<CustomersPage />);

    expect(screen.getByRole("heading", { name: /customers/i })).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Search customers")).toBeInTheDocument();
  });

  it("shows the order total once the list has loaded", async () => {
    render(<CustomersPage />);

    await waitFor(() => expect(screen.getByText(/orders in total/)).toBeInTheDocument());
  });
});
