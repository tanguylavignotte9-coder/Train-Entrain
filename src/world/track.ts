import { Rng, hashInts, hashString } from '../core/rng';
import { clamp, lerp, smooth, KMH } from '../core/util';
import { heightAt, riverAt, HSCALE, SEA_LEVEL, type World, type Edge } from './mapgen';

export const DS = 10; // pas d'échantillonnage de la voie (m)

export interface EdgeProfile {
  edgeId: number; n: number; // n+1 échantillons
  elev: Float32Array; ground: Float32Array; curv: Float32Array; tunnel: Uint8Array; bridge: Uint8Array;
}
const cache = new Map<string, EdgeProfile>();

export function edgeProfile(w: World, e: Edge): EdgeProfile {
  const key = w.seed + ':' + e.id;
  const hit = cache.get(key); if (hit) return hit;
  const A = w.cities[e.a], B = w.cities[e.b];
  const n = Math.round(e.lengthM / DS);
  const rng = new Rng(hashInts(hashString(w.seed), e.id, 77));
  const ground = new Float32Array(n + 1), t = new Float32Array(n + 1);
  const tH = new Float32Array(n + 1); const water = new Uint8Array(n + 1);
  for (let i = 0; i <= n; i++) {
    const f = i / n, x = lerp(A.x, B.x, f), y = lerp(A.y, B.y, f);
    tH[i] = heightAt(w, x, y) * HSCALE;
    water[i] = (riverAt(w, x, y) || heightAt(w, x, y) <= SEA_LEVEL) ? 1 : 0;
  }
  const h0 = tH[0], h1 = tH[n];
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    const dev = tH[i] - lerp(h0, h1, f);
    ground[i] = lerp(A.elev, B.elev, f) + dev * 0.55;
  }
  // déblais/remblais : lissage puis limitation des pentes
  const gmax = e.mountain > 0.5 ? 0.036 : 0.028;
  for (let i = 0; i <= n; i++) t[i] = ground[i];
  const tmp = new Float32Array(n + 1);
  for (let pass = 0; pass < 6; pass++) {
    for (let i = 0; i <= n; i++) {
      let s = 0, c = 0;
      for (let k = -18; k <= 18; k++) { const j = i + k; if (j >= 0 && j <= n) { s += t[j]; c++; } }
      tmp[i] = s / c;
    }
    t.set(tmp); t[0] = A.elev; t[n] = B.elev;
  }
  const flatEnds = (i: number) => {
    const d = Math.min(i, n - i), tgt = i < n / 2 ? A.elev : B.elev;
    return lerp(tgt, t[i], smooth(clamp((d - 25) / 50, 0, 1)));
  };
  for (let i = 0; i <= n; i++) t[i] = flatEnds(i);
  for (let it = 0; it < 4; it++) {
    t[0] = A.elev; for (let i = 1; i <= n; i++) t[i] = clamp(t[i], t[i - 1] - gmax * DS, t[i - 1] + gmax * DS);
    t[n] = B.elev; for (let i = n - 1; i >= 0; i--) t[i] = clamp(t[i], t[i + 1] - gmax * DS, t[i + 1] + gmax * DS);
  }
  // tunnels et ponts
  const tunnel = new Uint8Array(n + 1), bridge = new Uint8Array(n + 1);
  for (let i = 80; i <= n - 80; i++) {
    if (ground[i] - t[i] > 13) tunnel[i] = 1;
    else if (t[i] - ground[i] > 7 || water[i]) bridge[i] = 1;
  }
  const clean = (arr: Uint8Array, minLen: number, grow: number) => {
    let i = 0;
    while (i <= n) {
      if (!arr[i]) { i++; continue; }
      let j = i; while (j <= n && arr[j]) j++;
      if (j - i < minLen) for (let k = i; k < j; k++) arr[k] = 0;
      else { for (let k = Math.max(0, i - grow); k < i; k++) arr[k] = 1; for (let k = j; k < Math.min(n + 1, j + grow); k++) arr[k] = 1; }
      i = j + grow;
    }
  };
  clean(tunnel, 10, 4); clean(bridge, 3, 1);
  for (let i = 0; i <= n; i++) if (tunnel[i] && bridge[i]) bridge[i] = 0;
  // courbes
  const curv = new Float32Array(n + 1);
  const m = e.mountain;
  let s = Math.round(rng.range(15, 60));
  while (s < n - 25) {
    const len = Math.round(rng.range(12, 50) * (1 - m * 0.3));
    const R = m > 0.45 ? rng.range(200, 900) : rng.range(450, 3500);
    const sign = rng.chance(0.5) ? 1 : -1;
    for (let k = 0; k < len && s + k <= n - 20; k++) curv[s + k] = sign / R;
    s += len + Math.max(1, Math.round(rng.range(15, 90) * (1.3 - m)));
  }
  const p: EdgeProfile = { edgeId: e.id, n, elev: t, ground, curv, tunnel, bridge };
  cache.set(key, p);
  return p;
}

export type FeatureKind = 'station' | 'switch' | 'signal' | 'distant' | 'speedsign' | 'crossing' | 'worksite' | 'neutral' | 'stopmark' | 'buffer' | 'loopstart' | 'loopend' | 'curvesign' | 'block';
export interface Feature { s: number; kind: FeatureKind; len?: number; data?: Record<string, number | string | boolean> }
export interface LoopInfo { entryS: number; exitS: number; signalS: number; distantS: number; edgeIndex: number; pnj: boolean; spawnT: number; pnjSpeed: number; spawnS: number }

export interface Route {
  key: string; cities: number[]; edges: number[]; reversed: boolean[];
  length: number; n: number; startFront: number; nodeS: number[]; stopS: number; bufferS: number; edgeStartS: number[];
  elev: Float32Array; curv: Float32Array; tunnel: Uint8Array; bridge: Uint8Array; electrified: Uint8Array; limit: Float32Array;
  grade: Float32Array; ground: Float32Array;
  features: Feature[]; loops: LoopInfo[];
  year: number; electricRequired: boolean; hasUnelectrified: boolean;
}

export interface RouteOptions { trainLength: number; year: number; seed: string; day: number; electrifiedOf: (e: Edge) => boolean; slowKmh?: (e: Edge) => number | undefined }

export function lineSpeedLimit(e: Edge, eraKmh: number): number { return Math.min(e.maxSpeedKmh, eraKmh); }

export function buildRoute(w: World, cityPath: number[], edgePath: number[], opt: RouteOptions, eraKmh: number): Route {
  const rng = new Rng(hashInts(hashString(opt.seed), hashString(edgePath.join('-')), opt.day));
  const P0 = Math.round(opt.trainLength + 60), s0 = P0 + 150;
  const edges = edgePath.map(id => w.edges[id]);
  const reversed = edges.map((e, i) => e.a !== cityPath[i]);
  const total = edges.reduce((a, e) => a + e.lengthM, 0);
  const stopS = s0 + total + 220, bufferS = stopS + 70, length = bufferS + 330;
  const n = Math.ceil(length / DS);
  const elev = new Float32Array(n + 1), curv = new Float32Array(n + 1), tunnel = new Uint8Array(n + 1), bridge = new Uint8Array(n + 1);
  const electrified = new Uint8Array(n + 1), limit = new Float32Array(n + 1), ground = new Float32Array(n + 1);
  const nodeS: number[] = [s0], edgeStartS: number[] = [];
  const startElev = w.cities[cityPath[0]].elev, endElev = w.cities[cityPath[cityPath.length - 1]].elev;
  for (let i = 0; i <= n; i++) { elev[i] = i * DS <= s0 ? startElev : endElev; ground[i] = elev[i]; limit[i] = 40 * KMH; }
  const year = opt.year, t = clamp((year - 1905) / 115, 0, 1);
  const aLat = 0.85 + 0.45 * t;
  let cur = s0, hasUnel = false;
  const features: Feature[] = [];
  const loops: LoopInfo[] = [];
  edges.forEach((e, ei) => {
    edgeStartS.push(cur);
    const pr = edgeProfile(w, e); const rev = reversed[ei];
    const el = opt.electrifiedOf(e);
    if (!el) hasUnel = true;
    const slow = opt.slowKmh?.(e);
    const vLine = Math.min(lineSpeedLimit(e, eraKmh), slow ?? 999) * KMH;
    for (let i = 0; i <= pr.n; i++) {
      const src = rev ? pr.n - i : i;
      const gi = Math.round((cur + i * DS) / DS);
      if (gi > n) break;
      elev[gi] = pr.elev[src]; ground[gi] = pr.ground[src];
      curv[gi] = rev ? -pr.curv[src] : pr.curv[src];
      tunnel[gi] = pr.tunnel[src]; bridge[gi] = pr.bridge[src];
      electrified[gi] = el ? 1 : 0;
      const R = Math.abs(curv[gi]) > 1e-6 ? 1 / Math.abs(curv[gi]) : Infinity;
      limit[gi] = Math.min(vLine, Math.sqrt(aLat * R) * 1.0);
    }
    cur += e.lengthM; nodeS.push(cur);
  });
  // pads : voie plate avant/après, électrification prolongée
  for (let i = 0; i <= n; i++) {
    const s = i * DS;
    if (s < s0) { electrified[i] = electrified[Math.round(s0 / DS)]; limit[i] = 40 * KMH; }
    else if (s > nodeS[nodeS.length - 1]) { electrified[i] = electrified[Math.round(nodeS[nodeS.length - 1] / DS) - 1] ?? 0; }
  }
  // limites de gare / aiguillages
  const stationLimit = (s: number, r: number, v: number) => {
    for (let i = Math.max(0, Math.floor((s - r) / DS)); i <= Math.min(n, Math.ceil((s + r) / DS)); i++) limit[i] = Math.min(limit[i], v);
  };
  nodeS.forEach((s, i) => {
    const first = i === 0, last = i === nodeS.length - 1;
    if (first) { stationLimit(s, 400, 45 * KMH); features.push({ s: s, kind: 'switch', data: { city: cityPath[0] } }); }
    else if (!last) { stationLimit(s, 350, 50 * KMH); features.push({ s, kind: 'station', data: { city: cityPath[i], pass: true } }); }
    else { stationLimit(s, 700, 45 * KMH); features.push({ s, kind: 'switch', data: { city: cityPath[i] } }); }
  });
  for (let i = Math.floor((stopS - 450) / DS); i <= n; i++) limit[i] = Math.min(limit[i], 25 * KMH);
  for (let i = 0; i <= n; i++) if (i * DS > nodeS[0] + 120 && i * DS < nodeS[0] + 700) limit[i] = Math.min(limit[i], 60 * KMH);
  features.push({ s: stopS, kind: 'stopmark' }, { s: bufferS, kind: 'buffer' });
  // signaux de limitation : panneaux à chaque changement notable
  let lastLim = -1;
  for (let i = Math.round(s0 / DS); i < n; i++) {
    const v = Math.round(limit[i] / KMH / 10) * 10;
    if (v !== lastLim) { features.push({ s: i * DS - 30, kind: 'speedsign', data: { kmh: v } }); lastLim = v; }
  }
  // courbes : panneaux d'avertissement
  for (let i = 1; i < n; i++) if (Math.abs(curv[i]) > 1e-6 && Math.abs(curv[i - 1]) < 1e-6) features.push({ s: i * DS - 250, kind: 'curvesign', data: { r: Math.round(1 / Math.abs(curv[i])) } });
  // travaux temporaires
  edges.forEach((e, ei) => {
    const cnt = rng.chance(0.55) ? 1 : 0;
    for (let k = 0; k < cnt; k++) {
      const a = edgeStartS[ei] + rng.range(0.25, 0.7) * e.lengthM, len = rng.range(250, 450);
      const gi = Math.round(a / DS);
      if (tunnel[gi] || bridge[gi]) continue;
      const v = rng.pick([30, 40, 60]);
      stationLimit(a + len / 2, len / 2, v * KMH);
      features.push({ s: a - 500, kind: 'speedsign', data: { kmh: v, warn: true } }, { s: a, kind: 'worksite', len, data: { kmh: v } }, { s: a + len, kind: 'speedsign', data: { kmh: Math.round(limit[Math.min(n, gi + Math.round(len / DS) + 5)] / KMH / 10) * 10 } });
    }
  });
  // passages à niveau
  edges.forEach((e, ei) => {
    const cnt = Math.floor(e.lengthM / 3800);
    for (let k = 0; k < cnt; k++) {
      const a = edgeStartS[ei] + (k + 0.5 + rng.range(-0.25, 0.25)) / cnt * e.lengthM;
      const gi = Math.round(a / DS);
      let ok = true; for (let j = -4; j <= 4; j++) if (tunnel[gi + j] || bridge[gi + j]) ok = false;
      if (!ok) continue;
      const near = features.some(f => f.kind === 'worksite' && Math.abs(f.s - a) < 400);
      if (near) continue;
      features.push({ s: a, kind: 'crossing', data: { car: rng.chance(0.4), id: features.length } });
    }
  });
  // zones neutres (caténaire) aux jonctions entre sections électrifiées
  for (let i = 1; i < nodeS.length - 1; i++) {
    const s = nodeS[i]; features.push({ s: s - 70, kind: 'neutral', len: 140 });
  }
  // gares de croisement et trafic adverse
  edges.forEach((e, ei) => {
    if (e.lengthM < 9000) return;
    const mid = edgeStartS[ei] + e.lengthM * rng.range(0.42, 0.58);
    const gi = Math.round(mid / DS);
    let ok = true; for (let j = -30; j <= 30; j++) if (tunnel[gi + j] || bridge[gi + j]) ok = false;
    if (!ok) return;
    const entryS = mid - 200, exitS = mid + 200;
    const hasPnj = rng.chance(0.75);
    const pnjSpeed = rng.range(18, 24);
    const spawnS = exitS + 2600;
    const arriveLoop = (entryS - startFrontOf(opt.trainLength)) / 15 + rng.range(-10, 55);
    const spawnT = Math.max(0, arriveLoop - (spawnS - mid) / pnjSpeed);
    for (let i = Math.floor((entryS - 60) / DS); i <= Math.ceil((exitS + 60) / DS); i++) limit[i] = Math.min(limit[i], 50 * KMH);
    const info: LoopInfo = { entryS, exitS, signalS: exitS + 40, distantS: entryS - 700, edgeIndex: ei, pnj: hasPnj, spawnT, pnjSpeed, spawnS };
    loops.push(info);
    features.push({ s: entryS, kind: 'loopstart' }, { s: exitS, kind: 'loopend' }, { s: info.signalS, kind: 'signal', data: { loop: loops.length - 1 } }, { s: info.distantS, kind: 'distant', data: { loop: loops.length - 1 } });
  });
  // signaux de bloc décoratifs
  for (let s = s0 + 1500; s < stopS - 800; s += 2200 + rng.range(0, 900)) {
    if (loops.some(l => Math.abs(l.entryS - s) < 900)) continue;
    features.push({ s, kind: 'block' });
  }
  features.sort((a, b) => a.s - b.s);
  const grade = new Float32Array(n + 1);
  for (let i = 0; i < n; i++) grade[i] = (elev[i + 1] - elev[i]) / DS;
  grade[n] = grade[n - 1];
  for (const l of loops) { const li = l; void li; }
  return {
    key: edgePath.join('-') + ':' + cityPath[0], cities: cityPath, edges: edgePath, reversed, length, n, startFront: startFrontOf(opt.trainLength), nodeS, stopS, bufferS,
    edgeStartS, elev, curv, tunnel, bridge, electrified, limit, grade, ground, features, loops, year,
    electricRequired: false, hasUnelectrified: hasUnel,
  };
}
function startFrontOf(trainLength: number): number { return Math.round(trainLength + 60) - 20; }

const at = (arr: Float32Array | Uint8Array, s: number, n: number) => arr[clamp(Math.round(s / DS), 0, n)];
export const routeGrade = (r: Route, s: number) => at(r.grade, s, r.n);
export const routeElev = (r: Route, s: number) => at(r.elev, s, r.n);
export const routeCurv = (r: Route, s: number) => at(r.curv, s, r.n);
export const routeLimit = (r: Route, s: number) => at(r.limit, s, r.n);
export const routeTunnel = (r: Route, s: number) => at(r.tunnel, s, r.n) === 1;
export const routeBridge = (r: Route, s: number) => at(r.bridge, s, r.n) === 1;
export const routeElectrified = (r: Route, s: number) => at(r.electrified, s, r.n) === 1;
export function routeEdgeIndex(r: Route, s: number): number {
  let k = 0; for (let i = 0; i < r.edgeStartS.length; i++) if (s >= r.edgeStartS[i]) k = i; return k;
}
/** Position cartographique approximative (cellules) d'une abscisse de route, pour le décor. */
export function routeMapPos(w: World, r: Route, s: number, off = 0): { x: number; y: number } {
  const ei = clamp(routeEdgeIndex(r, s), 0, r.edges.length - 1);
  const e = w.edges[r.edges[ei]];
  const from = w.cities[r.cities[ei]], to = w.cities[r.cities[ei + 1]];
  const f = clamp((s - r.edgeStartS[ei]) / e.lengthM, 0, 1);
  const dx = to.x - from.x, dy = to.y - from.y, L = Math.hypot(dx, dy) || 1;
  return { x: lerp(from.x, to.x, f) + (-dy / L) * off, y: lerp(from.y, to.y, f) + (dx / L) * off };
}
