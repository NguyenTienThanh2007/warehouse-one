import { checkInvariants, validateConfig } from "./engine";
import { hashValue } from "./hash";
import {
  ENGINE_VERSION,
  SNAPSHOT_VERSION,
  type SimulationConfig,
  type SimulationState,
} from "./types";

export interface Snapshot {
  readonly snapshot_version: number;
  readonly engine_version: string;
  readonly config: SimulationConfig;
  readonly state: SimulationState;
  /** Fingerprint of {config, state}; detects corruption or tampering-by-accident on load. */
  readonly state_hash: string;
}

export function stateHash(config: SimulationConfig, state: SimulationState): string {
  return hashValue({ config, state });
}

export function createSnapshot(config: SimulationConfig, state: SimulationState): Snapshot {
  return {
    snapshot_version: SNAPSHOT_VERSION,
    engine_version: ENGINE_VERSION,
    config,
    state,
    state_hash: stateHash(config, state),
  };
}

export function serializeSnapshot(snapshot: Snapshot): string {
  return JSON.stringify(snapshot);
}

/** Parse and verify a snapshot. Throws a descriptive error for anything unsupported or corrupt. */
export function loadSnapshot(json: string): Snapshot {
  const raw = JSON.parse(json) as Partial<Snapshot>;
  if (raw.snapshot_version !== SNAPSHOT_VERSION) {
    throw new Error(
      `unsupported snapshot_version ${String(raw.snapshot_version)} (expected ${SNAPSHOT_VERSION})`,
    );
  }
  if (!raw.config || !raw.state || typeof raw.state_hash !== "string")
    throw new Error("snapshot is missing fields");
  const problems = validateConfig(raw.config);
  if (problems.length > 0) throw new Error(`snapshot config invalid: ${problems.join("; ")}`);
  if (stateHash(raw.config, raw.state) !== raw.state_hash)
    throw new Error("snapshot hash mismatch: data is corrupt");
  const violations = checkInvariants(raw.config, raw.state);
  if (violations.length > 0)
    throw new Error(`snapshot violates invariants: ${violations.join("; ")}`);
  return raw as Snapshot;
}
