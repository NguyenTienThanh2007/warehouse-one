"use client";

import { PerformanceMonitor } from "@react-three/drei";
import { Canvas } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import { AgXToneMapping, NoToneMapping } from "three";
import { CameraRig } from "@/components/world/camera-rig";
import { Effects } from "@/components/world/effects";
import { Lighting } from "@/components/world/lighting";
import { ReadySignal, WarehouseWorld } from "@/components/world/warehouse-world";
import { exposePerfHook, frameStats, rendererInfo } from "@/lib/perf/renderer-probe";
import { useSimulation } from "@/lib/sim/store";
import { isSoftwareRenderer, QUALITY_TIERS, TIER_SETTINGS, useView } from "@/lib/world/view-store";
import { levelsFor, resolveFacility } from "@/world/derive";
import { CAMERA_FOV } from "@/world/framing";
import { worldBounds } from "@/world/network-view";
import { useFrame } from "@react-three/fiber";

/**
 * Records frame time and the previous frame's draw statistics. Post-processing renders several
 * passes per frame, so `gl.info` is accumulated manually (autoReset off) and read once per frame.
 */
function FrameProbe() {
  useFrame(({ gl }, delta) => {
    gl.info.autoReset = false;
    frameStats.record(delta * 1000);
    rendererInfo.drawCalls = gl.info.render.calls;
    rendererInfo.triangles = gl.info.render.triangles;
    rendererInfo.dpr = gl.getPixelRatio();
    gl.info.reset();
  });
  return null;
}

/** Applies tone mapping where post-processing does not (the Low tier renders straight to screen). */
function ToneMappingSwitch({ post }: { post: boolean }) {
  useFrame(({ gl }) => {
    const wanted = post ? NoToneMapping : AgXToneMapping;
    if (gl.toneMapping !== wanted) gl.toneMapping = wanted;
  });
  return null;
}

export default function SceneCanvas() {
  const select = useSimulation((s) => s.select);
  const config = useSimulation((s) => s.config);
  const tier = useView((s) => s.tier);
  const mode = useView((s) => s.qualityMode);
  const setTier = useView((s) => s.setTier);
  const settings = TIER_SETTINGS[tier];
  const facility = useMemo(() => resolveFacility(config), [config]);
  const rackHeight = useMemo(
    () =>
      (Math.max(1, ...config.locations.map((l) => levelsFor(l.capacity, facility.rack))) - 1) *
        facility.rack.level_height +
      1.4,
    [config, facility],
  );
  const bounds = useMemo(() => worldBounds(config), [config]);
  useEffect(exposePerfHook, []);

  const stepDown = () => {
    if (mode !== "auto") return;
    const i = QUALITY_TIERS.indexOf(tier);
    const next = QUALITY_TIERS[Math.min(i + 1, QUALITY_TIERS.length - 1)];
    if (next && next !== tier) setTier(next);
  };

  return (
    <Canvas
      data-testid="scene-canvas"
      shadows={settings.shadows ? "percentage" : false}
      dpr={settings.dpr}
      camera={{ position: [60, 50, 70], fov: CAMERA_FOV, near: 0.5, far: 4000 }}
      gl={{ antialias: !settings.smaa, powerPreference: "high-performance", stencil: false }}
      onPointerMissed={(e) => e.type === "click" && select(null)}
      onCreated={({ gl }) => {
        const ctx = gl.getContext();
        const ext = ctx.getExtension("WEBGL_debug_renderer_info");
        rendererInfo.gpu = ext ? String(ctx.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : "unknown";
        // No GPU acceleration: start on the Low tier instead of waiting for the monitor to decline.
        if (useView.getState().qualityMode === "auto" && isSoftwareRenderer(rendererInfo.gpu))
          setTier("low");
      }}
      aria-label="3D view of the warehouse. Use the inspector's location picker for keyboard access."
    >
      <PerformanceMonitor onDecline={stepDown} flipflops={2} />
      <Lighting bounds={bounds} tier={tier} />
      <WarehouseWorld />
      <CameraRig facility={facility} rackHeight={rackHeight} />
      <Effects tier={tier} />
      <ToneMappingSwitch post={settings.ao || settings.smaa} />
      <FrameProbe />
      <ReadySignal />
    </Canvas>
  );
}
