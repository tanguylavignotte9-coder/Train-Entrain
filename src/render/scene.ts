import { Rng, hashInts, hashString } from '../core/rng';
import { makeNoise2D, fbm } from '../core/noise';
import { clamp, lerp, smooth } from '../core/util';
import { locoById, wagonById, goodById, eraAt } from '../data';
import { biomeAt, heightAt, Biome, HSCALE, SEA_LEVEL, type World } from '../world/mapgen';
import { routeElev, routeTunnel, routeBridge, routeElectrified, routeCurv, routeEdgeIndex, type Route, type Feature } from '../world/track';
import type { Trip } from '../game/trip';
import { seasonOf, dateOf, daylight } from '../sim/weather';
import { yearNow } from '../game/state';
import { makeCanvas, ctx2d, hex, css, mix, shade, rect, disc, wheelSprite, type RGB } from './pixel';
import { vehicleSprite, MPP, type VehicleSprite } from './sprites';
import * as P from './props';

export const VW = 640, VH = 360;
const FRONT_X = 400;
const TRACK_Y = 268;
const VEX = 3.2; // exagération verticale du relief

interface Layer { p: number; base: number; amp: number; off: number; haze: number; trees: number; arr?: Float32Array; bio?: Uint8Array; col?: Float32Array }
const LAYERS: Layer[] = [
  { p: 0.035, base: 176, amp: 0.34, off: 17, haze: 0.8, trees: 0 },
  { p: 0.08, base: 192, amp: 0.34, off: 10, haze: 0.62, trees: 0 },
  { p: 0.16, base: 214, amp: 0.4, off: 5.5, haze: 0.42, trees: 9 },
  { p: 0.34, base: 234, amp: 0.55, off: 2.4, haze: 0.22, trees: 15 },
];
const SAMPLE = 30, S_MIN = -6000;

interface Obj { s: number; kind: string; v: number; plane: number; city?: number; w?: number }
interface Particle { s: number; y: number; vx: number; vy: number; life: number; max: number; size: number; col: RGB; a: number; grow: number }

class Buf {
  cv = makeCanvas(VW, VH); ctx = this.cv.getContext('2d')!; img = this.ctx.createImageData(VW, VH); u = new Uint32Array(this.img.data.buffer);
  clear() { this.u.fill(0); this.minY = VH; }
  minY = VH;
  col(x: number, y0: number, y1: number, c: RGB) {
    if (x < 0 || x >= VW) return; y0 = Math.max(0, Math.round(y0)); if (y0 < this.minY) this.minY = y0; y1 = Math.min(VH, Math.round(y1)); if (y1 <= y0) return;
    const v = (255 << 24) | ((c[2] | 0) << 16) | ((c[1] | 0) << 8) | (c[0] | 0);
    for (let y = y0; y < y1; y++) this.u[y * VW + x] = v;
  }
  colN(x: number, y0: number, y1: number, r: number, g: number, b: number, w = 1) {
    y0 = Math.max(0, y0 | 0); y1 = Math.min(VH, y1 | 0); if (y1 <= y0) return; if (y0 < this.minY) this.minY = y0;
    const v = (255 << 24) | ((b | 0) << 16) | ((g | 0) << 8) | (r | 0);
    for (let k = 0; k < w && x + k < VW; k++) for (let y = y0; y < y1; y++) this.u[y * VW + x + k] = v;
  }
  flush(dst: CanvasRenderingContext2D) { const y = Math.min(this.minY, VH - 1); this.ctx.putImageData(this.img, 0, 0, 0, y, VW, VH - y); dst.drawImage(this.cv, 0, y, VW, VH - y, 0, y, VW, VH - y); }
}

export class SceneRenderer {
  lbuf = new Buf(); gbuf = new Buf();
  cv: HTMLCanvasElement; c: CanvasRenderingContext2D;
  light: HTMLCanvasElement; lc: CanvasRenderingContext2D;
  trip!: Trip; world!: World; route!: Route; season: P.Season = 'été';
  objs: Obj[] = []; particles: Particle[] = []; t = 0; wheelPhase = 0; shake = 0;
  rain: { x: number; y: number; v: number }[] = []; stars: { x: number; y: number; b: number }[] = [];
  clouds: { x: number; y: number; v: number; s: number }[] = [];
  sFront = 0; elevCam = 0; light01 = 1; ambient: RGB = [1, 1, 1]; sky: { top: RGB; hor: RGB } = { top: [100, 170, 230], hor: [200, 230, 244] };
  glows: { x: number; y: number; r: number; col: string }[] = []; emit: { x: number; y: number; w: number; h: number; col: string }[] = [];
  smokeAcc = 0; lastShovel = -9; ventAcc = 0; sparkAcc = 0;
  private noise = new Rng(7);

  constructor() {
    this.cv = makeCanvas(VW, VH); this.c = ctx2d(this.cv);
    this.light = makeCanvas(VW, VH); this.lc = this.light.getContext('2d')!;
    const r = new Rng(99);
    for (let i = 0; i < 70; i++) this.stars.push({ x: r.int(0, VW), y: r.int(0, 140), b: r.next() });
    for (let i = 0; i < 10; i++) this.clouds.push({ x: r.range(0, VW * 2), y: r.range(14, 90), v: r.range(1.5, 4), s: r.int(0, 3) });
    for (let i = 0; i < 180; i++) this.rain.push({ x: r.range(0, VW), y: r.range(0, VH), v: r.range(0.8, 1.4) });
  }

  setTrip(trip: Trip, world: World) {
    this.trip = trip; this.world = world; this.route = trip.route; this.particles = [];
    const d = dateOf(trip.g.state.startYear, trip.g.state.day);
    this.season = seasonOf(d.doy);
    for (const L of LAYERS) { L.arr = undefined; L.bio = undefined; L.col = undefined; }
    this.buildLayers(); this.buildObjects();
  }

  // ---------------------------------------------------------------- données
  private buildLayers() {
    const r = this.route, w = this.world;
    const n = Math.ceil((r.length - S_MIN + 6000) / SAMPLE) + 2;
    const nz = makeNoise2D(hashString(r.key) ^ 0x1234);
    const DETAIL = [300, 230, 170, 120];
    for (const [li, L] of LAYERS.entries()) {
      L.arr = new Float32Array(n); L.bio = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        const s = clamp(S_MIN + i * SAMPLE, 0, r.length);
        const ei = clamp(routeEdgeIndex(r, s), 0, r.edges.length - 1);
        const e = w.edges[r.edges[ei]];
        const from = w.cities[r.cities[ei]], to = w.cities[r.cities[ei + 1]];
        const f = clamp((s - r.edgeStartS[ei]) / e.lengthM, 0, 1);
        const dx = to.x - from.x, dy = to.y - from.y, ll = Math.hypot(dx, dy) || 1;
        const side = (hashString(r.key) & 1) ? 1 : -1;
        const x = lerp(from.x, to.x, f) + (-dy / ll) * L.off * side, y = lerp(from.y, to.y, f) + (dx / ll) * L.off * side;
        const base = heightAt(w, x, y) * HSCALE - SEA_LEVEL * HSCALE * 0.9;
        const sea = heightAt(w, x, y) <= SEA_LEVEL;
        L.arr[i] = sea ? base : base + (fbm(nz, (S_MIN + i * SAMPLE) / (900 - li * 150), li * 9.3, 3) * 0.5 + 0.5) * DETAIL[li] * (0.55 + Math.min(1, Math.max(0, base) / 250) * 0.6);
        L.bio![i] = biomeAt(w, x, y);
      }
      // couleurs lissées (évite les ruptures nettes aux changements de biome)
      const raw = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { const c = this.biomeColor(L.bio![i], L.arr[i], this.season); raw[i * 3] = c[0]; raw[i * 3 + 1] = c[1]; raw[i * 3 + 2] = c[2]; }
      L.col = new Float32Array(n * 3);
      const R = 3;
      for (let i = 0; i < n; i++) { let a = 0, b = 0, cc = 0, k = 0; for (let j = Math.max(0, i - R); j <= Math.min(n - 1, i + R); j++) { a += raw[j * 3]; b += raw[j * 3 + 1]; cc += raw[j * 3 + 2]; k++; } L.col[i * 3] = a / k; L.col[i * 3 + 1] = b / k; L.col[i * 3 + 2] = cc / k; }
    }
  }

  private buildObjects() {
    const r = this.route, w = this.world, t = this.trip;
    const rng = new Rng(hashInts(hashString(r.key), 4242));
    const objs: Obj[] = [];
    const year = yearNow(t.g.state);
    // végétation et accessoires le long de la voie
    for (let s = 0; s < r.length; s += 14 + rng.int(0, 16)) {
      const gi = Math.round(s / 10);
      if (r.tunnel[gi]) continue;
      const ei = clamp(routeEdgeIndex(r, s), 0, r.edges.length - 1);
      const e = w.edges[r.edges[ei]];
      const from = w.cities[r.cities[ei]], to = w.cities[r.cities[ei + 1]];
      const f = clamp((s - r.edgeStartS[ei]) / e.lengthM, 0, 1);
      const bx = lerp(from.x, to.x, f), by = lerp(from.y, to.y, f);
      const bio = biomeAt(w, bx, by);
      const plane = rng.pick([0.62, 0.78, 0.9, 1.0]);
      const near = rng.chance(0.35);
      switch (bio) {
        case Biome.Forest: if (rng.chance(0.8)) objs.push({ s, kind: rng.chance(0.55) ? 'conifer' : 'broad', v: rng.int(0, 5), plane }); if (near) objs.push({ s: s + 5, kind: 'bush', v: rng.int(0, 3), plane: 1.0 }); break;
        case Biome.Plains: if (rng.chance(0.28)) objs.push({ s, kind: rng.chance(0.3) ? 'poplar' : 'broad', v: rng.int(0, 5), plane }); if (near) objs.push({ s, kind: 'bush', v: rng.int(0, 3), plane: 1.0 }); break;
        case Biome.Hills: if (rng.chance(0.5)) objs.push({ s, kind: rng.chance(0.6) ? 'conifer' : 'broad', v: rng.int(0, 5), plane }); if (rng.chance(0.2)) objs.push({ s, kind: 'rock', v: rng.int(0, 4), plane: 1.0 }); break;
        case Biome.Mountain: case Biome.Snow: if (rng.chance(0.45)) objs.push({ s, kind: rng.chance(0.7) ? 'pine' : 'rock', v: rng.int(0, 4), plane }); if (rng.chance(0.3)) objs.push({ s, kind: 'rock', v: rng.int(0, 4), plane: 1.0 }); break;
        case Biome.Beach: case Biome.Ocean: if (rng.chance(0.12)) objs.push({ s, kind: 'bush', v: rng.int(0, 3), plane: 1.0 }); break;
      }
    }
    // poteaux / mâts
    for (let s = 40; s < r.length; s += 60) {
      const gi = Math.round(s / 10);
      if (r.tunnel[gi]) continue;
      objs.push({ s, kind: r.electrified[gi] ? 'mast' : (s % 120 < 60 ? 'pole' : 'none'), v: 0, plane: 1.0 });
    }
    // villes et industries
    const places: { s: number; city: number; kind: 'start' | 'mid' | 'end' }[] = [{ s: r.startFront - 30, city: r.cities[0], kind: 'start' }];
    for (let i = 1; i < r.cities.length - 1; i++) places.push({ s: r.nodeS[i], city: r.cities[i], kind: 'mid' });
    places.push({ s: r.stopS - 30, city: r.cities[r.cities.length - 1], kind: 'end' });
    for (const pl of places) {
      const c = w.cities[pl.city];
      const pop = c.pop * (1 + 0.0085 * (year - 1905));
      const nHouses = clamp(Math.round(4 + Math.sqrt(pop) * 2.2), 5, 26);
      for (let i = 0; i < nHouses; i++) {
        const off = (rng.next() - 0.5) * (260 + nHouses * 14);
        const plane = rng.pick([0.55, 0.62, 0.7, 0.8]);
        const big = pop > 30 && rng.chance(0.3);
        objs.push({ s: pl.s + off, kind: big ? 'tower' : 'house', v: rng.int(0, 7), plane, city: pl.city });
      }
      if (pop > 8) objs.push({ s: pl.s + rng.range(-100, 100), kind: 'church', v: 0, plane: 0.58, city: pl.city });
      c.industries.slice(0, 2).forEach((ind, k) => objs.push({ s: pl.s + (k ? 1 : -1) * rng.range(160, 280), kind: 'ind:' + ind, v: 0, plane: 0.5 + k * 0.08, city: pl.city }));
      objs.push({ s: pl.kind === 'end' ? r.stopS - 55 : pl.kind === 'start' ? r.startFront - 60 : pl.s, kind: 'station', v: 0, plane: 1.0, city: pl.city });
      if (pl.kind === 'mid') objs.push({ s: pl.s, kind: 'station', v: 0, plane: 1.0, city: pl.city });
    }
    // travaux
    for (const f of r.features) if (f.kind === 'worksite') for (let i = 0; i < 5; i++) objs.push({ s: f.s + 30 + i * ((f.len ?? 300) / 5), kind: i % 2 ? 'worker' : 'cone', v: i, plane: 1.0 });
    objs.sort((a, b) => a.s - b.s);
    this.objs = objs;
  }

  // ---------------------------------------------------------------- utilitaires
  private xOf(s: number, p = 1): number { return FRONT_X + (s - this.sFront) * p / MPP; }
  private elevAt(s: number): number { return routeElev(this.route, clamp(s, 0, this.route.length)); }
  private yOf(s: number): number { return TRACK_Y - (this.elevAt(s) - this.elevCam) * VEX / MPP * 0.5; }

  private biomeColor(b: number, h: number, season: P.Season): RGB {
    const winter = season === 'hiver';
    switch (b) {
      case Biome.Ocean: return hex('#3f78a8');
      case Biome.Beach: return hex('#d8c89a');
      case Biome.Plains: return winter ? hex('#dbe5e8') : season === 'automne' ? hex('#b09a48') : season === 'printemps' ? hex('#8fbd5c') : hex('#79a844');
      case Biome.Forest: return winter ? hex('#bccfd2') : season === 'automne' ? hex('#9a5e2c') : hex('#3f6f3c');
      case Biome.Hills: return winter ? hex('#d6e0e4') : season === 'automne' ? hex('#9a8a4a') : hex('#7d9a58');
      case Biome.Mountain: return winter ? hex('#e4ecf0') : mix(hex('#6f8258'), hex('#8c8c96'), clamp((h - 150) / 220, 0, 1));
      default: return hex('#f0f4f8');
    }
  }

  // ---------------------------------------------------------------- image
  render(dt: number) {
    const trip = this.trip, sim = trip.sim, c = this.c;
    this.t += dt;
    this.sFront = sim.s;
    this.elevCam = this.elevAt(sim.s - 20);
    const dl = trip.light;
    this.light01 = dl.light;
    const w = trip.weather;
    const inTunnelNow = routeTunnel(this.route, sim.s - 5);
    this.shake = clamp(Math.abs(sim.v) / 40, 0, 1) * (0.35 + 0.65 * (1 - sim.loco.unit.cond.wheels)) * (inTunnelNow ? 1.2 : 1);
    this.glows.length = 0; this.emit.length = 0;
    this.wheelPhase += sim.v * dt;
    c.save();
    c.setTransform(1, 0, 0, 1, 0, 0);
    const T = (window as any).__prof ? (n: string, f: () => void) => { const t = performance.now(); f(); const P = ((window as any).__profd ??= {}); P[n] = (P[n] ?? 0) + performance.now() - t; } : (_n: string, f: () => void) => f();
    T('sky', () => this.drawSky(dl, w.cloud, w.kind));
    T('layers', () => this.drawLayers(dl));
    T('obj0', () => this.drawObjects(0, 0.99));
    T('ground', () => this.drawGround());
    T('track', () => this.drawTrackSide(dl));
    T('obj1', () => this.drawObjects(0.99, 1.2));
    T('veh', () => this.drawVehicles(dt));
    T('part', () => { this.updateParticles(dt); this.drawParticles(); });
    T('fore', () => this.drawForeground());
    T('weather', () => this.drawWeather(dt));
    T('light', () => this.applyLighting(dl, inTunnelNow));
    c.restore();
  }

  private skyColors(dl: { light: number; dawn: number }, cloud: number) {
    const dayTop = hex('#5fa8e6'), dayHor = hex('#cde8f6'), nightTop = hex('#070b22'), nightHor = hex('#17214a'), duskHor = hex('#f0a060'), duskTop = hex('#4a5a9a');
    let top = mix(nightTop, dayTop, dl.light), hor = mix(nightHor, dayHor, dl.light);
    top = mix(top, duskTop, dl.dawn * 0.6 * (1 - Math.abs(dl.light - 0.5) * 0.4)); hor = mix(hor, duskHor, dl.dawn * 0.85);
    const grey: RGB = [150, 158, 168];
    top = mix(top, mix(grey, nightTop, 1 - dl.light), cloud * 0.55); hor = mix(hor, mix([190, 196, 204], nightHor, 1 - dl.light), cloud * 0.5);
    return { top, hor };
  }

  private drawSky(dl: { light: number; sunAngle: number; dawn: number; isNight: boolean }, cloud: number, kind: string) {
    const c = this.c;
    const sk = this.skyColors(dl, cloud); this.sky = sk;
    for (let y = 0; y < VH; y += 4) { c.fillStyle = css(mix(sk.top, sk.hor, clamp(y / 230, 0, 1))); c.fillRect(0, y, VW, 4); }
    if (dl.light < 0.55) for (const st of this.stars) { const tw = 0.5 + 0.5 * Math.sin(this.t * 2 + st.b * 20); c.fillStyle = `rgba(255,255,240,${(0.9 - dl.light * 1.6) * (0.45 + 0.55 * tw) * (1 - cloud * 0.9)})`; c.fillRect(st.x, st.y, 1, 1); }
    // soleil / lune
    const ax = 50 + (dl.sunAngle / Math.PI) * 540;
    if (dl.light > 0.05) { const sy = 190 - Math.sin(dl.sunAngle) * 150; if (cloud < 0.8) { disc(c, ax, sy, 9, css(mix(hex('#ffe9a0'), hex('#ff9a40'), dl.dawn), 0.35)); disc(c, ax, sy, 6, css(mix(hex('#fff6d0'), hex('#ffb060'), dl.dawn))); } }
    else { const m = ((this.trip.hour % 24) - 18 + 24) % 24 / 12; const mx = 60 + clamp(m, 0, 1) * 520, my = 160 - Math.sin(clamp(m, 0, 1) * Math.PI) * 120; if (cloud < 0.85) { disc(c, mx, my, 6, '#e8eaf0'); disc(c, mx + 2, my - 1, 5, css(mix(sk.top, sk.hor, 0.3))); } }
    // nuages
    const nC = Math.round(2 + cloud * 8);
    for (let i = 0; i < nC && i < this.clouds.length; i++) {
      const cl = this.clouds[i];
      const x = ((cl.x + this.t * cl.v * (1 + this.trip.weather.windMs * 0.1) - this.sFront * 0.02 / MPP) % (VW + 120) + VW + 120) % (VW + 120) - 60;
      const pr = P.cloud(cl.s); c.globalAlpha = (0.5 + cloud * 0.5) * (0.35 + 0.65 * dl.light + (dl.isNight ? 0.1 : 0));
      c.drawImage(pr.canvas, Math.round(x - pr.ax), Math.round(cl.y * (1 - cloud * 0.3)));
      c.globalAlpha = 1;
    }
    void kind;
  }

  private drawLayers(dl: { light: number }) {
    const c = this.c, r = this.route;
    const fog = this.trip.weather.fog;
    LAYERS.forEach((L, li) => {
      if (!L.arr) return;
      if (li === 0 || li === 3) this.lbuf.clear();
      const haze = clamp(L.haze + fog * 0.5, 0, 0.95);
      const hazeCol = this.sky.hor;
      const seaH = SEA_LEVEL * HSCALE * 0.1;
      const step = L.p < 0.2 ? 2 : 1, lb = this.lbuf, c3 = L.col!, hr = hazeCol[0], hg = hazeCol[1], hb = hazeCol[2], oc = this.biomeColor(Biome.Ocean, 0, this.season);
      const bottom = 340;
      for (let x = 0; x < VW; x += step) {
        const s = this.sFront + (x - FRONT_X) * MPP / L.p;
        const fi = (s - S_MIN) / SAMPLE; const i0 = clamp(Math.floor(fi), 0, L.arr.length - 2), t = clamp(fi - i0, 0, 1);
        const h = L.arr[i0] + (L.arr[i0 + 1] - L.arr[i0]) * t;
        const b = L.bio![Math.round(clamp(fi, 0, L.arr.length - 1))];
        const sea = b === Biome.Ocean;
        const yy = Math.round(L.base - ((sea ? seaH : h) - this.elevCam) * L.amp);
        let r0: number, g0: number, b0: number;
        if (sea) { const sh = (0.5 + 0.5 * Math.sin(x * 0.4 + this.t * 2 + li)) * 0.08; r0 = oc[0] + (255 - oc[0]) * sh; g0 = oc[1] + (255 - oc[1]) * sh; b0 = oc[2] + (255 - oc[2]) * sh; }
        else { r0 = c3[i0 * 3] + (c3[i0 * 3 + 3] - c3[i0 * 3]) * t; g0 = c3[i0 * 3 + 1] + (c3[i0 * 3 + 4] - c3[i0 * 3 + 1]) * t; b0 = c3[i0 * 3 + 2] + (c3[i0 * 3 + 5] - c3[i0 * 3 + 2]) * t; }
        const r1 = r0 + (hr - r0) * haze, g1 = g0 + (hg - g0) * haze, b1 = b0 + (hb - b0) * haze;
        lb.colN(x, yy, yy + 2, Math.min(255, r1 * 1.12 + 10), Math.min(255, g1 * 1.12 + 10), Math.min(255, b1 * 1.12 + 10), step);
        lb.colN(x, yy + 2, yy + 16, r1, g1, b1, step);
        lb.colN(x, yy + 16, bottom, r1 * 0.93, g1 * 0.93, b1 * 0.93, step);
        if (!sea && h > 300 && li < 2 && b >= Biome.Mountain) lb.colN(x, yy, yy + 3, 244 + (hr - 244) * haze, 247 + (hg - 247) * haze, 250 + (hb - 250) * haze, step);
      }
      if (li === 2 || li === 3) this.lbuf.flush(c);
      // arbres de fond
      if (L.trees && !(window as any).__notrees) {
        for (let x = 6; x < VW; x += L.trees) {
          const s = this.sFront + (x - FRONT_X) * MPP / L.p;
          const fi = (s - S_MIN) / SAMPLE; const i0 = clamp(Math.floor(fi), 0, L.arr.length - 2), t = clamp(fi - i0, 0, 1);
          const b = L.bio![Math.round(clamp(fi, 0, L.arr.length - 1))];
          if (b !== Biome.Forest && b !== Biome.Hills && b !== Biome.Plains && b !== Biome.Mountain) continue;
          if (b === Biome.Plains && ((x * 7 + li) % 3)) continue;
          const h = lerp(L.arr[i0], L.arr[i0 + 1], t);
          const y = Math.round(L.base - (h - this.elevCam) * L.amp);
          const sz = li === 2 ? 11 : 17;
          const tr = P.tree(b === Biome.Mountain || (b === Biome.Forest && (x % 2)) ? 'conifer' : 'broad', (x >> 3) % 4, this.season, sz);
          c.globalAlpha = 1 - haze * 0.75;
          c.drawImage(tr.canvas, Math.round(x - tr.ax), y - tr.h + 4);
          c.globalAlpha = 1;
        }
      }
    });
    void dl; void r;
  }

  private drawObjects(minP: number, maxP: number) {
    const c = this.c; const year = yearNow(this.trip.g.state);
    const fog = this.trip.weather.fog;
    for (const o of this.objs) {
      if (o.plane < minP || o.plane >= maxP) continue;
      const x = this.xOf(o.s, o.plane);
      if (x < -90 || x > VW + 90) continue;
      // hauteur du sol de ce plan : on se base sur la voie, relevée selon la profondeur
      const baseY = this.yOf(o.s) * o.plane + (TRACK_Y - 12) * (1 - o.plane) + (o.plane < 0.99 ? (-(1 - o.plane) * 14) : 0) + this.planeYAdjust(o);
      let pr: P.Prop | null = null;
      switch (o.kind) {
        case 'conifer': pr = P.tree('conifer', o.v, this.season, 22 + (o.v % 3) * 4); break;
        case 'pine': pr = P.tree('pine', o.v, this.season, 20 + (o.v % 3) * 3); break;
        case 'broad': pr = P.tree('broad', o.v, this.season, 22 + (o.v % 3) * 3); break;
        case 'poplar': pr = P.tree('poplar', o.v, this.season, 28); break;
        case 'bush': pr = P.tree('bush', o.v, this.season, 8); break;
        case 'rock': pr = P.rock(o.v, this.season === 'hiver'); break;
        case 'house': pr = P.house(o.v, this.season, year > 1960); break;
        case 'tower': pr = P.tower(o.v); break;
        case 'church': pr = P.church(this.season); break;
        case 'worker': pr = P.worker(o.v); break;
        case 'cone': pr = P.cone(); break;
        case 'mast': pr = P.catenary(); break;
        case 'pole': pr = P.pole(); break;
        case 'station': pr = P.station(this.world.cities[o.city!].name, this.world.cities[o.city!].pop, this.season); break;
        default: if (o.kind.startsWith('ind:')) pr = P.industry(o.kind.slice(4), this.season);
      }
      if (!pr) continue;
      const hazeA = o.plane < 0.99 ? clamp((1 - o.plane) * 0.9 + fog * 0.5, 0, 0.8) : fog * 0.35;
      const oy = o.kind === 'station' || o.kind === 'mast' || o.kind === 'pole' || o.kind === 'worker' || o.kind === 'cone' ? this.yOf(o.s) : baseY;
      const dx = Math.round(x - pr.ax), dy = Math.round(oy - pr.h + (o.kind === 'station' ? 6 : 1));
      if (hazeA > 0.02) { c.globalAlpha = 1 - hazeA * 0.5; }
      c.drawImage(pr.canvas, dx, dy);
      c.globalAlpha = 1;
      if (hazeA > 0.05) { c.globalAlpha = hazeA * 0.5; c.globalCompositeOperation = 'source-atop'; c.globalCompositeOperation = 'source-over'; c.globalAlpha = 1; }
      if (pr.glow) for (const g of pr.glow) this.glows.push({ x: dx + g.x, y: dy + g.y, r: g.r, col: g.col });
      // fumée des usines
      if (o.kind === 'ind:factory' && (Math.floor(o.s) % 2 === 0) && this.t % 0.35 < 0.02) this.spawnSmoke(o.s + (dx + 55 - x) * MPP / o.plane, oy - 60, 1, [90, 90, 96], 5);
    }
  }
  private planeYAdjust(o: Obj): number { return o.plane < 0.99 ? -(o.plane * 6) + 8 : 0; }

  private drawGround() {
    const r = this.route, g = this.gbuf; g.clear();
    const season = this.season;
    let col: RGB = [0, 0, 0];
    for (let x = 0; x < VW; x++) {
      const s = this.sFront + (x - FRONT_X) * MPP;
      const sc = clamp(s, 0, r.length);
      const gi = Math.round(sc / 10);
      const y = Math.round(this.yOf(sc));
      if (r.tunnel[gi]) continue;
      const bridge = r.bridge[gi] === 1;
      const ground = clamp((r.ground[gi] - r.elev[gi]), -30, 30);
      if (x % 4 === 0) col = this.biomeColor(this.groundBiome(sc), 0, season);
      const gy = y + 7;
      if (!bridge) {
        g.col(x, gy, gy + 2, shade(col, 1.05)); g.col(x, gy + 2, gy + 24, shade(col, 0.88)); g.col(x, gy + 24, VH, shade(col, 0.74));
        for (let k = 0; k < 4; k++) { const yy = gy + 30 + k * 18 + ((x * 13 + k * 7) % 5 === 0 ? 1 : 0); if (((x >> 3) + k) % 3 === 0) g.col(x, yy, yy + 2, shade(col, 0.66 + k * 0.03)); }
        if (ground > 3) { const hh = Math.round(clamp(ground * 0.9, 0, 26)); g.col(x, y - hh, y, shade(col, 0.8)); g.col(x, y - hh, y - hh + 1, shade(col, 0.95)); }
        if (((x + (this.sFront / MPP | 0)) * 2654435761 >>> 0) % 23 === 0) g.col(x, gy, gy + 1, shade(col, 1.2));
      }
    }
    g.flush(this.c);
  }
  private groundBiome(s: number): number {
    const w = this.world, r = this.route;
    const ei = clamp(routeEdgeIndex(r, s), 0, r.edges.length - 1);
    const e = w.edges[r.edges[ei]]; const from = w.cities[r.cities[ei]], to = w.cities[r.cities[ei + 1]];
    const f = clamp((s - r.edgeStartS[ei]) / e.lengthM, 0, 1);
    let b = biomeAt(w, lerp(from.x, to.x, f), lerp(from.y, to.y, f));
    if (b === Biome.Ocean || b === Biome.Snow) b = Biome.Plains;
    if (b === Biome.Mountain) b = Biome.Hills;
    return b;
  }

  private drawTrackSide(dl: { light: number }) {
    const c = this.c, r = this.route, trip = this.trip;
    const winter = this.season === 'hiver' && trip.weather.tempC < 2;
    let prevTunnel = false, prevBridge = false;
    const loops = r.loops;
    for (let x = 0; x < VW; x++) {
      const s = this.sFront + (x - FRONT_X) * MPP;
      const sc = clamp(s, 0, r.length);
      const gi = Math.round(sc / 10);
      const y = Math.round(this.yOf(sc));
      const tun = r.tunnel[gi] === 1, br = r.bridge[gi] === 1;
      if (tun) {
        c.fillStyle = '#3c3a40'; c.fillRect(x, 0, 1, y - 34);
        c.fillStyle = (x + gi) % 5 === 0 ? '#2e2c32' : '#34323a'; c.fillRect(x, y - 36, 1, 6);
        c.fillStyle = '#0c0c10'; c.fillRect(x, y - 34, 1, 36 + 6);
        c.fillStyle = '#17171c'; c.fillRect(x, y + 6, 1, VH);
        if (gi % 6 === 0) { c.fillStyle = '#ffd88a'; c.fillRect(x, y - 30, 1, 2); this.glows.push({ x, y: y - 28, r: 26, col: 'rgba(255,200,120,0.5)' }); }
      }
      if (tun !== prevTunnel && x > 0) this.drawPortal(x, y, tun);
      if (br) { this.drawBridgeColumn(x, y, gi); }
      prevTunnel = tun; prevBridge = br;
      // voie : ballast, traverses et rails
      if (!tun || true) {
        const ballast = tun ? '#2c2a2a' : '#6c655a';
        c.fillStyle = winter ? '#e8eef0' : ballast; c.fillRect(x, y + 2, 1, 5);
        if (((x + (gi & 1)) % 6) < 2) { c.fillStyle = '#4a382c'; c.fillRect(x, y + 1, 1, 2); }
        c.fillStyle = '#9a9aa4'; c.fillRect(x, y, 1, 1);
        c.fillStyle = '#5c5c66'; c.fillRect(x, y + 1, 1, 1);
        if (!tun && ((x * 31 + gi) % 7) === 0) { c.fillStyle = '#8a8478'; c.fillRect(x, y + 3, 1, 1); }
      }
      // fil de contact
      if (r.electrified[gi]) {
        const wy = y - 46 + (Math.abs(((s + 30) % 60) - 30) * 0.05);
        c.fillStyle = tun ? '#3a3a40' : '#2c2c32'; c.fillRect(x, Math.round(wy), 1, 1);
      }
    }
    // voie d'évitement
    for (const L of loops) {
      const x0 = this.xOf(L.entryS), x1 = this.xOf(L.exitS);
      if (x1 < -20 || x0 > VW + 20) continue;
      for (let x = Math.max(0, Math.floor(x0)); x < Math.min(VW, Math.ceil(x1)); x++) {
        const s = this.sFront + (x - FRONT_X) * MPP; const y = Math.round(this.yOf(s)) - 9;
        const e = Math.min(x - x0, x1 - x), off = clamp(e / 20, 0, 1);
        const yy = y + Math.round((1 - off) * 9);
        c.fillStyle = '#9a9aa4'; c.fillRect(x, yy, 1, 1); c.fillStyle = '#5c5c66'; c.fillRect(x, yy + 1, 1, 1);
        if (x % 6 < 2) { c.fillStyle = '#4a382c'; c.fillRect(x, yy + 1, 1, 1); }
      }
    }
    // éléments ponctuels
    for (const f of r.features) this.drawFeature(f, dl);
    // trafic adverse
    this.drawOpposing();
  }

  private drawPortal(x: number, y: number, entering: boolean) {
    const c = this.c;
    c.fillStyle = '#5a5860'; c.fillRect(x - (entering ? 6 : 0), y - 40, 6, 46);
    c.fillStyle = '#6e6c76'; c.fillRect(x - (entering ? 6 : 0), y - 40, 6, 2);
    c.fillStyle = '#4a4850'; c.fillRect(x - (entering ? 6 : 0), y - 40, 1, 46);
  }
  private drawBridgeColumn(x: number, y: number, gi: number) {
    const c = this.c;
    c.fillStyle = '#4a4a54'; c.fillRect(x, y + 7, 1, 2);
    c.fillStyle = '#3a3a44'; c.fillRect(x, y + 9, 1, 1);
    const k = (gi * 3 + x) % 8; c.fillStyle = '#5a5a66'; c.fillRect(x, y + 10 + (k < 4 ? k : 8 - k), 1, 1);
    if (gi % 22 === 0) { c.fillStyle = '#6a6460'; c.fillRect(x - 2, y + 9, 5, VH); c.fillStyle = '#7e7872'; c.fillRect(x - 2, y + 9, 1, VH); }
    c.fillStyle = '#7a7a86'; c.fillRect(x, y - 6, 1, 1); if (gi % 4 === 0) c.fillRect(x, y - 6, 1, 7);
  }

  private drawFeature(f: Feature, dl: { light: number }) {
    const c = this.c; const trip = this.trip;
    const x = this.xOf(f.s);
    if (x < -40 || x > VW + 40) return;
    const y = this.yOf(f.s);
    const year = yearNow(trip.g.state);
    switch (f.kind) {
      case 'signal': case 'distant': {
        const asp = trip.signalAspect(f);
        const pr = P.signal(year < 1955 ? 'semaphore' : 'light', asp, f.kind === 'distant');
        c.drawImage(pr.canvas, Math.round(x - pr.ax), Math.round(y - pr.h + 6));
        const g = pr.glow![0]; this.glows.push({ x: x - pr.ax + g.x, y: y - pr.h + 6 + g.y, r: g.r, col: g.col });
        this.emit.push({ x: Math.round(x - 1), y: Math.round(y - pr.h + 6 + (year < 1955 ? 1 : (asp === 'red' ? 3 : asp === 'yellow' ? 6 : 9))), w: 2, h: 2, col: asp === 'red' ? '#ff3b30' : asp === 'yellow' ? '#ffd23a' : '#4cd964' });
        break;
      }
      case 'block': { const pr = P.signal(year < 1955 ? 'semaphore' : 'light', 'green'); c.drawImage(pr.canvas, Math.round(x - pr.ax), Math.round(y - pr.h + 6)); this.emit.push({ x: Math.round(x - 1), y: Math.round(y - pr.h + 6 + (year < 1955 ? 1 : 9)), w: 2, h: 2, col: '#4cd964' }); break; }
      case 'speedsign': { const pr = P.speedSign(f.data!.kmh as number, !!f.data!.warn); c.drawImage(pr.canvas, Math.round(x - pr.ax), Math.round(y - pr.h + 4)); break; }
      case 'curvesign': { const pr = P.curveSign(); c.drawImage(pr.canvas, Math.round(x - pr.ax), Math.round(y - pr.h + 4)); break; }
      case 'buffer': { const pr = P.buffer(); c.drawImage(pr.canvas, Math.round(x - pr.ax), Math.round(y - pr.h + 7)); break; }
      case 'stopmark': {
        c.fillStyle = '#ffd23a'; c.fillRect(Math.round(x) - 1, Math.round(y) + 8, 3, 3);
        c.fillStyle = '#1c1c22'; c.fillRect(Math.round(x), Math.round(y) + 8, 1, 3);
        // quai
        const px0 = x - 380, px1 = x + 10;
        c.fillStyle = '#b4b0a6'; c.fillRect(Math.round(px0), Math.round(y) + 7, Math.round(px1 - px0), 3);
        c.fillStyle = '#d6d2c6'; c.fillRect(Math.round(px0), Math.round(y) + 7, Math.round(px1 - px0), 1);
        c.fillStyle = '#ffd23a'; c.fillRect(Math.round(px0), Math.round(y) + 9, Math.round(px1 - px0), 1);
        break;
      }
      case 'crossing': {
        const hit = trip.crossings.find(cc => cc.f === f);
        const near = Math.abs(f.s - this.sFront) < 450 && f.s > this.sFront - 60;
        const blink = near && Math.floor(this.t * 2.5) % 2 === 0;
        c.fillStyle = '#58544e'; c.fillRect(Math.round(x) - 6, Math.round(y) + 2, 12, 5);
        c.fillStyle = '#3a3836'; c.fillRect(Math.round(x) - 6, Math.round(y) + 7, 12, VH);
        c.fillStyle = '#d9d4c4'; for (let k = 0; k < 10; k++) c.fillRect(Math.round(x), Math.round(y) + 12 + k * 14, 1, 6);
        const pr = P.gate(); c.drawImage(pr.canvas, Math.round(x) - 12, Math.round(y) - 10); c.drawImage(pr.canvas, Math.round(x) + 8, Math.round(y) - 10);
        if (near) { c.fillStyle = '#d4302c'; c.fillRect(Math.round(x) - 14, Math.round(y) - 18, 12, 2); c.fillRect(Math.round(x) + 6, Math.round(y) - 18, 12, 2); c.fillStyle = '#f3eed8'; for (let k = 0; k < 3; k++) { c.fillRect(Math.round(x) - 12 + k * 4, Math.round(y) - 18, 2, 2); c.fillRect(Math.round(x) + 8 + k * 4, Math.round(y) - 18, 2, 2); } }
        if (blink) { this.emit.push({ x: Math.round(x) - 11, y: Math.round(y) - 7, w: 2, h: 2, col: '#ff3b30' }); this.glows.push({ x: Math.round(x) - 10, y: Math.round(y) - 6, r: 10, col: 'rgba(255,60,40,0.6)' }); }
        if (hit && hit.f.data?.car) {
          const cp = P.car(yearNow(trip.g.state), (f.data!.id as number) | 0);
          const onTrack = !hit.cleared && !hit.hit;
          c.drawImage(cp.canvas, Math.round(x) - 12, Math.round(y) - (onTrack ? 7 : -14));
        }
        break;
      }
      case 'worksite': { /* éléments dessinés comme objets */ break; }
      case 'neutral': { const w = (f.len ?? 100) / MPP; c.fillStyle = '#ffd23a'; c.fillRect(Math.round(x), Math.round(y) - 50, 2, 6); c.fillRect(Math.round(x + w), Math.round(y) - 50, 2, 6); break; }
      default: break;
    }
    void dl;
  }

  private drawOpposing() {
    const trip = this.trip, c = this.c, r = this.route;
    const year = yearNow(trip.g.state);
    for (const L of r.loops) {
      if (!L.pnj) continue;
      const p = trip.pnjPos(L); // avant du train adverse
      const len = 90; // m
      const x = this.xOf(p);
      if (x > VW + len / MPP + 20 || x < -60 - len / MPP) continue;
      const defs = year < 1950 ? ['s230', 'c2_bois', 'c3_bois', 'c3_bois', 'm_fourgon'] : year < 1990 ? ['d_renard', 'c2_acier', 'c2_acier', 'c1_acier'] : ['e_foudre', 'c2_clim', 'c2_clim', 'c1_clim'];
      let xx = x; // l'avant du train adverse regarde vers la gauche (il vient en face)
      defs.forEach((id, i) => {
        const isLoco = i === 0;
        const sp = vehicleSprite(id, isLoco ? 'loco' : 'wagon', i);
        const yy = this.yOf(p) - 9 + 0;
        c.save(); c.translate(Math.round(xx), Math.round(yy)); c.scale(-1, 1);
        c.drawImage(sp.canvas, 0, -sp.h + 6);
        for (const wh of sp.wheels) { const fr = Math.floor(((this.wheelPhase * 0 + this.t * 20) % 8)); c.drawImage(wheelSprite(wh.r, fr, '#25252b', '#4a4a54', '#8a8a94'), Math.round(wh.x - wh.r), Math.round(-wh.r * 2 - 0 + 0) + 1); }
        c.restore();
        xx += sp.w + 1;
        if (isLoco && sp.chimney && year < 1950 && this.t % 0.3 < 0.03) this.spawnSmoke(p + sp.w * MPP * 0.6, this.yOf(p) - 9 - sp.h + 8, 1, [60, 60, 64], 7);
      });
    }
  }

  // ---------------------------------------------------------------- véhicules
  private drawVehicles(dt: number) {
    const sim = this.trip.sim, c = this.c; const trip = this.trip;
    const cargoColor = trip.contract.goodId ? goodById(trip.contract.goodId).color : undefined;
    const dark = this.light01 < 0.35 || routeTunnel(this.route, sim.s);
    const sway = Math.sin(this.t * 9) * this.shake * 0.5;
    sim.vehicles.forEach((veh, i) => {
      const def = veh.def; const isLoco = veh.isLoco;
      const load = !isLoco ? clamp(veh.unit.loadT / (wagonById(veh.unit.defId).capacityT || 1), 0, 1) : 0;
      const sp = vehicleSprite(veh.unit.defId, isLoco ? 'loco' : 'wagon', veh.unit.uid, !isLoco ? veh.unit.cargo : undefined, load);
      const front = sim.s - veh.offset, rear = front - veh.lengthM;
      const xr = this.xOf(front), xl = this.xOf(rear);
      if (xr < -20 || xl > VW + 20) return;
      const y1 = this.yOf(front), y2 = this.yOf(rear);
      const ang = Math.atan2(y1 - y2, xr - xl);
      const cy = (y1 + y2) / 2 + sway * (i % 2 ? 1 : -1) * 0.6;
      c.save();
      c.translate(Math.round((xr + xl) / 2), Math.round(cy + 6));
      c.rotate(ang);
      // la base du sprite est à y = h - 6 du bas (rail à axleY)
      const ox = -sp.w / 2, oy = -sp.h + 0;
      c.drawImage(sp.canvas, Math.round(ox), Math.round(oy));
      // roues
      for (const wh of sp.wheels) {
        const th = this.wheelPhase / (wh.r * MPP) + (wh.x * 0.37);
        const fr = Math.floor((((th % Math.PI) + Math.PI) % Math.PI) / Math.PI * 8) & 7;
        const spr = wheelSprite(wh.r, fr, '#1c1c22', wh.driver ? '#a8322d' : '#3a3a44', wh.driver ? '#e8d8b0' : '#9a9aa4');
        c.drawImage(spr, Math.round(ox + wh.x - wh.r), Math.round(oy + sp.h - sp.axleY + 0 - wh.r + 2 - 0 + (wh.r >= 5 ? -1 : 0)));
      }
      if (sp.rods) {
        const dr = sp.wheels.filter(w => w.driver); const r0 = dr[0].r; const th = this.wheelPhase / (r0 * MPP);
        const px = Math.cos(th) * r0 * 0.55, py = Math.sin(th) * r0 * 0.55;
        const wy = oy + sp.h - sp.axleY - r0 + 2 + (r0 >= 5 ? -1 : 0) + r0;
        c.fillStyle = '#c9c9d2'; c.fillRect(Math.round(ox + sp.rods.x1 + px), Math.round(wy + py - 1), Math.round(sp.rods.x2 - sp.rods.x1) + 1, 2);
        c.fillStyle = '#6a6a76'; c.fillRect(Math.round(ox + sp.rods.x1 + px), Math.round(wy + py + 1), Math.round(sp.rods.x2 - sp.rods.x1) + 1, 1);
      }
      // pantographe
      if (sp.pantograph && sim.electric) {
        const px = ox + sp.pantograph.x, py = oy + sp.pantograph.y;
        c.fillStyle = '#3a3a42';
        if (sim.electric.pantoUp) { c.fillRect(Math.round(px - 5), Math.round(py - 38), 11, 1); for (let k = 0; k < 4; k++) { c.fillRect(Math.round(px - 4 + k), Math.round(py - k * 3 - 1), 1, 3); c.fillRect(Math.round(px + 4 - k), Math.round(py - 14 - k * 3 + 0), 1, 3); } c.fillRect(Math.round(px), Math.round(py - 38), 1, 38 - 0); }
        else { c.fillRect(Math.round(px - 6), Math.round(py - 3), 12, 1); c.fillRect(Math.round(px - 3), Math.round(py - 4), 6, 1); }
        if (sim.electric.arc > 0.3 && Math.random() < 0.3) { c.fillStyle = '#bde0ff'; c.fillRect(Math.round(px - 2 + Math.random() * 4), Math.round(py - 38 - Math.random() * 3), 2, 2); this.glows.push({ x: xr - 20, y: cy - 40, r: 20, col: 'rgba(150,200,255,0.8)' }); }
      }
      // feu avant
      if (isLoco && sp.headlight) {
        c.fillStyle = '#fff4b0'; c.fillRect(Math.round(ox + sp.headlight.x - 1), Math.round(oy + sp.headlight.y), 2, 3);
      }
      if (!isLoco && sp.tail && i === sim.vehicles.length - 1) { c.fillStyle = '#ff3b30'; c.fillRect(Math.round(ox), Math.round(oy + sp.h - 22), 2, 3); }
      c.restore();
      // lumières & fumée (en coordonnées écran)
      const bx = (xr + xl) / 2, by = cy + 6;
      if (dark) for (const wd of sp.windows) { const cs = Math.cos(ang), sn = Math.sin(ang); const lx = ox + wd.x + wd.w / 2, ly = oy + wd.y + wd.h / 2; const gx = bx + lx * cs - ly * sn, gy = by + lx * sn + ly * cs; this.emit.push({ x: Math.round(gx - wd.w / 2), y: Math.round(gy - wd.h / 2), w: wd.w, h: wd.h, col: 'rgba(255,214,130,0.85)' }); this.glows.push({ x: gx, y: gy + 4, r: 9, col: 'rgba(255,200,110,0.35)' }); }
      if (isLoco) {
        const cs = Math.cos(ang), sn = Math.sin(ang);
        const world = (px: number, py: number) => ({ x: bx + (ox + px) * cs - (oy + py) * sn, y: by + (ox + px) * sn + (oy + py) * cs });
        if (sp.headlight) { const hp = world(sp.headlight.x, sp.headlight.y + 1); this.headlight = { x: hp.x, y: hp.y }; }
        this.emitLocoParticles(dt, sp, world, veh);
      }
    });
  }
  headlight: { x: number; y: number } | null = null;

  private emitLocoParticles(dt: number, sp: VehicleSprite, world: (x: number, y: number) => { x: number; y: number }, veh: any) {
    const sim = this.trip.sim, ctl = this.trip.ctl;
    const w = this.trip.weather;
    if (sp.chimney) {
      const cp = world(sp.chimney.x, sp.chimney.y);
      const sChimney = this.sFront + (cp.x - FRONT_X) * MPP;
      if (sim.steam) {
        const st = sim.steam;
        // échappement synchronisé avec les coups de piston
        const strokeRate = Math.abs(sim.v) / (Math.PI * 1.7) * 4; // coups/s
        const power = clamp(st.steamUse / (sim.locoDef.powerKW * 10 / 3600 * 1.1), 0, 1.2);
        this.smokeAcc += dt * Math.max(strokeRate, 0.8 + power * 2);
        const heavy = st.bed > 150 * 1.1 || ctl.shovel;
        while (this.smokeAcc >= 1) {
          this.smokeAcc -= 1;
          const dark = clamp(0.25 + (st.bed < 40 ? 0.1 : 0.45) + (this.lastShovel > this.t - 3 ? 0.3 : 0), 0, 1);
          const gray = lerp(235, 55, dark);
          this.spawnSmoke(sChimney, cp.y, 0.7 + power * 1.3, [gray, gray, gray + 6], 4 + Math.round(power * 3), sim.v);
        }
        if (ctl.shovel && sim.steam.shovelCd > 0.85) { this.lastShovel = this.t; }
        if (st.venting) { this.ventAcc += dt * 14; while (this.ventAcc >= 1) { this.ventAcc--; const vp = world(sp.whistle!.x, sp.whistle!.y); this.spawnSmoke(this.sFront + (vp.x - FRONT_X) * MPP, vp.y, 2.6, [245, 245, 250], 3, 0, -26); } }
        if (sim.steam.injFlow > 0 && sim.v < 3) { this.ventAcc += dt * 6; while (this.ventAcc >= 1) { this.ventAcc--; this.spawnSmoke(this.sFront + (cp.x - FRONT_X) * MPP - 6, cp.y + 24, 0.5, [235, 235, 240], 2, 0, 2); } }
      } else if (sim.diesel && sim.diesel.pf > 0.15) {
        this.smokeAcc += dt * (3 + sim.diesel.pf * 8);
        while (this.smokeAcc >= 1) { this.smokeAcc--; const g = lerp(150, 60, sim.diesel.pf * (1.2 - sim.loco.unit.cond.powerplant)); this.spawnSmoke(sChimney, cp.y, 0.5 + sim.diesel.pf * 0.5, [g, g, g + 4], 2 + Math.round(sim.diesel.pf * 2), sim.v); }
      }
    }
    // sifflet
    if (this.trip.whistleHeld && sp.whistle) {
      const wp = world(sp.whistle.x, sp.whistle.y);
      this.ventAcc += dt * 40; while (this.ventAcc >= 1) { this.ventAcc--; this.spawnSmoke(this.sFront + (wp.x - FRONT_X) * MPP, wp.y, 1.6, [245, 245, 250], 2 + (sim.steam ? 1 : 0), 0, -22); }
    }
    // étincelles de freinage
    if (sim.brakeP > 0.3 && Math.abs(sim.v) > 4 && sim.brakeTempAvg > 160) {
      this.sparkAcc += dt * clamp((sim.brakeTempAvg - 150) / 30, 0, 10);
      while (this.sparkAcc >= 1) { this.sparkAcc--; const wh = sp.wheels[Math.floor(Math.random() * sp.wheels.length)]; const wp = world(wh.x, sp.h - 4); this.particles.push({ s: this.sFront + (wp.x - FRONT_X) * MPP, y: wp.y, vx: -Math.sign(sim.v) * (2 + Math.random() * 4), vy: -(Math.random() * 14), life: 0.4, max: 0.4, size: 1, col: [255, 190, 90], a: 1, grow: 0 }); }
    }
    if (sim.slipping) { this.sparkAcc += dt * 18; while (this.sparkAcc >= 1) { this.sparkAcc--; const wh = sp.wheels.find(x => x.driver) ?? sp.wheels[0]; const wp = world(wh.x, sp.h - 3); this.particles.push({ s: this.sFront + (wp.x - FRONT_X) * MPP, y: wp.y, vx: -3 - Math.random() * 3, vy: -(Math.random() * 10), life: 0.35, max: 0.35, size: 1, col: [255, 220, 120], a: 1, grow: 0 }); } }
    void w; void veh;
  }

  spawnSmoke(s: number, y: number, size: number, col: RGB, life: number, v = 0, vy = -10) {
    const wind = this.trip.weather.windMs * Math.cos(this.trip.weather.windDir);
    if (this.particles.length > 420) return;
    this.particles.push({ s, y, vx: -wind * 0.4 + (Math.random() - 0.5) * 1.5 - Math.sign(v) * 0.5, vy: vy - Math.random() * 4, life: life * (0.8 + Math.random() * 0.4), max: life, size: size * 1.5, col, a: 0.85, grow: 2.2 });
  }
  private updateParticles(dt: number) {
    for (const p of this.particles) {
      p.life -= dt; p.s += p.vx * dt; p.y += p.vy * dt; p.vy *= 1 - dt * 0.15;
      if (p.grow) p.size += p.grow * dt;
    }
    this.particles = this.particles.filter(p => p.life > 0);
  }
  private drawParticles() {
    const c = this.c;
    for (const p of this.particles) {
      const x = this.xOf(p.s); if (x < -10 || x > VW + 10) continue;
      const a = clamp(p.life / p.max, 0, 1) * p.a;
      const sz = Math.max(1, Math.round(p.size));
      c.fillStyle = css(p.col, Math.round(a * 4) / 4);
      c.fillRect(Math.round(x - sz / 2), Math.round(p.y - sz / 2), sz, sz);
    }
  }

  private drawForeground() {
    const c = this.c, r = this.route;
    const planes = [{ p: 1.25, dy: 22 }, { p: 1.6, dy: 44 }, { p: 2.2, dy: 74 }];
    for (const pl of planes) {
      const step = 18;
      const s0a = Math.floor((this.sFront - FRONT_X * MPP / pl.p) / step) * step;
      for (let s0 = s0a; s0 < this.sFront + (VW - FRONT_X) * MPP / pl.p + step; s0 += step) {
        const gi = Math.round(clamp(s0, 0, r.length) / 10); if (r.tunnel[gi] || r.bridge[gi]) continue;
        const x = FRONT_X + (s0 - this.sFront) * pl.p / MPP;
        const y = this.yOf(clamp(s0, 0, r.length)) + pl.dy;
        const hsh = (Math.abs(Math.round(s0 * 7 + pl.dy)) * 2654435761 >>> 0);
        const col = this.biomeColor(this.groundBiome(clamp(s0, 0, r.length)), 0, this.season);
        const dark = css(shade(col, 0.5)), light = css(shade(col, 1.25));
        const kind = hsh % 10;
        if (kind < 4) { c.fillStyle = dark; for (let k = 0; k < 5; k++) c.fillRect(Math.round(x + k * 2), Math.round(y - (k % 2 ? 4 : 8) * (pl.p > 1.5 ? 1.4 : 1)), 1, Math.round((k % 2 ? 4 : 8) * (pl.p > 1.5 ? 1.4 : 1))); }
        else if (kind < 5) { c.fillStyle = css(mix(hex('#5a4630'), [0, 0, 0], 0.1)); for (let k = 0; k < 3; k++) c.fillRect(Math.round(x + k * 9), Math.round(y - 10), 1, 11); c.fillRect(Math.round(x), Math.round(y - 8), 19, 1); c.fillRect(Math.round(x), Math.round(y - 4), 19, 1); }
        else if (kind < 6) { const pr = P.tree('bush', hsh % 4, this.season, 12); c.drawImage(pr.canvas, Math.round(x - 6), Math.round(y - 11)); }
        else if (kind < 7 && this.season !== 'hiver') { const fc = this.season === 'automne' ? ['#d9a032', '#b8452c'] : ['#f2e66a', '#e87aa0', '#ffffff']; for (let k = 0; k < 4; k++) { c.fillStyle = fc[(hsh + k) % fc.length]; c.fillRect(Math.round(x + k * 3), Math.round(y - 3 - (k % 2) * 2), 1, 1); c.fillStyle = dark; c.fillRect(Math.round(x + k * 3), Math.round(y - 2 - (k % 2) * 2), 1, 2 + (k % 2) * 2); } }
        else if (kind < 8) { const pr = P.rock(hsh % 4, this.season === 'hiver'); c.drawImage(pr.canvas, Math.round(x - 7), Math.round(y - 8)); }
        else if (kind < 9) { c.fillStyle = light; c.fillRect(Math.round(x), Math.round(y), 6, 1); c.fillStyle = dark; c.fillRect(Math.round(x + 1), Math.round(y + 1), 6, 1); }
      }
    }
  }

  private drawWeather(dt: number) {
    const w = this.trip.weather, c = this.c, sim = this.trip.sim;
    const tunnel = routeTunnel(this.route, sim.s);
    if (tunnel) return;
    if (w.kind === 'rain' || w.kind === 'snow') {
      const n = Math.round(this.rain.length * clamp(w.precip * 1.4, 0.2, 1));
      const slant = (w.windMs * Math.cos(w.windDir) * 1.5 - sim.v * 0.6);
      for (let i = 0; i < n; i++) {
        const d = this.rain[i];
        if (w.kind === 'rain') { d.y += dt * 260 * d.v; d.x += dt * slant * 8; c.fillStyle = 'rgba(190,210,235,0.55)'; c.fillRect(Math.round(d.x), Math.round(d.y), 1, 4); }
        else { d.y += dt * 40 * d.v; d.x += dt * (slant * 5 + Math.sin(this.t * 2 + i) * 12); c.fillStyle = 'rgba(255,255,255,0.9)'; c.fillRect(Math.round(d.x), Math.round(d.y), 2, 2); }
        if (d.y > VH) { d.y = -6; d.x = Math.random() * VW; }
        if (d.x < -4) d.x += VW + 8; if (d.x > VW + 4) d.x -= VW + 8;
      }
      c.fillStyle = `rgba(120,130,150,${0.12 * w.precip})`; c.fillRect(0, 0, VW, VH);
    }
    if (w.fog > 0.05) { const g = c.createLinearGradient(0, 120, 0, VH); const a = clamp(w.fog * 0.75, 0, 0.8); const fc = css(mix(this.sky.hor, [220, 224, 228], 0.5)); g.addColorStop(0, css(mix(this.sky.hor, [220, 224, 228], 0.5), a * 0.8)); g.addColorStop(1, css(mix(this.sky.hor, [220, 224, 228], 0.5), a)); c.fillStyle = g; c.fillRect(0, 0, VW, VH); void fc; }
  }

  private applyLighting(dl: { light: number; dawn: number }, tunnel: boolean) {
    const c = this.c, lc = this.lc;
    const w = this.trip.weather;
    const dark = tunnel ? 0.0 : dl.light;
    // teinte ambiante
    const night: RGB = [0.2, 0.26, 0.46], day: RGB = [1, 1, 1], dusk: RGB = [1.0, 0.78, 0.66], tun: RGB = [0.16, 0.16, 0.2];
    let amb = tunnel ? tun : mix(night, day, smooth(clamp(dark * 1.15, 0, 1)));
    if (!tunnel) amb = mix(amb, dusk, dl.dawn * 0.6 * (dark > 0.05 ? 1 : 0));
    const over = w.cloud * 0.18 + (w.kind === 'rain' || w.kind === 'snow' ? 0.1 : 0);
    amb = [amb[0] * (1 - over), amb[1] * (1 - over), amb[2] * (1 - over * 0.8)];
    this.ambient = amb;
    const needLights = amb[0] < 0.97 || amb[2] < 0.97;
    if (needLights) {
      lc.globalCompositeOperation = 'source-over';
      lc.fillStyle = `rgb(${Math.round(amb[0] * 255)},${Math.round(amb[1] * 255)},${Math.round(amb[2] * 255)})`;
      lc.fillRect(0, 0, VW, VH);
      lc.globalCompositeOperation = 'lighter';
      const strength = clamp(1 - dark * 1.1, 0, 1);
      for (const g of this.glows) { if (g.x < -40 || g.x > VW + 40) continue; const gr = lc.createRadialGradient(g.x, g.y, 0, g.x, g.y, g.r); gr.addColorStop(0, g.col); gr.addColorStop(1, 'rgba(0,0,0,0)'); lc.fillStyle = gr; lc.globalAlpha = tunnel ? 1 : clamp(strength * 1.2, 0, 1); lc.fillRect(g.x - g.r, g.y - g.r, g.r * 2, g.r * 2); }
      lc.globalAlpha = 1;
      // phare
      if (this.headlight && strength > 0.05) {
        const h = this.headlight; const L = 190;
        const gr = lc.createRadialGradient(h.x, h.y, 2, h.x + 70, h.y + 4, L); gr.addColorStop(0, `rgba(255,244,190,${0.9 * clamp(strength + (tunnel ? 0.6 : 0), 0, 1)})`); gr.addColorStop(1, 'rgba(0,0,0,0)');
        lc.fillStyle = gr; lc.beginPath(); lc.moveTo(h.x, h.y - 3); lc.lineTo(h.x + L, h.y - 46); lc.lineTo(h.x + L, h.y + 52); lc.lineTo(h.x, h.y + 3); lc.closePath(); lc.fill();
        const g2 = lc.createRadialGradient(h.x, h.y, 0, h.x, h.y, 22); g2.addColorStop(0, 'rgba(255,240,170,0.8)'); g2.addColorStop(1, 'rgba(0,0,0,0)'); lc.fillStyle = g2; lc.fillRect(h.x - 22, h.y - 22, 44, 44);
      }
      lc.globalCompositeOperation = 'source-over';
      c.globalCompositeOperation = 'multiply'; c.drawImage(this.light, 0, 0); c.globalCompositeOperation = 'source-over';
      // éléments émissifs par-dessus
      for (const e of this.emit) { c.fillStyle = e.col; c.fillRect(e.x, e.y, e.w, e.h); }
    } else for (const e of this.emit) if (e.col.startsWith('#')) { c.fillStyle = e.col; c.fillRect(e.x, e.y, e.w, e.h); }
    // vignette douce
    const vg = c.createRadialGradient(VW / 2, VH / 2, VH * 0.45, VW / 2, VH / 2, VW * 0.62); vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,12,0.28)');
    c.fillStyle = vg; c.fillRect(0, 0, VW, VH);
    this.headlight = null;
  }
}
export { eraAt, locoById, routeBridge, routeElectrified, routeCurv };
