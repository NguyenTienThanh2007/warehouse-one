import { expect, test } from "@playwright/test";

test.describe("application shell", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("main")).toHaveAttribute("data-world-status", "ready", {
      timeout: 45_000,
    });
  });

  test("renders the brand, HUD panels and a WebGL canvas without console errors", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on(
      "console",
      (m) =>
        m.type() === "error" &&
        !m.text().includes("Failed to load resource") &&
        errors.push(m.text()),
    );
    page.on("pageerror", (e) => errors.push(e.message));

    await expect(page).toHaveTitle("WAREHOUSE ONE");
    await expect(page.getByRole("heading", { name: "WAREHOUSE ONE" })).toBeVisible();
    await expect(page.getByTestId("simulation-panel")).toBeVisible();
    await expect(page.getByTestId("renderer-panel")).toBeVisible();
    await expect(page.locator("canvas")).toBeVisible();
    const hasWebGL = await page
      .locator("canvas")
      .evaluate((c: HTMLCanvasElement) => !!(c.getContext("webgl2") ?? c.getContext("webgl")));
    expect(hasWebGL).toBe(true);
    await page.waitForTimeout(1000);
    expect(errors).toEqual([]);
  });

  test("the simulation advances, emits events, and pause freezes simulated time", async ({
    page,
  }) => {
    const tick = page.getByTestId("sim-tick");
    await expect
      .poll(async () => Number((await tick.textContent())?.replace(/,/g, "")), { timeout: 10_000 })
      .toBeGreaterThan(10);
    await expect
      .poll(async () => Number(await page.getByTestId("sim-events").textContent()), {
        timeout: 15_000,
      })
      .toBeGreaterThan(0);

    await page.getByTestId("sim-toggle").click();
    await expect(page.getByTestId("sim-toggle")).toHaveText("Resume");
    const frozen = await page.getByTestId("sim-clock").textContent();
    await page.waitForTimeout(1500);
    await expect(page.getByTestId("sim-clock")).toHaveText(frozen ?? "");

    const ticks = Number((await tick.textContent())?.replace(/,/g, ""));
    await page.getByRole("button", { name: /Advance one tick/ }).click();
    await expect(tick).toHaveText((ticks + 1).toLocaleString("en-US"));
  });

  test("keyboard shortcuts control the simulation", async ({ page }) => {
    await page.locator("body").press("Space");
    await expect(page.getByTestId("sim-toggle")).toHaveText("Resume");
    await page.locator("body").press("4");
    await expect(page.getByRole("button", { name: "4×" })).toHaveAttribute("aria-pressed", "true");
    const before = Number((await page.getByTestId("sim-tick").textContent())?.replace(/,/g, ""));
    await page.locator("body").press(".");
    await expect(page.getByTestId("sim-tick")).toHaveText((before + 1).toLocaleString("en-US"));
  });

  test("API status resolves to a definite state", async ({ page }) => {
    const status = page.getByTestId("api-status");
    await expect(status).not.toHaveAttribute("data-status", "checking", { timeout: 10_000 });
    const value = await status.getAttribute("data-status");
    expect(["online", "degraded", "offline"]).toContain(value);
    if (process.env.EXPECT_API_ONLINE) expect(value).toBe("online");
  });
});
