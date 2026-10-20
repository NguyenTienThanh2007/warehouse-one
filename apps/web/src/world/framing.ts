/**
 * Camera framing maths, independent of React: given world bounds, viewport aspect and a viewing
 * direction, find the closest camera distance at which the whole box is on screen.
 */
import { Box3, PerspectiveCamera, Vector3 } from "three";
import type { FacilityConfig } from "@warehouse-one/simulation";
import { VEHICLE_SIZE, YARD_LEVEL } from "./derive";

export interface CameraPose {
  readonly position: readonly [number, number, number];
  readonly target: readonly [number, number, number];
}

export const CAMERA_FOV = 35;

/** Spherical direction: azimuth from +z around +y, polar from +y. */
export function direction(azimuth: number, polar: number): Vector3 {
  return new Vector3(
    Math.sin(azimuth) * Math.sin(polar),
    Math.cos(polar),
    Math.cos(azimuth) * Math.sin(polar),
  );
}

function corners(box: Box3): Vector3[] {
  const out: Vector3[] = [];
  for (const x of [box.min.x, box.max.x])
    for (const y of [box.min.y, box.max.y])
      for (const z of [box.min.z, box.max.z]) out.push(new Vector3(x, y, z));
  return out;
}

/** Largest |NDC| coordinate of the box corners for a camera pose (≤ 1 means fully visible). */
export function maxNdcExtent(
  box: Box3,
  pose: CameraPose,
  aspect: number,
  fov = CAMERA_FOV,
): number {
  const cam = new PerspectiveCamera(fov, aspect, 0.1, 5000);
  cam.position.set(...pose.position);
  cam.lookAt(...pose.target);
  cam.updateMatrixWorld();
  cam.updateProjectionMatrix();
  let extent = 0;
  for (const c of corners(box)) {
    const p = c.project(cam);
    if (p.z > 1) return Number.POSITIVE_INFINITY; // behind the camera
    extent = Math.max(extent, Math.abs(p.x), Math.abs(p.y));
  }
  return extent;
}

/** Binary-search the distance so the box fills `fill` of the smaller screen half-extent. */
export function fitBox(
  box: Box3,
  azimuth: number,
  polar: number,
  aspect: number,
  fill = 0.9,
  fov = CAMERA_FOV,
): CameraPose {
  const center = box.getCenter(new Vector3());
  const dir = direction(azimuth, polar);
  const pose = (d: number): CameraPose => ({
    position: [center.x + dir.x * d, center.y + dir.y * d, center.z + dir.z * d],
    target: [center.x, center.y, center.z],
  });
  let lo = 1;
  let hi = 5000;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (maxNdcExtent(box, pose(mid), aspect, fov) > fill) lo = mid;
    else hi = mid;
  }
  return pose(hi);
}

/** Box covering the building, its racking height and the trucks at the docks. */
export function facilityFrame(f: FacilityConfig, rackHeight: number): Box3 {
  // Trucks arrive at run time (Phase 2); frame the area they occupy when docked.
  const hasDocks = f.docks.length > 0;
  const dockedRear = hasDocks
    ? Math.max(...f.docks.map((d) => d.position.z)) + 0.6 + VEHICLE_SIZE.truck.length
    : f.building.max.z;
  return new Box3(
    new Vector3(f.building.min.x, hasDocks ? YARD_LEVEL : 0, f.building.min.z),
    new Vector3(f.building.max.x, rackHeight, Math.max(f.building.max.z, dockedRear)),
  );
}

/**
 * Overview framing. Landscape screens see the facility from a three-quarter angle; portrait
 * screens look along the facility's long axis so it runs up the screen instead of being shrunk.
 */
export function overviewPose(box: Box3, aspect: number): CameraPose {
  const size = box.getSize(new Vector3());
  const portrait = aspect < 1;
  const longAxisZ = size.z >= size.x;
  const azimuth = portrait ? (longAxisZ ? 0.18 : Math.PI / 2 - 0.18) : 0.62;
  const polar = portrait ? 0.95 : 0.9;
  // Phones lose the top and bottom of the screen to HUD panels, so frame a little looser.
  return fitBox(box, azimuth, polar, aspect, portrait ? 0.8 : 0.86);
}
