import { defineConfig, devices } from "@playwright/test";

/**
 * The base URL is the one contract shared by every tool in this kit: the SEO
 * probes, Lighthouse and the blind breaker all point at the same origin.
 */
const baseURL = process.env["KIT_BASE_URL"] ?? "http://localhost:4321";

/**
 * When the suite runs against a generated client SPA, `spa-kit verify` sets
 * KIT_PROJECT_DIR and starts that app itself. Playwright must then NOT start a
 * server of its own, and visual baselines belong to that project rather than to
 * the kit — otherwise three clients would overwrite each other's screenshots.
 */
const projectDir = process.env["KIT_PROJECT_DIR"];

/**
 * Escape hatch: `KIT_BROWSER_CHANNEL=chrome` runs the Chromium projects against
 * an installed browser instead of Playwright's pinned build — useful when the
 * managed download is unavailable. It deliberately does not apply to the mobile
 * project, which is WebKit and rejects a Chromium channel. Never use it for
 * visual baselines: those are only comparable against the pinned browser.
 */
const channel = process.env["KIT_BROWSER_CHANNEL"];
const chromium = {
  ...devices["Desktop Chrome"],
  ...(channel ? { channel } : {}),
};

export default defineConfig({
  testDir: "./tests",
  outputDir: projectDir ? `${projectDir}/.spa-kit/test-results` : "./test-results",
  // Baselines live with the project they describe, per platform.
  ...(projectDir
    ? {
        snapshotPathTemplate:
          `${projectDir}/tests/__screenshots__/{testFilePath}/{arg}-{projectName}-{platform}{ext}`,
      }
    : {}),
  fullyParallel: true,
  forbidOnly: !!process.env["CI"],
  retries: process.env["CI"] ? 2 : 0,
  // Omitted outside CI so Playwright picks its own default: under
  // exactOptionalPropertyTypes, passing `undefined` is not the same as omitting.
  ...(process.env["CI"] ? { workers: 2 } : {}),
  reporter: process.env["CI"]
    ? [["github"], ["html", { open: "never" }]]
    : [["list"], ["html", { open: "never" }]],

  use: {
    baseURL,
    trace: "on-first-retry",
    video: "retain-on-failure",
    screenshot: "only-on-failure",
  },

  /**
   * Visual baselines only match when the rendering environment matches. Pin the
   * viewport and device scale factor here, and generate baselines in CI (or in
   * the Playwright Docker image) rather than on a laptop.
   */
  expect: {
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.01,
      animations: "disabled",
      caret: "hide",
      scale: "css",
    },
  },

  projects: [
    {
      name: "smoke",
      testMatch: /smoke\.spec\.ts/,
      use: { ...chromium, viewport: { width: 1440, height: 900 } },
    },
    {
      name: "visual",
      testMatch: /visual\.spec\.ts/,
      use: {
        ...chromium,
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 1,
        // Freeze motion so a screenshot is a function of markup, not of timing.
        reducedMotion: "reduce",
        colorScheme: "dark",
        timezoneId: "UTC",
        locale: "en-US",
      },
    },
    {
      name: "a11y",
      testMatch: /a11y\.spec\.ts/,
      use: { ...chromium },
    },
    {
      name: "motion",
      testMatch: /motion\.spec\.ts/,
      use: { ...chromium },
    },
    {
      name: "perf",
      testMatch: /vitals\.spec\.ts/,
      use: { ...chromium, viewport: { width: 1440, height: 900 } },
    },
    {
      name: "mobile",
      testMatch: /smoke\.spec\.ts/,
      use: { ...devices["iPhone 15"] },
    },
  ],

  /**
   * Tests run against a production build, not the dev server: dev-only overlays,
   * unminified bundles and missing prerendering all distort both visual
   * baselines and web-vitals numbers.
   *
   * Only for the kit's own fixture — an external project is served by the caller.
   */
  ...(projectDir
    ? {}
    : {
        webServer: {
          command: "npm run start --workspace apps/fixture",
          cwd: "../..",
          url: baseURL,
          reuseExistingServer: !process.env["CI"],
          timeout: 120_000,
          stdout: "pipe" as const,
          stderr: "pipe" as const,
        },
      }),
});
