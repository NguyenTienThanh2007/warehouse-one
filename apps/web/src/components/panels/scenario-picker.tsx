"use client";

import { SCENARIO_IDS, createScenario, type ScenarioId } from "@warehouse-one/simulation";
import { useMemo } from "react";
import { useSimulation } from "@/lib/sim/store";

export function ScenarioPicker() {
  const scenarioId = useSimulation((s) => s.scenarioId);
  const loadScenario = useSimulation((s) => s.loadScenario);
  const options = useMemo(
    () => SCENARIO_IDS.map((id) => ({ id, label: createScenario(id).label })),
    [],
  );
  return (
    <label className="panel pointer-events-auto flex items-center gap-2 px-3 py-2 text-xs">
      <span className="text-fog-400">Scenario</span>
      <select
        value={scenarioId}
        data-testid="scenario-picker"
        onChange={(e) => {
          const id = e.target.value as ScenarioId;
          loadScenario(id);
          const url = new URL(window.location.href);
          url.searchParams.set("scenario", id);
          window.history.replaceState(null, "", url);
        }}
        className="rounded-md bg-ink-800 px-2 py-1 text-fog-50 outline-none"
      >
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
