import { expect, test } from "@playwright/test";
import type { CustomerDto } from "../src/api/customers.api";

const customers: CustomerDto[] = [
  { id: "c1", name: "Ada", email: "ada@example.com", ordersCount: 4 },
  { id: "c2", name: "Grace", email: "grace@example.com", ordersCount: 9 },
  { id: "c3", name: "Linus", email: "linus@example.com", ordersCount: 1 },
];

test.beforeEach(async ({ page }) => {
  await page.route("**/api/customers**", (route) => {
    const query = new URL(route.request().url()).searchParams.get("query") ?? "";
    const rows = customers.filter((customer) => customer.name.toLowerCase().includes(query.toLowerCase()));
    return route.fulfill({ json: rows });
  });
  await page.goto("/customers");
});

test("search narrows the list to the matching customers", async ({ page }) => {
  await page.getByRole("textbox", { name: "Search customers" }).fill("grace");

  await expect(page.getByRole("row", { name: /Grace/ })).toBeVisible();
  await expect(page.getByRole("row", { name: /Ada/ })).toHaveCount(0);
});

test("the footer adds up the orders of the listed customers", async ({ page }) => {
  await expect(page.getByText("14 orders in total")).toBeVisible();

  await page.getByRole("textbox", { name: "Search customers" }).fill("ada");

  await expect(page.getByText("4 orders in total")).toBeVisible();
});

test("a failing API shows the error instead of a table of stale rows", async ({ page }) => {
  await page.route("**/api/customers**", (route) => route.fulfill({ status: 500, json: { message: "down" } }));

  await page.reload();

  await expect(page.getByRole("alert")).toContainText("500");
  await expect(page.getByRole("row", { name: /Grace/ })).toHaveCount(0);
});
