# Visual Design Specification

**Status:** v1.0 (Phase 0). This document governs Phase 1 (3D world) and all later UI work.
Phase 0 implements the tokens, the HUD shell and a *diagnostic* scene only. The diagnostic scene is
schematic on purpose and is not an accepted visual asset.

## 1. Direction: "Night shift control room"

WAREHOUSE ONE should feel like premium industrial software that happens to be beautiful, not like
a toy and not like a generic SaaS dashboard.

- **World:** semi-realistic, physically based materials. Brushed and galvanised steel racking,
  sealed-concrete floors with subtle wear, painted safety markings, warm sodium-to-neutral LED
  high-bay lighting. Proportions follow real equipment: standard racking bay ≈ 2.7 m wide; EUR
  pallet 1.2 × 0.8 m; counterbalance forklift ≈ 1.2 × 2.4 m.
- **Interface:** dark graphite glass panels floating over the world. Content-dense but calm.
  Numbers use a monospaced font with tabular figures.
- **Colour roles:** safety amber marks actions and attention; teal marks live data; red, amber and
  green are reserved for operational status only and never used decoratively.

### Explicitly avoid

Excess bloom, neon gradients, purple "AI" aesthetics, unlabelled 3D decoration, text under
11 px for data, unbounded drop shadows, placeholder cubes in accepted features, and colour as the
only carrier of meaning.

## 2. Design tokens (implemented in `apps/web/src/app/globals.css`)

| Token | Value | Role |
|-------|-------|------|
| `ink-950` | `#0c0f14` | App background, 3D clear colour, fog |
| `ink-900` | `#11151b` | Panel base (82% opacity + 14 px blur) |
| `ink-800` / `ink-700` | `#1a2029` / `#252d38` | Raised controls, selected segment |
| `fog-50` | `#f2f5f8` | Primary text |
| `fog-200` / `fog-400` / `fog-500` | `#c9d1db` / `#8d98a6` / `#808b99` | Secondary / labels / tertiary |
| `signal-400` | `#f5b83d` | Primary action, selection, attention |
| `data-400` / `data-300` | `#3fb8af` / `#7fe0d8` | Live data, running state |
| `ok-400` / `warn-400` / `critical-400` | `#4ade80` / `#fbbf24` / `#f87171` | Operational status only |
| `radius-panel` | 14 px | Panels; controls use 8–10 px |

**Typography:** Geist Sans for UI and Geist Mono for metrics and identifiers (SIL OFL, self-hosted
via the `geist` package, so no runtime font requests). Scale: 10/11 px for labels in uppercase with
0.08em tracking, 12–13 px for body, 18 px for inspector titles, 30 px for the hero metric.

**Contrast (computed with the WCAG 2.x formula against opaque `ink-900`):** fog-50 16.7:1,
fog-200 11.9:1, fog-400 6.3:1, fog-500 5.3:1, signal-400 10.3:1, data-300 11.8:1. Button text
`ink-950` on `signal-400` is 10.8:1. Every text token passes AA (4.5:1). In Phase 0 `fog-500` was
raised from `#6b7685` (3.97:1, failing) to `#808b99`. Panels are translucent, so an automated
in-browser contrast audit over the rendered scene is still required in Phase 1.

## 3. Layout

- The 3D viewport fills the screen and is always the primary surface.
- The HUD has **no persistent sidebar**. Panels float at the edges: brand and modes top-left,
  inspector top-right, simulation and timeline bottom-left, system and performance status bottom-right.
- Panels are `pointer-events: auto` islands over a `pointer-events: none` overlay, so empty space
  always reaches the scene.
- **Below 640 px (phones):** secondary panels (event stream, renderer stats) collapse. The
  inspector appears only on selection. No horizontal scroll (verified at 390 px in Phase 0).

## 4. Lighting and rendering targets (Phase 1)

| Aspect | Target |
|--------|--------|
| Key light | One shadow-casting directional "skylight" plus hemispheric fill, with baked or SSAO contact shadows |
| Interior | High-bay fixtures as emissive meshes; no per-fixture real-time lights beyond a small budget |
| Tone mapping | ACES Filmic or AgX, exposure tuned so the concrete floor reads mid-grey |
| Post-processing | Subtle SSAO, SMAA, very restrained bloom on emissives only. Each effect must be toggleable and justified by a before/after capture |
| Shadows | PCF soft, 2048² on desktop, 1024² on low tier |
| Draw-call budget | ≤ 150 for the standard scene (instancing for racks, pallets, boxes) |
| Adaptive quality | Tiers High / Medium / Low switch DPR, shadows and post-FX from measured frame time |

## 5. Camera

Orbit with damping, polar angle clamped above the floor (implemented in Phase 0), pan within
facility bounds, smooth zoom with distance limits. Isometric overview preset. Follow-vehicle mode
with a smoothed spring arm. Collision-aware distance so the camera never ends up inside racking.
Transitions between presets ease over 600–900 ms and respect `prefers-reduced-motion`.

## 6. Motion and feedback

UI transitions take 120–200 ms with ease-out. Selection gives an immediate highlight (amber
footprint, implemented) plus an inspector panel. Hover shows a pointer cursor and an outline
(Phase 1). Nothing pulses except the "running" indicator.

## 7. Reference benchmark

**Reference provided:** a phone screen recording, `references/ScreenRecording_10-14-2026 18-51-49_1.mp4`
(36 s, 512×1112, 30 fps), stored outside the repository. It shows a social-media post of a
third-party product branded "WareTrack". Frames were extracted and inspected in Phase 0.

**Observed in the reference:**
- Bright, low-contrast, near-white "clay" world with a lavender-grey palette and blue accents.
  Stylised low-poly trucks, pallets, forklifts, fencing and trees on a near-isometric camera.
- White card UI: KPI chips (stock on hand, trucks on site, on-time delivery %), a right-hand
  entity inspector (dock, truck, SKU details), a shipment-tracking stepper at the bottom-left, and
  a tabbed docks/forklifts/trucks table at the bottom-right.
- Smooth camera moves between overview and close-up of a selected truck with a selection box.

**What we take:** clear entity selection with a rich inspector, KPI chips that tie to the world,
a lifecycle timeline for shipments, and cinematic but purposeful camera transitions.

**How we differ:** we use our own identity (dark control-room theme, amber and teal roles, our own
brand), semi-realistic materials instead of clay, and a simulation and data layer behind every
displayed number. We do not copy their layout, branding or assets.

**Comparison status: UNVERIFIED.** The reference's 3D viewport is about 512 px wide inside a phone
recording, so fine detail (materials, aliasing, shadow quality) cannot be judged. No claim that
WAREHOUSE ONE's graphics match or surpass the reference may be made until Phase 1 produces
side-by-side captures at comparable framing. Those will be judged on the following criteria.

### Phase 1 visual acceptance checklist

1. Five fixed camera bookmarks captured at 1440×900 and 390×844: overview, dock, aisle, forklift
   close-up, inspector open.
2. No visible z-fighting, clipping, floating objects or texture stretching in any bookmark.
3. All text in HUD ≥ 11 px; data contrast passes AA (automated check).
4. Every rendered entity corresponds to simulation state (spot-check five entities against the inspector).
5. Measured FPS and p95 frame time per bookmark recorded with the GPU string.
6. Side-by-side with the reference on: entity readability, selection clarity, material quality,
   lighting depth and UI hierarchy. The reviewer records the verdict per criterion.
