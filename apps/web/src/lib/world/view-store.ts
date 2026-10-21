"use client";

import { create } from "zustand";

/**
 * Camera presets. "world" frames the whole logistics network; "overview", "docks", "aisle" and
 * "top" frame the distribution centre; "focus" frames the current selection; "site" frames the site
 * named in the request.
 */
export const CAMERA_PRESETS = ["world", "overview", "docks", "aisle", "top", "focus"] as const;
export type CameraPreset = (typeof CAMERA_PRESETS)[number] | "site";

/** What the camera shows: the whole network, or one site (facility view). */
export type ViewScope = { kind: "world" } | { kind: "site"; siteId: string };

export const QUALITY_TIERS = ["high", "medium", "low"] as const;
export type QualityTier = (typeof QUALITY_TIERS)[number];
export type QualityMode = "auto" | QualityTier;

export type WorldStatus =
  { kind: "loading" } | { kind: "ready" } | { kind: "error"; reason: string };

interface ViewState {
  /** Last requested camera move; `nonce` makes repeated requests for the same preset distinct. */
  cameraRequest: {
    preset: CameraPreset;
    nonce: number;
    instant?: boolean;
    siteId?: string;
  } | null;
  /** Set by the camera rig when it moves: world view or the site being looked at. */
  scope: ViewScope;
  qualityMode: QualityMode;
  /** Tier currently rendered (equals the mode unless the mode is "auto"). */
  tier: QualityTier;
  status: WorldStatus;
  requestCamera(preset: CameraPreset, instant?: boolean): void;
  /** Fly to one site of the network (the facility view of that site). */
  requestSite(siteId: string, instant?: boolean): void;
  setScope(scope: ViewScope): void;
  setQualityMode(mode: QualityMode): void;
  setTier(tier: QualityTier): void;
  setStatus(status: WorldStatus): void;
}

export const useView = create<ViewState>()((set, get) => ({
  cameraRequest: null,
  scope: { kind: "world" },
  qualityMode: "auto",
  tier: "high",
  status: { kind: "loading" },
  requestCamera(preset, instant) {
    set({ cameraRequest: { preset, nonce: (get().cameraRequest?.nonce ?? 0) + 1, instant } });
  },
  requestSite(siteId, instant) {
    set({
      cameraRequest: {
        preset: "site",
        siteId,
        nonce: (get().cameraRequest?.nonce ?? 0) + 1,
        instant,
      },
    });
  },
  setScope(scope) {
    const now = get().scope;
    if (
      now.kind !== scope.kind ||
      (now.kind === "site" && scope.kind === "site" && now.siteId !== scope.siteId)
    )
      set({ scope });
  },
  setQualityMode(mode) {
    set(mode === "auto" ? { qualityMode: mode } : { qualityMode: mode, tier: mode });
  },
  setTier(tier) {
    set({ tier });
  },
  setStatus(status) {
    set({ status });
  },
}));

export function qualityFromSearch(search: string): QualityMode | null {
  const v = new URLSearchParams(search).get("quality");
  return v === "auto" || v === "high" || v === "medium" || v === "low" ? v : null;
}

/** Settings per tier. Every effect is switchable so its cost can be measured in isolation. */
export const TIER_SETTINGS: Record<
  QualityTier,
  { dpr: [number, number]; shadows: boolean; shadowMap: number; ao: boolean; smaa: boolean }
> = {
  high: { dpr: [1, 1.5], shadows: true, shadowMap: 2048, ao: true, smaa: true },
  medium: { dpr: [1, 1.5], shadows: true, shadowMap: 1024, ao: false, smaa: true },
  low: { dpr: [1, 1], shadows: false, shadowMap: 512, ao: false, smaa: false },
};

/**
 * Software rasterisers (no GPU acceleration) cannot sustain the High tier; Auto mode starts them
 * on Low. Matches the unmasked renderer strings of SwiftShader, Mesa llvmpipe/softpipe and
 * Microsoft's Basic Render Driver.
 */
export function isSoftwareRenderer(renderer: string): boolean {
  return /swiftshader|llvmpipe|softpipe|software|basic render driver/i.test(renderer);
}
