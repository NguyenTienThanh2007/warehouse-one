/**
 * Captures the Phase 5 multi-site world for visual review: the world overview, each site's
 * facility view. The run is advanced at 8× for a while first so
 * trucks are on the road, then paused so captures are repeatable.
 *
 * Usage: pnpm --filter @warehouse-one/web exec next start -p 3100 &  pnpm capture:network [-- --out dir]
 */
import { chromium, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? (process.argv[i + 1] ?? fallback) : fallback;
};
const BASE = arg("url", "http://localhost:3100");
const OUT = arg("out", "docs/phases/evidence/phase-5");
const TICKS = Number(arg("ticks", "2400"));
mkdirSync(OUT, { recursive: true });

async function rest(page: Page) {
  const before = await page.evaluate(
    () => window.__WAREHOUSE_ONE_SCENE__?.cameraMotion?.rests ?? 0,
  );
  await page.waitForFunction(
    (b) => {
      const m = window.__WAREHOUSE_ONE_SCENE__?.cameraMotion;
      return !!m && m.rests > b && !m.moving;
    },
    before,
    { timeout: 30_000 },
  );
  await page.waitForTimeout(600);
}

const tick = (page: Page) =>
  page.evaluate(
    () =>
      (
        window as unknown as { __WAREHOUSE_ONE_SIM__: { state(): { tick: number } } }
      ).__WAREHOUSE_ONE_SIM__.state().tick,
  );

const browser = await chromium.launch({
  args: ["--enable-gpu", "--ignore-gpu-blocklist", "--use-angle=metal"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(`${BASE}/?quality=high`);
await page.waitForSelector('[data-world-status="ready"]', { timeout: 60_000 });
await page.locator("body").press("5"); // 8×
await page.waitForFunction(
  (n) =>
    (
      window as unknown as { __WAREHOUSE_ONE_SIM__: { state(): { tick: number } } }
    ).__WAREHOUSE_ONE_SIM__.state().tick >= n,
  TICKS,
  { timeout: 120_000 },
);
await page.locator("body").press("Space"); // pause
console.log(`paused at tick ${await tick(page)}`);
await page.getByTestId("nav-world").click();
await rest(page).catch(() => undefined);
await page.screenshot({ path: `${OUT}/1-world.jpg`, type: "jpeg", quality: 88 });

const sites = await page.evaluate(
  () => window.__WAREHOUSE_ONE_SCENE__?.network?.sites.map((s) => s.id) ?? [],
);
let n = 2;
for (const id of sites) {
  await page.getByTestId(`nav-site-${id}`).click();
  await rest(page);
  await page.screenshot({ path: `${OUT}/${n++}-site-${id}.jpg`, type: "jpeg", quality: 88 });
}

await browser.close();
console.log(`captures in ${OUT}`);
