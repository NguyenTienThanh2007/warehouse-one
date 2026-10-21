import { expect, type Page } from "@playwright/test";

/**
 * Shared helpers for browser tests. The app exposes two read-only hooks: what the renderer drew
 * (`window.__WAREHOUSE_ONE_SCENE__`, see apps/web/src/lib/world/scene-debug.ts) and the
 * authoritative simulation (`window.__WAREHOUSE_ONE_SIM__`, see apps/web/src/lib/sim/store.ts).
 * Tests compare the two; neither can change the simulation.
 */

type Position =
  | { kind: "slot"; location_id: string; slot: number }
  | { kind: "staging"; dock_id: string; position: number }
  | { kind: "equipment"; equipment_id: string }
  | { kind: "truck"; truck_id: string; position: number };

/** The subset of the simulation state the browser tests read. */
export interface SimState {
  tick: number;
  inventory: Record<string, Record<string, number>>;
  ops: {
    pallets: Record<string, { id: string; sku: string; at: Position; order_id: string | null }>;
    equipment: Record<string, { id: string; status: string; carrying: string | null }>;
    tasks: Record<string, { id: string; type: string; status: string; pallet_id: string }>;
    trucks: Record<string, { id: string; status: string; direction: string }>;
    orders: Record<string, { id: string; status: string }>;
    docks: Record<string, { truck_id: string | null }>;
  };
}

/** The logistics network (Phase 5) as the browser tests read it. */
export interface NetState {
  tick: number;
  network: {
    sites: Record<string, { stock: Record<string, number>; containers: number; received: number }>;
    vehicles: Record<
      string,
      {
        id: string;
        status: string;
        node: string;
        route: string[];
        transfer_id: string | null;
        site_id: string | null;
      }
    >;
    transfers: Record<
      string,
      {
        id: string;
        status: string;
        lane_id: string | null;
        vehicle_id: string | null;
        from_site: string;
        to_site: string;
      }
    >;
  };
}

interface SimHook {
  state(): SimState;
  poses(): {
    vehicles: { id: string; x: number; z: number; yaw: number; fork: number }[];
    trucks: { id: string; x: number; z: number }[];
    linehaul: { id: string; x: number; z: number; yaw: number }[];
  };
  finishedOrders(): { order_id: string; status: string }[];
}

export const scene = (page: Page) => page.evaluate(() => window.__WAREHOUSE_ONE_SCENE__ ?? null);

export const simState = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { __WAREHOUSE_ONE_SIM__: SimHook }).__WAREHOUSE_ONE_SIM__.state(),
  );

export const netState = (page: Page) =>
  page.evaluate(() =>
    (
      window as unknown as { __WAREHOUSE_ONE_SIM__: { state(): NetState } }
    ).__WAREHOUSE_ONE_SIM__.state(),
  );

export const simPoses = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { __WAREHOUSE_ONE_SIM__: SimHook }).__WAREHOUSE_ONE_SIM__.poses(),
  );

export const kpi = async (page: Page, id: string) =>
  Number((await page.getByTestId(id).locator(".metric").textContent())?.replace(/[^0-9]/g, ""));

export async function openWorld(page: Page, query = "") {
  await page.goto(`/${query}`);
  await expect(page.locator("main")).toHaveAttribute("data-world-status", "ready", {
    timeout: 45_000,
  });
}

/** Wait until the camera has come to rest after the latest move (camera-controls 'rest'). */
export async function cameraRest(page: Page, before: number) {
  await expect
    .poll(
      async () => {
        const m = (await scene(page))?.cameraMotion;
        return !!m && m.rests > before && !m.moving;
      },
      { timeout: 45_000, intervals: [250] },
    )
    .toBe(true);
}

export const rests = async (page: Page) => (await scene(page))?.cameraMotion?.rests ?? 0;

/** Pause the run (no-op when already paused). */
export async function pause(page: Page) {
  const toggle = page.getByTestId("sim-toggle");
  if ((await toggle.textContent()) === "Pause") await toggle.click();
  await expect(toggle).toHaveText("Resume");
}

/** Pallets on site that the scene draws: everything except pallets inside trailers. */
export function drawnPallets(s: SimState): number {
  return Object.values(s.ops.pallets).filter((p) => p.at.kind !== "truck").length;
}

export function inventoryUnits(s: SimState): number {
  let n = 0;
  for (const row of Object.values(s.inventory)) for (const q of Object.values(row)) n += q;
  return n;
}
