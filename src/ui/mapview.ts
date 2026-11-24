import { clamp } from '../core/util';
import { Biome, WORLD_SIZE, type World } from '../world/mapgen';
import { edgeActive, edgeElectrified, yearNow, type Game } from '../game/state';
import { priceMul, closedEdges, rates } from '../economy/economy';
import { industryById } from '../data';

export type Overlay = 'relief' | 'regions' | 'prices';
export const MAP_PX = 4; // pixels par cellule

const terrainCache = new Map<string, HTMLCanvasElement>();
const BCOL: Record<number, [number, number, number]> = {
  [Biome.Ocean]: [47, 90, 130], [Biome.Beach]: [216, 200, 154], [Biome.Plains]: [140, 176, 92], [Biome.Forest]: [74, 120, 70],
  [Biome.Hills]: [150, 160, 98], [Biome.Mountain]: [140, 136, 130], [Biome.Snow]: [240, 244, 248],
};

function terrain(w: World, overlay: Overlay): HTMLCanvasElement {
  const key = w.seed + '|' + overlay;
  let c = terrainCache.get(key); if (c) return c;
  const N = WORLD_SIZE;
  c = document.createElement('canvas'); c.width = N * MAP_PX; c.height = N * MAP_PX;
  const x = c.getContext('2d')!; const img = x.createImageData(N * MAP_PX, N * MAP_PX);
  for (let py = 0; py < N * MAP_PX; py++) for (let px = 0; px < N * MAP_PX; px++) {
    const cx = Math.min(N - 1, (px / MAP_PX) | 0), cy = Math.min(N - 1, (py / MAP_PX) | 0), i = cy * N + cx;
    const b = w.biome[i]; let [r, g, bl] = BCOL[b];
    // ombrage par la pente (lumière du nord-ouest)
    const hx = w.height[Math.min(N - 1, cx + 1) + cy * N] - w.height[Math.max(0, cx - 1) + cy * N];
    const hy = w.height[cx + Math.min(N - 1, cy + 1) * N] - w.height[cx + Math.max(0, cy - 1) * N];
    const sh = 1 + clamp((-hx - hy) * 3.2, -0.25, 0.25) + (b === Biome.Ocean ? -(0.4 - w.height[i]) * 0.5 : w.height[i] * 0.15);
    r *= sh; g *= sh; bl *= sh;
    if (w.river[i] && b !== Biome.Ocean) { r = 70; g = 130; bl = 190; }
    if (overlay === 'regions' && b !== Biome.Ocean) {
      const reg = w.regions[w.regionMap[i]]; if (reg) { const h = reg.hue; const [rr, gg, bb] = hsl(h, 0.55, 0.55); r = r * 0.45 + rr * 0.55; g = g * 0.45 + gg * 0.55; bl = bl * 0.45 + bb * 0.55; }
    }
    const o = (py * N * MAP_PX + px) * 4; img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = bl; img.data[o + 3] = 255;
  }
  x.putImageData(img, 0, 0);
  terrainCache.set(key, c); return c;
}
function hsl(h: number, s: number, l: number): [number, number, number] {
  const a = s * Math.min(l, 1 - l); const f = (n: number) => { const k = (n + h / 30) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

export interface MapOpts { overlay: Overlay; city: number | null; edge: number | null; good: string; labels: boolean; routeEdges?: number[] }

export function drawMap(canvas: HTMLCanvasElement, g: Game, o: MapOpts) {
  const w = g.world, s = g.state, N = WORLD_SIZE, P = MAP_PX;
  canvas.width = N * P; canvas.height = N * P;
  const c = canvas.getContext('2d')!;
  c.drawImage(terrain(w, o.overlay), 0, 0);
  const year = yearNow(s);
  const closed = closedEdges(s.eco);
  const cx = (i: number) => (w.cities[i].x + 0.5) * P, cy = (i: number) => (w.cities[i].y + 0.5) * P;
  // lignes
  for (const e of w.edges) {
    const active = edgeActive(s, e);
    const isRoute = o.routeEdges?.includes(e.id);
    c.lineWidth = active ? 3 : 2;
    if (!active) { c.setLineDash([5, 5]); c.strokeStyle = 'rgba(255,255,255,0.45)'; }
    else { c.setLineDash([]); c.strokeStyle = closed.has(e.id) ? '#d0604a' : '#2a2018'; }
    if (isRoute) { c.strokeStyle = '#ffd23a'; c.lineWidth = 5; c.setLineDash([]); }
    c.beginPath(); c.moveTo(cx(e.a), cy(e.a)); c.lineTo(cx(e.b), cy(e.b)); c.stroke();
    if (active && !isRoute) { c.setLineDash([2, 6]); c.strokeStyle = edgeElectrified(s, e) ? '#8fe0ff' : '#e8dcc0'; c.lineWidth = 1.5; c.beginPath(); c.moveTo(cx(e.a), cy(e.a)); c.lineTo(cx(e.b), cy(e.b)); c.stroke(); }
    if (o.edge === e.id) { c.setLineDash([]); c.strokeStyle = '#ffffff'; c.lineWidth = 6; c.globalAlpha = 0.5; c.beginPath(); c.moveTo(cx(e.a), cy(e.a)); c.lineTo(cx(e.b), cy(e.b)); c.stroke(); c.globalAlpha = 1; }
    if (closed.has(e.id)) { const mx = (cx(e.a) + cx(e.b)) / 2, my = (cy(e.a) + cy(e.b)) / 2; c.setLineDash([]); c.fillStyle = '#d0604a'; c.fillRect(mx - 6, my - 6, 12, 12); c.fillStyle = '#fff'; c.font = 'bold 11px sans-serif'; c.fillText('×', mx - 3, my + 4); }
  }
  c.setLineDash([]);
  // villes
  const priceOf = (i: number) => priceMul(w, s.eco, year, i, o.good);
  for (const city of w.cities) {
    const r = clamp(3 + Math.sqrt(city.pop) * 0.55, 3, 9);
    const x = cx(city.id), y = cy(city.id);
    let fill = city.connected || w.edges.some(e => (e.a === city.id || e.b === city.id) && edgeActive(s, e)) ? '#f3e7cf' : '#9a8a70';
    if (o.overlay === 'prices') {
      const rt = rates(w, s.eco, year, city.id, o.good);
      if (rt.prod + rt.cons > 0) { const m = priceMul(w, s.eco, year, city.id, o.good); const t = clamp((m - 0.35) / 2, 0, 1); fill = `rgb(${Math.round(60 + 195 * t)},${Math.round(200 - 140 * t)},${Math.round(90 - 40 * t)})`; }
      else fill = '#777';
    }
    c.fillStyle = '#1a130d'; c.beginPath(); c.arc(x, y, r + 1.5, 0, 7); c.fill();
    c.fillStyle = fill; c.beginPath(); c.arc(x, y, r, 0, 7); c.fill();
    if (s.depots[city.id] !== undefined) { c.fillStyle = '#e0ad4f'; c.fillRect(x - 3, y - 3, 6, 6); c.strokeStyle = '#1a130d'; c.lineWidth = 1; c.strokeRect(x - 3, y - 3, 6, 6); }
    if (s.warehouses[city.id]) { c.fillStyle = '#62b3ae'; c.fillRect(x + r - 1, y - r - 3, 5, 5); }
    if (city.id === s.hq) { c.fillStyle = '#d0604a'; star(c, x, y - r - 8, 6); }
    if (o.city === city.id) { c.strokeStyle = '#fff'; c.lineWidth = 2; c.beginPath(); c.arc(x, y, r + 5, 0, 7); c.stroke(); }
    if (s.location === city.id) { c.fillStyle = '#ffd23a'; c.beginPath(); c.moveTo(x, y - r - 5); c.lineTo(x - 6, y - r - 14); c.lineTo(x + 6, y - r - 14); c.closePath(); c.fill(); c.strokeStyle = '#1a130d'; c.lineWidth = 1.5; c.stroke(); }
    if (o.labels || o.city === city.id) {
      c.font = (city.pop > 25 ? 'bold ' : '') + '11px Trebuchet MS, sans-serif'; c.textAlign = 'center';
      c.strokeStyle = 'rgba(20,14,8,0.85)'; c.lineWidth = 3; c.strokeText(city.name, x, y + r + 12); c.fillStyle = '#fff6e0'; c.fillText(city.name, x, y + r + 12);
    }
  }
  // régions : noms
  if (o.overlay === 'regions') {
    c.font = 'italic bold 16px Georgia'; c.textAlign = 'center';
    for (const r of w.regions) { c.strokeStyle = 'rgba(20,14,8,0.9)'; c.lineWidth = 4; c.strokeText(r.name, r.cx * P, r.cy * P - 24); c.fillStyle = '#fff'; c.fillText(r.name, r.cx * P, r.cy * P - 24); }
  }
  void industryById;
}
function star(c: CanvasRenderingContext2D, x: number, y: number, r: number) {
  c.beginPath(); for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? r * 0.45 : r; c.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr); } c.closePath(); c.fill();
}

export function pickMap(g: Game, px: number, py: number): { city?: number; edge?: number } {
  const w = g.world; const x = px / MAP_PX, y = py / MAP_PX;
  let best = -1, bd = 2.6;
  for (const c of w.cities) { const d = Math.hypot(c.x + 0.5 - x, c.y + 0.5 - y); if (d < bd) { bd = d; best = c.id; } }
  if (best >= 0) return { city: best };
  let be = -1, bed = 1.8;
  for (const e of w.edges) {
    const a = w.cities[e.a], b = w.cities[e.b];
    const dx = b.x - a.x, dy = b.y - a.y; const t = clamp(((x - a.x - 0.5) * dx + (y - a.y - 0.5) * dy) / (dx * dx + dy * dy), 0, 1);
    const d = Math.hypot(a.x + 0.5 + dx * t - x, a.y + 0.5 + dy * t - y);
    if (d < bed) { bed = d; be = e.id; }
  }
  return be >= 0 ? { edge: be } : {};
}
