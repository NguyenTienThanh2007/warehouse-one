"""Pure rules of the proposal lifecycle (no I/O; unit-tested).

The server never trusts the browser's verdict. On creation it checks the evaluation against the
snapshot it came with, re-checks the recommended plan's hard rules from the snapshot's own
network configuration, recomputes every delta from the metrics and derives the engine commands
an execution may submit. The same freshness rule as packages/twin/src/context.ts decides whether
a proposal still describes the live run.
"""

import math
from dataclasses import dataclass
from typing import Any

from pydantic import ValidationError

from warehouse_api.contracts.commands import COMMAND_ADAPTER
from warehouse_api.twin.schemas import (
    Candidate,
    Evaluation,
    FleetMetrics,
    InputSnapshot,
    LiveContext,
    MetricDelta,
    MetricKey,
    StandbyPlan,
    ValidationCheck,
)

SUPPORTED_STRATEGIES = {("fleet-standby", "1.0.0")}
PRIMARY_METRIC: MetricKey = "pickup_wait_s"

# key -> (unit, better), in the order of packages/twin/src/metrics.ts METRICS.
METRICS: dict[MetricKey, tuple[str, str]] = {
    "pickup_wait_s": ("s", "lower"),
    "pickup_wait_p90_s": ("s", "lower"),
    "empty_km": ("km", "lower"),
    "loaded_km": ("km", "info"),
    "transfers_planned": ("transfers", "info"),
    "pallets_planned": ("pallets", "info"),
    "transfers_delivered": ("transfers", "higher"),
    "pallets_delivered": ("pallets", "higher"),
    "transfers_cancelled": ("transfers", "lower"),
    "transfers_waiting_end": ("transfers", "lower"),
    "lead_time_s": ("s", "lower"),
}

# Lifecycle (DEC-040). Terminal states have no outgoing transitions.
TRANSITIONS: dict[str, tuple[str, ...]] = {
    "generated": ("validated", "not_actionable", "invalid"),
    "validated": ("approved", "rejected", "expired", "superseded"),
    "approved": ("executing", "rejected", "expired"),
    "executing": ("applied", "failed"),
    "not_actionable": (),
    "invalid": (),
    "rejected": (),
    "applied": (),
    "failed": (),
    "expired": (),
    "superseded": (),
}


def can_transition(current: str, target: str) -> bool:
    return target in TRANSITIONS.get(current, ())


def js_round(x: float, digits: int) -> float:
    """Math.round(x * 10^d) / 10^d, as the TypeScript side rounds (half towards +infinity)."""
    f = 10.0**digits
    return math.floor(x * f + 0.5) / f


def metric_delta(key: MetricKey, baseline: float | None, candidate: float | None) -> MetricDelta:
    unit, better = METRICS[key]
    abs_ = None if baseline is None or candidate is None else js_round(candidate - baseline, 3)
    pct = None if abs_ is None or not baseline else js_round(abs_ / abs(baseline) * 100, 1)
    improved = (
        None if abs_ is None or better == "info" else (abs_ < 0 if better == "lower" else abs_ > 0)
    )
    return MetricDelta.model_validate(
        {
            "key": key,
            "unit": unit,
            "better": better,
            "baseline": baseline,
            "candidate": candidate,
            "abs": abs_,
            "pct": pct,
            "improved": improved,
        }
    )


def compare_metrics(baseline: FleetMetrics, candidate: FleetMetrics) -> list[MetricDelta]:
    return [metric_delta(k, getattr(baseline, k), getattr(candidate, k)) for k in METRICS]


# ---------------------------------------------------------------------------------------------
# Plan rules, from the snapshot's own configuration (independent of the browser's checks)


def _network(snapshot: InputSnapshot) -> tuple[dict[str, Any], dict[str, Any]]:
    net = snapshot.config.get("network")
    state_net = snapshot.state.get("network")
    if not isinstance(net, dict) or not isinstance(state_net, dict):
        return {}, {}
    return net, state_net


def standby_capacity(site: dict[str, Any]) -> int:
    if site.get("kind") in ("gateway", "fleet_depot"):
        return 0
    stalls = sum(1 for s in site.get("stands", []) if s.get("kind") == "staging")
    return max(0, stalls - 1)


def snapshot_plan(snapshot: InputSnapshot) -> list[tuple[str, str | None]]:
    """(vehicle, standby site) pairs in the snapshot's state, sorted by vehicle id."""
    _, state_net = _network(snapshot)
    vehicles = state_net.get("vehicles", {})
    return sorted((vid, v.get("standby_site")) for vid, v in vehicles.items())


def plan_problems(snapshot: InputSnapshot, plan: StandbyPlan) -> list[str]:
    net, state_net = _network(snapshot)
    if not net:
        return ["the snapshot has no logistics network"]
    sites = {s["id"]: s for s in net.get("sites", []) if isinstance(s, dict) and "id" in s}
    fleet = sorted(state_net.get("vehicles", {}))
    ids = [a.vehicle_id for a in plan.assignments]
    problems: list[str] = []
    if sorted(ids) != fleet:
        problems.append(f"the plan must name each of the {len(fleet)} trucks exactly once")
    counts: dict[str, int] = {}
    for a in plan.assignments:
        if a.site_id is None:
            continue
        site = sites.get(a.site_id)
        if site is None:
            problems.append(f"{a.vehicle_id}: unknown site {a.site_id}")
            continue
        if standby_capacity(site) == 0:
            problems.append(f"{a.vehicle_id}: trucks cannot stand by at {a.site_id}")
            continue
        counts[a.site_id] = counts.get(a.site_id, 0) + 1
    for site_id, n in sorted(counts.items()):
        cap = standby_capacity(sites[site_id])
        if n > cap:
            problems.append(f"{n} trucks at {site_id}, capacity {cap} (one stall stays free)")
    return problems


def plan_commands(
    base: list[tuple[str, str | None]], plan: StandbyPlan, prefix: str
) -> list[dict[str, Any]]:
    """The engine commands that turn `base` into `plan`; clears first (as planCommands in TS)."""
    before = dict(base)
    changes = [
        (a.vehicle_id, before.get(a.vehicle_id), a.site_id)
        for a in sorted(plan.assignments, key=lambda a: a.vehicle_id)
        if before.get(a.vehicle_id) != a.site_id
    ]
    commands: list[dict[str, Any]] = []
    for vehicle, old, _new in changes:
        if old is not None:
            commands.append(_standby(f"{prefix}-{len(commands) + 1}", vehicle, None))
    for vehicle, _old, new in changes:
        if new is not None:
            commands.append(_standby(f"{prefix}-{len(commands) + 1}", vehicle, new))
    return commands


def _standby(command_id: str, vehicle: str, site: str | None) -> dict[str, Any]:
    return {
        "command_id": command_id,
        "type": "linehaul.set_standby",
        "payload": {"vehicle_id": vehicle, "site_id": site},
    }


# ---------------------------------------------------------------------------------------------
# Validation of a new proposal


@dataclass(frozen=True)
class Validated:
    status: str  # validated | not_actionable | invalid
    checks: list[ValidationCheck]
    commands: list[dict[str, Any]]
    evaluation: Evaluation  # with server-computed deltas


def _check(id_: str, label: str, passed: bool, detail: str) -> ValidationCheck:
    return ValidationCheck(id=id_, label=label, passed=passed, detail=detail)


def validate(evaluation: Evaluation, snapshot: InputSnapshot, prefix: str) -> Validated:
    src = evaluation.source
    state_tick = snapshot.state.get("tick")
    checks = [
        _check(
            "strategy_supported",
            "Strategy and version are supported by this server",
            (evaluation.strategy.id, evaluation.strategy.version) in SUPPORTED_STRATEGIES,
            f"{evaluation.strategy.id} {evaluation.strategy.version}",
        ),
        _check(
            "snapshot_matches_source",
            "The stored snapshot is the state the evaluation names",
            snapshot.state_hash == src.state_hash
            and str(snapshot.config.get("simulation_id")) == str(src.simulation_id)
            and state_tick == src.tick,
            f"hash {snapshot.state_hash}, tick {state_tick}",
        ),
        _check(
            "baseline_is_plan_in_effect",
            "The baseline is the standby plan in effect in the snapshot",
            [(a.vehicle_id, a.site_id) for a in evaluation.baseline.plan.assignments]
            == snapshot_plan(snapshot),
            f"{len(evaluation.baseline.plan.assignments)} trucks",
        ),
    ]
    # Recompute every delta from the metrics: the stored figures are the server's own arithmetic.
    candidates: list[Candidate] = []
    for c in evaluation.candidates:
        deltas = compare_metrics(evaluation.baseline.metrics, c.metrics) if c.metrics else []
        candidates.append(c.model_copy(update={"deltas": deltas}))
    evaluation = evaluation.model_copy(update={"candidates": candidates})

    rec = evaluation.recommendation
    commands: list[dict[str, Any]] = []
    if rec is None:
        status = "not_actionable" if all(c.passed for c in checks) else "invalid"
        return Validated(status, checks, commands, evaluation)

    chosen = next((c for c in candidates if c.candidate_id == rec.candidate_id), None)
    checks.append(
        _check(
            "recommendation_consistent",
            "The recommended candidate exists, is feasible and met every constraint",
            chosen is not None
            and chosen.verdict == "recommended"
            and chosen.feasible
            and chosen.metrics is not None
            and all(c.satisfied for c in chosen.constraints),
            rec.candidate_id,
        )
    )
    if chosen is not None and chosen.metrics is not None:
        problems = plan_problems(snapshot, chosen.plan)
        checks.append(
            _check(
                "plan_rules",
                "The plan meets the network's standby rules (checked by the server)",
                not problems,
                "; ".join(problems) or "fleet covered, eligible sites, within stall capacity",
            )
        )
        base, cand, o = evaluation.baseline.metrics, chosen.metrics, evaluation.options
        wait_b, wait_c = base.pickup_wait_s, cand.pickup_wait_s
        gain_s = js_round(wait_b - wait_c, 1) if wait_b is not None and wait_c is not None else 0.0
        gain_pct = js_round(gain_s / wait_b * 100, 1) if wait_b else 0.0
        checks.append(
            _check(
                "objective_improves",
                f"Mean pickup wait falls by at least {o.min_improvement_pct} % and "
                f"{o.min_improvement_s} s (recomputed)",
                gain_s > 0 and gain_s >= o.min_improvement_s and gain_pct >= o.min_improvement_pct,
                f"{wait_b} s → {wait_c} s ({-gain_pct} %)",
            )
        )
        floor = math.ceil(base.pallets_delivered * o.service_floor_pct / 100)
        checks.append(
            _check(
                "service_level",
                f"Delivers at least {o.service_floor_pct} % of the baseline's pallets and no more "
                "cancellations (recomputed)",
                cand.pallets_delivered >= floor
                and cand.transfers_cancelled <= base.transfers_cancelled,
                f"{cand.pallets_delivered} pallets (floor {floor}), "
                f"{cand.transfers_cancelled} cancelled (baseline {base.transfers_cancelled})",
            )
        )
        commands = plan_commands(snapshot_plan(snapshot), chosen.plan, prefix)
        bad: list[str] = []
        for cmd in commands:
            try:
                COMMAND_ADAPTER.validate_python(cmd)
            except ValidationError as exc:
                bad.append(f"{cmd['command_id']}: {exc.errors()[0]['msg']}")
        checks.append(
            _check(
                "commands_valid",
                "Execution commands match the command contract",
                bool(commands) and not bad,
                "; ".join(bad) or f"{len(commands)} linehaul.set_standby commands",
            )
        )
    status = "validated" if all(c.passed for c in checks) else "invalid"
    return Validated(status, checks, commands if status == "validated" else [], evaluation)


# ---------------------------------------------------------------------------------------------
# Freshness (same rule as packages/twin/src/context.ts `freshness`)


@dataclass(frozen=True)
class Stale:
    reason: str
    message: str


def staleness(row: dict[str, Any], live: LiveContext, max_age_ticks: int) -> Stale | None:
    if str(live.simulation_id) != str(row["simulation_id"]) or (
        live.config_hash != row["config_hash"]
    ):
        return Stale(
            "other_run",
            "The live simulation is a different run or scenario than the one evaluated.",
        )
    if live.tick < row["source_tick"]:
        return Stale(
            "run_restarted", "The live run is earlier than the evaluated state: it was reset."
        )
    if live.fleet_fingerprint != row["fleet_fingerprint"]:
        return Stale("fleet_changed", "The fleet's standby settings changed after the evaluation.")
    age = live.tick - row["source_tick"]
    if age > max_age_ticks:
        return Stale(
            "too_old",
            f"The evaluation is {age} ticks old; proposals stay valid for {max_age_ticks} ticks.",
        )
    return None
