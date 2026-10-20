import { cyrb128 } from "./hash";

/**
 * Seeded PRNG (sfc32). The full generator state is four uint32 values stored inside the
 * simulation state, so snapshots capture it and restore resumes the identical random stream.
 * All functions are pure: they return the drawn value together with the next state.
 */
export type RngState = readonly [number, number, number, number];

export function seedRng(seed: string): RngState {
  let s: RngState = cyrb128(seed);
  // Discard initial outputs to decorrelate similar seeds.
  for (let i = 0; i < 12; i++) s = nextU32(s)[1];
  return s;
}

export function nextU32(state: RngState): [number, RngState] {
  let [a, b, c, d] = state;
  const t = (((a + b) | 0) + d) | 0;
  d = (d + 1) | 0;
  a = b ^ (b >>> 9);
  b = (c + (c << 3)) | 0;
  c = (c << 21) | (c >>> 11);
  c = (c + t) | 0;
  return [t >>> 0, [a >>> 0, b >>> 0, c >>> 0, d >>> 0]];
}

/** Uniform float in [0, 1). */
export function nextFloat(state: RngState): [number, RngState] {
  const [u, next] = nextU32(state);
  return [u / 4294967296, next];
}

/** Uniform integer in [min, max] inclusive. */
export function nextInt(state: RngState, min: number, max: number): [number, RngState] {
  if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) {
    throw new RangeError(`nextInt: invalid range [${min}, ${max}]`);
  }
  const [f, next] = nextFloat(state);
  return [min + Math.floor(f * (max - min + 1)), next];
}
