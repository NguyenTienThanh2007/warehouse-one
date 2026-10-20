import { expect, test } from "@playwright/test";
import {
  drawnPallets,
  inventoryUnits,
  kpi,
  openWorld,
  pause,
  scene,
  simPoses,
  simState,
  type SimState,
} from "./helpers";

/**
 * Phase 2 operator workflows in the browser, driven through the UI and verified against the
 * authoritative simulation state. Every wait is on state (ticks, statuses, rendered counts), never
 * on elapsed time.
 */

const palletsOf = (s: SimState) => Object.values(s.ops.pallets);

test.describe("live operations in the 3D world", () => {
  test("vehicles, trucks and carried pallets are drawn exactly at their simulated poses", async ({
    page,
  }) => {
    await openWorld(page);
    await page.locator("body").press("5"); // 8× speed
    // Wait until a pallet is on forks and a truck is on site, then freeze the run.
    await expect
      .poll(
        async () => {
          const s = await simState(page);
          return (
            palletsOf(s).some((p) => p.at.kind === "equipment") &&
            Object.keys(s.ops.trucks).length > 0
          );
        },
        { timeout: 60_000, intervals: [100] },
      )
      .toBe(true);
    await pause(page);
    const expected = await simPoses(page);
    const s = await simState(page);
    // Paused, the renderer shows the latest tick exactly (no interpolation offset).
    await expect
      .poll(async () => (await scene(page))?.moving?.vehicles)
      .toEqual(
        expected.vehicles.map((v) => ({
          id: v.id,
          x: Math.round(v.x * 1000) / 1000,
          z: Math.round(v.z * 1000) / 1000,
          yaw: Math.round(v.yaw * 1000) / 1000,
          fork: Math.round(v.fork * 1000) / 1000,
        })),
      );
    const moving = (await scene(page))!.moving!;
    expect(moving.trucks).toEqual(
      expected.trucks.map((t) => ({
        id: t.id,
        x: Math.round(t.x * 1000) / 1000,
        z: Math.round(t.z * 1000) / 1000,
      })),
    );
    // Each pallet on forks is drawn, in front of the vehicle carrying it.
    const onForks = palletsOf(s).filter((p) => p.at.kind === "equipment");
    expect(moving.carried.map((p) => p.id).sort()).toEqual(onForks.map((p) => p.id).sort());
    for (const p of moving.carried) {
      const holder = Object.values(s.ops.equipment).find((e) => e.carrying === p.id)!;
      const v = moving.vehicles.find((x) => x.id === holder.id)!;
      expect(Math.hypot(p.x - v.x, p.z - v.z)).toBeLessThan(1.2);
    }
    // The operations panel lists the same tasks as the simulation.
    await expect(page.getByTestId("task-row")).toHaveCount(
      Math.min(30, Object.keys(s.ops.tasks).length),
    );
  });

  test("a truck can be selected and inspected while it is on site", async ({ page }) => {
    await openWorld(page);
    await page.locator("body").press("5");
    await expect
      .poll(async () => Object.keys((await simState(page)).ops.trucks).length, {
        timeout: 30_000,
      })
      .toBeGreaterThan(0);
    await pause(page);
    await page.getByTestId("ops-tab-trucks").click();
    const id = Object.keys((await simState(page)).ops.trucks).sort()[0]!;
    await page.locator(`[data-testid="truck-row"][data-truck-id="${id}"] button`).first().click();
    await expect(page.getByTestId("inspector")).toContainText(id);
    const status = (await simState(page)).ops.trucks[id]!.status;
    await expect(page.getByTestId("inspector-status")).toHaveText(status);
  });
});

test.describe("operator commands", () => {
  test("a rejected order explains why, and changes nothing", async ({ page }) => {
    await openWorld(page, "?scenario=empty");
    await page.getByTestId("ops-tab-new").click();
    await page.getByTestId("order-sku-0").selectOption("sku-electronics");
    await page.getByTestId("order-qty-0").fill("3");
    await page.getByTestId("order-submit").click();
    const row = page.getByTestId("command-row").first();
    await expect(row).toHaveAttribute("data-status", "rejected");
    await expect(row).toHaveAttribute("data-code", "INSUFFICIENT_STOCK");
    await expect(row.getByTestId("rejection-explanation")).toContainText(
      "Not enough free pallets of this SKU",
    );
    await expect(row).toContainText("0 pallets available, 3 requested");
    const s = await simState(page);
    expect(s.ops.orders).toEqual({});
    expect(s.ops.trucks).toEqual({});
  });

  test("a relocation requested in the bay inspector is carried out by a vehicle", async ({
    page,
  }) => {
    await openWorld(page);
    await pause(page);
    // A bay holding a free pallet (not allocated, not moving), and an empty bay to move it to.
    const before = await simState(page);
    const free = palletsOf(before).find((p) => p.at.kind === "slot" && !p.order_id)!;
    const from = free.at.kind === "slot" ? free.at.location_id : "";
    const config = await page.evaluate(() =>
      (
        window as unknown as {
          __WAREHOUSE_ONE_SIM__: { config(): { locations: { id: string }[] } };
        }
      ).__WAREHOUSE_ONE_SIM__.config(),
    );
    const target = config.locations.find((l) => !before.inventory[l.id])!.id;
    await page.getByTestId("location-picker").selectOption(from);
    await expect(page.getByTestId("inspector")).toContainText(from);
    await page.getByTestId("relocate-pallet").selectOption(free.id);
    const pallet = await page.getByTestId("relocate-pallet").inputValue();
    expect(pallet).toBe(free.id);
    await page.getByTestId("relocate-target").selectOption(target);
    await page.getByRole("button", { name: "Create relocation task" }).click();
    await page.getByRole("button", { name: /Advance one tick/ }).click();
    await expect(page.getByTestId("command-row").first()).toHaveAttribute(
      "data-status",
      "accepted",
    );
    // A relocation task exists for that pallet, and the run completes it.
    const task = Object.values((await simState(page)).ops.tasks).find(
      (t) => t.type === "relocate" && t.pallet_id === pallet,
    );
    expect(task).toBeDefined();
    await page.getByTestId("sim-toggle").click();
    await page.locator("body").press("5");
    await expect
      .poll(async () => (await simState(page)).ops.pallets[pallet]?.at, {
        timeout: 60_000,
        intervals: [250],
      })
      .toMatchObject({ kind: "slot", location_id: target });
  });

  test("inbound truck → put-away → outbound order → pick → load → ship, through the UI", async ({
    page,
  }) => {
    // Measured in the engine for this flow: ~1,380 ticks inbound and put-away plus ~2,050 ticks
    // for the order, i.e. ≥ 43 s of real time at the UI's maximum speed (8×), plus page load.
    test.setTimeout(180_000);
    const step = { timeout: 90_000, intervals: [250] };

    await openWorld(page, "?scenario=empty");
    await page.locator("body").press("5");
    expect(await kpi(page, "kpi-stock")).toBe(0);

    // 1. Schedule an inbound truck with 2 pallets.
    await page.getByTestId("ops-tab-new").click();
    await page.getByTestId("inbound-sku-0").selectOption("sku-std-pallet");
    await page.getByTestId("inbound-qty-0").fill("2");
    await page.getByTestId("inbound-submit").click();
    await expect(page.getByTestId("command-row").first()).toHaveAttribute(
      "data-status",
      "accepted",
    );
    const inboundTruck = Object.values((await simState(page)).ops.trucks).find(
      (t) => t.direction === "inbound",
    )!;
    expect(inboundTruck).toBeDefined();

    // 2. The truck docks, is unloaded, and both pallets are put away into rack slots.
    await expect
      .poll(async () => {
        const s = await simState(page);
        const slotted = palletsOf(s).filter((p) => p.at.kind === "slot").length;
        return slotted === 2 && Object.keys(s.ops.tasks).length === 0;
      }, step)
      .toBe(true);
    await expect.poll(() => kpi(page, "kpi-stock")).toBe(2);

    // 3. Order both pallets.
    await page.getByTestId("order-sku-0").selectOption("sku-std-pallet");
    await page.getByTestId("order-qty-0").fill("2");
    await page.getByTestId("order-submit").click();
    await expect(page.getByTestId("command-row").first()).toHaveAttribute(
      "data-status",
      "accepted",
    );
    const order = Object.keys((await simState(page)).ops.orders)[0]!;
    expect(order).toMatch(/^ord-/);
    await page.getByTestId("ops-tab-orders").click();
    await expect(
      page.locator(`[data-testid="order-row"][data-order-id="${order}"]`),
    ).toHaveAttribute("data-status", "in_progress", { timeout: 30_000 });

    // 4. Pallets are picked to the lane and loaded; the order ships and the truck leaves.
    await expect(
      page.locator(`[data-testid="finished-order"][data-order-id="${order}"]`),
    ).toHaveAttribute("data-status", "shipped", step);
    await expect
      .poll(async () => Object.keys((await simState(page)).ops.trucks).length, step)
      .toBe(0);

    // 5. The resulting state reconciles: nothing on site, no work left, every dock free.
    await pause(page);
    const s = await simState(page);
    expect(s.ops.pallets).toEqual({});
    expect(s.ops.orders).toEqual({});
    expect(s.ops.tasks).toEqual({});
    expect(Object.values(s.ops.docks).every((d) => d.truck_id === null)).toBe(true);
    expect(inventoryUnits(s)).toBe(0);
    expect(await kpi(page, "kpi-stock")).toBe(0);
    await expect.poll(async () => (await scene(page))?.counts?.pallets).toBe(drawnPallets(s));
    expect((await scene(page))!.counts!.trucks).toBe(0);
  });
});
