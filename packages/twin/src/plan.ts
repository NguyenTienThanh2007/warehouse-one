import type { SetStandbyCommand } from "@warehouse-one/contracts";
import {
  standbyCapacity,
  standbyProblem,
  type SimulationConfig,
  type SimulationState,
} from "@warehouse-one/simulation";

/**
 * A fleet standby plan: for every line-haul truck, the site where it waits while idle (null: its
 * home stall at the depot). Plans always cover the whole fleet, sorted by vehicle id, so equal
 * plans are equal values.
 */
export interface StandbyAssignment {
  readonly vehicle_id: string;
  readonly site_id: string | null;
}
export interface StandbyPlan {
  readonly assignments: readonly StandbyAssignment[];
}

export interface PlanChange {
  readonly vehicle_id: string;
  readonly from: string | null;
  readonly to: string | null;
}

/** A hard constraint and whether a plan meets it. `stage` says where it was checked. */
export interface ConstraintResult {
  readonly id: string;
  readonly label: string;
  readonly stage: "plan" | "simulation";
  readonly satisfied: boolean;
  readonly detail: string;
}

export function makePlan(assignments: readonly StandbyAssignment[]): StandbyPlan {
  return {
    assignments: [...assignments].sort((a, b) => a.vehicle_id.localeCompare(b.vehicle_id)),
  };
}

/** The standby settings in effect in a state. */
export function currentPlan(state: SimulationState): StandbyPlan {
  return makePlan(
    Object.values(state.network?.vehicles ?? {}).map((v) => ({
      vehicle_id: v.id,
      site_id: v.standby_site ?? null,
    })),
  );
}

export function planChanges(from: StandbyPlan, to: StandbyPlan): PlanChange[] {
  const before = new Map(from.assignments.map((a) => [a.vehicle_id, a.site_id]));
  return to.assignments
    .filter((a) => (before.get(a.vehicle_id) ?? null) !== a.site_id)
    .map((a) => ({
      vehicle_id: a.vehicle_id,
      from: before.get(a.vehicle_id) ?? null,
      to: a.site_id,
    }));
}

/** Trucks per standby site ("home" for the depot). */
export function planCounts(plan: StandbyPlan): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const a of plan.assignments) {
    const key = a.site_id ?? "home";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/**
 * The engine commands that turn `from` into `to`. Trucks leaving a site are cleared first, so no
 * site is ever over its standby capacity between two commands of the same tick.
 */
export function planCommands(
  from: StandbyPlan,
  to: StandbyPlan,
  idPrefix: string,
): SetStandbyCommand[] {
  const changes = planChanges(from, to);
  const commands: SetStandbyCommand[] = [];
  for (const c of changes.filter((x) => x.from !== null))
    commands.push({
      command_id: `${idPrefix}-${commands.length + 1}`,
      type: "linehaul.set_standby",
      payload: { vehicle_id: c.vehicle_id, site_id: null },
    });
  for (const c of changes.filter((x) => x.to !== null))
    commands.push({
      command_id: `${idPrefix}-${commands.length + 1}`,
      type: "linehaul.set_standby",
      payload: { vehicle_id: c.vehicle_id, site_id: c.to },
    });
  return commands;
}

/** Check a plan against the network's hard rules before it is simulated. */
export function validatePlan(
  config: SimulationConfig,
  state: SimulationState,
  plan: StandbyPlan,
): ConstraintResult[] {
  const net = config.network;
  const fleet = Object.keys(state.network?.vehicles ?? {}).sort();
  const ids = plan.assignments.map((a) => a.vehicle_id);
  const unknown = ids.filter((id) => !fleet.includes(id));
  const missing = fleet.filter((id) => !ids.includes(id));
  const duplicated = ids.filter((id, i) => ids.indexOf(id) !== i);
  const out: ConstraintResult[] = [
    {
      id: "fleet_coverage",
      label: "Every truck of the fleet exactly once",
      stage: "plan",
      satisfied: unknown.length + missing.length + duplicated.length === 0,
      detail:
        unknown.length + missing.length + duplicated.length === 0
          ? `${fleet.length} trucks`
          : [
              unknown.length ? `unknown: ${unknown.join(", ")}` : "",
              missing.length ? `missing: ${missing.join(", ")}` : "",
              duplicated.length ? `twice: ${duplicated.join(", ")}` : "",
            ]
              .filter(Boolean)
              .join("; "),
    },
  ];
  const ineligible = net
    ? plan.assignments.flatMap((a) => {
        const problem = a.site_id === null ? null : standbyProblem(net, a.site_id);
        return problem ? [`${a.vehicle_id}: ${problem}`] : [];
      })
    : ["no logistics network"];
  out.push({
    id: "site_eligibility",
    label: "Standby only at sites with staging stalls",
    stage: "plan",
    satisfied: ineligible.length === 0,
    detail: ineligible.length ? ineligible.join("; ") : "terminal, cross-dock and DC only",
  });
  const over = net
    ? Object.entries(planCounts(plan)).flatMap(([site, n]) =>
        site !== "home" && standbyProblem(net, site) === null && n > standbyCapacity(net, site)
          ? [`${n} at ${site}, capacity ${standbyCapacity(net, site)}`]
          : [],
      )
    : [];
  out.push({
    id: "stall_capacity",
    label: "Standby trucks fit, with one staging stall left free per site",
    stage: "plan",
    satisfied: over.length === 0,
    detail: over.length ? over.join("; ") : "within capacity",
  });
  return out;
}
