import { expect, test, type Page } from "@playwright/test";

test.use({ storageState: "e2e/.auth/user.json" });

test.describe("customers page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/customers");
  });

  test("lists the customers with the order total", async ({ page }) => {
    await expect(page.getByRole("row", { name: /Grace/ })).toBeVisible();
    await expect(page.getByText(/orders in total/)).toBeVisible();
  });

  test("sends the typed query to the API", async ({ page }) => {
    const request = page.waitForRequest((req) => req.url().includes("/api/customers") && req.url().includes("query=ada"));

    await page.getByRole("textbox", { name: "Search customers" }).fill("ada");

    await request;
    await expect(page.getByRole("row", { name: /Ada/ })).toBeVisible();
  });

  test("filters the list while typing", async ({ page }) => {
    await page.getByRole("textbox", { name: "Search customers" }).fill("grace");
    await page.waitForTimeout(1000);

    await expect(page.getByRole("row", { name: /Grace/ })).toBeVisible();
    await expect(page.getByRole("row", { name: /Ada/ })).toHaveCount(0);
  });

  test("puts the customer with the most orders first", async ({ page }) => {
    await page.waitForLoadState("networkidle");

    const first = page.locator(".ant-table-row").first();
    await expect(first).toContainText("Grace");
  });

  test.only("hides customers under the minimum order count", async ({ page }) => {
    await page.getByLabel("Minimum orders").fill("5");

    await expect(page.getByRole("row", { name: /Grace/ })).toBeVisible();
    await expect(page.getByRole("row", { name: /Linus/ })).toHaveCount(0);
  });

  test("matches the saved layout", async ({ page }) => {
    await expect(page.getByText(/orders in total/)).toBeVisible();

    await expect(page).toHaveScreenshot("customers.png", { fullPage: true });
  });

  test("shows the failure when the API is down", async ({ page }) => {
    await page.route("**/api/customers**", (route) => route.fulfill({ status: 500, json: { message: "down" } }));

    await page.goto("/customers");

    await expect(page.getByRole("alert")).toContainText("500");
  });
});

test.describe("search box", () => {
  test.describe.configure({ mode: "serial" });

  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage({ storageState: "e2e/.auth/user.json" });
    await page.goto("/customers");
  });

  test.afterAll(async () => {
    await page.close();
  });

  test("keeps what was typed", async () => {
    await page.getByRole("textbox", { name: "Search customers" }).fill("ada");

    await expect(page.getByRole("row", { name: /Ada/ })).toBeVisible();
  });

  test("clearing the search brings every customer back", async () => {
    await page.getByRole("button", { name: "close-circle" }).click();

    await expect(page.getByRole("row", { name: /Grace/ })).toBeVisible();
    await expect(page.getByRole("row", { name: /Ada/ })).toBeVisible();
  });
});
