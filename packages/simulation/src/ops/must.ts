/**
 * Unwrap a value the engine's own invariants guarantee to exist. Throws a descriptive engine error
 * instead of silently assuming (an invalid command can never reach here; handlers validate first).
 */
export function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`invariant violated: missing ${what}`);
  return value;
}
