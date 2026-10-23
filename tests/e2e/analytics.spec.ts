import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page, type Route } from "@playwright/test";
import { openWorld } from "./helpers";

/**
 * Analytics mode (Phase 4) in the browser. The analytics API is served from responses captured
 * from the real API (tests/e2e/fixtures/analytics, validated by the web contract tests), so every
 * state is reproducible without a running data platform. analytics-live.spec.ts checks the same
 * view against the real API in the data-platform CI job.
 */

const FIXTURES = fileURLToPath(new URL("fixtures/analytics/", import.meta.url));
const load = (name: string) => JSON.parse(readFileSync(resolve(FIXTURES, `${name}.json`), "utf8"));
const OPS = "f34d0922-999b-8f4f-9ae6-c979f93658d5";
const NET = "1f54e195-a02e-815c-9e93-4266b6c0f97f";

interface Mock {
  status?: string | ((route: Route) => Promise<void>);
  requests: string[];
}

async function mockAnalytics(page: Page, status = "status-fresh"): Promise<Mock> {
  const mock: Mock = { status, requests: [] };
  await page.route("**/api/v1/analytics/**", async (route) => {
    const url = new URL(route.request().url());
    mock.requests.push(url.pathname + url.search);
    if (url.pathname.endsWith("/status")) {
      if (typeof mock.status === "function") return mock.status(route);
      return route.fulfill({ json: load(mock.status ?? "status-fresh") });
    }
    if (url.pathname.endsWith("/runs")) return route.fulfill({ json: load("runs") });
    const run = url.pathname.split("/").at(-1);
    if (run === OPS)
      return route.fulfill({
        json: load(url.searchParams.has("from") ? "run-operations-window" : "run-operations"),
      });
    if (run === NET) return route.fulfill({ json: load("run-network") });
    return route.fulfill({
      status: 404,
      json: { error: { code: "RUN_NOT_IN_SNAPSHOT", message: "x", details: {} } },
    });
  });
  return mock;
}

/** Through the mode bar, from the running 3D world. */
async function openAnalytics(page: Page) {
  await openWorld(page);
  await page.getByTestId("mode-analytics").click();
  await expect(page.getByTestId("analytics-view")).toBeVisible();
}

/** A deep link: the dashboard does not wait for the 3D world (it is covered and not rendered). */
async function deepLink(page: Page) {
  await page.goto("/?mode=analytics");
  await expect(page.getByTestId("analytics-view")).toBeVisible();
}

const tile = (page: Page, id: string) => page.getByTestId(`kpi-${id}-value`);

test.describe("analytics mode", () => {
  test("opens from the mode bar and shows the published figures of each run, labelled as historical", async ({
    page,
  }) => {
    await mockAnalytics(page);
    await openAnalytics(page);
    const active = page.locator('[data-testid="mode-nav"] [aria-current="page"]');
    await expect(active).toHaveText("Analytics");
    await expect(page).toHaveURL(/\?mode=analytics$/);
    const dash = page.getByTestId("analytics-dashboard");
    await expect(dash).toHaveAttribute("data-state", "fresh");
    await expect(page.getByTestId("analytics-source-badge")).toHaveText("Published · historical");
    await expect(page.getByTestId("analytics-state")).toHaveText("Fresh");
    await expect(page.getByTestId("analytics-pipeline")).toContainText("healthy");
    await expect(page.getByTestId("analytics-reconciliation")).toContainText("passed");

    // The network run (first in the list) and its figures, exactly as the API published them.
    const net = load("run-network");
    await expect(page.getByTestId("analytics-run-figures")).toHaveAttribute(
      "data-simulation-id",
      NET,
    );
    await expect(tile(page, "events")).toHaveText(String(net.kpis.events));
    await expect(tile(page, "tasks")).toHaveText(String(net.kpis.tasks_completed));
    await expect(tile(page, "transfers")).toHaveText(String(net.kpis.transfers_delivered));
    await expect(page.getByTestId("analytics-lane")).toHaveCount(net.transfers_by_lane.length);

    // Switching runs reloads the figures for that run.
    await page.getByTestId("analytics-run").selectOption(OPS);
    const ops = load("run-operations");
    await expect(page.getByTestId("analytics-run-figures")).toHaveAttribute(
      "data-simulation-id",
      OPS,
    );
    await expect(tile(page, "events")).toHaveText(String(ops.kpis.events));
    await expect(tile(page, "orders")).toHaveText(String(ops.kpis.orders_shipped));
    await expect(tile(page, "shipped")).toHaveText(String(ops.kpis.pallets_shipped));
    await expect(page.getByTestId("analytics-lanes")).toHaveCount(0); // no transfers in this run
    await expect(page.getByTestId("chart-task-cycle-row")).toHaveCount(
      ops.tasks_by_type.filter((t: { cycle_p50_ms: number | null }) => t.cycle_p50_ms !== null)
        .length,
    );
    await expect(page.getByTestId("analytics-redelivered")).toHaveText(
      String(ops.integrity.redelivered_copies),
    );
  });

  test("a custom window queries simulated time and shows the windowed figures", async ({
    page,
  }) => {
    const mock = await mockAnalytics(page);
    await deepLink(page);
    await page.getByTestId("analytics-run").selectOption(OPS);
    await expect(tile(page, "events")).toHaveText(String(load("run-operations").kpis.events));
    await page.getByTestId("analytics-window-custom").click();
    await page.getByTestId("analytics-custom-toMin").fill("4");
    const windowed = load("run-operations-window");
    await expect(tile(page, "events")).toHaveText(String(windowed.kpis.events));
    const last = mock.requests.filter((r) => r.includes(OPS)).at(-1) ?? "";
    expect(new URL(`http://x${last}`).searchParams.get("from")).toBe("2026-01-05T06:00:00.100Z");
    expect(new URL(`http://x${last}`).searchParams.get("to")).toBe("2026-01-05T06:04:00.100Z");
    await expect(page.getByTestId("analytics-window")).toContainText(
      "06:00 UTC – 06:05:00 (simulated)",
    );
    // The series matches the window: one bar per bucket, and the table view lists them all.
    await expect(page.getByTestId("chart-activity-bucket")).toHaveCount(windowed.window.buckets);
    await page.getByTestId("chart-activity-table-toggle").click();
    await expect(page.locator('[data-testid="chart-activity-table"] tbody tr')).toHaveCount(
      windowed.window.buckets,
    );
  });

  test("every bucket has a hover tooltip with its value", async ({ page }) => {
    await mockAnalytics(page);
    await deepLink(page);
    await page.getByTestId("analytics-run").selectOption(OPS);
    const ops = load("run-operations");
    const busiest = ops.series.reduce(
      (best: number, p: { events: number }, i: number, all: { events: number }[]) =>
        p.events > (all[best]?.events ?? -1) ? i : best,
      0,
    );
    await page.getByTestId("chart-activity-bucket").nth(busiest).hover();
    await expect(page.getByTestId("chart-activity-tooltip")).toContainText(
      `Events: ${ops.series[busiest].events}`,
    );
    await expect(page.getByTestId("chart-activity-tooltip")).toContainText("(simulated)");
  });

  for (const [fixture, state, testid, text] of [
    ["status-stale", "stale", "analytics-banner-warning", "Stale snapshot"],
    ["status-degraded", "degraded", "analytics-banner-critical", "last published snapshot"],
  ] as const) {
    test(`a ${state} snapshot is labelled, never presented as current`, async ({ page }) => {
      await mockAnalytics(page, fixture);
      await deepLink(page);
      await expect(page.getByTestId("analytics-dashboard")).toHaveAttribute("data-state", state);
      await expect(page.getByTestId(testid)).toContainText(text);
      await expect(page.getByTestId("analytics-state")).not.toHaveText("Fresh");
      // The figures stay available underneath the warning.
      await expect(tile(page, "events")).toBeVisible();
    });
  }

  test("nothing published yet is an explained empty state", async ({ page }) => {
    await mockAnalytics(page, "status-empty");
    await deepLink(page);
    await expect(page.getByTestId("analytics-empty")).toContainText(
      "Nothing has been published yet",
    );
    await expect(page.getByTestId("analytics-run-figures")).toHaveCount(0);
  });

  test("an unreachable API, an error and a contract mismatch each say so, and retry recovers", async ({
    page,
  }) => {
    const mock = await mockAnalytics(page);
    mock.status = (route) => route.abort("connectionrefused");
    await deepLink(page);
    await expect(page.getByTestId("analytics-offline")).toContainText("Analytics API unavailable");

    mock.status = (route) =>
      route.fulfill({
        status: 500,
        json: { error: { code: "INTERNAL", message: "boom", details: {} } },
      });
    await page.getByTestId("analytics-retry").click();
    await expect(page.getByTestId("analytics-error")).toContainText("500 INTERNAL");

    mock.status = (route) => route.fulfill({ json: { ...load("status-fresh"), state: "live" } });
    await page.getByTestId("analytics-retry").click();
    await expect(page.getByTestId("analytics-error")).toContainText("CONTRACT");
    await expect(tile(page, "events")).toHaveCount(0);

    mock.status = "status-fresh";
    await page.getByTestId("analytics-retry").click();
    await expect(page.getByTestId("analytics-dashboard")).toHaveAttribute("data-state", "fresh");
    await expect(tile(page, "events")).toBeVisible();
  });

  test("leaving Analytics brings the running 3D world back", async ({ page }) => {
    await mockAnalytics(page);
    await deepLink(page);
    const tickIn = async () =>
      page.evaluate(
        () =>
          (
            window as unknown as { __WAREHOUSE_ONE_SIM__: { state(): { tick: number } } }
          ).__WAREHOUSE_ONE_SIM__.state().tick,
      );
    const before = await tickIn();
    // The simulation keeps running while the dashboard is open.
    await expect.poll(tickIn, { timeout: 15_000 }).toBeGreaterThan(before);
    await page.getByTestId("mode-explore").click();
    await expect(page.getByTestId("analytics-view")).toHaveCount(0);
    await expect(page.getByTestId("site-navigator")).toBeVisible();
    await expect(page.locator("main")).toHaveAttribute("data-world-status", "ready");
  });
});

test.describe("analytics on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("a deep link opens the dashboard without horizontal scrolling", async ({ page }) => {
    await mockAnalytics(page);
    await page.goto("/?mode=analytics");
    await expect(page.getByTestId("analytics-dashboard")).toHaveAttribute("data-state", "fresh");
    await expect(tile(page, "events")).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
    ).toBe(false);
  });
});
