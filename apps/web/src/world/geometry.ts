/**
 * Procedural asset geometry at real-world scale (metres). Every asset is built from primitives and
 * merged per material, so each one renders with a handful of draw calls and instances cheaply.
 * No third-party models are used (see docs/design/ASSETS.md).
 */
import type { BufferGeometry } from "three";
import {
  BoxGeometry,
  CylinderGeometry,
  Euler,
  Matrix4,
  Quaternion,
  TorusGeometry,
  Vector3,
} from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";

export type Xyz = readonly [number, number, number];

/** Transform a geometry in place and strip it to the attributes every part shares. */
function place(geo: BufferGeometry, pos: Xyz, rot: Xyz = [0, 0, 0]): BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  for (const name of Object.keys(g.attributes))
    if (name !== "position" && name !== "normal" && name !== "uv") g.deleteAttribute(name);
  g.applyMatrix4(
    new Matrix4().compose(
      new Vector3(...pos),
      new Quaternion().setFromEuler(new Euler(...rot)),
      new Vector3(1, 1, 1),
    ),
  );
  return g;
}

export const box = (w: number, h: number, d: number, pos: Xyz, rot?: Xyz) =>
  place(new BoxGeometry(w, h, d), pos, rot);
const rbox = (w: number, h: number, d: number, r: number, pos: Xyz, rot?: Xyz) =>
  place(new RoundedBoxGeometry(w, h, d, 1, Math.min(r, w / 2, h / 2, d / 2)), pos, rot);
export const cyl = (rTop: number, rBottom: number, h: number, seg: number, pos: Xyz, rot?: Xyz) =>
  place(new CylinderGeometry(rTop, rBottom, h, seg), pos, rot);

export function merge(parts: BufferGeometry[]): BufferGeometry {
  const merged = mergeGeometries(parts, false);
  if (!merged) throw new Error("geometry merge failed");
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return merged;
}

/** Multi-material model: one merged geometry per material key (parts may be absent). */
export type Model<K extends string> = Partial<Record<K, BufferGeometry>>;

// ---------------------------------------------------------------------------------------------
// Pallet and cargo. Local frame: x along the beam (1.0 m), z into the rack (1.2 m), y up from 0.

export const PALLET = { width: 1.0, depth: 1.2, height: 0.144 } as const;

export function palletGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [];
  const { width: w, depth: d } = PALLET;
  // Bottom boards, blocks, stringer boards, top deck boards.
  for (const x of [-0.42, 0, 0.42]) parts.push(box(0.14, 0.022, d, [x, 0.011, 0]));
  for (const x of [-0.42, 0, 0.42])
    for (const z of [-0.53, 0, 0.53]) parts.push(box(0.14, 0.078, 0.14, [x, 0.061, z]));
  for (const z of [-0.53, 0, 0.53]) parts.push(box(w, 0.022, 0.14, [0, 0.111, z]));
  for (let i = 0; i < 7; i++)
    parts.push(box(0.1, 0.022, d, [-w / 2 + 0.05 + i * ((w - 0.1) / 6), 0.133, 0]));
  return merge(parts);
}

const LOAD_BASE = PALLET.height;

export function cargoGeometry(
  kind: "cartons" | "cold-chain" | "bulk-bag" | "electronics",
): BufferGeometry {
  switch (kind) {
    case "cartons": {
      // 3 layers of 2×3 cartons with slight offsets, as stacked by hand.
      const parts: BufferGeometry[] = [];
      for (let layer = 0; layer < 3; layer++)
        for (let ix = 0; ix < 2; ix++)
          for (let iz = 0; iz < 3; iz++) {
            const jitter = ((ix * 7 + iz * 3 + layer * 5) % 5) * 0.004;
            parts.push(
              box(
                0.47,
                0.36,
                0.38,
                [
                  -0.245 + ix * 0.49 + jitter,
                  LOAD_BASE + 0.18 + layer * 0.365,
                  -0.4 + iz * 0.4 - jitter,
                ],
                [0, jitter, 0],
              ),
            );
          }
      return merge(parts);
    }
    case "cold-chain":
      return merge([
        rbox(0.98, 1.12, 1.18, 0.05, [0, LOAD_BASE + 0.56, 0]),
        // Recessed lid and reinforcing ribs.
        rbox(0.9, 0.04, 1.1, 0.02, [0, LOAD_BASE + 1.13, 0]),
        box(1.0, 0.05, 1.2, [0, LOAD_BASE + 0.32, 0]),
        box(1.0, 0.05, 1.2, [0, LOAD_BASE + 0.82, 0]),
      ]);
    case "bulk-bag": {
      const parts = [
        rbox(0.96, 1.05, 1.1, 0.22, [0, LOAD_BASE + 0.53, 0]),
        cyl(0.18, 0.3, 0.12, 12, [0, LOAD_BASE + 1.1, 0]),
      ];
      for (const [x, z] of [
        [-0.38, -0.45],
        [0.38, -0.45],
        [-0.38, 0.45],
        [0.38, 0.45],
      ] as const)
        parts.push(
          place(
            new TorusGeometry(0.08, 0.018, 6, 12, Math.PI),
            [x, LOAD_BASE + 1.04, z],
            [0, Math.PI / 4, 0],
          ),
        );
      return merge(parts);
    }
    case "electronics": {
      const parts: BufferGeometry[] = [];
      for (let layer = 0; layer < 4; layer++)
        for (let ix = 0; ix < 2; ix++)
          for (let iz = 0; iz < 2; iz++)
            parts.push(
              box(0.48, 0.27, 0.58, [
                -0.25 + ix * 0.5,
                LOAD_BASE + 0.135 + layer * 0.275,
                -0.3 + iz * 0.6,
              ]),
            );
      return merge(parts);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Racking members (unit geometries, scaled per instance).

/** Upright post: 1 m tall, centred; scaled in y per instance. Omega-section approximated by a box. */
export const postGeometry = () => box(0.09, 1, 0.07, [0, 0, 0]);
/** Box-section load beam, 1 m long along x; scaled per instance. */
export const beamGeometry = () => box(1, 0.12, 0.05, [0, 0, 0]);
/** Frame brace, 1 m long along local z. */
export const braceGeometry = () => box(0.03, 0.03, 1, [0, 0, 0]);
/** Post protector. */
export const guardGeometry = () => rbox(0.2, 0.4, 0.18, 0.03, [0, 0, 0]);

// ---------------------------------------------------------------------------------------------
// Vehicles. Local frame: +z is forward, origin at the footprint centre on the floor.

/** `forks` (carriage + blades) is a separate part so it can rise with the simulated lift height. */
export type VehiclePart = "body" | "dark" | "steel" | "tyre" | "glass" | "forks";

/**
 * Fork blades are modelled with their centre at y = 0 in the `forks` part; the renderer lifts the
 * part to the simulated fork height (`EquipmentPose.fork`) plus this offset, so a carried pallet
 * (drawn by `palletWorld` 4 cm below fork height) sits with the blades in its pockets.
 */
export const FORK_BLADE_OFFSET = 0.03;

export function forkliftModel(): Model<VehiclePart> {
  const body = [
    rbox(1.1, 0.55, 1.6, 0.08, [0, 0.62, -0.45]), // chassis
    rbox(1.12, 0.6, 0.5, 0.12, [0, 0.78, -1.15]), // counterweight top band
    box(0.5, 0.08, 0.5, [0, 1.0, -0.45]), // seat base
  ];
  const dark = [
    rbox(1.14, 0.62, 0.55, 0.14, [0, 0.42, -1.2]), // counterweight
    rbox(0.46, 0.5, 0.12, 0.04, [0, 1.25, -0.75]), // seat back
    box(0.44, 0.08, 0.44, [0, 1.06, -0.5]), // seat cushion
    box(0.06, 1.15, 0.06, [-0.5, 1.5, -0.05]), // overhead guard posts
    box(0.06, 1.15, 0.06, [0.5, 1.5, -0.05]),
    box(0.06, 1.15, 0.06, [-0.5, 1.5, -1.0]),
    box(0.06, 1.15, 0.06, [0.5, 1.5, -1.0]),
    box(1.1, 0.05, 1.05, [0, 2.08, -0.52]), // guard roof
    cyl(0.16, 0.16, 0.04, 16, [0, 1.25, 0.08], [1.0, 0, 0]), // steering wheel
  ];
  const steel = [
    box(0.08, 2.1, 0.1, [-0.32, 1.12, 0.48]), // mast rails
    box(0.08, 2.1, 0.1, [0.32, 1.12, 0.48]),
    box(0.72, 0.08, 0.06, [0, 2.12, 0.48]),
  ];
  const forks = [
    box(0.78, 0.36, 0.05, [0, 0.27, 0.58]), // carriage
    box(0.1, 0.045, 1.1, [-0.25, 0, 1.15]), // blades
    box(0.1, 0.045, 1.1, [0.25, 0, 1.15]),
    box(0.1, 0.42, 0.045, [-0.25, 0.21, 0.6]),
    box(0.1, 0.42, 0.045, [0.25, 0.21, 0.6]),
  ];
  const tyre: BufferGeometry[] = [];
  for (const [x, z, r] of [
    [-0.5, 0.15, 0.3],
    [0.5, 0.15, 0.3],
    [-0.46, -1.0, 0.24],
    [0.46, -1.0, 0.24],
  ] as const)
    tyre.push(cyl(r, r, 0.22, 20, [x, r, z], [0, 0, Math.PI / 2]));
  return {
    body: merge(body),
    dark: merge(dark),
    steel: merge(steel),
    tyre: merge(tyre),
    forks: merge(forks),
  };
}

export function reachTruckModel(): Model<VehiclePart> {
  return {
    body: merge([
      rbox(1.2, 1.25, 1.1, 0.12, [0, 0.8, -0.65]),
      box(0.9, 0.08, 0.5, [0, 1.45, -0.9]),
    ]),
    dark: merge([
      box(0.06, 1.0, 0.06, [-0.52, 1.95, -0.2]),
      box(0.06, 1.0, 0.06, [0.52, 1.95, -0.2]),
      box(0.06, 1.0, 0.06, [-0.52, 1.95, -1.1]),
      box(0.06, 1.0, 0.06, [0.52, 1.95, -1.1]),
      box(1.1, 0.05, 1.0, [0, 2.45, -0.65]),
      box(0.12, 0.12, 1.3, [-0.55, 0.12, 0.6]), // outriggers
      box(0.12, 0.12, 1.3, [0.55, 0.12, 0.6]),
    ]),
    steel: merge([
      box(0.08, 2.35, 0.1, [-0.32, 1.27, 0.0]),
      box(0.08, 2.35, 0.1, [0.32, 1.27, 0.0]),
    ]),
    forks: merge([
      box(0.74, 0.32, 0.05, [0, 0.18, 0.12]), // carriage
      box(0.1, 0.045, 1.0, [-0.22, 0, 0.62]), // blades
      box(0.1, 0.045, 1.0, [0.22, 0, 0.62]),
    ]),
    tyre: merge([
      cyl(0.13, 0.13, 0.1, 16, [-0.55, 0.13, 1.1], [0, 0, Math.PI / 2]),
      cyl(0.13, 0.13, 0.1, 16, [0.55, 0.13, 1.1], [0, 0, Math.PI / 2]),
      cyl(0.18, 0.18, 0.18, 16, [0, 0.18, -0.9], [0, 0, Math.PI / 2]),
    ]),
  };
}

/** Tractor unit + 13.6 m curtainside trailer. Forward (+z) is the tractor; the rear faces the dock. */
export function truckModel(): Model<VehiclePart> {
  const L = 16.5;
  const rear = -L / 2;
  const trailerLen = 13.6;
  const trailerZ = rear + trailerLen / 2;
  const cabZ = L / 2 - 1.2;
  const body: BufferGeometry[] = [
    rbox(2.48, 2.75, trailerLen, 0.06, [0, 1.2 + 2.75 / 2, trailerZ]), // trailer box
    rbox(2.45, 2.2, 2.25, 0.18, [0, 1.15 + 1.1, cabZ]), // cab
    rbox(2.3, 0.7, 1.2, 0.18, [0, 3.6, cabZ - 0.4]), // high roof
  ];
  const dark: BufferGeometry[] = [
    box(1.0, 0.28, L - 1.5, [-0.45, 0.85, 0.2]), // chassis rails
    box(1.0, 0.28, L - 1.5, [0.45, 0.85, 0.2]),
    rbox(2.5, 0.35, 0.3, 0.06, [0, 0.95, L / 2 - 0.05]), // bumper
    box(2.5, 0.22, 0.18, [0, 1.12, rear + 0.05]), // underride bar
    box(2.52, 0.08, trailerLen, [0, 1.2, trailerZ]), // trailer floor edge
    rbox(0.5, 0.9, 0.5, 0.08, [-1.05, 1.05, cabZ - 1.4]), // fuel tank
  ];
  for (let i = 0; i < 12; i++)
    dark.push(box(2.52, 2.62, 0.04, [0, 1.2 + 1.37, rear + 0.6 + i * 1.1])); // side posts
  const steel = [box(2.0, 0.1, 0.9, [0, 1.15, cabZ - 2.0])]; // fifth wheel
  const glass = [
    box(2.2, 0.9, 0.05, [0, 2.75, cabZ + 1.13], [-0.12, 0, 0]),
    box(0.05, 0.8, 0.9, [-1.23, 2.75, cabZ + 0.4]),
    box(0.05, 0.8, 0.9, [1.23, 2.75, cabZ + 0.4]),
  ];
  const tyre: BufferGeometry[] = [];
  const wheel = (x: number, z: number) =>
    tyre.push(cyl(0.5, 0.5, 0.36, 20, [x, 0.5, z], [0, 0, Math.PI / 2]));
  for (const z of [cabZ + 0.3, cabZ - 3.2, cabZ - 4.55]) for (const x of [-1.05, 1.05]) wheel(x, z);
  for (const z of [rear + 1.5, rear + 2.85, rear + 4.2]) for (const x of [-1.05, 1.05]) wheel(x, z);
  return {
    body: merge(body),
    dark: merge(dark),
    steel: merge(steel),
    glass: merge(glass),
    tyre: merge(tyre),
  };
}
