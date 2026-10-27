import type { Snapshot } from "@warehouse-one/simulation";
import { compareStandbyPlans, optimizeStandby, type Evaluation } from "./optimizer";

export interface VerifyResult {
  readonly ok: boolean;
  readonly evaluation_id: string;
  readonly mismatches: readonly string[];
}

/**
 * Re-run a stored evaluation from its stored snapshot and compare every figure. An optimisation is
 * re-optimised with the same options; a what-if re-compares the same plans. Deltas are compared
 * too, so a proposal whose numbers were computed (or stored) differently does not verify.
 */
export async function verifyEvaluation(
  stored: Evaluation,
  snapshot: Snapshot,
): Promise<VerifyResult> {
  const again =
    stored.kind === "optimization"
      ? await optimizeStandby(snapshot, stored.options)
      : await compareStandbyPlans(
          snapshot,
          stored.candidates.map((c) => ({ label: c.label, plan: c.plan })),
          stored.options,
        );
  const mismatches: string[] = [];
  const same = (what: string, a: unknown, b: unknown) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) mismatches.push(what);
  };
  same("evaluation_id", again.evaluation_id, stored.evaluation_id);
  same("source", again.source, stored.source);
  same("baseline.metrics", again.baseline.metrics, stored.baseline.metrics);
  same("candidates.length", again.candidates.length, stored.candidates.length);
  for (const [i, c] of again.candidates.entries()) {
    const s = stored.candidates[i];
    same(`${c.candidate_id}.plan`, c.plan, s?.plan);
    same(`${c.candidate_id}.metrics`, c.metrics, s?.metrics);
    same(`${c.candidate_id}.deltas`, c.deltas, s?.deltas);
    same(`${c.candidate_id}.verdict`, c.verdict, s?.verdict);
  }
  same("recommendation", again.recommendation?.candidate_id, stored.recommendation?.candidate_id);
  return { ok: mismatches.length === 0, evaluation_id: stored.evaluation_id, mismatches };
}
