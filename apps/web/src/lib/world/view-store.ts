"use client";

import { create } from "zustand";

/** Camera presets. "focus" frames the current selection. */
export const CAMERA_PRESETS = ["overview", "docks", "aisle", "top", "focus"] as const;
export type CameraPreset = (typeof CAMERA_PRESETS)[number];

export const QUALITY_TIERS = ["high", "medium", "low"] as const;
export type QualityTier = (typeof QUALITY_TIERS)[number];
export type QualityMode = "auto" | QualityTier;

export type WorldStatus =
  { kind: "loading" } | { kind: "ready" } | { kind: "error"; reason: string };

interface ViewState {
  /** Last requested camera move; `nonce` makes repeated requests for the same preset distinct. */
  cameraRequest: { preset: CameraPreset; nonce: number; instant?: boolean } | null;
  qualityMode: QualityMode;
  /** Tier currently rendered (equals the mode unless the mode is "auto"). */
  tier: QualityTier;
  status: WorldStatus;
  requestCamera(preset: CameraPreset, instant?: boolean): void;
  setQualityMode(mode: QualityMode): void;
  setTier(tier: QualityTier): void;
  setStatus(status: WorldStatus): void;
}

export const useView = create<ViewState>()((set, get) => ({
  cameraRequest: null,
  qualityMode: "auto",
  tier: "high",
  status: { kind: "loading" },
  requestCamera(preset, instant) {
    set({ cameraRequest: { preset, nonce: (get().cameraRequest?.nonce ?? 0) + 1, instant } });
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
