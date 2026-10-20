import { expect, test, type Page } from "@playwright/test";

/** Read-only scene introspection published by the app (see apps/web/src/lib/world/scene-debug.ts). */
const scene = (page: Page) => page.evaluate(() => window.__WAREHOUSE_ONE_SCENE__ ?? null);
const kpi = async (page: Page, id: string) =>
  Number((await page.getByTestId(id).locator(".metric").textContent())?.replace(/[^0-9]/g, ""));

async function openWorld(page: Page, query = "") {
  await page.goto(`/${query}`);
  await expect(page.locator("main")).toHaveAttribute("data-world-status", "ready", {
    timeout: 45_000,
  });
}

/** Click an entity at its projected screen position (pick volumes make this precise). */
async function clickEntity(page: Page, kind: string, id: string) {
  await expect
    .poll(
      async () =>
        (await scene(page))?.projected?.find((p) => p.kind === kind && p.id === id)?.visible,
      { timeout: 10_000 },
    )
    .toBe(true);
  const p = (await scene(page))!.projected!.find((e) => e.kind === kind && e.id === id)!;
  const vp = page.viewportSize()!;
  await page.mouse.click(((p.x + 1) / 2) * vp.width, ((1 - p.y) / 2) * vp.height);
}

test.describe("3D world reflects authoritative simulation state", () => {
  test("rendered pallets equal stock on hand, and bays/vehicles/docks equal facility data", async ({
    page,
  }) => {
    await openWorld(page);
    await expect(page.getByTestId("scene-loading")).toHaveCount(0);
    const counts = (await scene(page))!.counts!;
    expect(counts.pallets).toBeGreaterThan(0);
    expect(counts.pallets).toBe(await kpi(page, "kpi-stock"));
    expect(counts.bays).toBe(84);
    expect(counts.docks).toBe(4);
    expect(counts.vehicles).toBe(6);
    expect(Object.values(counts.palletsByArchetype).reduce((a, b) => a + b, 0)).toBe(
      counts.pallets,
    );
  });

  test("pallets follow the simulation as it runs", async ({ page }) => {
    await openWorld(page);
    await page.locator("body").press("5"); // 8× speed
    await page.waitForTimeout(4000);
    await page.locator("body").press("Space");
    await expect
      .poll(async () => (await scene(page))!.counts!.pallets)
      .toBe(await kpi(page, "kpi-stock"));
  });

  for (const n of [100, 300, 1000]) {
    test(`benchmark scenario bench-${n} renders exactly ${n} pallets`, async ({ page }) => {
      await openWorld(page, `?scenario=bench-${n}`);
      await expect.poll(async () => (await scene(page))?.counts?.pallets).toBe(n);
      expect(await kpi(page, "kpi-stock")).toBe(n);
    });
  }

  test("an empty facility shows an explanatory empty state and renders no pallets", async ({
    page,
  }) => {
    await openWorld(page, "?scenario=empty");
    await expect(page.getByTestId("empty-state")).toContainText("No stock on hand");
    expect((await scene(page))!.counts!.pallets).toBe(0);
    await page.getByRole("button", { name: "Load showcase" }).click();
    await expect(page.getByTestId("empty-state")).toHaveCount(0);
    await expect.poll(async () => (await scene(page))!.counts!.pallets).toBeGreaterThan(0);
  });
});

test.describe("selection and camera", () => {
  test("clicking a forklift opens its inspector from facility data", async ({ page }) => {
    await openWorld(page);
    await page.locator("body").press("Space");
    await clickEntity(page, "equipment", "fl-01");
    const inspector = page.getByTestId("inspector");
    await expect(inspector).toContainText("fl-01");
    await expect(inspector).toContainText("Counterbalance forklift");
    await expect(page.getByTestId("inspector-status")).toHaveText("Parked");
    await page.locator("body").press("Escape");
    await expect(page.getByTestId("inspector")).toHaveCount(0);
  });

  test("clicking a rack bay shows its live occupancy", async ({ page }) => {
    await openWorld(page);
    await page.locator("body").press("Space");
    await clickEntity(page, "location", "loc-05-007");
    await expect(page.getByTestId("inspector")).toContainText("loc-05-007");
    await expect(page.getByTestId("inspector-occupancy")).toHaveText(/^\d+ \/ 8 positions$/);
  });

  test("the keyboard location picker selects a bay and flies the camera to it", async ({
    page,
  }) => {
    await openWorld(page);
    const before = (await scene(page))!.camera!;
    await page.getByTestId("location-picker").selectOption("loc-02-010");
    await expect(page.getByTestId("inspector")).toContainText("loc-02-010");
    await expect
      .poll(
        async () => {
          const c = (await scene(page))!.camera!;
          return Math.hypot(...c.position.map((v, i) => v - before.position[i]!));
        },
        { timeout: 10_000 },
      )
      .toBeGreaterThan(10);
  });

  test("camera presets produce distinct, sensible poses", async ({ page }) => {
    await openWorld(page);
    const pose = async (preset: string) => {
      await page.getByTestId(`camera-${preset}`).click();
      await page.waitForTimeout(1800);
      return (await scene(page))!.camera!;
    };
    const top = await pose("top");
    expect(top.position[1] - top.target[1]).toBeGreaterThan(30);
    expect(
      Math.hypot(top.position[0] - top.target[0], top.position[2] - top.target[2]),
    ).toBeLessThan(1);
    const aisle = await pose("aisle");
    expect(aisle.position[1]).toBeLessThan(6); // eye level in the aisle
    const docks = await pose("docks");
    expect(docks.position[2]).toBeGreaterThan(aisle.position[2]);
    const overview = await pose("overview");
    expect(overview.position[1]).toBeGreaterThan(aisle.position[1]);
    // The camera never goes below the floor.
    for (const p of [top, aisle, docks, overview]) expect(p.position[1]).toBeGreaterThan(0);
  });

  test("overview frames every rack bay on a desktop screen", async ({ page }) => {
    await openWorld(page);
    await expect
      .poll(
        async () =>
          (await scene(page))?.projected
            ?.filter((p) => p.kind === "location")
            .every((p) => p.visible),
        { timeout: 10_000 },
      )
      .toBe(true);
  });
});

test.describe("states and quality", () => {
  test("shows a recoverable error state when WebGL is unavailable, while the simulation keeps running", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      // Simulate a browser without WebGL; 2D canvases keep working.
      const original = HTMLCanvasElement.prototype.getContext as (
        this: HTMLCanvasElement,
        type: string,
        ...args: unknown[]
      ) => unknown;
      (HTMLCanvasElement.prototype as unknown as { getContext: unknown }).getContext = function (
        this: HTMLCanvasElement,
        type: string,
        ...args: unknown[]
      ) {
        return type.startsWith("webgl") ? null : original.call(this, type, ...args);
      };
    });
    await page.goto("/");
    await expect(page.getByTestId("scene-error")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("scene-error")).toContainText("3D view unavailable");
    await expect
      .poll(
        async () => Number((await page.getByTestId("sim-tick").textContent())?.replace(/,/g, "")),
        { timeout: 10_000 },
      )
      .toBeGreaterThan(5);
  });

  test("quality can be switched manually", async ({ page }) => {
    await openWorld(page);
    await page.getByTestId("quality-mode").selectOption("low");
    await expect(page.getByTestId("quality-tier")).toHaveText("low");
    await page.getByTestId("quality-mode").selectOption("high");
    await expect(page.getByTestId("quality-tier")).toHaveText("high");
  });
});

test.describe("phone layout", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("frames the whole facility in portrait without horizontal scrolling", async ({ page }) => {
    await openWorld(page);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
    ).toBe(false);
    await expect
      .poll(
        async () =>
          (await scene(page))?.projected
            ?.filter((p) => p.kind === "location")
            .every((p) => p.visible),
        { timeout: 10_000 },
      )
      .toBe(true);
    await expect(page.getByTestId("camera-toolbar")).toBeVisible();
    await expect(page.getByTestId("simulation-panel")).toBeVisible();
  });
});
