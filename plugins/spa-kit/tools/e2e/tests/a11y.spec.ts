import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test.describe("accessibility", () => {
  test("home has no critical or serious WCAG violations", async ({ page }) => {
    await page.goto("/");

    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();

    const blocking = results.violations.filter(
      (v) => v.impact === "critical" || v.impact === "serious",
    );

    expect(
      blocking,
      blocking
        .map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)
        .join("\n"),
    ).toEqual([]);
  });

  test("keyboard focus is always visible", async ({ page }) => {
    await page.goto("/");
    await page.keyboard.press("Tab");

    const outline = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const style = getComputedStyle(el);
      return { width: style.outlineWidth, style: style.outlineStyle, color: style.outlineColor };
    });

    expect(outline, "nothing received focus on first Tab").not.toBeNull();
    expect(outline?.style).not.toBe("none");
    expect(parseFloat(outline?.width ?? "0")).toBeGreaterThan(0);
  });
});
