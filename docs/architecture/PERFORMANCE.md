# Performance Measurement Approach

Rule: **numbers are measured, reproducible and published with their context** (hardware, browser,
GPU string, viewport, scene, sample duration). Estimates are never reported as results.

## Instruments

| Instrument | What it measures | Command |
|------------|------------------|---------|
| `packages/simulation/scripts/bench.ts` | Headless `step()` cost (mean and p95 µs/tick, ticks/s) for 100 / 300 / 1,000 locations with the synthetic workload | `pnpm bench:sim [-- --ticks N]` |
| In-app probe (`apps/web/src/lib/perf`) | Rolling 240-frame window: FPS, p50/p95/p99 frame time, long frames (> 25 ms), draw calls, triangles. Shown in the HUD and exposed read-only at `window.__WAREHOUSE_ONE_PERF__` | Always on |
| `tests/performance/render-benchmark.ts` | Drives Chromium through scene sizes (`?aisles=&bays=`), 3 s warm-up, N s sample, records the GPU string, writes JSON to `test-results/performance/` | `pnpm bench:render [-- --seconds 10 --headed]` (needs a running `next start` on :3100) |

**Pitfalls handled:** hidden or background tabs throttle `requestAnimationFrame` (we observed
~1 FPS in a hidden browser pane, which is an artifact, not a result). The benchmark disables
background throttling and records the GPU string, because CI runners without a GPU fall back to
SwiftShader. Their FPS is never compared with GPU numbers.

## Targets

| Scene | Target (Apple Silicon laptop, 1440×900 @2x) |
|-------|---------------------------------------------|
| Standard scene | 60 FPS, p95 ≤ 20 ms, < 1% long frames |
| 300 entities | ≥ 55 FPS, p95 ≤ 25 ms |
| 1,000 entities | ≥ 45 FPS on the High tier; adaptive quality must keep ≥ 30 FPS on the Low tier |
| Simulation | `step()` p95 well under 1 ms at 1,000 entities, so the sim never dominates a 16.7 ms frame |

## Phase 0 results (2026-10-20)

**Machine:** Apple M2, 8 GB, macOS 26.6.2, Node 24.16.0.

### Simulation (`pnpm bench:sim`, 2,000 ticks after 200 warm-up)

| Layout | mean µs/tick | p95 µs/tick | ticks/s |
|--------|-------------:|------------:|--------:|
| 100 locations | 5.9 | 14.6 | 168,642 |
| 300 locations | 11.1 | 31.9 | 90,079 |
| 1,000 locations | 16.9 | 45.0 | 59,148 |

Phase 0 simulates inventory only, so these figures do not predict Phase 2 cost.

### Renderer (`pnpm bench:render -- --seconds 8`)

Chromium 153.0.8010.12 headless, GPU `ANGLE (Apple, ANGLE Metal Renderer: Apple M2)`, 1440×900 @2x,
**Phase 0 diagnostic scene** (2 instanced meshes + floor + grid, 5 draw calls).

| Scene | FPS | p50 ms | p95 ms | p99 ms | long frames | draws | tris |
|-------|----:|-------:|-------:|-------:|------------:|------:|-----:|
| demo (24 locations) | 59.8 | 16.7 | 18.6 | 20.4 | 1 | 5 | 868 |
| 100 locations | 59.0 | 16.7 | 18.8 | 25.0 | 2 | 5 | 3,604 |
| 300 locations | 60.0 | 16.7 | 18.9 | 19.7 | 0 | 5 | 10,804 |
| 1,000 locations | 60.0 | 16.6 | 21.2 | 22.4 | 0 | 5 | 36,004 |

**Interpretation:** the renderer holds the 60 Hz vsync cap with this schematic scene. That
validates the measurement pipeline and the instancing path. It is **not** evidence about Phase 1
visual quality or performance, which will have far more geometry, materials and shadow casters.
