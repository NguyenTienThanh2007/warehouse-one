/**
 * Captures the Phase 1 visual-review bookmarks (docs/design/VISUAL_DESIGN_SPEC.md §7) from the
 * running production build: overview, docks, aisle, forklift close-up and inspector open, at
 * desktop and phone sizes. The simulation is paused right after load so captures are repeatable.
 *
 * Usage: pnpm --filter @warehouse-one/web exec next start -p 3100 &  pnpm capture:bookmarks [-- --out dir]
 */
import { chromium, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? (process.argv[i + 1] ?? fallback) : fallback;
};
const BASE = arg("url", "http://localhost:3100");
const OUT = arg("out", "docs/phases/evidence/phase-1");
mkdirSync(OUT, { recursive: true });

async function clickEntity(page: Page, kind: string, id: string) {
  const p = await page.evaluate(
    ([k, i]) => window.__WAREHOUSE_ONE_SCENE__?.projected?.find((e) => e.kind === k && e.id === i),
    [kind, id] as const,
  );
  if (!p || !p.visible) throw new Error(`${kind} ${id} not on screen`);
  const vp = page.viewportSize()!;
  await page.mouse.click(((p.x + 1) / 2) * vp.width, ((1 - p.y) / 2) * vp.height);
}

async function settle(page: Page, ms = 1600) {
  await page.waitForTimeout(ms);
}

const browser = await chromium.launch({
  args: ["--enable-gpu", "--ignore-gpu-blocklist", "--use-angle=metal"],
});
for (const [label, viewport, scale] of [
  ["desktop-1440x900", { width: 1440, height: 900 }, 1],
  ["mobile-390x844", { width: 390, height: 844 }, 2],
] as const) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: scale });
  await page.goto(`${BASE}/?scenario=showcase&quality=high`);
  await page.waitForSelector('[data-world-status="ready"]', { timeout: 30_000 });
  await page.locator("body").press("Space"); // pause: freeze the stock picture
  await settle(page, 2500);
  await page.screenshot({ path: `${OUT}/${label}-1-overview.jpg`, type: "jpeg", quality: 88 });

  await page.getByTestId("camera-docks").click();
  await settle(page);
  await page.screenshot({ path: `${OUT}/${label}-2-docks.jpg`, type: "jpeg", quality: 88 });

  await page.getByTestId("camera-aisle").click();
  await settle(page);
  await page.screenshot({ path: `${OUT}/${label}-3-aisle.jpg`, type: "jpeg", quality: 88 });

  await page.getByTestId("camera-overview").click();
  await settle(page);
  await clickEntity(page, "equipment", "fl-01");
  await page.getByTestId("camera-focus").click();
  await settle(page, 2000);
  await page.screenshot({ path: `${OUT}/${label}-4-forklift.jpg`, type: "jpeg", quality: 88 });

  await page.locator("body").press("Escape");
  await page.getByTestId("camera-overview").click();
  await settle(page);
  await clickEntity(page, "location", "loc-05-007");
  await page.getByTestId("camera-focus").click();
  await settle(page, 2000);
  await page.screenshot({ path: `${OUT}/${label}-5-inspector.jpg`, type: "jpeg", quality: 88 });
  await page.close();
}
await browser.close();
console.log(`saved bookmarks to ${OUT}`);
