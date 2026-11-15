import { expect, test } from "@playwright/test";

export const authFile = "e2e/.auth/user.json";

test("operator can sign in", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill(process.env.E2E_USER ?? "operator@example.com");
  await page.getByLabel("Password").fill(process.env.E2E_PASSWORD ?? "");
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page).toHaveURL(/\/customers$/);
  await page.context().storageState({ path: authFile });
});

test("a wrong password stays on the sign-in page", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("operator@example.com");
  await page.getByLabel("Password").fill("not-the-password");
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page.getByRole("alert")).toContainText("Invalid credentials");
  await expect(page).toHaveURL(/\/login$/);
});
