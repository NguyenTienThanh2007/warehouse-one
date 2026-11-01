/**
 * Digital-twin evaluation benchmark in the browser (Phase 6.1). Loads the production build in
 * Chromium, opens AI mode on the logistics park and runs the optimiser from the UI, once with the
 * background worker pool (default) and once on the main thread (`?twinExecution=main-thread`),
 * for several horizons. For each run it records, from inside the page:
 *   - wall time of the whole evaluation (the result's own `elapsedMs`);
 *   - main-thread long tasks (> 50 ms) while it ran, and the longest one;
 *   - animation-frame intervals (p95 and max): what the operator feels as stutter; the share of
 *     frames that miss a vsync (> 20 ms), split into start-up (first second: workers start, first
 *     batch), steady state, and the end (last half second: the result is rendered);
 *   - how far the live simulation advanced (it must keep running at its speed);
 *   - JS heap of the page before and after (Chromium's performance.memory; workers not included)
 *     and the renderer process's resident memory, sampled during the run (workers included);
 *   - throughput: simulated ticks per second over all simulations of the evaluation.
 * It also times worker start-up (fetch + compile + engine load until "ready"), cold and warm, and
 * how throughput scales with 1, 2 and 4 workers (the pool sizes itself from
 * navigator.hardwareConcurrency, which the scaling runs override).
 * The twin API is stubbed out (saving is not measured).
 *
 * Usage: pnpm --filter @warehouse-one/web build && pnpm bench:twin-browser [-- --url http://localhost:3100 --runs 3 --only scaling]
 * (start the server first: pnpm --filter @warehouse-one/web exec next start -p 3100)
 */
import { chromium, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { arch, cpus, platform, release } from "node:os";

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? (process.argv[i + 1] ?? fallback) : fallback;
};
const BASE = arg("url", "http://localhost:3100");
const RUNS = Number(arg("runs", "3"));
/** `--only scaling` runs the pool-size comparison alone. */
const ONLY = arg("only", "all");
const HORIZONS = [
  { ticks: 9_000, label: "15 min" },
  { ticks: 18_000, label: "30 min" },
  { ticks: 36_000, label: "60 min" },
];
const MODES = [
  { mode: "worker", query: "?mode=ai" },
  { mode: "main_thread", query: "?mode=ai&twinExecution=main-thread" },
];

interface Sample {
  elapsedMs: number;
  longTasks: number;
  longTaskMs: number;
  longestTaskMs: number;
  frameP95Ms: number;
  frameMaxMs: number;
  fps: number;
  lateStartup: number;
  lateSteadyPct: number;
  lateFinish: number;
  liveTicks: number;
  wallMs: number;
  heapBeforeMb: number | null;
  heapAfterMb: number | null;
  mode: string;
  workers: number;
  simulations: number;
  rssBeforeMb: number;
  rssPeakMb: number;
}

const browser = await chromium.launch({
  args: ["--disable-renderer-backgrounding", "--disable-background-timer-throttling"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.route("**/api/v1/**", (route) => route.abort("connectionrefused"));
const browserCdp = await browser.newBrowserCDPSession();

/** The renderer processes (the page and its workers). Looked up once per run: asking the browser
 * during a run would disturb the frames being measured. */
async function rendererPids(): Promise<string[]> {
  const { processInfo } = (await browserCdp.send("SystemInfo.getProcessInfo")) as {
    processInfo: { type: string; id: number }[];
  };
  return processInfo.filter((p) => p.type === "renderer").map((p) => String(p.id));
}

/** Their resident memory in MB, read with ps (outside the browser). */
function rssMb(pids: readonly string[]): number {
  if (pids.length === 0) return NaN;
  const kb = execFileSync("ps", ["-o", "rss=", "-p", pids.join(",")], { encoding: "utf8" })
    .split("\n")
    .reduce((sum, line) => sum + (Number(line.trim()) || 0), 0);
  return Math.round(kb / 1024);
}

async function startupMs(p: Page): Promise<number> {
  return p.evaluate(`new Promise((resolve, reject) => {
    const t = performance.now();
    const w = new Worker("/workers/twin-evaluation.js", { type: "module" });
    w.onmessage = () => { resolve(performance.now() - t); w.terminate(); };
    w.onerror = () => reject(new Error("worker failed to load"));
  })`) as Promise<number>;
}

async function evaluate(p: Page, horizon: number): Promise<Sample> {
  await p.getByTestId("twin-horizon").selectOption(String(horizon));
  const pids = await rendererPids();
  // Plain strings: tsx would wrap named functions in a helper the page does not have.
  await p.evaluate(`(() => {
    const mem = performance.memory;
    const b = {
      longTasks: [],
      frames: [],
      at: [],
      tick0: window.__WAREHOUSE_ONE_SIM__.state().tick,
      t0: performance.now(),
      heap0: mem ? mem.usedJSHeapSize : null,
    };
    window.__bench = b;
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) b.longTasks.push(e.duration);
    }).observe({ type: "longtask" });
    let last = performance.now();
    const frame = (t) => {
      b.frames.push(t - last);
      b.at.push(t);
      last = t;
      if (window.__bench === b) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  })()`);
  const rssBeforeMb = rssMb(pids);
  let rssPeakMb = rssBeforeMb;
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      rssPeakMb = Math.max(rssPeakMb, rssMb(pids));
      await new Promise((r) => setTimeout(r, 250));
    }
  })();
  await p.getByTestId("twin-run").click();
  await p.getByTestId("twin-run-facts").waitFor({ timeout: 240_000 });
  sampling = false;
  await sampler;
  const sample = (await p.evaluate(`(() => {
    const b = window.__bench;
    window.__bench = null;
    const facts = document.querySelector('[data-testid="twin-run-facts"]');
    const frames = [...b.frames].sort((x, y) => x - y);
    const q = (f) => frames[Math.min(frames.length - 1, Math.floor(f * frames.length))] ?? 0;
    const end = performance.now();
    const late = (from, to) => {
      const idx = b.at.map((t, i) => i).filter((i) => b.at[i] >= from && b.at[i] < to);
      const n = idx.filter((i) => b.frames[i] > 20).length;
      return { frames: idx.length, late: n };
    };
    const startup = late(b.t0, b.t0 + 1000);
    const finish = late(end - 500, end + 1);
    const steady = late(b.t0 + 1000, end - 500);
    const mem = performance.memory;
    const mb = (x) => (x === null ? null : Math.round((x / 2 ** 20) * 10) / 10);
    return {
      elapsedMs: Number(facts?.dataset.elapsedMs ?? NaN),
      mode: facts?.dataset.mode ?? "?",
      longTasks: b.longTasks.length,
      longTaskMs: Math.round(b.longTasks.reduce((x, y) => x + y, 0)),
      longestTaskMs: Math.round(Math.max(0, ...b.longTasks)),
      frameP95Ms: Math.round(q(0.95) * 10) / 10,
      frameMaxMs: Math.round(q(1) * 10) / 10,
      fps: Math.round((b.frames.length / ((end - b.t0) / 1000)) * 10) / 10,
      lateStartup: startup.late,
      lateSteadyPct: Math.round((steady.late / Math.max(1, steady.frames)) * 1000) / 10,
      lateFinish: finish.late,
      liveTicks: window.__WAREHOUSE_ONE_SIM__.state().tick - b.tick0,
      wallMs: Math.round(performance.now() - b.t0),
      heapBeforeMb: mb(b.heap0),
      heapAfterMb: mb(mem ? mem.usedJSHeapSize : null),
      workers: Number((document.body.innerText.match(/Background workers ×(\\d+)/) || [0, 0])[1]),
      simulations: Number((document.body.innerText.match(/· (\\d+) simulations ·/) || [0, NaN])[1]),
    };
  })()`)) as Omit<Sample, "rssBeforeMb" | "rssPeakMb">;
  return { ...sample, rssBeforeMb, rssPeakMb };
}

const ticksPerS = (s: Sample, horizon: number) =>
  Math.round((s.simulations * horizon) / (s.elapsedMs / 1000));

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? NaN;
const report: Record<string, unknown>[] = [];

await page.goto(`${BASE}/?mode=ai`);
await page.getByTestId("twin-context").waitFor();
const cold = await startupMs(page);
const warm = await startupMs(page);
// Reference: the same page with no evaluation running (headless frame timing is coarse).
const idle = (await page.evaluate(`new Promise((resolve) => {
  const frames = []; let last = performance.now(); const t0 = last;
  const tick0 = window.__WAREHOUSE_ONE_SIM__.state().tick;
  const frame = (t) => {
    frames.push(t - last); last = t;
    if (t - t0 < 5000) requestAnimationFrame(frame);
    else {
      frames.sort((a, b) => a - b);
      resolve({
        frame_p95_ms: Math.round(frames[Math.floor(0.95 * frames.length)] * 10) / 10,
        frame_max_ms: Math.round(frames[frames.length - 1] * 10) / 10,
        live_ticks_per_s: ((window.__WAREHOUSE_ONE_SIM__.state().tick - tick0) / (t - t0)) * 1000,
      });
    }
  };
  requestAnimationFrame(frame);
})`)) as Record<string, number>;
console.log(JSON.stringify({ mode: "idle (no evaluation)", ...idle }));
const hardwareConcurrency = await page.evaluate(() => navigator.hardwareConcurrency);
// Every configuration runs in a fresh page and context, alone: the first page is emptied so
// that its live run and animation frames do not compete with the measured one.
await page.goto("about:blank");

async function freshPage(cores?: number): Promise<Page> {
  const p = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await p.route("**/api/v1/**", (route) => route.abort("connectionrefused"));
  if (cores)
    await p.addInitScript(
      `Object.defineProperty(navigator, "hardwareConcurrency", { get: () => ${cores} })`,
    );
  return p;
}

async function runs(p: Page, query: string, horizon: number): Promise<Sample[]> {
  const samples: Sample[] = [];
  for (let i = 0; i < RUNS; i++) {
    await p.goto(`${BASE}/${query}`);
    await p.getByTestId("twin-context").waitFor();
    await p.waitForTimeout(1000);
    samples.push(await evaluate(p, horizon));
  }
  await p.close();
  return samples;
}

for (const { mode, query } of ONLY === "scaling" ? [] : MODES) {
  for (const h of HORIZONS) {
    const samples = await runs(await freshPage(), query, h.ticks);
    const row = {
      mode,
      horizon: h.label,
      runs: samples.length,
      reported_mode: samples[0]?.mode,
      elapsed_ms_median: median(samples.map((s) => s.elapsedMs)),
      elapsed_ms_min: Math.min(...samples.map((s) => s.elapsedMs)),
      long_tasks_median: median(samples.map((s) => s.longTasks)),
      long_task_ms_median: median(samples.map((s) => s.longTaskMs)),
      longest_task_ms_max: Math.max(...samples.map((s) => s.longestTaskMs)),
      frame_p95_ms_median: median(samples.map((s) => s.frameP95Ms)),
      frame_max_ms_max: Math.max(...samples.map((s) => s.frameMaxMs)),
      fps_median: median(samples.map((s) => s.fps)),
      late_frames_startup_median: median(samples.map((s) => s.lateStartup)),
      late_frames_steady_pct_median: median(samples.map((s) => s.lateSteadyPct)),
      late_frames_finish_median: median(samples.map((s) => s.lateFinish)),
      live_ticks_per_s_median: median(samples.map((s) => (s.liveTicks / s.wallMs) * 1000)),
      heap_mb_after_median: median(samples.map((s) => s.heapAfterMb ?? NaN)),
      renderer_rss_mb_before_median: median(samples.map((s) => s.rssBeforeMb)),
      renderer_rss_mb_peak_max: Math.max(...samples.map((s) => s.rssPeakMb)),
      simulations: samples[0]?.simulations,
      simulated_ticks_per_s_median: median(samples.map((s) => ticksPerS(s, h.ticks))),
    };
    report.push(row);
    console.log(JSON.stringify(row));
  }
}

// Throughput against pool size: the pool uses min(4, cores - 1) workers.
const scaling: Record<string, unknown>[] = [];
for (const cores of [2, 3, 5]) {
  const samples = await runs(await freshPage(cores), "?mode=ai", 18_000);
  const row = {
    workers: samples[0]?.workers,
    horizon: "30 min",
    runs: samples.length,
    elapsed_ms_median: median(samples.map((s) => s.elapsedMs)),
    simulated_ticks_per_s_median: median(samples.map((s) => ticksPerS(s, 18_000))),
    frame_p95_ms_median: median(samples.map((s) => s.frameP95Ms)),
    renderer_rss_mb_peak_max: Math.max(...samples.map((s) => s.rssPeakMb)),
  };
  scaling.push(row);
  console.log(JSON.stringify(row));
}

const context = {
  date: new Date().toISOString(),
  machine: `${cpus()[0]?.model ?? "?"} × ${cpus().length}`,
  os: `${platform()} ${release()} ${arch()}`,
  node: process.version,
  chromium: browser.version(),
  hardware_concurrency: hardwareConcurrency,
  worker_startup_ms: { cold: Math.round(cold), warm: Math.round(warm) },
  idle,
  scenario: "network (logistics park), optimiser budget 8, live simulation at 1×",
};
console.log(JSON.stringify(context));
mkdirSync("test-results/perf", { recursive: true });
writeFileSync(
  `test-results/perf/twin-benchmark${ONLY === "scaling" ? "-scaling" : ""}.json`,
  JSON.stringify({ context, results: report, scaling }, null, 2),
);
await browser.close();
