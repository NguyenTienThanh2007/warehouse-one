/**
 * Deterministic, dependency-free hashing used for state fingerprints and event IDs.
 * cyrb128 is a fast non-cryptographic 128-bit hash: suitable for determinism checks and
 * integrity of snapshots against accidental corruption, NOT for security.
 */
export function cyrb128(input: string): [number, number, number, number] {
  let h1 = 1779033703,
    h2 = 3144134277,
    h3 = 1013904242,
    h4 = 2773480762;
  for (let i = 0; i < input.length; i++) {
    const k = input.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
}

const hex32 = (n: number) => n.toString(16).padStart(8, "0");

/** JSON serialization with sorted object keys, so equal values always produce equal strings. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error(`stableStringify: non-finite number ${value}`);
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

export function hashValue(value: unknown): string {
  return cyrb128(stableStringify(value)).map(hex32).join("");
}

/**
 * Deterministic RFC 9562 version-8 UUID derived from (simulation_id, sequence).
 * Replaying a simulation reproduces identical event IDs, which makes downstream
 * deduplication by event_id correct across replays and redeliveries.
 */
export function deterministicUuid(namespace: string, sequence: number): string {
  const h = cyrb128(`${namespace}:${sequence}`).map(hex32).join("");
  const variant = ((parseInt(h[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
