"use client";

import { Canvas } from "@react-three/fiber";
import { useEffect } from "react";
import { exposePerfHook } from "@/lib/perf/renderer-probe";
import { useSimulation } from "@/lib/sim/store";
import { DiagnosticScene } from "./diagnostic-scene";

export default function SceneCanvas() {
  const select = useSimulation((s) => s.select);
  useEffect(exposePerfHook, []);
  return (
    <Canvas
      data-testid="scene-canvas"
      shadows
      dpr={[1, 2]}
      camera={{ position: [24, 22, 26], fov: 38, near: 0.5, far: 400 }}
      gl={{ antialias: true, powerPreference: "high-performance" }}
      onPointerMissed={() => select(null)}
    >
      <DiagnosticScene />
    </Canvas>
  );
}
