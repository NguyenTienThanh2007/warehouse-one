"use client";

import { Environment, Lightformer, type CameraControls } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useLayoutEffect, useMemo, useRef } from "react";
import { Vector3, type DirectionalLight, type Fog } from "three";
import { TIER_SETTINGS, type QualityTier } from "@/lib/world/view-store";
import type { Bounds } from "@/world/derive";

const SKY = "#0d1117";

/**
 * Lighting rig: a warm key "sun" through the open roof with soft shadows, a cool sky fill, and a
 * procedural studio environment (Lightformers, rendered once) for physically based reflections.
 * No HDR files are downloaded.
 */
export function Lighting({ bounds: f, tier }: { bounds: Bounds; tier: QualityTier }) {
  const sun = useRef<DirectionalLight>(null);
  const settings = TIER_SETTINGS[tier];
  const c = useMemo(() => ({ x: (f.min.x + f.max.x) / 2, z: (f.min.z + f.max.z) / 2 }), [f]);
  const radius = useMemo(() => Math.hypot(f.max.x - f.min.x, f.max.z - f.min.z) / 2, [f]);

  useLayoutEffect(() => {
    const light = sun.current;
    if (!light) return;
    light.shadow.mapSize.set(settings.shadowMap, settings.shadowMap);
    light.shadow.map?.dispose();
    light.shadow.map = null;
  }, [settings.shadowMap]);

  // The shadow frustum follows what the camera looks at and scales with its distance: tight and
  // sharp inside one facility, wide (and coarser) in the whole-world view. The centre snaps to the
  // shadow-map texel grid so shadows do not shimmer while the camera moves.
  const target = useMemo(() => new Vector3(), []);
  const applied = useRef({ x: Number.NaN, z: Number.NaN, half: 0 });
  useFrame(({ camera, controls }) => {
    const light = sun.current;
    if (!light) return;
    const cc = controls as unknown as CameraControls | null;
    if (cc?.getTarget) cc.getTarget(target);
    else target.set(c.x, 0, c.z);
    const dist = camera.position.distanceTo(target);
    const half = Math.min(Math.max(45, dist * 0.7), radius * 1.1);
    const texel = (half * 2) / settings.shadowMap;
    const x = Math.round(target.x / texel) * texel;
    const z = Math.round(target.z / texel) * texel;
    const a = applied.current;
    if (a.x === x && a.z === z && Math.abs(a.half - half) / half < 0.08) return;
    applied.current = { x, z, half };
    const dir = { x: 0.55, y: 1.1, z: 0.35 };
    const k = Math.max(half, 80);
    light.position.set(x + dir.x * k, dir.y * k, z + dir.z * k);
    light.target.position.set(x, 0, z);
    light.target.updateMatrixWorld();
    const cam = light.shadow.camera;
    cam.left = cam.bottom = -half;
    cam.right = cam.top = half;
    cam.near = 1;
    cam.far = k * 3.5;
    cam.updateProjectionMatrix();
  });

  return (
    <>
      <color attach="background" args={[SKY]} />
      <AdaptiveFog cx={c.x} cz={c.z} radius={radius} />
      <hemisphereLight args={["#dfe8f5", "#3a3128", 0.45]} />
      <directionalLight
        ref={sun}
        castShadow={settings.shadows}
        position={[c.x + radius * 0.55, radius * 1.1, c.z + radius * 0.35]}
        intensity={3.1}
        color="#ffeed6"
        shadow-bias={-0.0003}
        shadow-normalBias={0.04}
      >
        <object3D attach="target" />
      </directionalLight>
      <directionalLight
        position={[c.x - radius, radius * 0.6, c.z - radius * 0.8]}
        intensity={0.35}
        color="#9fb6d6"
      />
      <Environment resolution={128} frames={1} environmentIntensity={0.55}>
        <Lightformer
          form="rect"
          intensity={2.2}
          color="#ffffff"
          position={[0, 12, 0]}
          rotation-x={Math.PI / 2}
          scale={[30, 30, 1]}
        />
        <Lightformer
          form="rect"
          intensity={1.2}
          color="#ffe9cc"
          position={[-18, 6, 0]}
          rotation-y={Math.PI / 2}
          scale={[20, 6, 1]}
        />
        <Lightformer
          form="rect"
          intensity={0.8}
          color="#cfe0ff"
          position={[18, 6, 0]}
          rotation-y={-Math.PI / 2}
          scale={[20, 6, 1]}
        />
        <Lightformer form="ring" intensity={1.5} color="#ffffff" position={[0, 8, 18]} scale={6} />
      </Environment>
    </>
  );
}

/**
 * Fog that always starts beyond the facility, whatever the camera distance (phones frame from
 * much further away than desktops), so it only fades the surrounding ground, never the building.
 */
function AdaptiveFog({ cx, cz, radius }: { cx: number; cz: number; radius: number }) {
  const fog = useRef<Fog>(null);
  useFrame(({ camera }) => {
    const f = fog.current;
    if (!f) return;
    const d = Math.hypot(camera.position.x - cx, camera.position.y, camera.position.z - cz);
    f.near = d + radius * 0.4;
    f.far = d + radius * 3.2;
  });
  return <fog ref={fog} attach="fog" args={[SKY, radius * 2, radius * 5]} />;
}
