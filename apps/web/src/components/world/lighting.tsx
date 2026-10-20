"use client";

import { Environment, Lightformer } from "@react-three/drei";
import type { FacilityConfig } from "@warehouse-one/simulation";
import { useFrame } from "@react-three/fiber";
import { useLayoutEffect, useMemo, useRef } from "react";
import type { DirectionalLight, Fog } from "three";
import { TIER_SETTINGS, type QualityTier } from "@/lib/world/view-store";

const SKY = "#0d1117";

/**
 * Lighting rig: a warm key "sun" through the open roof with soft shadows, a cool sky fill, and a
 * procedural studio environment (Lightformers, rendered once) for physically based reflections.
 * No HDR files are downloaded.
 */
export function Lighting({ facility: f, tier }: { facility: FacilityConfig; tier: QualityTier }) {
  const sun = useRef<DirectionalLight>(null);
  const settings = TIER_SETTINGS[tier];
  const c = useMemo(
    () => ({ x: (f.site.min.x + f.site.max.x) / 2, z: (f.site.min.z + f.site.max.z) / 2 }),
    [f],
  );
  const radius = useMemo(
    () => Math.hypot(f.site.max.x - f.site.min.x, f.site.max.z - f.site.min.z) / 2,
    [f],
  );

  useLayoutEffect(() => {
    const light = sun.current;
    if (!light) return;
    light.target.position.set(c.x, 0, c.z);
    light.target.updateMatrixWorld();
    const cam = light.shadow.camera;
    cam.left = cam.bottom = -radius * 0.85;
    cam.right = cam.top = radius * 0.85;
    cam.near = 1;
    cam.far = radius * 4;
    cam.updateProjectionMatrix();
    light.shadow.mapSize.set(settings.shadowMap, settings.shadowMap);
    light.shadow.map?.dispose();
    light.shadow.map = null;
  }, [c, radius, settings.shadowMap]);

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
