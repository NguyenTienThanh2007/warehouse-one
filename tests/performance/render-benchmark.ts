/**
 * Renderer frame-time benchmark. Loads the production web build in Chromium for the benchmark
 * scenarios (exactly 100 / 300 / 1,000 pallets + 6 vehicles) and the showcase, discards a warm-up period, samples frame times via the in-app probe
 * (window.__WAREHOUSE_ONE_PERF__) and prints a JSON + table report including the GPU string,
 * so results are never quoted without their hardware/software context.
 *
 * Usage: pnpm --filter @warehouse-one/web build && pnpm bench:render [-- --url http://localhost:3100 --seconds 10]
 * (start the server first: pnpm --filter @warehouse-one/web exec next start -p 3100)
 */
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { arch, cpus, platform, release } from "node:os";

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? (process.argv[i + 1] ?? fallback) : fallback;
};
const BASE = arg("url", "http://localhost:3100");
const SECONDS = Number(arg("seconds", "10"));
const HEADED = process.argv.includes("--headed");

const SCENES = [
  { label: "bench-100 · high", query: "?scenario=bench-100&quality=high" },
  { label: "bench-300 · high", query: "?scenario=bench-300&quality=high" },
  { label: "bench-1000 · high", query: "?scenario=bench-1000&quality=high" },
  { label: "bench-1000 · medium", query: "?scenario=bench-1000&quality=medium" },
  { label: "bench-1000 · low", query: "?scenario=bench-1000&quality=low" },
  { label: "showcase · high", query: "?scenario=showcase&quality=high" },
];

const browser = await chromium.launch({
  headless: !HEADED,
  args: [
    "--enable-gpu",
    "--ignore-gpu-blocklist",
    "--use-angle=metal",
    "--disable-renderer-backgrounding",
    "--disable-background-timer-throttling",
  ],
});
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
});
const results = [];

for (const scene of SCENES) {
  await page.goto(`${BASE}/${scene.query}`);
  await page.waitForSelector('[data-world-status="ready"]', { timeout: 60_000 });
  await page.waitForTimeout(3000); // warm-up: shader compile, first shadow maps, camera settle
  await page.evaluate(() => window.__WAREHOUSE_ONE_PERF__!.reset());
  await page.waitForTimeout(SECONDS * 1000);
  const r = await page.evaluate(() => {
    const canvas = document.querySelector("canvas");
    const gl = canvas?.getContext("webgl2") as WebGL2RenderingContext | null;
    const ext = gl?.getExtension("WEBGL_debug_renderer_info");
    return {
      frame: window.__WAREHOUSE_ONE_PERF__!.summary(),
      renderer: window.__WAREHOUSE_ONE_PERF__!.renderer(),
      counts: window.__WAREHOUSE_ONE_SCENE__?.counts ?? null,
      gpu: ext && gl ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : "unknown",
    };
  });
  results.push({ scene: scene.label, ...r });
}
await browser.close();

const report = {
  measured_at: new Date().toISOString(),
  machine: {
    platform: platform(),
    release: release(),
    arch: arch(),
    cpu: cpus()[0]?.model ?? "unknown",
  },
  browser: `chromium ${browser.version()} (${HEADED ? "headed" : "headless"})`,
  viewport: "1440x900 @2x",
  sample_seconds: SECONDS,
  results,
};
mkdirSync("test-results/performance", { recursive: true });
const file = `test-results/performance/render-${report.measured_at.replace(/[:.]/g, "-")}.json`;
writeFileSync(file, JSON.stringify(report, null, 2));

console.log(`${report.browser} on ${report.machine.cpu}; GPU: ${results[0]?.gpu}`);
console.log(
  "scene              | pallets | vehicles | fps   | p50 ms | p95 ms | p99 ms | long | draws | tris",
);
for (const r of results) {
  const f = r.frame;
  console.log(
    `${r.scene.padEnd(18)} | ${String(r.counts?.pallets ?? "?").padStart(7)} | ${String(r.counts?.vehicles ?? "?").padStart(8)} | ${f ? f.fps.toFixed(1).padStart(5) : "  n/a"} | ${f ? f.p50Ms.toFixed(1).padStart(6) : "   n/a"} | ${f ? f.p95Ms.toFixed(1).padStart(6) : "   n/a"} | ${f ? f.p99Ms.toFixed(1).padStart(6) : "   n/a"} | ${String(f?.longFrames ?? "-").padStart(4)} | ${String(r.renderer.drawCalls).padStart(5)} | ${r.renderer.triangles}`,
  );
}
console.log(`saved ${file}`);
