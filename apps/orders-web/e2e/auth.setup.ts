import { expect, test as setup } from "@playwright/test";
import { authFile } from "../playwright.config";

setup("sign in as an operator", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill(process.env.E2E_USER ?? "operator@example.com");
  await page.getByLabel("Password").fill(process.env.E2E_PASSWORD ?? "");
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page).toHaveURL(/\/customers$/);
  await page.context().storageState({ path: authFile });
});
