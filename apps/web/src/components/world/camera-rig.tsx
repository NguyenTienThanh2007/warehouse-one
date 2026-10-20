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
import { facilityFrame, fitBox, overviewPose, type CameraPose } from "@/world/framing";

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
  if (sel.kind === "equipment") {
    const e = f.equipment.find((v) => v.id === sel.id);
    if (!e) return null;
    const s = VEHICLE_SIZE[e.kind];
    const r = Math.max(s.length, s.width) / 2;
    const y0 = e.kind === "truck" ? YARD_LEVEL : 0;
    return new Box3(
      new Vector3(e.position.x - r, y0, e.position.z - r),
      new Vector3(e.position.x + r, y0 + s.height, e.position.z + r),
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
  },
): CameraPose | null {
  const { facility: f, config, rackHeight, aspect } = ctx;
  const frame = facilityFrame(f, rackHeight);
  switch (preset) {
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
  const bounds = useMemo(() => {
    const b = facilityFrame(facility, rackHeight);
    return new Box3(b.min.clone().addScalar(-30), b.max.clone().addScalar(30));
  }, [facility, rackHeight]);

  // Frame the facility on load, on scenario change and when the screen flips orientation.
  useEffect(() => {
    requestCamera("overview", true);
  }, [facility, portrait, requestCamera]);

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
    });
    if (!pose) return;
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
    const pickables = window.__WAREHOUSE_ONE_SCENE__?.pickables ?? [];
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
      maxDistance={420}
      minPolarAngle={0}
      // Never below the horizon: the camera cannot dip under the floor.
      maxPolarAngle={MathUtils.degToRad(86)}
      dollyToCursor
      infinityDolly={false}
    />
  );
}
