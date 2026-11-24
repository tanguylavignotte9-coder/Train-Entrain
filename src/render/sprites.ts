import { locoById, wagonById, goodById, type LocoDef, type WagonDef } from '../data';
import { hashInts, hashString } from '../core/rng';
import { makeCanvas, ctx2d, hex, css, shade, mix, rect, disc, drawText, textWidth, type RGB } from './pixel';

export const MPP = 0.5; // mètres par pixel

export interface VehicleSprite {
  canvas: HTMLCanvasElement; w: number; h: number; wheels: { x: number; r: number; driver?: boolean }[]; axleY: number;
  chimney?: { x: number; y: number }; whistle?: { x: number; y: number }; pantograph?: { x: number; y: number };
  windows: { x: number; y: number; w: number; h: number }[]; headlight?: { x: number; y: number }; tail?: { x: number; y: number };
  rods?: { x1: number; x2: number; y: number }; couplerY: number; firebox?: { x: number; y: number };
}

const cache = new Map<string, VehicleSprite>();
const K = {
  black: hex('#25252b'), steel: hex('#3a3a44'), brass: hex('#c9a24a'), red: hex('#a8322d'), white: hex('#e8e6dc'), glass: hex('#9fc3d6'), glassNight: hex('#f2d58a'),
};

function sprite(w: number, h: number, draw: (c: CanvasRenderingContext2D) => void): HTMLCanvasElement {
  const cv = makeCanvas(w, h); const c = ctx2d(cv); draw(c); return cv;
}
const fill = (c: CanvasRenderingContext2D, col: RGB, x: number, y: number, w: number, h: number) => rect(c, x, y, w, h, css(col));

/** Boîte avec ombrage 3 tons (haut clair, bas sombre). */
function box(c: CanvasRenderingContext2D, col: RGB, x: number, y: number, w: number, h: number) {
  fill(c, col, x, y, w, h);
  fill(c, shade(col, 1.18), x, y, w, 1);
  fill(c, shade(col, 0.78), x, y + h - 1, w, 1);
  if (h > 8) fill(c, shade(col, 0.9), x, y + Math.floor(h * 0.6), w, 1);
}

// ---------------------------------------------------------------- locomotives
function steamLoco(d: LocoDef): VehicleSprite {
  const L = Math.round(d.lengthM / MPP), H = 44;
  const tank = d.id === 's030';
  const scheme: Record<string, { body: RGB; acc: RGB; wheel: string }> = {
    s030: { body: hex('#2c4a3a'), acc: hex('#c9a24a'), wheel: '#a8322d' },
    s230: { body: hex('#1f3b2e'), acc: hex('#c9a24a'), wheel: '#a8322d' },
    s140: { body: hex('#25252b'), acc: hex('#a8322d'), wheel: '#25252b' },
    s231: { body: hex('#4a1f24'), acc: hex('#c9a24a'), wheel: '#25252b' },
    s241: { body: hex('#1c1c22'), acc: hex('#8a8a96'), wheel: '#25252b' },
  };
  const sc = scheme[d.id] ?? scheme.s140;
  const tenderL = tank ? 0 : Math.round(L * 0.36);
  const locoL = L - tenderL;
  const base = H - 8; // y du bas du châssis
  const bh = d.id === 's241' ? 15 : d.id === 's030' ? 12 : 13;
  const bTop = base - 7 - bh;
  const wheels: VehicleSprite['wheels'] = [];
  const cv = sprite(L, H, c => {
    // châssis
    fill(c, K.black, 0, base - 5, L, 4);
    fill(c, shade(K.black, 1.5), 0, base - 5, L, 1);
    // tender
    if (!tank) {
      box(c, shade(sc.body, 0.9), 0, base - 20, tenderL - 2, 15);
      fill(c, hex('#111114'), 2, base - 24, tenderL - 6, 4); // charbon
      for (let i = 0; i < tenderL - 8; i += 3) fill(c, hex('#303036'), 3 + i, base - 25 + (i % 2), 2, 1);
      fill(c, sc.acc, 1, base - 12, tenderL - 4, 1);
      fill(c, K.black, tenderL - 3, base - 8, 3, 2); // attelage tender
    }
    const x0 = tenderL;
    // cabine
    const cabW = Math.round(locoL * 0.2);
    box(c, shade(sc.body, 1.05), x0, base - 24, cabW, 19);
    fill(c, K.black, x0 - 1, base - 26, cabW + 3, 2); // toit
    fill(c, shade(K.black, 1.4), x0 - 1, base - 26, cabW + 3, 1);
    fill(c, K.glass, x0 + 2, base - 20, Math.max(3, cabW - 5), 7);
    fill(c, shade(K.glass, 0.6), x0 + 2, base - 20, Math.max(3, cabW - 5), 1);
    // chaudière
    const bx = x0 + cabW, bw = locoL - cabW - 2;
    box(c, sc.body, bx, bTop, bw, bh);
    fill(c, shade(sc.body, 1.25), bx, bTop + 1, bw, 1);
    for (let i = 4; i < bw - 3; i += Math.max(7, Math.round(bw / 5))) fill(c, sc.acc, bx + i, bTop, 1, bh); // frettes
    // chambre à fumée + porte
    fill(c, K.steel, bx + bw - 6, bTop - 1, 6, bh + 2);
    fill(c, shade(K.steel, 1.3), bx + bw - 6, bTop - 1, 6, 1);
    disc(c, bx + bw - 2, bTop + bh / 2, 2, css(shade(K.steel, 0.7)));
    // dôme et sablier
    box(c, sc.body, bx + Math.round(bw * 0.35), bTop - 4, 6, 4);
    fill(c, sc.acc, bx + Math.round(bw * 0.35) + 1, bTop - 5, 4, 1);
    box(c, sc.body, bx + Math.round(bw * 0.62), bTop - 3, 5, 3);
    // cheminée
    const chx = bx + bw - 5;
    const tall = d.id === 's230' || d.id === 's231';
    fill(c, K.black, chx, bTop - (tall ? 8 : 6), 4, tall ? 8 : 6);
    fill(c, sc.acc, chx - 1, bTop - (tall ? 9 : 7), 6, 2);
    if (d.id === 's241') { fill(c, K.steel, chx - 5, bTop - 8, 3, 9); fill(c, K.steel, chx + 6, bTop - 8, 3, 9); }
    // cylindre + tringles
    box(c, K.steel, bx + bw - 14, base - 12, 9, 6);
    // lanterne
    fill(c, hex('#f5e7a0'), bx + bw, bTop + 4, 2, 3);
    // chasse-corps
    fill(c, K.black, locoL - 3, base - 4, 4, 3);
    fill(c, sc.acc, locoL - 3, base - 4, 4, 1);
    if (tank) { box(c, shade(sc.body, 0.95), x0 + cabW + 3, bTop + 2, Math.round(bw * 0.4), bh - 3); }
    // roues motrices
    const nDr = d.id === 's230' || d.id === 's231' ? 2 : d.id === 's030' ? 3 : d.id === 's140' ? 4 : 4;
    const rD = d.id === 's230' || d.id === 's231' ? 7 : d.id === 's241' ? 7 : d.id === 's140' ? 5 : 4;
    const spacing = rD * 2 + 1;
    const startX = x0 + cabW + 3;
    for (let i = 0; i < nDr; i++) wheels.push({ x: startX + rD + i * spacing, r: rD, driver: true });
    wheels.push({ x: bx + bw - 6, r: 3 });
    if (!tank) { wheels.push({ x: x0 + 4, r: 3 }); wheels.push({ x: 7, r: 3 }); wheels.push({ x: tenderL - 9, r: 3 }); }
    else wheels.push({ x: x0 + 3, r: 3 });
    // garde-boue
    for (const w of wheels) if (w.driver) fill(c, K.black, w.x - w.r, base - 4 - w.r * 2 + 1 - 2, w.r * 2 + 1, 1);
  });
  const bx = tenderL + Math.round(locoL * 0.2);
  const chx = bx + (locoL - Math.round(locoL * 0.2) - 2) - 5;
  const dr = wheels.filter(w => w.driver);
  return {
    canvas: cv, w: L, h: H, wheels, axleY: 8, chimney: { x: chx + 2, y: bTop - 8 }, whistle: { x: tenderL + Math.round(locoL * 0.35) + 3, y: bTop - 6 },
    windows: [{ x: tenderL + 2, y: base - 20, w: 5, h: 7 }], headlight: { x: L - 1, y: bTop + 5 }, couplerY: 7,
    rods: dr.length ? { x1: dr[0].x, x2: dr[dr.length - 1].x, y: base - 4 - dr[0].r } : undefined,
    firebox: { x: tenderL + 2, y: base - 12 },
  };
}

function dieselElec(d: LocoDef): VehicleSprite {
  const L = Math.round(d.lengthM / MPP), H = 40, base = H - 6;
  const electric = d.traction === 'electric';
  const sch: Record<string, { body: RGB; stripe: RGB; roof: RGB }> = {
    d_taupe: { body: hex('#d9a620'), stripe: hex('#2c2c32'), roof: hex('#555560') },
    d_renard: { body: hex('#3f6b4e'), stripe: hex('#e1d7a8'), roof: hex('#5e6a62') },
    d_lynx: { body: hex('#c76a2a'), stripe: hex('#e8dfc4'), roof: hex('#6a6a70') },
    d_orque: { body: hex('#2c4f8a'), stripe: hex('#e9c33a'), roof: hex('#7a8088') },
    d_condor: { body: hex('#e6e8ea'), stripe: hex('#b0302c'), roof: hex('#8a9096') },
    e_eclair: { body: hex('#4a5d3a'), stripe: hex('#c9a24a'), roof: hex('#5a5a50') },
    e_foudre: { body: hex('#27506b'), stripe: hex('#e8dfc4'), roof: hex('#6a7078') },
    e_tonnerre: { body: hex('#a8322d'), stripe: hex('#e8e6dc'), roof: hex('#80868c') },
    e_aurore: { body: hex('#2f8a8a'), stripe: hex('#f1f1ee'), roof: hex('#80868c') },
  };
  const sc = sch[d.id] ?? sch.d_renard;
  const wheels: VehicleSprite['wheels'] = [];
  const win: VehicleSprite['windows'] = [];
  const hh = d.id === 'd_taupe' ? 17 : 22;
  const top = base - 4 - hh;
  const cv = sprite(L, H, c => {
    fill(c, K.black, 2, base - 5, L - 4, 4);
    box(c, sc.body, 0, top, L, hh);
    fill(c, sc.roof, 1, top - 2, L - 2, 3);
    fill(c, shade(sc.roof, 1.3), 1, top - 2, L - 2, 1);
    fill(c, sc.stripe, 0, top + Math.round(hh * 0.55), L, 2);
    // cabine avant (droite) et arrière
    const cw = d.id === 'd_taupe' ? Math.round(L * 0.42) : 9;
    fill(c, K.glass, L - cw + 1, top + 3, cw - 3, 8); win.push({ x: L - cw + 1, y: top + 3, w: cw - 3, h: 8 });
    fill(c, shade(K.glass, 0.6), L - cw + 1, top + 3, cw - 3, 1);
    if (d.id !== 'd_taupe') { fill(c, K.glass, 2, top + 3, 6, 8); win.push({ x: 2, y: top + 3, w: 6, h: 8 }); }
    // grilles de ventilation
    for (let x = cw === 9 ? 12 : 3; x < L - cw - 4; x += 5) { fill(c, shade(sc.body, 0.55), x, top + 4, 3, 7); fill(c, shade(sc.body, 0.8), x, top + 5, 3, 1); fill(c, shade(sc.body, 0.8), x, top + 8, 3, 1); }
    // phares
    fill(c, hex('#fff4b0'), L - 1, top + hh - 7, 1, 3); fill(c, K.red, 0, top + hh - 7, 1, 3);
    // jupe et marchepieds
    fill(c, shade(sc.body, 0.6), 2, top + hh, L - 4, 3);
    // bogies
    const nb = d.lengthM > 12 ? 2 : 1;
    const nAx = d.lengthM > 17 ? 3 : 2;
    const r = d.id === 'd_taupe' ? 4 : 4;
    for (let b = 0; b < nb; b++) {
      const cx = nb === 1 ? L / 2 : (b === 0 ? L * 0.24 : L * 0.76);
      for (let a = 0; a < nAx; a++) { const sx = (a - (nAx - 1) / 2) * (r * 2 + 2); wheels.push({ x: Math.round(cx + sx), r }); }
      fill(c, K.black, Math.round(cx - nAx * (r + 1)), base - 6, nAx * (r * 2 + 2), 2);
    }
    if (electric) { fill(c, K.black, Math.round(L * 0.44), top - 4, 10, 2); }
  });
  return {
    canvas: cv, w: L, h: H, wheels, axleY: 6, windows: win, headlight: { x: L - 1, y: top + hh - 6 }, couplerY: 7,
    pantograph: electric ? { x: Math.round(L * 0.5), y: top - 3 } : undefined,
    chimney: electric ? undefined : { x: Math.round(L * 0.35), y: top - 2 }, whistle: { x: Math.round(L * 0.6), y: top - 3 },
  };
}

// ---------------------------------------------------------------- wagons
const COACH_COL: RGB[] = [hex('#6b3a2a'), hex('#3d5a45'), hex('#4a4a6b')];
function pick<T>(arr: T[], seed: number): T { return arr[seed % arr.length]; }

function wagonSprite(d: WagonDef, uid: number, cargoColor?: string, loadFrac = 0): VehicleSprite {
  const L = Math.round(d.lengthM / MPP), H = 36, base = H - 6;
  const seed = hashInts(uid, hashString(d.id));
  const wheels: VehicleSprite['wheels'] = [];
  const win: VehicleSprite['windows'] = [];
  const bogie = d.lengthM >= 12;
  const r = 3;
  const era = d.introYear;
  const cv = sprite(L, H, c => {
    fill(c, K.black, 1, base - 4, L - 2, 3);
    let top = base - 5;
    switch (d.type) {
      case 'coach': {
        const body = era < 1930 ? pick(COACH_COL, seed) : era < 1975 ? pick([hex('#2f5a3a'), hex('#a8322d'), hex('#2f4a6b')], seed) : pick([hex('#d9dde0'), hex('#c9ced2')], seed);
        const hh = 20; top = base - 4 - hh;
        box(c, body, 0, top, L, hh);
        fill(c, shade(body, 0.7), 1, top - 2, L - 2, 3);
        fill(c, shade(body, 1.2), 1, top - 2, L - 2, 1);
        if (era >= 1975) fill(c, hex('#2f4a8a'), 0, top + 12, L, 2); else fill(c, hex('#d6b25a'), 0, top + 12, L, 1);
        const nw = Math.max(3, Math.floor((L - 8) / 8));
        for (let i = 0; i < nw; i++) { const x = 4 + Math.round(i * (L - 12) / Math.max(1, nw - 1)); fill(c, K.glass, x, top + 3, 5, 7); fill(c, shade(K.glass, 0.6), x, top + 3, 5, 1); win.push({ x, y: top + 3, w: 5, h: 7 }); }
        const cls = d.seats.c1 > 0 && d.seats.c2 === 0 && d.seats.c3 === 0 ? '1' : d.seats.c3 > 0 && d.seats.c1 === 0 && d.seats.c2 === 0 ? '3' : d.seats.c2 > 0 && d.seats.c1 === 0 ? '2' : '';
        if (cls) drawText(c, cls, L / 2 - 1, top + 14, '#f3eed8');
        break;
      }
      case 'mail': {
        const body = hex('#7a4a2a'); const hh = 19; top = base - 4 - hh;
        box(c, body, 0, top, L, hh); fill(c, shade(body, 0.7), 1, top - 2, L - 2, 3); fill(c, hex('#d6b25a'), 0, top + 10, L, 1);
        fill(c, shade(body, 0.55), Math.round(L / 2) - 4, top + 3, 9, 13); fill(c, shade(body, 0.75), Math.round(L / 2), top + 3, 1, 13);
        fill(c, K.red, 3, top + 5, 4, 3); drawText(c, 'P', 4, top + 4, '#f3eed8');
        break;
      }
      case 'open': {
        const body = hex('#5b4636'); const hh = 12; top = base - 4 - hh;
        box(c, body, 0, top, L, hh);
        for (let x = 3; x < L - 2; x += 5) fill(c, shade(body, 0.7), x, top + 1, 1, hh - 2);
        fill(c, shade(body, 1.3), 0, top, L, 1);
        if (cargoColor && loadFrac > 0.02) {
          const col = hex(cargoColor); const ph = 2 + Math.round(loadFrac * 5);
          for (let x = 1; x < L - 1; x++) { const hh2 = Math.round(ph * Math.sin((x / (L - 2)) * Math.PI) ** 0.6); fill(c, shade(col, 0.85 + ((x * 7) % 5) * 0.05), x, top - hh2, 1, hh2 + 1); }
        }
        break;
      }
      case 'flat': {
        top = base - 6; box(c, hex('#4d3f33'), 0, top, L, 2);
        for (const x of [2, L - 4]) { fill(c, K.black, x, top - 8, 1, 8); }
        if (cargoColor && loadFrac > 0.02) {
          const col = hex(cargoColor);
          if (cargoColor === '#9c6b3a') { for (let row = 0; row < 3; row++) for (let i = 0; i < Math.floor((L - 4) / 4); i++) { fill(c, shade(col, 0.8 + ((i + row) % 3) * 0.15), 3 + i * 4, top - 3 - row * 3, 4, 3); disc(c, 5 + i * 4, top - 2 - row * 3, 1, css(shade(col, 1.25))); } }
          else { const hh = 3 + Math.round(loadFrac * 4); for (let i = 0; i < Math.floor((L - 4) / 6); i++) box(c, shade(col, 0.9 + (i % 3) * 0.1), 3 + i * 6, top - hh, 5, hh); }
        }
        top -= 2; break;
      }
      case 'covered': {
        const body = pick([hex('#7a5a3c'), hex('#6a4a3a'), hex('#5a6a4a')], seed); const hh = 17; top = base - 4 - hh;
        box(c, body, 0, top, L, hh); fill(c, shade(body, 0.65), 1, top - 2, L - 2, 3);
        for (let x = 3; x < L - 2; x += 4) fill(c, shade(body, 0.82), x, top + 1, 1, hh - 2);
        fill(c, shade(body, 0.5), Math.round(L / 2) - 4, top + 2, 8, hh - 4); fill(c, hex('#b8a888'), Math.round(L / 2) - 4, top + 2, 8, 1);
        break;
      }
      case 'cattle': {
        const body = hex('#7a5a3c'); const hh = 17; top = base - 4 - hh;
        box(c, body, 0, top, L, hh); fill(c, shade(body, 0.65), 1, top - 2, L - 2, 3);
        for (let x = 2; x < L - 2; x += 3) { fill(c, shade(body, 0.45), x, top + 3, 1, 8); }
        fill(c, shade(body, 0.45), 1, top + 3, L - 2, 1); fill(c, shade(body, 0.45), 1, top + 10, L - 2, 1);
        break;
      }
      case 'tank': {
        const col = hex('#2c2c32'); const hh = 14; top = base - 4 - hh;
        fill(c, K.black, 2, base - 7, L - 4, 3);
        disc(c, 0, 0, 0, '#000');
        for (let y = 0; y < hh; y++) { const t = Math.abs((y - hh / 2 + 0.5) / (hh / 2)); const inset = Math.round(3 * t * t * 1.3); fill(c, shade(col, 1.5 - t * 0.9), inset + 1, top + y, L - 2 * inset - 2, 1); }
        fill(c, hex('#c9722b'), 6, top + Math.round(hh / 2) - 1, L - 12, 2);
        fill(c, K.black, Math.round(L / 2) - 2, top - 3, 4, 3);
        break;
      }
      case 'reefer': {
        const body = hex('#e6e3d6'); const hh = 17; top = base - 4 - hh;
        box(c, body, 0, top, L, hh); fill(c, shade(body, 0.75), 1, top - 2, L - 2, 3);
        fill(c, hex('#4a8a9a'), 0, top + 12, L, 2);
        fill(c, shade(body, 0.6), Math.round(L / 2) - 3, top + 3, 7, 10); fill(c, K.red, 2, top + 3, 1, 5);
        break;
      }
      case 'container': {
        top = base - 6; fill(c, hex('#4d4d55'), 0, top, L, 2);
        const cols = [hex('#b8442c'), hex('#2c5a8a'), hex('#d6a22a'), hex('#4a7a4a'), hex('#8a8a92')];
        const n = Math.floor((L - 2) / 18);
        for (let i = 0; i < n; i++) { const col = pick(cols, seed + i * 3); box(c, col, 1 + i * 18, top - 14, 17, 14); for (let k = 3; k < 17; k += 2) fill(c, shade(col, 0.82), 1 + i * 18 + k, top - 13, 1, 12); }
        break;
      }
    }
    // bogies / essieux
    if (bogie) { for (const cx of [Math.round(L * 0.2), Math.round(L * 0.8)]) { for (const dx of [-3, 3]) wheels.push({ x: cx + dx, r }); fill(c, K.black, cx - 6, base - 5, 12, 2); } }
    else { wheels.push({ x: Math.round(L * 0.25), r }); wheels.push({ x: Math.round(L * 0.75), r }); }
    void top;
  });
  return { canvas: cv, w: L, h: H, wheels, axleY: 6, windows: win, couplerY: 7, tail: { x: 0, y: 12 } };
}

export function vehicleSprite(defId: string, kind: 'loco' | 'wagon', uid = 0, cargo?: string, loadFrac = 0): VehicleSprite {
  const lf = Math.round(loadFrac * 4) / 4;
  const key = `${defId}|${kind === 'wagon' ? uid % 6 : 0}|${cargo ?? ''}|${lf}`;
  let s = cache.get(key); if (s) return s;
  if (kind === 'loco') { const d = locoById(defId); s = d.traction === 'steam' ? steamLoco(d) : dieselElec(d); }
  else s = wagonSprite(wagonById(defId), uid % 6, cargo ? goodById(cargo).color : undefined, loadFrac);
  cache.set(key, s); return s;
}
export { textWidth, mix };
