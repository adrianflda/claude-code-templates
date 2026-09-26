import { test, expect } from "@playwright/test";

/**
 * The motion contract.
 *
 * Two directions are asserted, because each catches a different regression:
 *  - with reduced motion requested, nothing may animate and no content may
 *    depend on an animation having run;
 *  - with motion allowed, something must actually animate, which is what stops
 *    an over-eager "disable everything" fix from silently killing the design.
 */
test.describe("motion contract", () => {
  test("reduced motion collapses every token duration to zero", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");

    const durations = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      return ["instant", "fast", "base", "slow", "cinematic"].map((name) => ({
        name,
        value: style.getPropertyValue(`--kit-dur-${name}`).trim(),
      }));
    });

    // Chromium serialises "0ms" as "0s", so compare the parsed value.
    const toMs = (value: string): number =>
      value.endsWith("ms") ? parseFloat(value) : parseFloat(value) * 1000;

    for (const { name, value } of durations) {
      expect(toMs(value), `--kit-dur-${name} is "${value}" under reduced motion`).toBe(0);
    }
  });

  test("content is fully visible without any animation running", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");

    const heading = page.getByRole("heading", { level: 1 });
    await expect(heading).toBeVisible();

    const opacity = await heading.evaluate((el) => {
      let node: HTMLElement | null = el as HTMLElement;
      let min = 1;
      while (node) {
        min = Math.min(min, parseFloat(getComputedStyle(node).opacity));
        node = node.parentElement;
      }
      return min;
    });
    expect(opacity, "revealed content must not stay transparent under reduced motion").toBe(1);

    const running = await page.evaluate(
      () => document.getAnimations().filter((a) => a.playState === "running").length,
    );
    expect(running, "no animation may run under reduced motion").toBe(0);
  });

  test("motion is alive when the viewer allows it", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.goto("/");

    const base = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--kit-dur-base").trim(),
    );
    expect(base, "durations must not be zero when motion is allowed").not.toBe("0ms");
  });
});
