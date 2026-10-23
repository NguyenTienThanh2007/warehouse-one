import { expect, test } from "@playwright/test";
import { openWorld } from "./helpers";

/**
 * Analytics mode against the real API and a real published snapshot (data-platform CI job, after
 * the smoke test has recorded runs and the refresh DAG has published them). Skipped unless
 * ANALYTICS_API_URL is set; the web build must use the same NEXT_PUBLIC_API_URL.
 */
const API = process.env.ANALYTICS_API_URL;

test.describe("analytics against the real API", () => {
  test.skip(!API, "set ANALYTICS_API_URL to run against a live API with published analytics");

  test("the dashboard shows exactly what the API published for the first run", async ({
    page,
    request,
  }) => {
    const status = await (await request.get(`${API}/api/v1/analytics/status`)).json();
    expect(status.snapshot, "a snapshot must have been published").not.toBeNull();
    const runs = await (await request.get(`${API}/api/v1/analytics/runs`)).json();
    const first = runs.runs[0];
    const run = await (
      await request.get(`${API}/api/v1/analytics/runs/${first.simulation_id}`, {
        params: { snapshot_id: runs.snapshot_id },
      })
    ).json();

    await openWorld(page);
    await page.getByTestId("mode-analytics").click();
    await expect(page.getByTestId("analytics-dashboard")).toHaveAttribute(
      "data-state",
      status.state,
    );
    await expect(page.getByTestId("analytics-run-figures")).toHaveAttribute(
      "data-simulation-id",
      first.simulation_id,
    );
    const compact = (n: number) =>
      n < 10_000 ? n.toLocaleString("en-US") : `${(n / 1000).toFixed(1).replace(/\.0$/, "")}K`;
    await expect(page.getByTestId("kpi-events-value")).toHaveText(compact(run.kpis.events));
    await expect(page.getByTestId("kpi-tasks-value")).toHaveText(compact(run.kpis.tasks_completed));
    await expect(page.getByTestId("kpi-orders-value")).toHaveText(compact(run.kpis.orders_shipped));
    await expect(page.getByTestId("chart-activity-bucket")).toHaveCount(run.window.buckets);
  });
});
