import type { SimulationConfig } from "@warehouse-one/simulation";

/** Simulated duration of `ticks` as m:ss (or h:mm:ss). */
export function formatTicks(config: SimulationConfig, ticks: number): string {
  const total = Math.max(0, Math.floor((ticks * config.tick_ms) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}
