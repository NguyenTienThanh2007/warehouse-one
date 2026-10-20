import { expect, test } from "@playwright/test";

test.describe("Phase 0 application shell", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
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

  test("clicking a storage location opens the inspector with live contents", async ({ page }) => {
    await expect(page.getByTestId("inspector-empty")).toBeVisible();
    // Let the scene settle, then click the centre of the canvas where the slot rows are.
    await page.waitForTimeout(1500);
    const box = (await page.locator("canvas").boundingBox())!;
    let opened = false;
    for (const [fx, fy] of [
      [0.5, 0.5],
      [0.45, 0.55],
      [0.55, 0.45],
      [0.4, 0.5],
      [0.6, 0.5],
      [0.5, 0.6],
    ] as const) {
      await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
      // Wait for React to commit before deciding: clicking the same slot again would deselect it.
      opened = await page
        .getByTestId("inspector")
        .waitFor({ state: "visible", timeout: 500 })
        .then(() => true)
        .catch(() => false);
      if (opened) break;
    }
    expect(opened, "a click on the slot area should select a location").toBe(true);
    await expect(page.getByTestId("inspector")).toContainText(/loc-\d{2}-\d{3}/);
    await expect(page.getByTestId("inspector")).toContainText("positions");
    await page.locator("body").press("Escape");
    await expect(page.getByTestId("inspector-empty")).toBeVisible();
  });

  test("API status resolves to a definite state", async ({ page }) => {
    const status = page.getByTestId("api-status");
    await expect(status).not.toHaveAttribute("data-status", "checking", { timeout: 10_000 });
    const value = await status.getAttribute("data-status");
    expect(["online", "degraded", "offline"]).toContain(value);
    if (process.env.EXPECT_API_ONLINE) expect(value).toBe("online");
  });
});
