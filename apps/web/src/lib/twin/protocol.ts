import type { OptimizeOptions, StandbyPlan } from "@warehouse-one/twin";
import type { Snapshot } from "@warehouse-one/simulation";

/** What the workspace asks the twin to evaluate. */
export type EvaluationRequest =
  | {
      readonly kind: "optimize";
      readonly snapshot: Snapshot;
      readonly options: Partial<OptimizeOptions>;
    }
  | {
      readonly kind: "compare";
      readonly snapshot: Snapshot;
      readonly alternatives: readonly { readonly label?: string; readonly plan: StandbyPlan }[];
      readonly options: Partial<OptimizeOptions>;
    };
