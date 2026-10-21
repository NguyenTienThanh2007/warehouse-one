"use client";

/**
 * Materials and procedural canvas textures (browser only). Created lazily once per page and shared
 * by all meshes so material count — and shader programs — stay small.
 */
import {
  CanvasTexture,
  Color,
  DoubleSide,
  MeshStandardMaterial,
  RepeatWrapping,
  SRGBColorSpace,
  type Texture,
} from "three";
import type { FacilityConfig, SimulationConfig } from "@warehouse-one/simulation";
import { rackRows, type CargoArchetype } from "./derive";

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("2D canvas unavailable");
  return [c, ctx];
}

/** Deterministic pseudo-random sequence for texture synthesis (not simulation randomness). */
function prng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Mottled surface: soft blotches plus fine grain, tileable enough at the repeat scales used. */
function surfaceTexture(base: string, spread: number, seed: number, size = 512): CanvasTexture {
  const [c, ctx] = canvas(size, size);
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);
  const rnd = prng(seed);
  for (let i = 0; i < 260; i++) {
    const x = rnd() * size;
    const y = rnd() * size;
    const r = 8 + rnd() * 60;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    const light = rnd() > 0.5;
    g.addColorStop(
      0,
      light ? `rgba(255,255,255,${spread * rnd()})` : `rgba(0,0,0,${spread * rnd()})`,
    );
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  const img = ctx.getImageData(0, 0, size, size);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (rnd() - 0.5) * 18;
    img.data[i] = (img.data[i] ?? 0) + n;
    img.data[i + 1] = (img.data[i + 1] ?? 0) + n;
    img.data[i + 2] = (img.data[i + 2] ?? 0) + n;
  }
  ctx.putImageData(img, 0, 0);
  const t = new CanvasTexture(c);
  t.wrapS = t.wrapT = RepeatWrapping;
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function claddingTexture(): CanvasTexture {
  const [c, ctx] = canvas(256, 64);
  ctx.fillStyle = "#c9ced4";
  ctx.fillRect(0, 0, 256, 64);
  for (let x = 0; x < 256; x += 32) {
    const g = ctx.createLinearGradient(x, 0, x + 32, 0);
    g.addColorStop(0, "rgba(0,0,0,0.18)");
    g.addColorStop(0.15, "rgba(255,255,255,0.12)");
    g.addColorStop(0.5, "rgba(0,0,0,0.02)");
    g.addColorStop(1, "rgba(0,0,0,0.12)");
    ctx.fillStyle = g;
    ctx.fillRect(x, 0, 32, 64);
  }
  const t = new CanvasTexture(c);
  t.wrapS = t.wrapT = RepeatWrapping;
  t.colorSpace = SRGBColorSpace;
  return t;
}

export interface WorldMaterials {
  floor: MeshStandardMaterial;
  ground: MeshStandardMaterial;
  yard: MeshStandardMaterial;
  plinth: MeshStandardMaterial;
  wall: MeshStandardMaterial;
  wallInner: MeshStandardMaterial;
  column: MeshStandardMaterial;
  rackPost: MeshStandardMaterial;
  rackBeam: MeshStandardMaterial;
  guard: MeshStandardMaterial;
  pallet: MeshStandardMaterial;
  cargo: Record<CargoArchetype, MeshStandardMaterial>;
  vehicle: {
    forkliftBody: MeshStandardMaterial;
    truckBody: MeshStandardMaterial;
    dark: MeshStandardMaterial;
    steel: MeshStandardMaterial;
    tyre: MeshStandardMaterial;
    glass: MeshStandardMaterial;
  };
  dockDoor: MeshStandardMaterial;
  /** Dock status lights above the doors: free (green) or holding a truck (amber). */
  dockLight: { free: MeshStandardMaterial; occupied: MeshStandardMaterial };
  dockSeal: MeshStandardMaterial;
  bumper: MeshStandardMaterial;
  hazard: MeshStandardMaterial;
}

let cached: WorldMaterials | null = null;

const std = (
  color: string,
  roughness: number,
  metalness = 0,
  extra: Partial<MeshStandardMaterial> = {},
) =>
  Object.assign(new MeshStandardMaterial({ color: new Color(color), roughness, metalness }), extra);

export function worldMaterials(): WorldMaterials {
  if (cached) return cached;
  const concrete = surfaceTexture("#a39f97", 0.08, 11);
  concrete.repeat.set(10, 10);
  const asphalt = surfaceTexture("#2c2f34", 0.1, 23);
  asphalt.repeat.set(14, 14);
  const cladding = claddingTexture();
  cladding.repeat.set(30, 1);
  cached = {
    floor: std("#ffffff", 0.72, 0, { map: concrete }),
    ground: std("#0a0d10", 1),
    yard: std("#ffffff", 0.92, 0, { map: asphalt }),
    plinth: std("#7b7e82", 0.9),
    wall: std("#ffffff", 0.5, 0.35, { map: cladding }),
    wallInner: std("#dfe3e8", 0.7, 0.1),
    column: std("#3b434d", 0.55, 0.6),
    rackPost: std("#2c5f93", 0.42, 0.55),
    rackBeam: std("#e2672a", 0.4, 0.35),
    guard: std("#f2c230", 0.5, 0.1),
    pallet: std("#ffffff", 0.88),
    cargo: {
      cartons: std("#ffffff", 0.82),
      "cold-chain": std("#ffffff", 0.42, 0.05),
      "bulk-bag": std("#ffffff", 0.95),
      electronics: std("#ffffff", 0.7),
    },
    vehicle: {
      forkliftBody: std("#f0b13a", 0.42, 0.2),
      truckBody: std("#eef1f4", 0.38, 0.15),
      dark: std("#24282e", 0.6, 0.4),
      steel: std("#8b939d", 0.32, 0.85),
      tyre: std("#141619", 0.88),
      glass: std("#1a2633", 0.08, 0.6),
    },
    dockDoor: std("#b9c1ca", 0.45, 0.4),
    dockLight: {
      free: std("#2fbf71", 0.4, 0, { emissive: new Color("#2fbf71"), emissiveIntensity: 1.6 }),
      occupied: std("#f5a623", 0.4, 0, { emissive: new Color("#f5a623"), emissiveIntensity: 1.6 }),
    },
    dockSeal: std("#1e2227", 0.95),
    bumper: std("#101113", 0.9),
    hazard: std("#f2c230", 0.5, 0.1),
  };
  return cached;
}

/** Base albedo per cargo type, applied as instance colour with small per-unit variation. */
export const CARGO_COLOR: Record<CargoArchetype, string> = {
  cartons: "#b98d5c",
  "cold-chain": "#e9eef3",
  "bulk-bag": "#d9cdb0",
  electronics: "#4b525c",
};
export const PALLET_COLOR = "#b4915f";

// ---------------------------------------------------------------------------------------------
// Floor markings: one canvas texture covering the building floor, derived from facility data.

const YELLOW = "rgba(242, 194, 48, 0.95)";
const WHITE = "rgba(236, 240, 244, 0.85)";

export function floorMarkingsTexture(
  config: SimulationConfig,
  f: FacilityConfig,
): { texture: Texture; width: number; depth: number } {
  const { min, max } = f.building;
  const width = max.x - min.x;
  const depth = max.z - min.z;
  const ppm = Math.min(40, 3800 / Math.max(width, depth));
  const [c, ctx] = canvas(Math.round(width * ppm), Math.round(depth * ppm));
  const X = (x: number) => (x - min.x) * ppm;
  const Z = (z: number) => (z - min.z) * ppm;

  // Slab saw-cut joints every 6 m.
  ctx.strokeStyle = "rgba(40,42,46,0.35)";
  ctx.lineWidth = Math.max(1, ppm * 0.02);
  for (let x = Math.ceil(min.x / 6) * 6; x < max.x; x += 6) line(ctx, X(x), 0, X(x), c.height);
  for (let z = Math.ceil(min.z / 6) * 6; z < max.z; z += 6) line(ctx, 0, Z(z), c.width, Z(z));

  // Aisle edge lines in front of every pick face, and row labels at both ends.
  const rack = f.rack;
  ctx.lineWidth = 0.1 * ppm;
  rackRows(config).forEach((row, i) => {
    const first = row.locations[0];
    const last = row.locations.at(-1);
    if (!first || !last) return;
    const yaw = row.yaw;
    const nx = Math.sin(yaw);
    const nz = Math.cos(yaw);
    const off = rack.depth / 2 + 0.25;
    const ax = Math.cos(yaw);
    const az = -Math.sin(yaw);
    const ext = rack.bay_width / 2 + 0.3;
    const p0 = {
      x: first.position.x - ax * ext + nx * off,
      z: first.position.z - az * ext + nz * off,
    };
    const p1 = {
      x: last.position.x + ax * ext + nx * off,
      z: last.position.z + az * ext + nz * off,
    };
    ctx.strokeStyle = YELLOW;
    line(ctx, X(p0.x), Z(p0.z), X(p1.x), Z(p1.z));
    const label = `ROW ${String.fromCharCode(65 + (i % 26))}`;
    ctx.fillStyle = WHITE;
    ctx.font = `700 ${Math.round(0.55 * ppm)}px ui-sans-serif, system-ui, -apple-system, Helvetica, Arial`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const [loc, dir] of [
      [first, -1],
      [last, 1],
    ] as const) {
      const lx = loc.position.x + ax * dir * (ext + 1.4);
      const lz = loc.position.z + az * dir * (ext + 1.4);
      ctx.fillText(label, X(lx), Z(lz));
    }
  });

  // Staging lanes in front of each dock door.
  for (const d of f.docks) {
    const laneW = 3.2;
    const laneL = 9;
    ctx.strokeStyle = WHITE;
    ctx.lineWidth = 0.08 * ppm;
    ctx.strokeRect(
      X(d.position.x - laneW / 2),
      Z(d.position.z - laneL),
      laneW * ppm,
      (laneL - 0.6) * ppm,
    );
    ctx.fillStyle = WHITE;
    ctx.font = `700 ${Math.round(0.9 * ppm)}px ui-sans-serif, system-ui, -apple-system, Helvetica, Arial`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(d.id.replace("dock-", ""), X(d.position.x), Z(d.position.z - laneL + 1.4));
  }

  // Charging area for the parked fleet.
  const fleet = f.equipment.filter((e) => e.kind !== "truck");
  if (fleet.length) {
    const xs = fleet.map((e) => e.position.x);
    const zs = fleet.map((e) => e.position.z);
    const x0 = Math.min(...xs) - 2.2;
    const x1 = Math.max(...xs) + 2.2;
    const z0 = Math.min(...zs) - 1.6;
    const z1 = Math.max(...zs) + 1.6;
    ctx.fillStyle = "rgba(63, 184, 175, 0.16)";
    ctx.fillRect(X(x0), Z(z0), (x1 - x0) * ppm, (z1 - z0) * ppm);
    ctx.strokeStyle = "rgba(63, 184, 175, 0.9)";
    ctx.lineWidth = 0.08 * ppm;
    ctx.strokeRect(X(x0), Z(z0), (x1 - x0) * ppm, (z1 - z0) * ppm);
    for (const e of fleet) line(ctx, X(x0), Z(e.position.z - 1.3), X(x1), Z(e.position.z - 1.3));
    ctx.save();
    ctx.translate(X(x1) + 0.7 * ppm, Z((z0 + z1) / 2));
    ctx.rotate(-Math.PI / 2);
    ctx.fillStyle = "rgba(127, 224, 216, 0.9)";
    ctx.font = `700 ${Math.round(0.5 * ppm)}px ui-sans-serif, system-ui, -apple-system, Helvetica, Arial`;
    ctx.textAlign = "center";
    ctx.fillText("CHARGING", 0, 0);
    ctx.restore();
  }

  // Pedestrian walkway along the dock wall.
  ctx.fillStyle = "rgba(242, 194, 48, 0.18)";
  ctx.fillRect(0, Z(max.z - 1.4), c.width, 1.2 * ppm);
  ctx.strokeStyle = YELLOW;
  ctx.lineWidth = 0.06 * ppm;
  line(ctx, 0, Z(max.z - 1.4), c.width, Z(max.z - 1.4));

  const texture = new CanvasTexture(c);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 8;
  return { texture, width, depth };
}

/** Yard markings: dock approach lanes and a dashed circulation line. */
export function yardMarkingsTexture(
  f: FacilityConfig,
  yardDepth: number,
): { texture: Texture; width: number; depth: number } {
  const width = f.site.max.x - f.site.min.x;
  const ppm = Math.min(30, 3000 / Math.max(width, yardDepth));
  const [c, ctx] = canvas(Math.round(width * ppm), Math.round(yardDepth * ppm));
  const X = (x: number) => (x - f.site.min.x) * ppm;
  const Z = (z: number) => (z - f.building.max.z) * ppm;
  ctx.strokeStyle = WHITE;
  ctx.lineWidth = 0.12 * ppm;
  const pitch =
    f.docks.length > 1
      ? Math.abs((f.docks[1]?.position.x ?? 0) - (f.docks[0]?.position.x ?? 0))
      : 4.6;
  for (const d of f.docks) {
    for (const s of [-1, 1])
      line(
        ctx,
        X(d.position.x + (s * pitch) / 2),
        Z(f.building.max.z + 0.5),
        X(d.position.x + (s * pitch) / 2),
        Z(f.building.max.z + 19),
      );
  }
  ctx.setLineDash([2 * ppm, 1.5 * ppm]);
  ctx.strokeStyle = YELLOW;
  line(ctx, 0, Z(f.building.max.z + 25), c.width, Z(f.building.max.z + 25));
  ctx.setLineDash([]);
  const texture = new CanvasTexture(c);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 8;
  return { texture, width, depth: yardDepth };
}

/** Trailer side livery (fictional brand: our own product name). */
export function liveryTexture(): Texture {
  const [c, ctx] = canvas(1024, 192);
  ctx.clearRect(0, 0, 1024, 192);
  ctx.fillStyle = "#f5b83d";
  ctx.fillRect(0, 150, 1024, 14);
  ctx.fillStyle = "#3fb8af";
  ctx.fillRect(0, 168, 1024, 6);
  ctx.fillStyle = "#1a2029";
  ctx.font = "800 84px ui-sans-serif, system-ui, -apple-system, Helvetica, Arial";
  ctx.textBaseline = "middle";
  ctx.fillText("WAREHOUSE ONE", 40, 80);
  ctx.font = "600 30px ui-sans-serif, system-ui, -apple-system, Helvetica, Arial";
  ctx.fillStyle = "#4b525c";
  ctx.fillText("Intelligent Logistics. Living Data.", 44, 128);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

export const decalMaterial = (map: Texture) =>
  new MeshStandardMaterial({
    map,
    transparent: true,
    roughness: 0.5,
    side: DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
  });

function line(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number) {
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
}

// ---------------------------------------------------------------------------------------------
// Phase 5: the logistics network around the facility.

export interface NetworkMaterials {
  terrain: MeshStandardMaterial;
  verge: MeshStandardMaterial;
  road: MeshStandardMaterial;
  pad: MeshStandardMaterial;
  padDark: MeshStandardMaterial;
  marking: MeshStandardMaterial;
  markingYellow: MeshStandardMaterial;
  water: MeshStandardMaterial;
  quay: MeshStandardMaterial;
  roof: MeshStandardMaterial;
  trim: MeshStandardMaterial;
  glazing: MeshStandardMaterial;
  craneYellow: MeshStandardMaterial;
  craneBlue: MeshStandardMaterial;
  container: MeshStandardMaterial;
  fence: MeshStandardMaterial;
  lampHead: MeshStandardMaterial;
  tree: MeshStandardMaterial;
  trunk: MeshStandardMaterial;
}

let networkCached: NetworkMaterials | null = null;

export function networkMaterials(): NetworkMaterials {
  if (networkCached) return networkCached;
  networkCached = {
    // Dark, slightly green ground under little sky light, so paved sites read clearly against it.
    terrain: std("#070c12", 1, 0, { envMapIntensity: 0.25 }),
    verge: std("#101713", 1),
    // Cool greys: the warm key light would otherwise turn neutral grey paving brown.
    road: std("#14171c", 0.9, 0, { envMapIntensity: 0.5 }),
    pad: std("#394049", 0.93),
    padDark: std("#2b3139", 0.95),
    marking: std("#e6eaef", 0.7, 0, { emissive: new Color("#e6eaef"), emissiveIntensity: 0.08 }),
    markingYellow: std("#f2c230", 0.6, 0, {
      emissive: new Color("#f2c230"),
      emissiveIntensity: 0.12,
    }),
    water: std("#06121d", 0.32, 0.15),
    quay: std("#8b8d8f", 0.85),
    roof: std("#59616b", 0.6, 0.45),
    trim: std("#2c333c", 0.55, 0.5),
    glazing: std("#1c2c3b", 0.1, 0.7, {
      emissive: new Color("#7fb2e6"),
      emissiveIntensity: 0.35,
    }),
    craneYellow: std("#e2a52b", 0.45, 0.35),
    craneBlue: std("#2c5f93", 0.45, 0.4),
    // White base; each container's colour comes from its instance colour.
    container: std("#ffffff", 0.62, 0.25),
    fence: std("#59626d", 0.6, 0.6),
    lampHead: std("#fff3d6", 0.4, 0, {
      emissive: new Color("#ffe2a8"),
      emissiveIntensity: 2.2,
    }),
    tree: std("#1f3b2c", 0.95),
    trunk: std("#3a2e24", 0.9),
  };
  return networkCached;
}

/** Shipping-line container colours (generic, no brands). */
export const CONTAINER_COLORS = [
  "#2f6db5",
  "#b8432f",
  "#2e8a63",
  "#c9ced4",
  "#d9822b",
  "#6b4c9a",
  "#8a2f3b",
  "#3f8fa6",
] as const;
