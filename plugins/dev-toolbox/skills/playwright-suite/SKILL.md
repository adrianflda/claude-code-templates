---
name: playwright-suite
description: Setting up and maintaining a Playwright Test suite (playwright.config.ts, projects, signed-in state, fixtures, flaky tests, CI workflow, sharding). Use when creating or changing a suite's configuration or CI, or when a test is flaky. For driving a browser by hand or generating one test, use /dev-toolbox:playwright-cli.
---

# Playwright suite

The configuration, the signed-in state and the test rules were read from the Playwright
documentation on 2026-11-25 (best practices, test configuration, authentication, CI); the
flaky-test procedure is working practice. Check the installed version with `npx playwright --version` and the docs for
that version before relying on an option: https://playwright.dev/docs/intro

## Configuration

```ts
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,          // a committed test.only fails the run
  retries: process.env.CI ? 2 : 0,       // retries on CI only: locally a flaky test must show
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  globalTimeout: 60 * 60 * 1000,         // fail the run, so the reporters still write a report
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',             // not 'on': it slows every test
  },
  projects: [
    { name: 'setup', testMatch: /.*\.setup\.ts/ },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], storageState: 'playwright/.auth/user.json' },
      dependencies: ['setup'],
    },
  ],
  webServer: {
    command: 'npm run start',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
  },
});
```

Add Firefox and WebKit projects only when the product supports them: each one multiplies the run.

## Signed-in state

- Log in once in `tests/auth.setup.ts`, wait for a signed-in element or the final URL, then
  `await page.context().storageState({ path: 'playwright/.auth/user.json' })`.
- `playwright/.auth` goes in `.gitignore`: the file holds session cookies.
- One shared account is enough when tests do not change server state. When they do, give each
  worker its own account: a worker-scoped `storageState` fixture keyed by
  `test.info().parallelIndex`, and tests import `test` from that fixtures file.
- UI mode does not run the setup project: run it by hand when the session expires.

## Tests

- Locate by what the user sees: `getByRole`, `getByLabel`, `getByText`, then `getByTestId`.
  CSS and XPath break when the markup changes.
- Assert with web-first assertions (`await expect(locator).toBeVisible()`), which wait and retry.
  `expect(await locator.isVisible()).toBe(true)` reads once and does not wait.
- Each test builds its own state and can run alone and in any order. Shared setup goes in
  `test.beforeEach` or a fixture, not in an earlier test.
- Test only what the team controls. Replace third-party calls with `page.route()` and
  `route.fulfill()`.
- Turn on `@typescript-eslint/no-floating-promises` and run `tsc --noEmit` in CI: a missing
  `await` is the most common silent failure.

## A flaky test

1. Reproduce it with a trace: `npx playwright test path/to.spec.ts:LINE --repeat-each=20 --trace on`.
   The configured `on-first-retry` records nothing locally, where retries are 0.
2. Open the trace of a failed run (`npx playwright show-report`, then the trace icon).
3. Fix the cause. The usual ones: an assertion that does not wait, state left by another test, a
   real race in the application, a fixed `waitForTimeout`.

Never make it pass by raising `retries`, adding a sleep, waiting for `networkidle`, or loosening
the expectation. If the application has the race, report it as a bug.

## CI (GitHub Actions)

The steps of the documented workflow: check out, set up Node LTS, `npm ci`,
`npx playwright install --with-deps` (name the browsers the projects use, for example `chromium`),
`npx playwright test`, then upload `playwright-report/` as an artifact with
`if: ${{ !cancelled() }}` so a failed run still has its report.

- Linux runners. For a large suite, a matrix with `--shard=${{ matrix.shard }}/N`.
- Traces and reports can contain tokens and personal data: upload them only to a store the team
  trusts, with a short retention.
- A report opened straight from the unzipped folder does not work: serve it with
  `npx playwright show-report <folder>`.

## Before changing a suite

Run it once and note what passes. After the change the same tests pass, and a test that was
removed or skipped is named in the summary with its reason.
