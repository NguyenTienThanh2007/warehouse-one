"use client";

import { EffectComposer, N8AO, SMAA, ToneMapping } from "@react-three/postprocessing";
import { ToneMappingMode } from "postprocessing";
import { TIER_SETTINGS, type QualityTier } from "@/lib/world/view-store";

/**
 * Post-processing per quality tier. High: ambient occlusion (N8AO, half resolution) + SMAA.
 * Medium: SMAA only. Low: none (the renderer's own AgX tone mapping applies).
 */
export function Effects({ tier }: { tier: QualityTier }) {
  const s = TIER_SETTINGS[tier];
  if (!s.ao && !s.smaa) return null;
  return (
    <EffectComposer multisampling={0} enableNormalPass={false}>
      {s.ao ? (
        <N8AO
          halfRes
          aoRadius={1.6}
          distanceFalloff={0.6}
          intensity={2.4}
          quality="medium"
          color="#0b0d10"
        />
      ) : (
        <></>
      )}
      <ToneMapping mode={ToneMappingMode.AGX} />
      {s.smaa ? <SMAA /> : <></>}
    </EffectComposer>
  );
}
