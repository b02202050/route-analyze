/** mulberry32：小而快的可重現 PRNG。種子每次請求隨機產生。 */
export type Rng = () => number;

export function createRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomSeed(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0];
}

export const uniform = (rng: Rng, min: number, max: number) => min + (max - min) * rng();
export const randInt = (rng: Rng, min: number, max: number) =>
  Math.floor(uniform(rng, min, max + 1));
export const pickSign = (rng: Rng) => (rng() < 0.5 ? -1 : 1);
