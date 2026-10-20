"use client";

import { Grid, OrbitControls } from "@react-three/drei";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { useLayoutEffect, useMemo, useRef } from "react";
import { Color, Object3D, type InstancedMesh } from "three";
import { frameStats, rendererInfo } from "@/lib/perf/renderer-probe";
import { useSimulation } from "@/lib/sim/store";

const SLOT = { width: 2.2, depth: 1.6, maxHeight: 2.4 } as const;
const EMPTY = new Color("#2a313c");
const FILL_LOW = new Color("#3fb8af");
const FILL_HIGH = new Color("#f5b83d");

/**
 * Phase 0 diagnostic scene: proves the simulation → rendering adapter path, instancing,
 * selection and frame measurement. Geometry is intentionally schematic, not final art (Phase 1).
 */
export function DiagnosticScene() {
  return (
    <>
      <color attach="background" args={["#0c0f14"]} />
      <fog attach="fog" args={["#0c0f14", 55, 130]} />
      <hemisphereLight args={["#dfe7f2", "#14171c", 0.55]} />
      <directionalLight
        castShadow
        position={[16, 28, 10]}
        intensity={1.8}
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-30}
        shadow-camera-right={30}
        shadow-camera-top={30}
        shadow-camera-bottom={-30}
        shadow-bias={-0.0004}
      />
      <mesh rotation-x={-Math.PI / 2} receiveShadow position-y={-0.01}>
        <planeGeometry args={[200, 200]} />
        <meshStandardMaterial color="#13171d" roughness={0.92} metalness={0.05} />
      </mesh>
      <Grid
        infiniteGrid
        cellSize={1}
        sectionSize={5}
        cellColor="#1d232c"
        sectionColor="#2b333f"
        fadeDistance={90}
        fadeStrength={1.5}
        position-y={0.001}
      />
      <LocationSlots />
      <OrbitControls
        makeDefault
        enableDamping
        dampingFactor={0.08}
        minDistance={8}
        maxDistance={95}
        // Keep the camera above the floor plane (no clipping under the ground).
        maxPolarAngle={Math.PI * 0.46}
        minPolarAngle={Math.PI * 0.08}
      />
      <FrameProbe />
    </>
  );
}

function LocationSlots() {
  const config = useSimulation((s) => s.config);
  const inventory = useSimulation((s) => s.inventory);
  const selected = useSimulation((s) => s.selectedLocationId);
  const select = useSimulation((s) => s.select);
  const bases = useRef<InstancedMesh>(null);
  const fills = useRef<InstancedMesh>(null);
  const dummy = useMemo(() => new Object3D(), []);
  const color = useMemo(() => new Color(), []);
  const count = config.locations.length;

  // Base footprints never change: lay them out once per config.
  useLayoutEffect(() => {
    const mesh = bases.current;
    if (!mesh) return;
    config.locations.forEach((loc, i) => {
      dummy.position.set(loc.position.x, 0.03, loc.position.z);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      mesh.setColorAt(i, loc.id === selected ? FILL_HIGH : EMPTY);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [config, dummy, selected]);

  // Fill columns are a pure function of authoritative inventory.
  useLayoutEffect(() => {
    const mesh = fills.current;
    if (!mesh) return;
    config.locations.forEach((loc, i) => {
      let units = 0;
      for (const q of Object.values(inventory[loc.id] ?? {})) units += q;
      const ratio = units / loc.capacity;
      const h = ratio * SLOT.maxHeight;
      dummy.position.set(loc.position.x, 0.06 + h / 2, loc.position.z);
      // Empty locations get a zero-scale (invisible) column so only the base tile shows.
      if (units === 0) dummy.scale.set(0, 0, 0);
      else dummy.scale.set(1, h, 1);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      mesh.setColorAt(i, color.copy(FILL_LOW).lerp(FILL_HIGH, ratio));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [config, inventory, dummy, color]);

  const onClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    const loc = e.instanceId === undefined ? undefined : config.locations[e.instanceId];
    if (loc) select(loc.id === selected ? null : loc.id);
  };
  const onOver = () => (document.body.style.cursor = "pointer");
  const onOut = () => (document.body.style.cursor = "");

  return (
    <group>
      <instancedMesh
        ref={bases}
        args={[undefined, undefined, count]}
        receiveShadow
        onClick={onClick}
        onPointerOver={onOver}
        onPointerOut={onOut}
      >
        <boxGeometry args={[SLOT.width, 0.06, SLOT.depth]} />
        <meshStandardMaterial roughness={0.7} metalness={0.1} />
      </instancedMesh>
      <instancedMesh
        ref={fills}
        args={[undefined, undefined, count]}
        castShadow
        receiveShadow
        onClick={onClick}
        onPointerOver={onOver}
        onPointerOut={onOut}
      >
        <boxGeometry args={[SLOT.width * 0.82, 1, SLOT.depth * 0.78]} />
        <meshStandardMaterial roughness={0.55} metalness={0.05} />
      </instancedMesh>
    </group>
  );
}

function FrameProbe() {
  useFrame(({ gl }, delta) => {
    frameStats.record(delta * 1000);
    rendererInfo.drawCalls = gl.info.render.calls;
    rendererInfo.triangles = gl.info.render.triangles;
    rendererInfo.dpr = gl.getPixelRatio();
  });
  return null;
}
