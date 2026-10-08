import { test, expect } from "@playwright/test";

/**
 * Visual regression.
 *
 * Determinism comes from four things, all of which must hold or the baseline
 * will flap: motion frozen, fonts loaded, dynamic content masked, and a fixed
 * viewport/scale (set in playwright.config.ts).
 */
test.describe("visual", () => {
  test.beforeEach(async ({ page }) => {
    // Collapses every token-driven duration to 0ms (see tokens.css).
    await page.addInitScript(() => {
      document.documentElement.dataset["motion"] = "frozen";
    });
  });

  test("home matches its baseline", async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => document.fonts.ready);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    await expect(page).toHaveScreenshot("home.png", {
      fullPage: true,
      // Anything whose pixels are not a function of the markup gets masked.
      mask: [page.locator("[data-visual-volatile]")],
    });
  });
});
