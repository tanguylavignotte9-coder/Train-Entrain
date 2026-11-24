/** Utilitaires de pixel art : couleurs, police bitmap 3×5, roues, cercles. */
export type RGB = [number, number, number];

export function hex(c: string): RGB {
  const n = parseInt(c.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export const css = (c: RGB, a = 1) => (a >= 1 ? `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})` : `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`);
export const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
export const shade = (c: RGB, f: number): RGB => (f < 1 ? [c[0] * f, c[1] * f, c[2] * f] : mix(c, [255, 255, 255], f - 1));

export function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas'); c.width = Math.max(1, Math.ceil(w)); c.height = Math.max(1, Math.ceil(h));
  return c;
}
export function ctx2d(c: HTMLCanvasElement): CanvasRenderingContext2D {
  const x = c.getContext('2d')!; x.imageSmoothingEnabled = false; return x;
}

export function rect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, col: string) {
  c.fillStyle = col; c.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
}

// police 3×5
const FONT: Record<string, string> = {
  A: '010101111101101', B: '110101110101110', C: '011100100100011', D: '110101101101110', E: '111100110100111', F: '111100110100100',
  G: '011100101101011', H: '101101111101101', I: '111010010010111', J: '001001001101010', K: '101101110101101', L: '100100100100111',
  M: '101111111101101', N: '110101101101101', O: '010101101101010', P: '110101110100100', Q: '010101101111011', R: '110101110101101',
  S: '011100010001110', T: '111010010010010', U: '101101101101111', V: '101101101101010', W: '101101111111101', X: '101101010101101',
  Y: '101101010010010', Z: '111001010100111', '0': '111101101101111', '1': '010110010010111', '2': '110001010100111', '3': '110001010001110',
  '4': '101101111001001', '5': '111100110001110', '6': '011100111101111', '7': '111001010010010', '8': '111101111101111', '9': '111101111001110',
  '-': '000000111000000', '.': '000000000000010', ' ': '000000000000000', '/': '001001010100100', '%': '101001010100101', ':': '000010000010000',
};
const ACCENTS: Record<string, string> = { 'É': 'E', 'È': 'E', 'Ê': 'E', 'À': 'A', 'Â': 'A', 'Ô': 'O', 'Î': 'I', 'Ï': 'I', 'Ç': 'C', 'Ù': 'U', 'Û': 'U', 'Œ': 'O' };

export function textWidth(s: string): number { return s.length * 4 - 1; }
export function drawText(c: CanvasRenderingContext2D, s: string, x: number, y: number, col: string) {
  c.fillStyle = col;
  let cx = Math.round(x);
  for (const chRaw of s.toUpperCase()) {
    const ch = ACCENTS[chRaw] ?? chRaw;
    const g = FONT[ch] ?? FONT[' '];
    for (let i = 0; i < 15; i++) if (g[i] === '1') c.fillRect(cx + (i % 3), Math.round(y) + Math.floor(i / 3), 1, 1);
    cx += 4;
  }
}

// disque plein / anneau en pixels
export function disc(c: CanvasRenderingContext2D, cx: number, cy: number, r: number, col: string) {
  c.fillStyle = col;
  for (let y = -r; y <= r; y++) { const w = Math.floor(Math.sqrt(r * r + r * 0.6 - y * y)); c.fillRect(Math.round(cx) - w, Math.round(cy) + y, w * 2 + 1, 1); }
}

const wheelCache = new Map<string, HTMLCanvasElement>();
/** Roue avec rayons ; `frame` ∈ [0, 8). */
export function wheelSprite(r: number, frame: number, tire: string, hub: string, spoke: string): HTMLCanvasElement {
  const key = `${r}|${frame}|${tire}|${hub}|${spoke}`;
  let c = wheelCache.get(key); if (c) return c;
  c = makeCanvas(r * 2 + 1, r * 2 + 1); const x = ctx2d(c);
  disc(x, r, r, r, tire);
  if (r >= 3) disc(x, r, r, r - 1, hub);
  x.fillStyle = spoke;
  const ang = frame / 8 * Math.PI;
  for (let k = 0; k < (r >= 5 ? 3 : 2); k++) {
    const a = ang + k * Math.PI / (r >= 5 ? 3 : 2);
    for (let t = -r + 1; t <= r - 1; t += 0.5) x.fillRect(Math.round(r + Math.cos(a) * t), Math.round(r + Math.sin(a) * t), 1, 1);
  }
  x.fillStyle = tire; x.fillRect(r, r, 1, 1);
  wheelCache.set(key, c); return c;
}
