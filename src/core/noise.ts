import { Rng } from './rng';

/** Bruit de valeur 2D lissé, déterministe selon la graine. Valeurs dans [-1, 1]. */
export function makeNoise2D(seed: number | string): (x: number, y: number) => number {
  const rng = new Rng(seed);
  const SIZE = 256;
  const perm = new Uint8Array(SIZE * 2);
  const vals = new Float32Array(SIZE);
  const p = Array.from({ length: SIZE }, (_, i) => i);
  rng.shuffle(p);
  for (let i = 0; i < SIZE; i++) { perm[i] = perm[i + SIZE] = p[i]; vals[i] = rng.next() * 2 - 1; }
  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
  const h = (xi: number, yi: number) => vals[perm[(perm[xi & 255] + yi) & 255 ]];
  return (x: number, y: number) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = fade(xf), v = fade(yf);
    const a = h(xi, yi), b = h(xi + 1, yi), c = h(xi, yi + 1), d = h(xi + 1, yi + 1);
    return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
  };
}

export function fbm(n: (x: number, y: number) => number, x: number, y: number, oct = 5, lac = 2, gain = 0.5): number {
  let amp = 1, f = 1, sum = 0, norm = 0;
  for (let i = 0; i < oct; i++) {
    sum += amp * n(x * f + i * 17.3, y * f - i * 9.1);
    norm += amp; amp *= gain; f *= lac;
  }
  return sum / norm;
}
