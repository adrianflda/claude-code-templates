import { test, expect } from "@playwright/test";

test.describe("smoke", () => {
  test("home renders its heading and emits no console errors", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });
    page.on("pageerror", (err) => errors.push(err.message));

    const response = await page.goto("/");
    expect(response?.status()).toBe(200);

    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page).toHaveTitle(/.+/);

    expect(errors, `console errors: ${errors.join(" | ")}`).toHaveLength(0);
  });

  test("structured data is present in the served document", async ({ page }) => {
    await page.goto("/");
    const blocks = page.locator('script[type="application/ld+json"]');
    await expect(blocks.first()).toBeAttached();

    const payloads = await blocks.allTextContents();
    for (const payload of payloads) {
      expect(() => JSON.parse(payload) as unknown).not.toThrow();
    }
  });
});
