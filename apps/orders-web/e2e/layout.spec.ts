import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const LOCALES = ["en", "de", "ar"] as const;

for (const locale of LOCALES) {
  test(`measure insights layout (${locale})`, async ({ page }) => {
    await page.goto(`/insights?locale=${locale}`);
    const widths: Record<string, number> = {};
    for (const name of ["score-track", "meter-track", "meter-fill", "badge-box", "orders-table"]) {
      const box = await page.locator(`[data-measure="${name}"]`).first().boundingBox();
      expect(box).not.toBeNull();
      widths[name] = Math.round((box?.width ?? 0) * 10) / 10;
    }
    const viewport = page.viewportSize();
    writeFileSync(`test-results/layout-${locale}-${viewport?.width}.json`, JSON.stringify(widths, null, 1));
  });
}
