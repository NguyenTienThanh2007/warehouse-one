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

interface SimHook {
  state(): SimState;
  poses(): {
    vehicles: { id: string; x: number; z: number; yaw: number; fork: number }[];
    trucks: { id: string; x: number; z: number }[];
  };
  finishedOrders(): { order_id: string; status: string }[];
}

export const scene = (page: Page) => page.evaluate(() => window.__WAREHOUSE_ONE_SCENE__ ?? null);

export const simState = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { __WAREHOUSE_ONE_SIM__: SimHook }).__WAREHOUSE_ONE_SIM__.state(),
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
