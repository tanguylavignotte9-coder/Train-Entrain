import { Rng, hashString } from '../core/rng';
import { makeNoise2D, fbm } from '../core/noise';
import { clamp, lerp, smooth } from '../core/util';
import { cityName, regionName, countryName } from './names';
import { INDUSTRIES } from '../data';

export const WORLD_SIZE = 168;
export const SEA_LEVEL = 0.36;
export const HSCALE = 720; // mètres de relief pour une hauteur de 1.0 (relief comprimé)
export const CELL_M = 620; // mètres de jeu par cellule (avant compression)

export enum Biome { Ocean = 0, Beach, Plains, Forest, Hills, Mountain, Snow }
export const BIOME_NAMES = ['Mer', 'Plage', 'Plaine', 'Forêt', 'Collines', 'Montagne', 'Sommets'];

export interface City {
  id: number; name: string; x: number; y: number; pop: number; elev: number; region: number;
  industries: string[]; coastal: boolean; terrain: string; connected: boolean;
}
export interface Region { id: number; name: string; cx: number; cy: number; hue: number }
export interface Edge {
  id: number; a: number; b: number; lengthM: number; kind: 'main' | 'branch' | 'shortcut';
  initial: boolean; maxSpeedKmh: number; electrifiedYear: number | null; mountain: number; buildCost: number;
}
export interface World {
  seed: string; country: string; size: number;
  height: Float32Array; moisture: Float32Array; biome: Uint8Array; regionMap: Int8Array; river: Uint8Array;
  cities: City[]; regions: Region[]; edges: Edge[];
}

const idx = (x: number, y: number, n = WORLD_SIZE) => y * n + x;

export function heightAt(w: World, x: number, y: number): number {
  const n = w.size;
  x = clamp(x, 0, n - 1.001); y = clamp(y, 0, n - 1.001);
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const h = w.height;
  const a = h[idx(xi, yi, n)], b = h[idx(xi + 1, yi, n)], c = h[idx(xi, yi + 1, n)], d = h[idx(xi + 1, yi + 1, n)];
  return (a * (1 - xf) + b * xf) * (1 - yf) + (c * (1 - xf) + d * xf) * yf;
}
export function biomeAt(w: World, x: number, y: number): Biome {
  const n = w.size;
  return w.biome[idx(clamp(Math.round(x), 0, n - 1), clamp(Math.round(y), 0, n - 1), n)] as Biome;
}
export function riverAt(w: World, x: number, y: number): boolean {
  const n = w.size;
  return w.river[idx(clamp(Math.round(x), 0, n - 1), clamp(Math.round(y), 0, n - 1), n)] === 1;
}
export function cityDist(a: City, b: City): number { return Math.hypot(a.x - b.x, a.y - b.y); }

function segIntersect(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): boolean {
  const o = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) => (qx - px) * (ry - py) - (qy - py) * (rx - px);
  const d1 = o(ax, ay, bx, by, cx, cy), d2 = o(ax, ay, bx, by, dx, dy), d3 = o(cx, cy, dx, dy, ax, ay), d4 = o(cx, cy, dx, dy, bx, by);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

export function generateWorld(seed: string): World {
  const rng = new Rng(hashString('world:' + seed));
  const N = WORLD_SIZE;
  const nH = makeNoise2D(rng.next() * 1e9), nM = makeNoise2D(rng.next() * 1e9), nR = makeNoise2D(rng.next() * 1e9), nW = makeNoise2D(rng.next() * 1e9);
  const height = new Float32Array(N * N), moisture = new Float32Array(N * N);
  const ox = rng.range(-0.1, 0.1), oy = rng.range(-0.1, 0.1);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const fx = x / N, fy = y / N;
    // masque continental : une grande masse avec côtes irrégulières
    const dx = (fx - 0.5 - ox) * 2, dy = (fy - 0.5 - oy) * 2;
    const warp = fbm(nW, fx * 4, fy * 4, 3) * 0.35;
    const d = Math.sqrt(dx * dx * 0.9 + dy * dy * 1.1) + warp;
    const mask = 1 - smooth(clamp((d - 0.55) / 0.6, 0, 1));
    const base = fbm(nH, fx * 5, fy * 5, 5) * 0.5 + 0.5;
    const ridge = 1 - Math.abs(fbm(nR, fx * 3.2, fy * 3.2, 4));
    const hh = (base * 0.55 + ridge * ridge * 0.35) * (0.35 + 0.65 * mask) * 1.05 * mask + mask * 0.22 - 0.02;
    height[idx(x, y)] = clamp(hh, 0, 1);
    moisture[idx(x, y)] = clamp(fbm(nM, fx * 4, fy * 4, 4) * 0.7 + 0.5, 0, 1);
  }
  // plus grande masse terrestre seulement
  const land = new Uint8Array(N * N);
  for (let i = 0; i < N * N; i++) land[i] = height[i] > SEA_LEVEL ? 1 : 0;
  const comp = new Int32Array(N * N).fill(-1);
  const sizes: number[] = [];
  for (let s = 0; s < N * N; s++) {
    if (!land[s] || comp[s] >= 0) continue;
    const id = sizes.length; let cnt = 0; const st = [s]; comp[s] = id;
    while (st.length) {
      const c = st.pop()!; cnt++;
      const cx = c % N, cy = (c / N) | 0;
      for (const [ax, ay] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cx + ax, ny = cy + ay;
        if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
        const ni = idx(nx, ny);
        if (land[ni] && comp[ni] < 0) { comp[ni] = id; st.push(ni); }
      }
    }
    sizes.push(cnt);
  }
  let main = 0; sizes.forEach((v, i) => { if (v > sizes[main]) main = i; });
  for (let i = 0; i < N * N; i++) if (land[i] && comp[i] !== main) { height[i] = SEA_LEVEL - 0.03; land[i] = 0; }
  const isLand = (x: number, y: number) => x >= 0 && y >= 0 && x < N && y < N && height[idx(x, y)] > SEA_LEVEL;

  const biome = new Uint8Array(N * N);
  for (let i = 0; i < N * N; i++) {
    const h = height[i], m = moisture[i];
    biome[i] = h <= SEA_LEVEL ? Biome.Ocean : h < SEA_LEVEL + 0.025 ? Biome.Beach : h > 0.86 ? Biome.Snow : h > 0.68 ? Biome.Mountain
      : h > 0.52 ? (m > 0.6 ? Biome.Forest : Biome.Hills) : (m > 0.58 ? Biome.Forest : Biome.Plains);
  }

  // rivières : descente de gradient depuis les reliefs
  const river = new Uint8Array(N * N);
  const srcs: number[] = [];
  for (let i = 0; i < N * N; i++) if (height[i] > 0.58 && height[i] < 0.75 && rng.chance(0.004)) srcs.push(i);
  for (const s of srcs.slice(0, 12)) {
    let x = s % N, y = (s / N) | 0; const path: number[] = [];
    for (let step = 0; step < 220; step++) {
      path.push(idx(x, y));
      let best = -1, bh = height[idx(x, y)];
      for (const [ax, ay] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
        const nx = x + ax, ny = y + ay;
        if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
        const hv = height[idx(nx, ny)] + (rng.next() - 0.5) * 0.004;
        if (hv < bh) { bh = hv; best = idx(nx, ny); }
      }
      if (best < 0) break;
      x = best % N; y = (best / N) | 0;
      if (height[best] <= SEA_LEVEL) break;
    }
    if (path.length > 25) for (const p of path) if (height[p] > SEA_LEVEL) river[p] = 1;
  }

  // villes
  const used = new Set<string>();
  const nameRng = rng.fork('names');
  const cities: City[] = [];
  const target = rng.int(46, 54);
  const nearOcean = (x: number, y: number) => { for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (!isLand(x + dx, y + dy)) return true; return false; };
  const nearRiver = (x: number, y: number) => { for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < N && yy < N && river[idx(xx, yy)]) return true; } return false; };
  const cands: { x: number; y: number; score: number }[] = [];
  for (let i = 0; i < 6000; i++) {
    const x = rng.int(4, N - 5), y = rng.int(4, N - 5);
    const h = height[idx(x, y)];
    if (h <= SEA_LEVEL + 0.03 || h > 0.74) continue;
    const slope = Math.abs(height[idx(x + 2, y)] - height[idx(x - 2, y)]) + Math.abs(height[idx(x, y + 2)] - height[idx(x, y - 2)]);
    const sc = 1 + (nearOcean(x, y) ? 0.7 : 0) + (nearRiver(x, y) ? 0.6 : 0) + (h < 0.52 ? 0.5 : 0) - slope * 3 + rng.next() * 0.7;
    cands.push({ x, y, score: sc });
  }
  cands.sort((a, b) => b.score - a.score);
  for (let dmin = 14; dmin >= 7 && cities.length < target; dmin--) {
    for (const c of cands) {
      if (cities.length >= target) break;
      if (cities.some(o => Math.hypot(o.x - c.x, o.y - c.y) < dmin)) continue;
      const coastal = nearOcean(c.x, c.y);
      cities.push({
        id: cities.length, name: cityName(nameRng, used), x: c.x, y: c.y, pop: 0, elev: 0, region: 0,
        industries: [], coastal, terrain: 'plains', connected: true,
      });
    }
  }
  // populations
  cities.forEach(c => {
    const coastBonus = c.coastal ? 1.4 : 1;
    c.pop = Math.round(clamp(Math.exp(rng.normal(1.9, 0.75)) * coastBonus, 2, 90) * 10) / 10;
  });
  [...cities].sort((a, b) => b.pop - a.pop).slice(0, 3).forEach(c => { c.pop = Math.round(c.pop * 2.6 * 10) / 10 + 40; });

  // régions (échantillonnage du point le plus éloigné)
  const R = rng.int(4, 6);
  const centers: City[] = [cities[rng.int(0, cities.length - 1)]];
  while (centers.length < R) {
    let best: City | null = null, bd = -1;
    for (const c of cities) {
      const d = Math.min(...centers.map(o => Math.hypot(o.x - c.x, o.y - c.y)));
      if (d > bd) { bd = d; best = c; }
    }
    centers.push(best!);
  }
  const rnRng = rng.fork('regions'); const usedR = new Set<string>();
  const regions: Region[] = centers.map((c, i) => ({ id: i, name: regionName(rnRng, usedR), cx: c.x, cy: c.y, hue: (i * 360 / R + 20) % 360 }));
  const regionMap = new Int8Array(N * N).fill(-1);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    if (height[idx(x, y)] <= SEA_LEVEL) continue;
    let bi = 0, bd = 1e9;
    regions.forEach((r, i) => { const d = Math.hypot(r.cx - x, r.cy - y) + fbm(nW, x / 20, y / 20, 2) * 6; if (d < bd) { bd = d; bi = i; } });
    regionMap[idx(x, y)] = bi;
  }
  for (const c of cities) c.region = regionMap[idx(c.x, c.y)] >= 0 ? regionMap[idx(c.x, c.y)] : 0;

  // terrain + industries
  for (const c of cities) {
    let sh = 0, sm = 0, k = 0;
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) { sh += height[idx(clamp(c.x + dx, 0, N - 1), clamp(c.y + dy, 0, N - 1))]; sm += moisture[idx(clamp(c.x + dx, 0, N - 1), clamp(c.y + dy, 0, N - 1))]; k++; }
    sh /= k; sm /= k;
    c.terrain = c.coastal ? 'coast' : sh > 0.62 ? 'mountain' : sh > 0.5 ? 'hills' : sm > 0.6 ? 'forest' : 'plains';
    c.elev = Math.max(6, height[idx(c.x, c.y)] * HSCALE - SEA_LEVEL * HSCALE * 0.9);
    const ir = rng.fork('ind' + c.id); const add = (id: string) => { if (!c.industries.includes(id)) c.industries.push(id); };
    switch (c.terrain) {
      case 'mountain': add(ir.chance(0.5) ? 'coal_mine' : 'ore_mine'); if (ir.chance(0.4)) add('quarry'); break;
      case 'hills': add(ir.pick(['coal_mine', 'ore_mine', 'quarry', 'forestry'])); break;
      case 'forest': add('forestry'); break;
      case 'coast': if (c.pop > 8) add('port'); if (c.pop > 14 && ir.chance(0.5)) add('refinery'); break;
      default: add('farm'); if (c.pop > 14) add('factory');
    }
    if (c.pop > 30) add('factory');
  }
  const need: [string, number, string[]][] = [['coal_mine', 3, ['mountain', 'hills']], ['ore_mine', 2, ['mountain', 'hills']], ['farm', 4, ['plains']], ['forestry', 2, ['forest', 'hills']], ['quarry', 2, ['hills', 'mountain']], ['factory', 4, ['plains', 'hills', 'coast']], ['port', 2, ['coast']], ['refinery', 1, ['coast']]];
  for (const [id, n, terr] of need) {
    let have = cities.filter(c => c.industries.includes(id)).length;
    const pool = cities.filter(c => !c.industries.includes(id) && c.industries.length < 3 && (terr.includes(c.terrain) || have < Math.ceil(n / 2) ));
    pool.sort((a, b) => (terr.includes(b.terrain) ? 1 : 0) - (terr.includes(a.terrain) ? 1 : 0) || b.pop - a.pop);
    for (const c of pool) { if (have >= n) break; c.industries.push(id); have++; }
  }
  // ports : au moins un si une ville côtière existe
  if (!cities.some(c => c.industries.includes('port'))) { const cc = cities.find(c => c.coastal); if (cc) cc.industries.push('port'); }

  // réseau ferré
  type Cand = { a: number; b: number; d: number; cost: number };
  const waterFrac = (a: City, b: City) => {
    let w = 0; const S = 24;
    for (let i = 0; i <= S; i++) { const t = i / S; if (heightAt({ height, size: N } as World, lerp(a.x, b.x, t), lerp(a.y, b.y, t)) <= SEA_LEVEL) w++; }
    return w / (S + 1);
  };
  const roughness = (a: City, b: City) => {
    let m = 0; const S = 24; let prev = height[idx(a.x, a.y)];
    for (let i = 1; i <= S; i++) { const t = i / S; const h = heightAt({ height, size: N } as World, lerp(a.x, b.x, t), lerp(a.y, b.y, t)); m += Math.abs(h - prev); prev = h; }
    return m;
  };
  const allC: Cand[] = [];
  for (let i = 0; i < cities.length; i++) for (let j = i + 1; j < cities.length; j++) {
    const d = cityDist(cities[i], cities[j]);
    if (d > 40) continue;
    const wf = waterFrac(cities[i], cities[j]);
    if (wf > 0.12) continue;
    allC.push({ a: i, b: j, d, cost: d * (1 + roughness(cities[i], cities[j]) * 3) });
  }
  allC.sort((p, q) => p.cost - q.cost);
  const parent = cities.map((_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const chosen: Cand[] = [];
  for (const c of allC) { const ra = find(c.a), rb = find(c.b); if (ra !== rb) { parent[ra] = rb; chosen.push(c); } }
  // connecter d'éventuelles composantes restantes (ignorer l'eau)
  for (let guard = 0; guard < 20; guard++) {
    const roots = new Set(cities.map((_, i) => find(i)));
    if (roots.size <= 1) break;
    let best: Cand | null = null;
    for (let i = 0; i < cities.length; i++) for (let j = i + 1; j < cities.length; j++) {
      if (find(i) === find(j)) continue;
      const d = cityDist(cities[i], cities[j]);
      if (!best || d < best.d) best = { a: i, b: j, d, cost: d };
    }
    if (!best) break; parent[find(best.a)] = find(best.b); chosen.push(best);
  }
  const deg = new Array(cities.length).fill(0);
  chosen.forEach(c => { deg[c.a]++; deg[c.b]++; });
  const chosenSet = new Set(chosen.map(c => c.a * 1000 + c.b));
  const crosses = (c: Cand, set: Cand[]) => set.some(o => o.a !== c.a && o.a !== c.b && o.b !== c.a && o.b !== c.b &&
    segIntersect(cities[c.a].x, cities[c.a].y, cities[c.b].x, cities[c.b].y, cities[o.a].x, cities[o.a].y, cities[o.b].x, cities[o.b].y));
  // chemins réseau pour tester l'intérêt d'un raccourci
  const netDist = (from: number, to: number, set: Cand[]) => {
    const dist = new Array(cities.length).fill(Infinity); dist[from] = 0; const q = [from];
    const adj: [number, number][][] = cities.map(() => []);
    set.forEach(e => { adj[e.a].push([e.b, e.d]); adj[e.b].push([e.a, e.d]); });
    const done = new Set<number>();
    while (q.length) { q.sort((a, b) => dist[b] - dist[a]); const u = q.pop()!; if (done.has(u)) continue; done.add(u); for (const [v, w] of adj[u]) if (dist[u] + w < dist[v]) { dist[v] = dist[u] + w; q.push(v); } }
    return dist[to];
  };
  const extra: Cand[] = [];
  for (const c of allC) {
    if (chosenSet.has(c.a * 1000 + c.b) || c.d > 30) continue;
    if (deg[c.a] >= 4 || deg[c.b] >= 4) continue;
    if (crosses(c, chosen)) continue;
    if (netDist(c.a, c.b, chosen) < c.d * 1.9) continue;
    chosen.push(c); extra.push(c); deg[c.a]++; deg[c.b]++;
  }
  // arêtes finales
  const edges: Edge[] = [];
  const addEdge = (c: Cand, kind: Edge['kind'], initial: boolean) => {
    const A = cities[c.a], B = cities[c.b];
    const lengthM = Math.round(clamp(c.d * CELL_M, 4500, 17000) / 10) * 10;
    edges.push({ id: edges.length, a: c.a, b: c.b, lengthM, kind, initial, maxSpeedKmh: 160, electrifiedYear: null, mountain: clamp(roughness(A, B) * 3, 0, 1), buildCost: 0 });
  };
  chosen.forEach(c => addEdge(c, 'main', true));
  // petites villes à raccorder : on retire leurs liaisons tant que le reste du réseau reste connexe
  const isolated = new Set<number>();
  const connectedWithout = (extraOut: number) => {
    const alive = cities.filter(c => !isolated.has(c.id) && c.id !== extraOut);
    const par = new Map<number, number>(alive.map(c => [c.id, c.id]));
    const f = (x: number): number => { while (par.get(x) !== x) { par.set(x, par.get(par.get(x)!)!); x = par.get(x)!; } return x; };
    for (const e of edges) if (e.initial && par.has(e.a) && par.has(e.b)) par.set(f(e.a), f(e.b));
    const r = new Set(alive.map(c => f(c.id)));
    return r.size === 1;
  };
  for (const l of [...cities].sort((a, b) => a.pop - b.pop)) {
    if (isolated.size >= 7) break;
    if (l.pop > 20 || !connectedWithout(l.id)) continue;
    isolated.add(l.id); l.connected = false;
  }
  for (const e of edges) if (isolated.has(e.a) || isolated.has(e.b)) { e.initial = false; e.kind = 'branch'; }
  // raccourcis candidats : lignes valides non construites
  let sc = 0;
  for (const c of allC) {
    if (sc >= 10) break;
    if (chosenSet.has(c.a * 1000 + c.b) || extra.some(e => e.a === c.a && e.b === c.b)) continue;
    if (c.d > 34 || c.d < 10) continue;
    if (!cities[c.a].connected || !cities[c.b].connected) continue;
    if (crosses(c, chosen)) continue;
    if (netDist(c.a, c.b, chosen) < c.d * 1.25) continue;
    addEdge(c, 'shortcut', false); sc++;
    chosen.push(c); // évite que deux raccourcis se croisent
  }
  // relaxation des altitudes : pentes moyennes ≤ 2,6 %
  for (let it = 0; it < 120; it++) {
    for (const e of edges) {
      const A = cities[e.a], B = cities[e.b];
      const lim = 0.026 * e.lengthM, diff = A.elev - B.elev;
      if (Math.abs(diff) > lim) { const ex = (Math.abs(diff) - lim) / 2 * 0.6; const s = Math.sign(diff); A.elev -= s * ex; B.elev += s * ex; }
    }
  }
  // vitesses de ligne, électrification, coûts
  const importance = edges.map(e => cities[e.a].pop + cities[e.b].pop);
  const order = edges.map((e, i) => i).filter(i => edges[i].initial).sort((a, b) => importance[b] - importance[a]);
  const nElec = Math.round(order.length * 0.42);
  order.slice(0, nElec).forEach((ei, rank) => { edges[ei].electrifiedYear = Math.round(1925 + (rank / nElec) * 80 + rng.range(-4, 4)); });
  for (const e of edges) {
    e.maxSpeedKmh = Math.round(clamp(160 - e.mountain * 110, 70, 160) / 10) * 10;
    e.buildCost = Math.round((e.lengthM / 1000) * (9000 + e.mountain * 18000) / 100) * 100;
  }
  return { seed, country: countryName(rng), size: N, height, moisture, biome, regionMap, river, cities, regions, edges };
}

export function regionOfCity(w: World, id: number): Region { return w.regions[w.cities[id].region]; }
export const INDUSTRY_IDS = INDUSTRIES.map(i => i.id);
