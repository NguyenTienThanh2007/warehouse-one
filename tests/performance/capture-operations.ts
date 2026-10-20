/**
 * Captures the Phase 2 operations screenshots from the running production build. Every capture
 * waits on simulation or camera state (never on a timer): the run is driven at 8× until the
 * wanted situation exists in `state.ops`, then paused, so each image shows a real simulated moment.
 *
 * Usage: pnpm --filter @warehouse-one/web exec next start -p 3100 &  pnpm capture:operations [-- --out dir]
 */
import { chromium, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? (process.argv[i + 1] ?? fallback) : fallback;
};
const BASE = arg("url", "http://localhost:3100");
const OUT = arg("out", "docs/phases/evidence/phase-2");
mkdirSync(OUT, { recursive: true });

interface Ops {
  pallets: Record<string, { id: string; at: { kind: string } }>;
  equipment: Record<string, { id: string; carrying: string | null; status: string }>;
  trucks: Record<string, { id: string; status: string }>;
}
const ops = (page: Page) =>
  page.evaluate(
    () =>
      (
        window as unknown as { __WAREHOUSE_ONE_SIM__: { state(): { ops: Ops } } }
      ).__WAREHOUSE_ONE_SIM__.state().ops,
  );

async function until(page: Page, what: string, test: (o: Ops) => boolean, timeoutMs = 120_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (test(await ops(page))) return;
    await new Promise((r) => setTimeout(r, 100)); // poll interval for the state check
  }
  throw new Error(`timed out waiting for: ${what}`);
}

async function setRunning(page: Page, running: boolean) {
  const toggle = page.getByTestId("sim-toggle");
  if ((await toggle.textContent()) === (running ? "Resume" : "Pause")) await toggle.click();
}

/**
 * Click a camera preset (or focus) and wait for camera-controls to report rest. Only request a
 * pose different from the current one: a no-op request wakes the controls but never rests.
 */
async function camera(page: Page, preset: string) {
  const before = await page.evaluate(
    () => window.__WAREHOUSE_ONE_SCENE__?.cameraMotion?.rests ?? 0,
  );
  await page.getByTestId(`camera-${preset}`).click();
  await page.waitForFunction(
    (n) => {
      const m = window.__WAREHOUSE_ONE_SCENE__?.cameraMotion;
      return !!m && m.rests > n && !m.moving;
    },
    before,
    { timeout: 60_000 },
  );
}

async function shot(page: Page, name: string) {
  // Two animation frames so the paused scene and panels are fully painted.
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))),
  );
  await page.screenshot({ path: `${OUT}/${name}.jpg`, type: "jpeg", quality: 88 });
  console.log(`saved ${OUT}/${name}.jpg`);
}

const browser = await chromium.launch({
  args: ["--enable-gpu", "--ignore-gpu-blocklist", "--use-angle=metal"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

// 1–4: the showcase operating: trucks at docks, a vehicle carrying a pallet.
await page.goto(`${BASE}/?scenario=showcase&quality=high`);
await page.waitForSelector('[data-world-status="ready"]', { timeout: 60_000 });
await page.locator("body").press("5");
await until(
  page,
  "a docked truck and a pallet on forks",
  (o) =>
    Object.values(o.trucks).some((t) => t.status === "docked") &&
    Object.values(o.equipment).some((e) => e.carrying),
);
await setRunning(page, false);
// The camera is already at the overview it framed on load.
await shot(page, "desktop-1-overview-operating");
await camera(page, "docks");
await shot(page, "desktop-2-docks-trucks-staging");

const carrier = Object.values((await ops(page)).equipment).find((e) => e.carrying)!;
await page.getByTestId("ops-tab-tasks").click();
// Select the carrying vehicle through its task row link and fly to it.
await page.locator(`[data-testid="task-row"] button`, { hasText: carrier.id }).first().click();
await camera(page, "focus");
await shot(page, "desktop-3-vehicle-carrying-inspector");

await page.getByTestId("ops-tab-trucks").click();
const truck = Object.values((await ops(page)).trucks).find((t) => t.status === "docked")!;
await page.locator(`[data-testid="truck-row"][data-truck-id="${truck.id}"] button`).first().click();
await camera(page, "focus");
await shot(page, "desktop-4-truck-inspector-trucks-panel");

await page.locator("body").press("Escape");
await page.getByTestId("ops-tab-orders").click();
await camera(page, "overview");
await shot(page, "desktop-5-orders-panel");

// 6: a rejected command with its explanation.
await page.goto(`${BASE}/?scenario=empty&quality=high`);
await page.waitForSelector('[data-world-status="ready"]', { timeout: 60_000 });
await page.getByTestId("ops-tab-new").click();
await page.getByTestId("order-sku-0").selectOption("sku-electronics");
await page.getByTestId("order-qty-0").fill("3");
await page.getByTestId("order-submit").click();
await page.locator('[data-testid="command-row"][data-status="rejected"]').waitFor();
await setRunning(page, false);
await shot(page, "desktop-6-rejected-order-explained");
await page.close();

// 7: phone overview of the running showcase.
const phone = await browser.newPage({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
});
await phone.goto(`${BASE}/?scenario=showcase&quality=high`);
await phone.waitForSelector('[data-world-status="ready"]', { timeout: 60_000 });
await phone.locator("body").press("5");
await until(phone, "a truck on site", (o) => Object.keys(o.trucks).length > 0);
await setRunning(phone, false);
await shot(phone, "mobile-1-overview-operating");
await browser.close();
