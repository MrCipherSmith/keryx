import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://localhost:5173";

export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  // The dev API is slow on shared runners, so give each test room and try again before failing the build.
  timeout: 90_000,
  expect: { timeout: 20_000 },
  retries: 3,
  workers: process.env.CI ? 4 : undefined,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run dev",
    url: baseURL,
    reuseExistingServer: !process.env.CI,
  },
});
