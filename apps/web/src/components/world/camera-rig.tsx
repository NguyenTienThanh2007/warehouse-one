"use client";

import { CameraControls } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import type { FacilityConfig, SimulationConfig } from "@warehouse-one/simulation";
import { useEffect, useMemo, useRef } from "react";
import { Box3, MathUtils, Vector3 } from "three";
import { useSimulation, type Selection } from "@/lib/sim/store";
import { publishSceneDebug } from "@/lib/world/scene-debug";
import { useView, type CameraPreset } from "@/lib/world/view-store";
import { bayBounds, rackRows, VEHICLE_SIZE, YARD_LEVEL } from "@/world/derive";
import { CAMERA_FOV, facilityFrame, fitBox, overviewPose, type CameraPose } from "@/world/framing";
import { linehaulViews, primarySiteId, resolveSites, worldBounds } from "@/world/network-view";
import { truckViews, vehicleViews } from "@/world/ops-view";

/** Box around a whole site (ground to roof height), for the site and world views. */
function siteBox(config: SimulationConfig, siteId: string): Box3 | null {
  const s = resolveSites(config).find((x) => x.id === siteId);
  if (!s) return null;
  const h = Math.max(8, ...s.buildings.map((b) => b.height)) + (s.containers ? 12 : 0);
  return new Box3(
    new Vector3(s.bounds.min.x, YARD_LEVEL, s.bounds.min.z),
    new Vector3(s.bounds.max.x, h, s.bounds.max.z),
  );
}

/** Move a pose sideways so its target appears at (dx, dy) in NDC instead of the centre. */
function shiftOnScreen(pose: CameraPose, aspect: number, dx: number, dy: number): CameraPose {
  const pos = new Vector3(...pose.position);
  const target = new Vector3(...pose.target);
  const forward = target.clone().sub(pos);
  const distance = forward.length();
  forward.normalize();
  const right = new Vector3().crossVectors(forward, new Vector3(0, 1, 0)).normalize();
  const up = new Vector3().crossVectors(right, forward).normalize();
  const halfH = distance * Math.tan(MathUtils.degToRad(CAMERA_FOV / 2));
  const shift = right.multiplyScalar(-dx * halfH * aspect).add(up.multiplyScalar(-dy * halfH));
  return {
    position: pos.add(shift).toArray() as [number, number, number],
    target: target.add(shift).toArray() as [number, number, number],
  };
}

function worldBox(config: SimulationConfig): Box3 {
  const b = worldBounds(config);
  return new Box3(new Vector3(b.min.x, YARD_LEVEL, b.min.z), new Vector3(b.max.x, 20, b.max.z));
}

function selectionBox(
  sel: Selection,
  config: SimulationConfig,
  f: FacilityConfig,
  rackHeight: number,
): Box3 | null {
  if (sel.kind === "location") {
    const loc = config.locations.find((l) => l.id === sel.id);
    if (!loc) return null;
    const b = bayBounds(loc, f.rack);
    return new Box3(new Vector3(b.min.x, 0, b.min.z), new Vector3(b.max.x, rackHeight, b.max.z));
  }
  if (sel.kind === "site") return siteBox(config, sel.id);
  if (sel.kind === "linehaul") {
    const sim = useSimulation.getState();
    const v = linehaulViews(config, undefined, sim.state, 1).find((x) => x.id === sel.id);
    if (!v) return null;
    return new Box3(
      new Vector3(v.pose.x - 9, YARD_LEVEL, v.pose.z - 9),
      new Vector3(v.pose.x + 9, YARD_LEVEL + 4.2, v.pose.z + 9),
    );
  }
  if (sel.kind === "equipment" || sel.kind === "truck") {
    // Moving entities are framed where the simulation has them now.
    const state = useSimulation.getState().state;
    const ops = state.ops;
    if (!ops) return null;
    const v =
      sel.kind === "equipment"
        ? vehicleViews(config, undefined, ops, 1).find((x) => x.id === sel.id)
        : truckViews(config, undefined, ops, 1).find((x) => x.id === sel.id);
    if (!v) return null;
    const s = VEHICLE_SIZE["kind" in v ? v.kind : "truck"];
    const r = Math.max(s.length, s.width) / 2;
    const y0 = sel.kind === "truck" ? YARD_LEVEL : 0;
    return new Box3(
      new Vector3(v.pose.x - r, y0, v.pose.z - r),
      new Vector3(v.pose.x + r, y0 + s.height, v.pose.z + r),
    );
  }
  const d = f.docks.find((k) => k.id === sel.id);
  if (!d) return null;
  return new Box3(
    new Vector3(d.position.x - 3, YARD_LEVEL, d.position.z - 5),
    new Vector3(d.position.x + 3, 4, d.position.z + 3),
  );
}

/** Camera pose for a preset. Pure apart from reading the controls' current azimuth for "focus". */
function presetPose(
  preset: CameraPreset,
  ctx: {
    config: SimulationConfig;
    facility: FacilityConfig;
    rackHeight: number;
    aspect: number;
    azimuth: number;
    selection: Selection | null;
    siteId?: string;
  },
): CameraPose | null {
  const { facility: f, config, rackHeight, aspect } = ctx;
  const frame = facilityFrame(f, rackHeight);
  switch (preset) {
    case "world": {
      const portrait = aspect < 1;
      // Landscape: a three-quarter view from the south-east, the network running corner to corner,
      // nudged right and down so the HUD's left column and top bars cover as little as possible.
      if (portrait) return fitBox(worldBox(config), Math.PI / 2 - 0.12, 0.82, aspect, 0.92);
      return shiftOnScreen(fitBox(worldBox(config), 0.46, 0.9, aspect, 0.9), aspect, 0.06, -0.02);
    }
    case "site": {
      if (!ctx.siteId) return null;
      // The DC's facility view is its overview preset (racks, docks and yard framed).
      if (ctx.siteId === primarySiteId(config)) return overviewPose(frame, aspect);
      const box = siteBox(config, ctx.siteId);
      return box ? fitBox(box, 0.62, 0.92, aspect, aspect < 1 ? 0.85 : 0.82) : null;
    }
    case "overview":
      return overviewPose(frame, aspect);
    case "top":
      return fitBox(frame, 0, 0.001, aspect, 0.9);
    case "docks": {
      if (f.docks.length === 0) return overviewPose(frame, aspect);
      const xs = f.docks.map((d) => d.position.x);
      const box = new Box3(
        new Vector3(Math.min(...xs) - 4, YARD_LEVEL, f.building.max.z - 10),
        new Vector3(Math.max(...xs) + 4, 4.5, f.building.max.z + 17),
      );
      return fitBox(box, aspect < 1 ? 0.25 : 0.55, 1.0, aspect, 0.92);
    }
    case "aisle": {
      // Stand at the end of the first working aisle between two pick faces, at reach-truck eye height.
      const rows = rackRows(config);
      const sorted = [...rows].sort(
        (a, b) => (a.locations[0]?.position.z ?? 0) - (b.locations[0]?.position.z ?? 0),
      );
      let z = f.building.min.z + 1.8;
      for (let i = 1; i < sorted.length; i++) {
        const a = sorted[i - 1];
        const b = sorted[i];
        if (a && b && a.yaw === 0 && b.yaw === Math.PI) {
          z = ((a.locations[0]?.position.z ?? 0) + (b.locations[0]?.position.z ?? 0)) / 2;
          break;
        }
      }
      const xMax = Math.max(...config.locations.map((l) => l.position.x)) + f.rack.bay_width / 2;
      const xMin = Math.min(...config.locations.map((l) => l.position.x)) - f.rack.bay_width / 2;
      return { position: [xMax + 3.5, 4.2, z + 1.2], target: [(xMin + xMax) / 2, 1.8, z] };
    }
    case "focus": {
      if (!ctx.selection) return null;
      const box = selectionBox(ctx.selection, config, f, rackHeight);
      if (!box) return null;
      return fitBox(box, ctx.azimuth, 1.0, aspect, 0.45);
    }
  }
}

export function CameraRig({
  facility,
  rackHeight,
}: {
  facility: FacilityConfig;
  rackHeight: number;
}) {
  const controls = useRef<CameraControls>(null);
  const config = useSimulation((s) => s.config);
  const selection = useSimulation((s) => s.selection);
  const request = useView((s) => s.cameraRequest);
  const requestCamera = useView((s) => s.requestCamera);
  const { size, camera } = useThree();
  const aspect = size.width / Math.max(1, size.height);
  const portrait = aspect < 1;
  const setScope = useView((s) => s.setScope);
  const hasNetwork = !!config.network;
  const bounds = useMemo(() => {
    const b = hasNetwork ? worldBox(config) : facilityFrame(facility, rackHeight);
    return new Box3(b.min.clone().addScalar(-60), b.max.clone().addScalar(60));
  }, [config, hasNetwork, facility, rackHeight]);
  const maxDistance = useMemo(() => {
    if (!hasNetwork) return 420;
    const size = worldBox(config).getSize(new Vector3());
    return Math.max(420, Math.hypot(size.x, size.z) * 1.6);
  }, [config, hasNetwork]);

  // Frame the world (or the single facility) on load, on scenario change and when the screen flips
  // orientation.
  useEffect(() => {
    requestCamera(hasNetwork ? "world" : "overview", true);
  }, [facility, portrait, requestCamera, hasNetwork]);

  useEffect(() => {
    const c = controls.current;
    if (!c || !request) return;
    const pose = presetPose(request.preset, {
      config,
      facility,
      rackHeight,
      aspect,
      azimuth: c.azimuthAngle,
      selection,
      ...(request.siteId ? { siteId: request.siteId } : {}),
    });
    if (!pose) return;
    // World view vs one site's facility view (drives labels, roofs and the HUD breadcrumb).
    if (request.preset === "world") setScope({ kind: "world" });
    else if (request.preset === "site" && request.siteId)
      setScope({ kind: "site", siteId: request.siteId });
    else if (request.preset !== "focus") setScope({ kind: "site", siteId: primarySiteId(config) });
    else if (selection?.kind === "site") setScope({ kind: "site", siteId: selection.id });
    void c.setLookAt(...pose.position, ...pose.target, !request.instant);
    // Only react to new requests, not to every selection/aspect change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  useEffect(() => {
    const c = controls.current;
    if (!c) return;
    c.setBoundary(bounds);
  }, [bounds]);

  // Report camera motion so automated tests can wait for a transition to finish instead of
  // sleeping (frame time varies by orders of magnitude between GPU and software rendering).
  useEffect(() => {
    const c = controls.current;
    if (!c) return;
    let rests = 0;
    const snapshot = () => {
      const t = c.getTarget(new Vector3());
      return {
        position: camera.position.toArray() as [number, number, number],
        target: t.toArray() as [number, number, number],
      };
    };
    const onWake = () => publishSceneDebug({ cameraMotion: { moving: true, rests } });
    const onRest = () => {
      rests += 1;
      publishSceneDebug({ camera: snapshot(), cameraMotion: { moving: false, rests } });
    };
    publishSceneDebug({ cameraMotion: { moving: false, rests } });
    c.addEventListener("wake", onWake);
    c.addEventListener("rest", onRest);
    return () => {
      c.removeEventListener("wake", onWake);
      c.removeEventListener("rest", onRest);
    };
  }, [camera]);

  const target = useMemo(() => new Vector3(), []);
  const scratch = useMemo(() => new Vector3(), []);
  const lastPublish = useRef(0);
  useFrame((state) => {
    const c = controls.current;
    if (!c || state.clock.elapsedTime - lastPublish.current < 0.25) return;
    lastPublish.current = state.clock.elapsedTime;
    c.getTarget(target);
    const debug = window.__WAREHOUSE_ONE_SCENE__;
    const pickables = [...(debug?.pickables ?? []), ...(debug?.moving?.pickables ?? [])];
    publishSceneDebug({
      camera: {
        position: camera.position.toArray() as [number, number, number],
        target: target.toArray() as [number, number, number],
      },
      projected: pickables.map((p) => {
        scratch.set(...p.center).project(camera);
        return {
          kind: p.kind,
          id: p.id,
          x: scratch.x,
          y: scratch.y,
          visible: Math.abs(scratch.x) <= 1 && Math.abs(scratch.y) <= 1 && scratch.z < 1,
        };
      }),
    });
  });

  return (
    <CameraControls
      ref={controls}
      makeDefault
      smoothTime={0.35}
      draggingSmoothTime={0.12}
      minDistance={2.5}
      maxDistance={maxDistance}
      minPolarAngle={0}
      // Never below the horizon: the camera cannot dip under the floor.
      maxPolarAngle={MathUtils.degToRad(86)}
      dollyToCursor
      infinityDolly={false}
    />
  );
}
