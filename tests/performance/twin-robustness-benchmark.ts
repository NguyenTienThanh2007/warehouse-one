/**
 * Multi-seed robustness benchmark in the browser (Phase 6.2). Identical workload for every
 * configuration: the golden fixture snapshot (data/fixtures/twin-standby), its discovery
 * evaluation (15 simulated minutes), its recommended candidate and root seed "bench". The
 * production code runs inside the live app (AI mode, live simulation at 1×), in a fresh page per
 * configuration: twin-robustness-entry.ts is bundled with esbuild and injected; its pool's workers
 * load the app's own worker bundle. Per run it records wall time, throughput, worker utilisation
 * and peak concurrent jobs, frames and long tasks on the page's main thread, and the renderer's
 * resident memory (page and workers, read with ps). It also measures cancellation latency.
 *
 * Usage: pnpm --filter @warehouse-one/web build && (cd apps/web && pnpm exec next start -p 3100)
 *        caffeinate -i -s pnpm bench:twin-robustness [-- --url http://localhost:3100 --runs 3]
 */
import { chromium, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, cpus, loadavg, platform, release, totalmem } from "node:os";
import type { BenchRequest, BenchResult } from "./twin-robustness-entry";

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? (process.argv[i + 1] ?? fallback) : fallback;
};
const BASE = arg("url", "http://localhost:3100");
const RUNS = Number(arg("runs", "3"));

const fixtures = "data/fixtures/twin-standby";
const snapshot = JSON.parse(readFileSync(`${fixtures}/snapshot.json`, "utf8")) as unknown;
const discovery = JSON.parse(readFileSync(`${fixtures}/evaluation-recommended.json`, "utf8")) as {
  recommendation: { candidate_id: string } | null;
  options: { horizon_ticks: number };
};
const candidateId = discovery.recommendation?.candidate_id ?? "c1";

mkdirSync("test-results/perf", { recursive: true });
const bundle = "test-results/perf/twin-robustness-entry.js";
execFileSync(
  "pnpm",
  [
    "--filter",
    "@warehouse-one/web",
    "exec",
    "esbuild",
    "../../tests/performance/twin-robustness-entry.ts",
    "--bundle",
    "--format=iife",
    "--target=es2022",
    `--outfile=../../${bundle}`,
    "--log-level=warning",
  ],
  { stdio: "inherit" },
);
const code = readFileSync(bundle, "utf8");

const browser = await chromium.launch({
  args: ["--disable-renderer-backgrounding", "--disable-background-timer-throttling"],
});
const browserCdp = await browser.newBrowserCDPSession();

async function rendererPids(): Promise<string[]> {
  const { processInfo } = (await browserCdp.send("SystemInfo.getProcessInfo")) as {
    processInfo: { type: string; id: number }[];
  };
  return processInfo.filter((p) => p.type === "renderer").map((p) => String(p.id));
}
const rssMb = (pids: readonly string[]) =>
  Math.round(
    execFileSync("ps", ["-o", "rss=", "-p", pids.join(",")], { encoding: "utf8" })
      .split("\n")
      .reduce((s, l) => s + (Number(l.trim()) || 0), 0) / 1024,
  );

interface Sample extends BenchResult {
  longTasks: number;
  longTaskMs: number;
  longestTaskMs: number;
  fps: number;
  frameP95Ms: number;
  latePct: number;
  liveTicksPerS: number;
  rssBeforeMb: number;
  rssPeakMb: number;
}

async function once(
  page: Page,
  req: Omit<BenchRequest, "snapshot" | "discovery" | "candidateId" | "rootSeed">,
): Promise<Sample> {
  await page.goto(`${BASE}/?mode=ai`);
  await page.getByTestId("twin-context").waitFor();
  await page.addScriptTag({ content: code });
  await page.waitForTimeout(1000);
  const pids = await rendererPids();
  const rssBeforeMb = rssMb(pids);
  let rssPeakMb = rssBeforeMb;
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      rssPeakMb = Math.max(rssPeakMb, rssMb(pids));
      await new Promise((r) => setTimeout(r, 250));
    }
  })();
  // Plain strings: tsx would wrap named functions in a helper the page does not have.
  await page.evaluate(`(() => {
    const b = { long: [], frames: [], t0: performance.now(), tick0: window.__WAREHOUSE_ONE_SIM__.state().tick };
    window.__frames = b;
    b.po = new PerformanceObserver((l) => { for (const e of l.getEntries()) b.long.push(e.duration); });
    b.po.observe({ type: "longtask" });
    let last = performance.now();
    const f = (t) => { b.frames.push(t - last); last = t; if (window.__frames === b) requestAnimationFrame(f); };
    requestAnimationFrame(f);
  })()`);
  const result = (await page.evaluate(
    ([r, s, d, c]) =>
      (
        window as unknown as { __twinBench: { run(x: unknown): Promise<BenchResult> } }
      ).__twinBench.run({
        ...(r as object),
        snapshot: s,
        discovery: d,
        candidateId: c,
        rootSeed: "bench",
      }),
    [req, snapshot, discovery, candidateId] as const,
  )) as BenchResult;
  const frames = (await page.evaluate(`(() => {
    const b = window.__frames; window.__frames = null; b.po.disconnect();
    const secs = (performance.now() - b.t0) / 1000;
    const fr = b.frames.slice(1).sort((x, y) => x - y);
    return {
      longTasks: b.long.length,
      longTaskMs: Math.round(b.long.reduce((x, y) => x + y, 0)),
      longestTaskMs: Math.round(Math.max(0, ...b.long)),
      fps: Math.round((fr.length / secs) * 10) / 10,
      frameP95Ms: Math.round((fr[Math.floor(0.95 * fr.length)] || 0) * 10) / 10,
      latePct: Math.round((fr.filter((x) => x > 20).length / Math.max(1, fr.length)) * 1000) / 10,
      liveTicksPerS: Math.round(((window.__WAREHOUSE_ONE_SIM__.state().tick - b.tick0) / secs) * 10) / 10,
    };
  })()`)) as Omit<Sample, keyof BenchResult | "rssBeforeMb" | "rssPeakMb">;
  sampling = false;
  await sampler;
  return { ...result, ...frames, rssBeforeMb, rssPeakMb };
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? NaN;
const horizon = discovery.options.horizon_ticks;

const CONFIGS: {
  label: string;
  req: Omit<BenchRequest, "snapshot" | "discovery" | "candidateId" | "rootSeed">;
}[] = [
  { label: "single-seed optimisation (discovery), workers ×4", req: { seeds: 0, workers: 4 } },
  ...[1, 5, 10, 20, 30].map((seeds) => ({
    label: `${seeds} seed${seeds === 1 ? "" : "s"}, workers ×4`,
    req: { seeds, workers: 4 },
  })),
  { label: "20 seeds, workers ×1", req: { seeds: 20, workers: 1 } },
  { label: "20 seeds, main thread (fallback)", req: { seeds: 20, workers: 0 } },
  {
    label: "30 seeds, workers ×4, cancelled after 3 s",
    req: { seeds: 30, workers: 4, cancelAfterMs: 3_000 },
  },
];

const startedAt = new Date().toISOString();
const loadBefore = loadavg();
const rows: Record<string, unknown>[] = [];
for (const c of CONFIGS) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.route("**/api/v1/**", (route) => route.abort("connectionrefused"));
  const samples: Sample[] = [];
  for (let i = 0; i < RUNS; i++) samples.push(await once(page, c.req));
  await page.close();
  const m = (f: (s: Sample) => number) => median(samples.map(f));
  const seeds = c.req.seeds;
  const row = {
    config: c.label,
    runs: samples.length,
    verdict: samples[0]?.verdict,
    ids_identical: new Set(samples.map((s) => s.resultId)).size === 1,
    ...(c.req.cancelAfterMs === undefined
      ? {
          wall_ms_median: Math.round(m((s) => s.wallMs)),
          wall_ms_min: Math.round(Math.min(...samples.map((s) => s.wallMs))),
          per_seed_ms_median: seeds > 0 ? Math.round(m((s) => s.wallMs) / seeds) : null,
          simulated_ticks_per_s_median: Math.round(m((s) => s.ticksSimulated / (s.wallMs / 1000))),
          worker_utilisation_median:
            c.req.workers > 0 ? Math.round(m((s) => s.utilisation ?? NaN) * 100) / 100 : null,
        }
      : {
          cancel_reject_ms_median: Math.round(m((s) => s.cancel?.rejectMs ?? NaN) * 10) / 10,
          cancel_workers_quiet_ms_median: Math.round(m((s) => s.cancel?.quietMs ?? NaN)),
          cancel_workers_quiet_ms_max: Math.round(
            Math.max(...samples.map((s) => s.cancel?.quietMs ?? NaN)),
          ),
        }),
    peak_concurrent_jobs_max: Math.max(...samples.map((s) => s.peakConcurrentJobs)),
    worker_startup_ms_median:
      c.req.workers > 0 ? Math.round(m((s) => median([...s.workerStartupMs]))) : null,
    long_tasks_median: m((s) => s.longTasks),
    long_task_ms_median: m((s) => s.longTaskMs),
    longest_task_ms_max: Math.max(...samples.map((s) => s.longestTaskMs)),
    fps_median: m((s) => s.fps),
    frame_p95_ms_median: m((s) => s.frameP95Ms),
    late_frames_pct_median: m((s) => s.latePct),
    live_ticks_per_s_median: m((s) => s.liveTicksPerS),
    renderer_rss_mb_before_median: m((s) => s.rssBeforeMb),
    renderer_rss_mb_peak_max: Math.max(...samples.map((s) => s.rssPeakMb)),
  };
  rows.push(row);
  console.log(JSON.stringify(row));
}

const context = {
  started: startedAt,
  finished: new Date().toISOString(),
  machine: `${cpus()[0]?.model ?? "?"} × ${cpus().length}, ${Math.round(totalmem() / 2 ** 30)} GiB`,
  os: `${platform()} ${release()} ${arch()}`,
  node: process.version,
  chromium: browser.version(),
  load_average_before: loadBefore.map((x) => Math.round(x * 100) / 100),
  load_average_after: loadavg().map((x) => Math.round(x * 100) / 100),
  workload: `fixture snapshot ${(snapshot as { state_hash: string }).state_hash.slice(0, 12)}, candidate ${candidateId}, horizon ${horizon} ticks (${horizon / 600} simulated minutes), root seed "bench"; live app in AI mode at 1×`,
};
console.log(JSON.stringify(context));
writeFileSync(
  "test-results/perf/twin-robustness-benchmark.json",
  JSON.stringify({ context, results: rows }, null, 2),
);
await browser.close();
