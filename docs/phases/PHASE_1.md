# Phase 1 — Premium 3D World

**Branch:** `feature/p1-3d-world` (from `main` @ `c512733`) · **PR:** draft, see `docs/PROJECT_STATUS.md`
**Status:** ready for owner review. CI history and the flaky-test fix are in §7. The result for the final head commit is reported on PR #2. Two visual-checklist items remain NOT RUN (§6).

## 1. Starting point

Phase 0 rendered a schematic diagnostic scene (instanced boxes on tiles) driven by inventory. The
simulation knew only storage locations, their floor positions and per-location inventory: no
building, racking dimensions, docks or vehicles. Phase 1 had to add those **without letting the
renderer invent operational data**.

## 2. Approach

1. **Facility master data in the simulation config** (DEC-014). `SimulationConfig.facility`
   (optional) describes the building, the site, the racking spec, docks and parked equipment.
   `LocationConfig.yaw` gives each bay's pick-face orientation. Neither affects simulation rules.
   Validation rejects bays outside the building, duplicate IDs, unknown equipment kinds and
   dangling dock references. The Phase 0 contracts, golden fixture and state hashes are unchanged.
2. **Scenario registry** (`packages/simulation/src/scenarios/warehouse.ts`): `showcase` (6 rows ×
   14 bays, 672 positions, ~55% opening stock), `empty`, and `bench-100/300/1000` (exactly that
   many pallets). Opening stock is a list of `inventory.receive` commands applied at tick 1 through
   `submit` + `step`, so it is validated, logged and replayable like any operator action.
3. **Pure derivation layer** (`apps/web/src/world/derive.ts`): config + state → rack parts, pallet
   instances, pick volumes and counts. One pallet instance per stored unit. Beam-level placement is
   a deterministic display convention (bottom-up, SKU order) because inventory is tracked per bay
   until Phase 2 (DEC-015). The inspector says so.
4. **Procedural assets at real scale** (`world/geometry.ts`, `world/materials.ts`), instanced per
   material. No third-party assets (`docs/design/ASSETS.md`).
5. **Rendering** (`components/world/*`): dollhouse cutaway (camera-facing walls drop to a knee
   wall), yard 1.2 m below the floor at dock height, soft-shadowed key light + sky fill +
   Lightformer environment, N8AO + SMAA + AgX tone mapping, distance-adaptive fog.
6. **Camera** (`camera-rig.tsx`, `world/framing.ts`): camera-controls with damping; presets
   Overview / Docks / Aisle / Plan / Focus selection; framing solved numerically so the whole
   facility fits any aspect ratio (portrait looks along the long axis); polar angle ≤ 86° so the
   camera never goes under the floor; target bounded to the site.
7. **Interaction**: invisible pick volumes (one per bay, vehicle and dock) make picking precise and
   cheap. Hover and selection outlines. Click, double-click to fly, keyboard shortcuts
   (O/D/A/T/F, Esc), and a keyboard-accessible "Jump to location" picker.
8. **States**: loading overlay until the first frames render; error boundary + `webglcontextlost`
   handler with a recoverable error state (the simulation keeps running); empty-stock and
   no-locations states; live KPI chips (stock, utilisation, bays in use, fleet).
9. **Quality tiers** High / Medium / Low with Auto mode: drei `PerformanceMonitor` steps down on
   sustained low FPS, and software rasterisers (SwiftShader, llvmpipe, Basic Render Driver) start
   on Low immediately (DEC-017). High caps the device pixel ratio at 1.5 (DEC-016, measured).

## 3. Acceptance criteria

| Criterion | Result | Evidence |
|-----------|--------|----------|
| Scene renders correctly | **PASS** | 10 bookmark captures (§5); e2e "renders … without console errors" |
| Camera works smoothly | **PASS** | Damped camera-controls; preset transitions; e2e "camera presets produce distinct, sensible poses"; framing unit tests at 4 aspect ratios |
| Objects are selectable | **PASS** | e2e: click forklift → equipment inspector; click bay → live occupancy; keyboard picker → selection + camera flight |
| No obvious geometry clipping | **PASS** (reviewed) | Bookmark review §6. The truck rear compresses the dock-shelter foam by 0.15 m, which is intentional |
| Desktop browser flows work | **PASS** | 18/18 Playwright tests on the production build (GPU), and 18/18 with SwiftShader under `CI=1` |
| Screenshots are captured | **PASS** | `evidence/phase-1/*.jpg`, reproducible with `pnpm capture:bookmarks` |
| Measured FPS is reported | **PASS** | §4 and `evidence/phase-1/benchmarks/*.json` (two runs) |
| Visual quality reviewed against documented targets | **PARTIAL** | §6: checklist items 1, 2, 3a, 4 and 6 done. **3b (live-scene contrast audit) and 5 (per-bookmark FPS) NOT RUN.** The reference comparison is limited by the reference's resolution |
| Rendering does not invent operational data | **PASS** | Unit tests (pallets ≡ inventory, no instance for empty bays, no docks or vehicles without facility data) + e2e (rendered pallets = KPI stock, before and after the simulation runs; bench scenarios render exactly 100/300/1,000) |
| Loading, error and empty states | **PASS** | e2e: WebGL-unavailable error state; empty scenario state + recovery; loading overlay gate (`data-world-status`) |
| Responsive with sensible mobile framing | **PASS** | e2e at 390×844: every bay on screen, no horizontal scroll; mobile captures |
| Performance at 100 / 300 / 1,000 rendered entities | **PASS** | §4 |

## 4. Performance (Apple M2, 8 GB, macOS 26.6.2; Chromium 153 headless, ANGLE Metal; 1440×900 @2x; overview camera; simulation running)

Entities = pallets (state-driven) + 6 parked vehicles. Two runs, 10 s samples after 3 s warm-up.

| Scene | Tier | FPS run 1 / 2 | p95 ms run 1 / 2 | Long frames (>25 ms) | Draw calls | Triangles* |
|-------|------|---------------|------------------|---------------------|-----------:|-----------:|
| bench-100 | High | 60.0 / 58.8 | 18.0 / 18.0 | 0 / 1 | 106 | 117,875 |
| bench-300 | High | 60.0 / 60.0 | 18.7 / 18.7 | 0 / 0 | 112 | 396,587 |
| bench-1000 | High | 60.0 / 60.0 | 20.6 / 20.1 | 0 / 0 | 120 | 1,272,203 |
| bench-1000 | Medium | 60.0 / 60.0 | 20.4 / 20.4 | 0 / 0 | 106 | 1,272,173 |
| bench-1000 | Low | 60.0 / 60.0 | 20.8 / 20.5 | 0 / 0 | 56 | 639,386 |
| showcase (399 pallets) | High | 60.0 / 60.0 | 19.1 / 19.1 | 0 / 0 | 116 | 491,843 |

\* Per frame, including the shadow-map pass (which roughly doubles geometry on the High and Medium tiers).

**Measured, not assumed:**
- The first High-tier measurement used DPR up to 2 and ran at **42–44 FPS (p95 26–28.5 ms)** at
  every size, so it was fill-rate-bound. Capping High at DPR 1.5 gave the table above (DEC-016).
- Rounded-edge cartons and beams first produced **2.84 M triangles** for the showcase. Plain boxes
  for small parts brought it to **489 K** with no visible difference at viewing distance. Asset
  triangle budgets are now unit-tested.
- 60 FPS is the display's vsync cap: the GPU has headroom we did not measure (no uncapped runs).

Simulation throughput is unchanged from Phase 0 (`pnpm bench:sim`: 17.4 µs/tick mean at 1,000 locations).

## 5. Evidence

- **Bookmarks** (`evidence/phase-1/`), desktop 1440×900 and phone 390×844: overview, docks, aisle,
  forklift close-up, inspector open. Simulation paused after load; `?quality=high`.
- **Benchmarks:** `evidence/phase-1/benchmarks/render-*.json` (two runs).
- **Tests:** see §7.

## 6. Visual review (against `docs/design/VISUAL_DESIGN_SPEC.md` §7)

| # | Checklist item | Status | Notes |
|---|----------------|--------|-------|
| 1 | Five bookmarks at 1440×900 and 390×844 | **DONE** | 10 captures in `evidence/phase-1/` |
| 2 | No z-fighting, clipping, floating objects or stretched textures | **DONE** (manual review) | None observed in the 10 captures. Markings use polygon offset |
| 3a | All HUD text ≥ 11 px | **DONE** | Seven 10 px instances raised to 11 px. Spec rule made explicit (visual spec §2) |
| 3b | AA contrast over the live scene (automated) | **NOT RUN** | Only the token ratios against opaque `ink-900` are computed (Phase 0, all ≥ 4.5:1). Panels are translucent, so text over bright scene areas is unverified |
| 4 | Rendered entities correspond to state | **DONE** | Automated (unit + e2e) and spot-checked: `loc-05-007` shows 7 cold-chain containers, matching the inspector's 7/8 |
| 5 | FPS and p95 per bookmark with GPU string | **NOT RUN** | Measured per **scenario** at the overview camera only (§4). The FPS values visible in the bookmark screenshots' HUD are not a measurement (short window, no warm-up control) |
| 6 | Side-by-side with the reference | **DONE** (limited) | See below; resolution-limited, no superiority claim |

**Reference comparison** (the "WareTrack" clip described in the visual spec §7; its viewport is
about 512 px wide). Judged on the agreed criteria:
- **Entity readability:** comparable. Pallet types, racking, vehicles and docks are identifiable in
  both. Ours shows far more stock (hundreds of pallets) and real rack structure.
- **Selection clarity:** comparable. Both outline the selection and show an inspector. Ours adds
  floor footprints and camera flight.
- **Material quality:** a different style, not directly comparable. The reference is stylised
  "clay"; ours uses PBR metals, wood and plastics with AO.
- **Lighting depth:** ours has directional shadows and AO; the reference's flat, bright lighting
  reads cleaner at a glance.
- **UI hierarchy:** comparable density. The reference has richer operational widgets (shipment
  timeline, dock tables) that we deliberately leave to Phases 2–4, when real data backs them.

**Verdict:** we do **not** claim to surpass the reference. At its resolution, only composition-level
comparison is possible.

## 7. Quality gates

| Gate | Result | Detail |
|------|--------|--------|
| Typecheck | PASS | contracts, simulation, web, tests |
| Lint / format | PASS | ESLint `--max-warnings 0`, Prettier, ruff |
| Unit tests | PASS | TS **104** (contracts 14, simulation 51, web 39); Python 20 |
| Integration | PASS | Python vs PostgreSQL 18 (2) |
| Browser e2e | PASS | **18/18** on GPU; **18/18** under `CI=1` with SwiftShader (no retries needed) |
| Production build | PASS | `next build` |
| Regression | PASS | Phase 0 golden fixture byte-identical; schema drift tests |
| Security | PASS (scope) | No new endpoints. URL parameters are allow-listed (`scenario`, `quality`). Scene debug hooks are read-only |
| Performance | PASS | §4 |
| GitHub Actions | PASS (with one flake found and fixed) | Run 39421534969 on `8de7aeb`: all 4 jobs green, e2e 18/18 with no retries (10.1 min). Run 39423216613 on `f8ed81c` (docs-only change): green, but e2e reported **1 flaky test**, "camera presets produce distinct, sensible poses", which failed once (camera still at the previous preset) and passed on CI's single retry. See "Flaky test fix" below |

**Flaky test fix.** The camera-preset test slept a fixed 1.8 s per transition. Under SwiftShader a
frame can take longer than that, so it read the pose mid-transition. A first attempt (polling until
two pose samples agree) still failed 2/5 locally under `CI=1`. Samples can agree simply because no
frame rendered between them. Final fix: the camera rig publishes camera-controls `wake`/`rest`
events through the read-only scene hook, and the test waits for a new `rest` after each click.
Evidence after the fix, all with retries disabled: camera test 5/5 under `CI=1` (SwiftShader), full
suite 18/18 under `CI=1`, and full suite twice on the GPU (36/36).

## 8. Known limitations

1. Vehicles and docks are **static master data**: no tasks, movement, door cycles, arrivals or
   utilisation until Phase 2. The inspector labels them "Parked".
2. Pallet beam levels are a display convention, not tracked state (DEC-015).
3. With the dollhouse cutaway, the dock shelters stand free when the dock wall is cut away.
4. No camera collision with racking. The camera is limited by the polar clamp, minimum distance
   and site bounds only, so it can pass through racks when the user dollies into them.
5. Follow-vehicle mode is deferred to Phase 2 (nothing moves yet).
6. On very slow devices the simulation shares the main thread with rendering. Phase 2 evaluates a
   Web Worker.
7. Not yet done: an in-browser contrast audit, per-bookmark FPS, and uncapped (non-vsync) GPU timing.
8. A `THREE.Clock` deprecation warning comes from React Three Fiber internals (not our code).
9. CI e2e duration grew to 10.1 min (from about 1.7 min in Phase 0) because the GPU-less runners render with SwiftShader. Still well within the 20 min job timeout; Phase 2 should watch this.

## 9. Handoff to Phase 2

- Promote equipment from `facility` master data to stateful aggregates (position, task, battery)
  and add per-pallet location tracking. Then `derivePallets` reads real slots and the display
  convention is retired.
- Animate vehicles by interpolating between fixed ticks in the renderer only.
- Keep `bench-*` scenarios and the e2e count-equality tests green as entity systems are added.
