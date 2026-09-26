import { test, expect, type Page } from "@playwright/test";

/**
 * Web-vitals budgets, measured in the same browser that runs the rest of the
 * suite. Lighthouse CI owns the audited score; this owns the fast regression
 * signal.
 *
 * Why this file splits the measurement in two
 * -------------------------------------------
 * Measured here on 2026-09-25, same page, same pinned headless Chromium:
 *
 *   WebGL available  → longest task 379ms (3/3 runs)
 *   WebGL disabled   → longest task   0ms (3/3 runs)
 *   System Chrome    → longest task   0ms (3/3 runs)
 *
 * Headless CI has no GPU, so the shader compiles through a software rasteriser
 * and costs ~380ms that a real viewer with a GPU never pays. A single budget
 * would therefore measure the runner rather than the product: either it fails
 * forever in CI, or it is loosened until it can no longer catch a genuine
 * hydration regression.
 *
 * So:
 *  - the HARD budget runs with WebGL neutralised. It is deterministic across
 *    environments and it is what guards hydration and application JavaScript.
 *  - the CEILING check keeps WebGL enabled and only fails on a pathological
 *    shader, catching "someone added four more shader layers" without
 *    re-importing the software-rendering penalty into the strict budget.
 */

const BUDGET = {
  lcpMs: 1500,
  cls: 0.1,
  longTaskMs: 200,
} as const;

/** A shader is allowed to be expensive under software rendering, but not absurd. */
const SHADER_CEILING_MS = 800;

interface Vitals {
  lcp: number;
  cls: number;
  longest: number;
}

async function collect(page: Page): Promise<Vitals> {
  await page.goto("/", { waitUntil: "load" });
  return page.evaluate(async () => {
    const result = { lcp: 0, cls: 0, longest: 0 };

    const lcpObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) result.lcp = entry.startTime;
    });
    lcpObserver.observe({ type: "largest-contentful-paint", buffered: true });

    const clsObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const shift = entry as PerformanceEntry & { value: number; hadRecentInput: boolean };
        if (!shift.hadRecentInput) result.cls += shift.value;
      }
    });
    clsObserver.observe({ type: "layout-shift", buffered: true });

    const taskObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        result.longest = Math.max(result.longest, entry.duration);
      }
    });
    taskObserver.observe({ type: "longtask", buffered: true });

    // Let post-load work (hydration, shader warm-up) settle before reading.
    await new Promise((resolve) => setTimeout(resolve, 2000));

    lcpObserver.disconnect();
    clsObserver.disconnect();
    taskObserver.disconnect();
    return result;
  });
}

/** Makes every WebGL context request fail. Decorative shaders then no-op. */
async function disableWebGL(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: any, ...rest: any[]) {
      if (String(type).includes("webgl")) return null;
      return original.call(this, type, ...rest);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
  });
}

test("application budget, WebGL neutralised", async ({ page }) => {
  await disableWebGL(page);
  const m = await collect(page);

  test.info().annotations.push({
    type: "vitals",
    description: `LCP ${m.lcp.toFixed(0)}ms · CLS ${m.cls.toFixed(3)} · longest task ${m.longest.toFixed(0)}ms`,
  });

  expect.soft(m.lcp, `LCP ${m.lcp.toFixed(0)}ms`).toBeLessThan(BUDGET.lcpMs);
  expect.soft(m.cls, `CLS ${m.cls.toFixed(3)}`).toBeLessThan(BUDGET.cls);
  expect
    .soft(m.longest, `longest task ${m.longest.toFixed(0)}ms`)
    .toBeLessThan(BUDGET.longTaskMs);
});

test("decorative WebGL stays under its ceiling", async ({ page }) => {
  const m = await collect(page);

  test.info().annotations.push({
    type: "vitals-webgl",
    description: `with WebGL: longest task ${m.longest.toFixed(0)}ms (software rendering in headless)`,
  });

  // LCP and CLS must hold regardless: the backdrop is deferred and must never
  // push the largest paint or shift the layout.
  expect.soft(m.lcp, `LCP with WebGL ${m.lcp.toFixed(0)}ms`).toBeLessThan(BUDGET.lcpMs);
  expect.soft(m.cls, `CLS with WebGL ${m.cls.toFixed(3)}`).toBeLessThan(BUDGET.cls);
  expect
    .soft(m.longest, `longest task with WebGL ${m.longest.toFixed(0)}ms`)
    .toBeLessThan(SHADER_CEILING_MS);
});
