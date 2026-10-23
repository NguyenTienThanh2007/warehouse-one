import { expect, test, type Page } from "@playwright/test";
import { cameraRest, openWorld, rests } from "./helpers";

/**
 * Top-bar modes: Explore and Operate open real views and the active tab follows the URL
 * (`?mode=`), including back/forward; planned modes explain their status instead of navigating.
 */

const active = (page: Page) => page.locator('[data-testid="mode-nav"] [aria-current="page"]');

test.describe("mode navigation", () => {
  test("Explore is active on load; Operate opens the DC operations console and the URL follows", async ({
    page,
  }) => {
    await openWorld(page);
    await expect(active(page)).toHaveText("Explore");
    await expect(page.getByTestId("network-panel")).toBeVisible();

    const r = await rests(page);
    await page.getByTestId("mode-operate").click();
    await expect(active(page)).toHaveText("Operate");
    await expect(page).toHaveURL(/\?mode=operate$/);
    await expect(page.getByTestId("operations-panel")).toBeVisible();
    await cameraRest(page, r);
    await expect(page.getByTestId("site-navigator")).toHaveAttribute("data-scope", "northgate-dc");
    // The operator console stays in Operate even when the camera visits another site.
    await page.getByTestId("nav-site-riverside-xd").click();
    await expect(page.getByTestId("operations-panel")).toBeVisible();

    // Back returns to Explore (the world view); forward to Operate.
    await page.goBack();
    await expect(active(page)).toHaveText("Explore");
    await expect(page).not.toHaveURL(/mode=/);
    await expect(page.getByTestId("site-navigator")).toHaveAttribute("data-scope", "world", {
      timeout: 15_000,
    });
    await page.goForward();
    await expect(active(page)).toHaveText("Operate");
  });

  test("a deep link opens Operate, framed on the DC", async ({ page }) => {
    await openWorld(page, "?mode=operate");
    await expect(active(page)).toHaveText("Operate");
    await expect(page.getByTestId("operations-panel")).toBeVisible();
    await expect(page.getByTestId("site-navigator")).toHaveAttribute("data-scope", "northgate-dc", {
      timeout: 15_000,
    });
    await page.getByTestId("mode-explore").click();
    await expect(active(page)).toHaveText("Explore");
    await expect(page).not.toHaveURL(/mode=/);
  });

  test("planned modes say what exists today instead of navigating", async ({ page }) => {
    await openWorld(page, "?scenario=showcase");
    const before = page.url();
    for (const [id, plan] of [
      ["build", "Not scheduled"],
      ["ai", "Phase 6"],
    ] as const) {
      const tab = page.getByTestId(`mode-${id}`);
      // Clickable (not a dead button), marked as planned, opening a notice rather than a view.
      await expect(tab).toBeEnabled();
      await expect(tab).toHaveAttribute("data-status", "planned");
      await expect(tab).toHaveAttribute("aria-haspopup", "dialog");
      await expect(tab).toContainText("Soon");
      await tab.click();
      const notice = page.getByTestId("mode-notice");
      await expect(notice).toBeVisible();
      await expect(notice).toContainText(`Coming soon · ${plan}`);
      await expect(page.getByTestId("mode-notice-detail")).toContainText(/not (built|started)/i);
      // Nothing navigates and the active tab does not change.
      expect(page.url()).toBe(before);
      await expect(active(page)).toHaveText("Explore");
    }
    await page.locator("body").press("Escape");
    await expect(page.getByTestId("mode-notice")).toHaveCount(0);
    // No stale promise anywhere in the bar.
    await expect(page.getByTestId("mode-nav")).not.toContainText("Phase 2");
    const titles = await page
      .locator('[data-testid="mode-nav"] [title]')
      .evaluateAll((els) => els.map((e) => e.getAttribute("title") ?? ""));
    expect(titles.length).toBe(5);
    await expect(page.getByTestId("mode-analytics")).not.toHaveAttribute("data-status", "planned");
    for (const t of titles) expect(t).not.toMatch(/arrives in Phase/);
  });
});
