import { defineConfig, devices } from "@playwright/test";

/**
 * Browser end-to-end tests run against the production build (`next start`).
 * WEB_PORT / API_URL can be overridden when the defaults are occupied locally.
 */
const port = Number(process.env.WEB_PORT ?? 3100);
const baseURL = `http://localhost:${port}`;

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  // Each test drives a full WebGL scene; limit concurrency so frame timing stays representative.
  workers: process.env.CI ? 1 : 2,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: process.env.CI ? 90_000 : 45_000,
  expect: { timeout: process.env.CI ? 15_000 : 5_000 },
  reporter: process.env.CI
    ? [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]]
    : "list",
  outputDir: "../../test-results/e2e",
  use: {
    baseURL,
    // Linux CI runners have no GPU: use Chromium's software WebGL (SwiftShader); the app then
    // starts on its Low quality tier. Locally on macOS, use the real GPU like a user would.
    launchOptions: process.env.CI
      ? { args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] }
      : process.platform === "darwin"
        ? { args: ["--enable-gpu", "--ignore-gpu-blocklist", "--use-angle=metal"] }
        : {},
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
  ],
  webServer: {
    command: `pnpm --filter @warehouse-one/web exec next start -p ${port}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
