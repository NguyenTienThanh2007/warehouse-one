/**
 * Where do animation frames go while a twin evaluation runs? (Phase 6.1 follow-up.) Opens AI mode
 * on the production build and records 8-second windows under controlled variations, so each
 * suspect can be switched on and off:
 *   - the live simulation (running or paused),
 *   - CPU contention alone (busy-loop workers that send no messages),
 *   - the real worker evaluation, with all, a quarter or none of its progress messages reaching
 *     the page,
 *   - the evaluation on the main thread.
 * Per window it reports animation-frame intervals, long tasks, main-thread time from Chromium's
 * own counters (script, style, layout), worker message counts and the main-thread time spent
 * sending and handling them (handler plus the React work it schedules in microtasks), and DOM
 * mutations (a proxy for React commits).
 *
 * Usage: pnpm --filter @warehouse-one/web build && (cd apps/web && pnpm exec next start -p 3100)
 *        pnpm bench:twin-frames [-- --url http://localhost:3100 --runs 3]
 */
import { chromium, type CDPSession, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? (process.argv[i + 1] ?? fallback) : fallback;
};
const BASE = arg("url", "http://localhost:3100");
const WINDOW_MS = Number(arg("window", "8000"));
const RUNS = Number(arg("runs", "2"));

// Wraps Worker before the app loads: times postMessage (the structured clone of what is sent)
// and each message handler including the microtasks it queues (React flushes store updates
// there), counts messages by type, and can drop progress messages before the pool sees them.
const INSTRUMENT = `(() => {
  const W = window.Worker;
  const s = { posts: 0, postMs: 0, postChars: 0, msgs: {}, handleMs: 0, dropProgress: false, keepEvery: 1, seen: 0 };
  window.__wstats = s;
  class Instrumented extends W {
    postMessage(m, t) {
      const t0 = performance.now();
      super.postMessage(m, t);
      s.postMs += performance.now() - t0;
      s.posts += 1;
      try { s.postChars += JSON.stringify(m).length; } catch {}
    }
    set onmessage(fn) {
      this.__fn = fn;
      super.onmessage = fn && ((e) => {
        const t0 = performance.now();
        const type = e.data && e.data.type;
        s.msgs[type] = (s.msgs[type] || 0) + 1;
        if (type === "progress" && (s.dropProgress || s.seen++ % s.keepEvery !== 0)) return;
        fn.call(this, e);
        queueMicrotask(() => { s.handleMs += performance.now() - t0; });
      });
    }
    get onmessage() { return this.__fn; }
  }
  window.Worker = Instrumented;
})()`;

const START_WINDOW = `(() => {
  const b = { frames: [], long: [], mutations: 0, t0: performance.now() };
  const ws = window.__wstats;
  Object.assign(ws, { posts: 0, postMs: 0, postChars: 0, msgs: {}, handleMs: 0 });
  b.tick0 = window.__WAREHOUSE_ONE_SIM__.state().tick;
  b.po = new PerformanceObserver((l) => { for (const e of l.getEntries()) b.long.push(e.duration); });
  b.po.observe({ type: "longtask" });
  b.mo = new MutationObserver((l) => { b.mutations += l.length; });
  b.mo.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
  let last = performance.now();
  const f = (t) => { b.frames.push(t - last); last = t; if (window.__win === b) requestAnimationFrame(f); };
  requestAnimationFrame(f);
  window.__win = b;
})()`;

const END_WINDOW = `(() => {
  const b = window.__win; window.__win = null; b.po.disconnect(); b.mo.disconnect();
  const secs = (performance.now() - b.t0) / 1000;
  const fr = b.frames.slice(1).sort((x, y) => x - y);
  const q = (p) => Math.round((fr[Math.min(fr.length - 1, Math.floor(p * fr.length))] || 0) * 10) / 10;
  const ws = window.__wstats;
  return {
    seconds: Math.round(secs * 10) / 10,
    fps: Math.round((fr.length / secs) * 10) / 10,
    frame_p50_ms: q(0.5), frame_p95_ms: q(0.95), frame_p99_ms: q(0.99), frame_max_ms: q(1),
    frames_over_20ms_pct: Math.round((fr.filter((x) => x > 20).length / Math.max(1, fr.length)) * 1000) / 10,
    long_tasks: b.long.length,
    long_task_ms: Math.round(b.long.reduce((x, y) => x + y, 0)),
    worker_posts: ws.posts,
    post_ms: Math.round(ws.postMs * 10) / 10,
    post_kb: Math.round(ws.postChars / 1024),
    worker_msgs: ws.msgs,
    handle_ms: Math.round(ws.handleMs),
    dom_mutations_per_s: Math.round(b.mutations / secs),
    live_ticks_per_s: Math.round(((window.__WAREHOUSE_ONE_SIM__.state().tick - b.tick0) / secs) * 10) / 10,
  };
})()`;

// N workers spinning for the window, sending nothing: pure CPU contention.
const busyWorkers = (n: number, ms: number) => `(() => {
  const src = "const end = performance.now() + ${ms}; while (performance.now() < end) {} postMessage('done');";
  const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
  window.__busy = Array.from({ length: ${n} }, () => new (Object.getPrototypeOf(window.Worker))(url));
})()`;

async function metrics(cdp: CDPSession): Promise<Record<string, number>> {
  const { metrics: m } = (await cdp.send("Performance.getMetrics")) as {
    metrics: { name: string; value: number }[];
  };
  return Object.fromEntries(m.map((x) => [x.name, x.value]));
}

async function measure(page: Page, cdp: CDPSession, label: string, setup: () => Promise<void>) {
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < RUNS; i++) {
    await page.goto(`${BASE}/?mode=ai`);
    await page.getByTestId("twin-context").waitFor();
    await page.waitForTimeout(1500);
    await setup();
    const before = await metrics(cdp);
    await page.evaluate(START_WINDOW);
    await page.waitForTimeout(WINDOW_MS);
    const row = (await page.evaluate(END_WINDOW)) as Record<string, unknown>;
    const after = await metrics(cdp);
    const per = (k: string) =>
      Math.round((((after[k] ?? 0) - (before[k] ?? 0)) / (row.seconds as number)) * 1000);
    rows.push({
      ...row,
      main_task_ms_per_s: per("TaskDuration"),
      script_ms_per_s: per("ScriptDuration"),
      style_ms_per_s: per("RecalcStyleDuration"),
      layout_ms_per_s: per("LayoutDuration"),
    });
  }
  const pick = (k: string) => rows.map((r) => r[k]);
  const out = { experiment: label, runs: rows };
  console.log(
    JSON.stringify({
      experiment: label,
      fps: pick("fps"),
      frame_p95_ms: pick("frame_p95_ms"),
      frames_over_20ms_pct: pick("frames_over_20ms_pct"),
      main_task_ms_per_s: pick("main_task_ms_per_s"),
      script_ms_per_s: pick("script_ms_per_s"),
      handle_ms: pick("handle_ms"),
      msgs: pick("worker_msgs"),
      dom_mutations_per_s: pick("dom_mutations_per_s"),
    }),
  );
  return out;
}

const browser = await chromium.launch({
  args: ["--disable-renderer-backgrounding", "--disable-background-timer-throttling"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.route("**/api/v1/**", (route) => route.abort("connectionrefused"));
await page.addInitScript(INSTRUMENT);
const cdp = await page.context().newCDPSession(page);
await cdp.send("Performance.enable");

const pause = async () => {
  await page.keyboard.press("Space");
  await page.waitForTimeout(300);
};
const evaluate = async (
  opts: { mainThread?: boolean; dropProgress?: boolean; keepEvery?: number } = {},
) => {
  if (opts.mainThread)
    await page.evaluate(`history.replaceState(null, "", "/?mode=ai&twinExecution=main-thread")`);
  if (opts.dropProgress) await page.evaluate(`window.__wstats.dropProgress = true`);
  if (opts.keepEvery) await page.evaluate(`window.__wstats.keepEvery = ${opts.keepEvery}`);
  await page.getByTestId("twin-horizon").selectOption("36000");
  await page.getByTestId("twin-run").click();
  // Measure the steady state: past worker start-up and the first batch dispatch.
  await page.waitForTimeout(1000);
};

const results = [
  await measure(page, cdp, "idle · live sim running", async () => {}),
  await measure(page, cdp, "idle · live sim paused", pause),
  await measure(page, cdp, "4 busy workers, no messages · sim running", () =>
    page.evaluate(busyWorkers(4, WINDOW_MS + 2000)),
  ),
  await measure(page, cdp, "7 busy workers, no messages · sim running", () =>
    page.evaluate(busyWorkers(7, WINDOW_MS + 2000)),
  ),
  await measure(page, cdp, "evaluation · workers · sim running", () => evaluate()),
  await measure(page, cdp, "evaluation · workers · sim paused", async () => {
    await pause();
    await evaluate();
  }),
  await measure(page, cdp, "evaluation · workers · 1 progress message in 4 kept", () =>
    evaluate({ keepEvery: 4 }),
  ),
  await measure(page, cdp, "evaluation · workers · progress messages dropped", () =>
    evaluate({ dropProgress: true }),
  ),
  await measure(page, cdp, "evaluation · main thread · sim running", () =>
    evaluate({ mainThread: true }),
  ),
];

const context = {
  date: new Date().toISOString(),
  machine: `${cpus()[0]?.model ?? "?"} × ${cpus().length}`,
  chromium: browser.version(),
  window_ms: WINDOW_MS,
  webgl_renderer: await page.evaluate(`(() => {
    const gl = document.createElement("canvas").getContext("webgl");
    const ext = gl && gl.getExtension("WEBGL_debug_renderer_info");
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "unknown";
  })()`),
};
console.log(JSON.stringify(context));
mkdirSync("test-results/perf", { recursive: true });
writeFileSync(
  "test-results/perf/twin-frame-diagnosis.json",
  JSON.stringify({ context, results }, null, 2),
);
await browser.close();
