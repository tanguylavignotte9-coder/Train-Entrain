export const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smooth = (t: number) => t * t * (3 - 2 * t);
export const KMH = 1 / 3.6;
export const toKmh = (ms: number) => ms * 3.6;
export const G = 9.81;

export function fmtMoney(n: number): string {
  const s = Math.round(Math.abs(n)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return (n < 0 ? '−' : '') + s + ' Cr';
}
export function fmtNum(n: number, d = 0): string {
  return n.toFixed(d).replace('.', ',');
}
export function fmtTime(sec: number): string {
  sec = Math.max(0, Math.round(sec));
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}
export function mean(a: number[]): number { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }
