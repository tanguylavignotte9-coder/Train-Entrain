import { hashInts } from '../core/rng';
import { makeCanvas, ctx2d, hex, css, shade, mix, rect, disc, drawText, textWidth, type RGB } from './pixel';

export type Season = 'hiver' | 'printemps' | 'été' | 'automne';
export interface Prop { canvas: HTMLCanvasElement; w: number; h: number; ax: number; glow?: { x: number; y: number; r: number; col: string }[] }

const cache = new Map<string, Prop>();
function make(key: string, w: number, h: number, ax: number, draw: (c: CanvasRenderingContext2D) => void, glow?: Prop['glow']): Prop {
  let p = cache.get(key); if (p) return p;
  const cv = makeCanvas(w, h); const c = ctx2d(cv); draw(c);
  p = { canvas: cv, w, h, ax, glow }; cache.set(key, p); return p;
}
const f = (c: CanvasRenderingContext2D, col: RGB | string, x: number, y: number, w: number, h: number) => rect(c, x, y, w, h, typeof col === 'string' ? col : css(col));

const LEAF: Record<Season, RGB[]> = {
  printemps: [hex('#7fb04a'), hex('#8cc254'), hex('#6fa043')],
  été: [hex('#3f7a3a'), hex('#4a8a40'), hex('#356e36')],
  automne: [hex('#c8742a'), hex('#b8452c'), hex('#d4a032'), hex('#8a5a28')],
  hiver: [hex('#5a4a3a'), hex('#4a3e32'), hex('#6a5a4a')],
};
const CONIFER: Record<Season, RGB> = { printemps: hex('#2f5f3a'), été: hex('#2a5836'), automne: hex('#2e5a3c'), hiver: hex('#34584a') };

export function tree(kind: 'conifer' | 'broad' | 'poplar' | 'bush' | 'pine', variant: number, season: Season, h = 24): Prop {
  const key = `tree|${kind}|${variant}|${season}|${h}`;
  const w = kind === 'bush' ? 12 : kind === 'poplar' ? 8 : 18 + (h > 28 ? 4 : 0);
  return make(key, w, h + 2, Math.round(w / 2), c => {
    const trunk = hex('#4a3426');
    if (kind === 'conifer' || kind === 'pine') {
      const col = CONIFER[season]; const tiers = 4 + (variant % 2);
      f(c, trunk, w / 2 - 1, h - 5, 2, 5);
      for (let i = 0; i < tiers; i++) {
        const ty = Math.round(i * (h - 6) / tiers), tw = Math.round(5 + (i + 1) * (w - 6) / tiers);
        for (let r = 0; r < Math.round((h - 6) / tiers) + 3; r++) { const ww = Math.max(2, Math.round(tw * (r + 1) / ((h - 6) / tiers + 3))); f(c, shade(col, 0.82 + (i % 2) * 0.12 + (r % 2) * 0.04), w / 2 - ww / 2, ty + r, ww, 1); }
      }
      if (season === 'hiver') for (let i = 0; i < tiers; i++) f(c, hex('#e8f0f4'), w / 2 - 3 - i, Math.round(i * (h - 6) / tiers) + 2, 2 + i * 2, 1);
      if (kind === 'pine') f(c, shade(col, 1.2), w / 2 - 1, 0, 2, 2);
    } else if (kind === 'broad') {
      f(c, trunk, w / 2 - 1, h * 0.5, 3, h * 0.5);
      const cols = LEAF[season];
      const rr = Math.round(w / 2 - 1);
      const cx = w / 2, cy = h * 0.38;
      for (let k = 0; k < 7; k++) {
        const col = cols[(k + variant) % cols.length];
        const ox = Math.round(Math.cos(k * 2.1 + variant) * rr * 0.5), oy = Math.round(Math.sin(k * 1.7 + variant) * rr * 0.45);
        if (season === 'hiver') { f(c, trunk, cx + ox / 2, cy + oy / 2 - 2, 1, 6); f(c, trunk, cx + ox, cy + oy - 3, 1, 3); }
        else disc(c, cx + ox, cy + oy, Math.max(3, rr - 3 + (k % 2)), css(shade(col, 0.8 + (k % 3) * 0.12)));
      }
      if (season === 'hiver') f(c, hex('#eef3f5'), cx - 4, cy - 3, 8, 1);
    } else if (kind === 'poplar') {
      f(c, trunk, w / 2 - 1, h - 4, 2, 4);
      const col = LEAF[season][variant % LEAF[season].length];
      for (let y = 0; y < h - 3; y++) { const t = y / (h - 3); const ww = Math.round(3 + 3 * Math.sin(Math.min(1, t * 1.2) * Math.PI * 0.8)); if (season !== 'hiver') f(c, shade(col, 0.8 + (y % 3) * 0.1), w / 2 - ww / 2, y, ww, 1); else f(c, trunk, w / 2, y, 1, 1); }
    } else {
      const cols = season === 'hiver' ? [hex('#dfe8ec'), hex('#c4d2d8')] : LEAF[season];
      for (let k = 0; k < 4; k++) disc(c, 3 + k * 2.5, h - 3 - (k % 2), 3, css(shade(cols[k % cols.length], 0.85 + (k % 2) * 0.15)));
    }
  });
}

export function rock(variant: number, snow: boolean): Prop {
  return make(`rock|${variant}|${snow}`, 14, 10, 7, c => {
    const col = hex('#7a7a82');
    for (let y = 0; y < 8; y++) { const ww = Math.round(4 + (y < 4 ? y * 2 : (8 - y) * 2 + 1) + variant % 3); f(c, shade(col, 0.8 + y * 0.04), 7 - ww / 2, 9 - y - 1, ww, 1); }
    if (snow) f(c, hex('#eef3f5'), 4, 3, 6, 1);
  });
}

// ----- bâtiments -----
const ROOFS = [hex('#a8442c'), hex('#7a3a2a'), hex('#4a5a6a'), hex('#8a6a3a')];
const WALLS = [hex('#d8c9a4'), hex('#c4b08a'), hex('#e0d6c0'), hex('#b8a08a'), hex('#cfd3d4')];
export function house(variant: number, season: Season, modern = false): Prop {
  const key = `house|${variant}|${season}|${modern}`;
  const w = 20 + (variant % 3) * 4, h = 22 + (variant % 2) * 4;
  return make(key, w, h, w / 2, c => {
    const wall = WALLS[variant % WALLS.length], roof = modern ? hex('#6a6a70') : ROOFS[variant % ROOFS.length];
    const wh = h - 9;
    f(c, wall, 1, h - wh, w - 2, wh); f(c, shade(wall, 0.85), 1, h - 2, w - 2, 2);
    for (let r = 0; r < 8; r++) { const ww = Math.max(2, w + 2 - r * 3); f(c, shade(roof, 0.85 + (r % 2) * 0.12), (w - ww) / 2, h - wh - 8 + r, ww, 1); }
    if (season === 'hiver') f(c, hex('#eef3f5'), 2, h - wh - 8, w - 4, 2);
    f(c, hex('#5a3a2a'), w / 2 - 2, h - 8, 4, 7);
    f(c, hex('#8fb7cc'), 4, h - wh + 3, 4, 4); f(c, hex('#8fb7cc'), w - 8, h - wh + 3, 4, 4);
    f(c, shade(roof, 0.7), w - 7, h - wh - 8, 3, 6);
  }, [{ x: 6, y: h - wh() , r: 7, col: 'rgba(255,200,110,0.55)' }]);
  function wh() { return 16; }
}
export function church(season: Season): Prop {
  return make(`church|${season}`, 22, 44, 11, c => {
    const wall = hex('#d6cfb8'), roof = hex('#6a4a3a');
    f(c, wall, 2, 26, 18, 18); f(c, shade(wall, 0.85), 2, 42, 18, 2);
    for (let r = 0; r < 6; r++) f(c, roof, 2 + r, 22 + r, 18 - r * 2, 1);
    f(c, wall, 8, 8, 6, 28); f(c, shade(wall, 0.8), 8, 8, 1, 28);
    for (let r = 0; r < 8; r++) f(c, roof, 8 + (r >> 1) + (r > 4 ? 1 : 0), r, Math.max(1, 6 - r), 1);
    f(c, hex('#2c2c32'), 10, 12, 2, 4); f(c, hex('#c9a24a'), 10, 0, 2, 1);
    f(c, hex('#8fb7cc'), 5, 30, 2, 5); f(c, hex('#8fb7cc'), 15, 30, 2, 5);
  }, [{ x: 11, y: 32, r: 9, col: 'rgba(255,200,110,0.4)' }]);
}
export function tower(variant: number): Prop {
  return make(`tower|${variant}`, 16, 40 + (variant % 3) * 10, 8, c => {
    const h = 40 + (variant % 3) * 10; const col = pick([hex('#9a9aa2'), hex('#a8a090'), hex('#7a8590')], variant);
    f(c, col, 1, 4, 14, h - 4); f(c, shade(col, 0.75), 1, 4, 3, h - 4); f(c, shade(col, 1.2), 1, 4, 14, 1);
    for (let y = 8; y < h - 4; y += 5) for (let x = 5; x < 14; x += 4) f(c, hex('#d8e6ee'), x, y, 2, 3);
  }, [{ x: 8, y: 24, r: 14, col: 'rgba(255,220,140,0.28)' }]);
}
function pick<T>(a: T[], i: number): T { return a[i % a.length]; }

export function industry(kind: string, season: Season): Prop {
  const key = `ind|${kind}|${season}`;
  switch (kind) {
    case 'coal_mine': return make(key, 46, 54, 23, c => {
      f(c, hex('#4a3a30'), 4, 30, 22, 22); f(c, hex('#3a2c24'), 4, 28, 22, 3);
      f(c, hex('#6a5a4a'), 20, 4, 3, 48); f(c, hex('#6a5a4a'), 8, 4, 3, 48);
      f(c, hex('#6a5a4a'), 8, 4, 15, 3);
      disc(c, 9.5, 9, 4, css(hex('#2c2c32'))); disc(c, 21.5, 9, 4, css(hex('#2c2c32'))); disc(c, 9.5, 9, 1, css(hex('#a8a8b0'))); disc(c, 21.5, 9, 1, css(hex('#a8a8b0')));
      for (let i = 0; i < 12; i++) f(c, hex('#1c1c22'), 28 + i, 52 - i, 12 - i, 1);
      f(c, hex('#8a8a92'), 30, 22, 2, 8); f(c, hex('#2c2c32'), 28, 20, 6, 2);
    }, [{ x: 12, y: 36, r: 8, col: 'rgba(255,200,110,0.45)' }]);
    case 'ore_mine': return make(key, 46, 50, 23, c => {
      f(c, hex('#6a4a3a'), 2, 30, 24, 18);
      for (let i = 0; i < 20; i++) f(c, hex('#8a5a3c'), 24 + i, 48 - i, 20 - i, 1);
      f(c, hex('#4a4a52'), 8, 6, 3, 42); f(c, hex('#4a4a52'), 8, 6, 14, 3); disc(c, 20, 10, 4, css(hex('#2c2c32')));
      f(c, hex('#a8a8b0'), 2, 28, 24, 2);
    }, [{ x: 10, y: 38, r: 8, col: 'rgba(255,200,110,0.4)' }]);
    case 'farm': return make(key, 52, 36, 26, c => {
      f(c, hex('#a83c2c'), 2, 14, 26, 20); for (let r = 0; r < 8; r++) f(c, hex('#7a2c24'), 2 + r, 6 + r, 26 - r * 2, 1);
      f(c, hex('#e8e0d0'), 12, 22, 6, 12); f(c, hex('#a83c2c'), 12, 22, 6, 1);
      f(c, hex('#cfd3d4'), 34, 4, 8, 30); disc(c, 38, 5, 4, css(hex('#9aa0a4'))); f(c, hex('#8a9094'), 34, 4, 2, 30);
      f(c, hex('#d8c9a4'), 44, 20, 8, 14); for (let r = 0; r < 4; r++) f(c, hex('#8a3a2a'), 44 + r, 16 + r, 8 - r * 2, 1);
    }, [{ x: 46, y: 26, r: 6, col: 'rgba(255,200,110,0.5)' }]);
    case 'forestry': return make(key, 50, 30, 25, c => {
      f(c, hex('#7a5a3a'), 4, 12, 24, 16); for (let r = 0; r < 6; r++) f(c, hex('#5a4a3a'), 4 + r, 6 + r, 24 - r * 2, 1);
      for (let i = 0; i < 4; i++) for (let j = 0; j < 4 - i; j++) disc(c, 36 + j * 4 + i * 2, 26 - i * 3, 2, css(shade(hex('#9c6b3a'), 0.85 + ((i + j) % 2) * 0.2)));
      f(c, hex('#4a4a52'), 28, 4, 3, 22);
    }, [{ x: 10, y: 20, r: 6, col: 'rgba(255,200,110,0.4)' }]);
    case 'quarry': return make(key, 50, 40, 25, c => {
      for (let i = 0; i < 28; i++) f(c, hex('#a6a6ae'), 0 + i, 38 - i, 40 - i, 1);
      for (let i = 0; i < 28; i += 4) f(c, hex('#8a8a92'), i, 38 - i, 40 - i, 1);
      f(c, hex('#c9a24a'), 30, 8, 3, 28); f(c, hex('#c9a24a'), 22, 8, 16, 2);
      f(c, hex('#4a4a52'), 40, 24, 8, 14);
    }, [{ x: 44, y: 28, r: 6, col: 'rgba(255,200,110,0.4)' }]);
    case 'factory': return make(key, 70, 62, 35, c => {
      f(c, hex('#8a4a3a'), 2, 24, 44, 36); f(c, hex('#6a3a2c'), 2, 22, 44, 3);
      for (let x = 4; x < 44; x += 7) for (let y = 30; y < 54; y += 8) f(c, hex('#d8e6ee'), x, y, 4, 5);
      f(c, hex('#7a3a2c'), 52, 2, 6, 58); f(c, hex('#5a2c24'), 52, 2, 2, 58); f(c, hex('#2c2c32'), 51, 0, 8, 2);
      f(c, hex('#7a3a2c'), 62, 12, 5, 48); f(c, hex('#2c2c32'), 61, 10, 7, 2);
      f(c, hex('#6a6a72'), 46, 36, 6, 24);
    }, [{ x: 20, y: 40, r: 18, col: 'rgba(255,200,110,0.35)' }]);
    case 'refinery': return make(key, 66, 50, 33, c => {
      for (let i = 0; i < 3; i++) { const x = 4 + i * 20; f(c, hex('#d6d6d0'), x, 22, 17, 26); f(c, shade(hex('#d6d6d0'), 0.8), x + 12, 22, 5, 26); for (let r = 0; r < 4; r++) f(c, hex('#d6d6d0'), x + 1 + r, 18 + r, 15 - 2 * r, 1); f(c, hex('#b8442c'), x, 34, 17, 2); }
      f(c, hex('#6a6a72'), 52, 4, 3, 44); f(c, hex('#6a6a72'), 52, 4, 10, 2); f(c, hex('#d65a2a'), 60, 2, 3, 3);
    }, [{ x: 61, y: 3, r: 10, col: 'rgba(255,140,40,0.65)' }]);
    case 'port': return make(key, 70, 56, 35, c => {
      f(c, hex('#4a6a8a'), 2, 30, 28, 20); f(c, hex('#3a5a7a'), 2, 28, 28, 3);
      f(c, hex('#c9a24a'), 40, 4, 3, 46); f(c, hex('#c9a24a'), 34, 4, 28, 3); f(c, hex('#a8a8b0'), 58, 7, 1, 20);
      f(c, hex('#8a5a3a'), 40, 40, 14, 10); f(c, hex('#2c5a8a'), 54, 44, 12, 6);
    }, [{ x: 30, y: 36, r: 10, col: 'rgba(255,220,140,0.3)' }]);
    default: return house(3, season);
  }
}

// ----- infrastructure -----
export function catenary(): Prop {
  return make('cat', 12, 40, 6, c => { f(c, hex('#4a4a52'), 5, 4, 2, 36); f(c, hex('#4a4a52'), 1, 4, 10, 2); f(c, hex('#2c2c32'), 0, 6, 12, 1); });
}
export function pole(): Prop {
  return make('pole', 10, 38, 5, c => { f(c, hex('#5a4a3a'), 4, 4, 2, 34); f(c, hex('#5a4a3a'), 0, 5, 10, 1); f(c, hex('#5a4a3a'), 1, 9, 8, 1); for (const x of [0, 3, 6, 9]) f(c, hex('#7aa0b0'), x, 3, 1, 2); });
}
export function signal(kind: 'semaphore' | 'light', aspect: 'green' | 'yellow' | 'red', distant = false): Prop {
  const key = `sig|${kind}|${aspect}|${distant}`;
  const col = { green: '#4cd964', yellow: '#ffd23a', red: '#ff3b30' }[aspect];
  return make(key, 16, 40, 8, c => {
    f(c, hex('#3a3a42'), 7, 8, 2, 32);
    if (kind === 'semaphore') {
      f(c, hex('#2c2c32'), 5, 3, 6, 8);
      const armCol = distant ? '#e8c43a' : '#c8302c';
      if (aspect === 'red' || aspect === 'yellow') { f(c, armCol, 3, 5, 12, 3); f(c, '#f3eed8', 5, 5, 2, 3); f(c, '#f3eed8', 10, 5, 2, 3); }
      else { for (let i = 0; i < 6; i++) f(c, armCol, 9 + i, 5 - i, 2, 3); }
      f(c, col, 7, 1, 2, 2);
    } else {
      f(c, hex('#1c1c22'), 5, 2, 6, distant ? 9 : 12);
      f(c, aspect === 'red' && !distant ? '#ff3b30' : '#4a2a2a', 7, 3, 2, 2);
      f(c, aspect === 'yellow' ? '#ffd23a' : '#4a4a2a', 7, 6, 2, 2);
      f(c, aspect === 'green' ? '#4cd964' : '#2a4a2a', 7, 9, 2, 2);
      if (aspect === 'red' && distant) f(c, '#ffd23a', 7, 6, 2, 2);
    }
  }, [{ x: 8, y: kind === 'light' ? 6 : 2, r: 9, col: col + 'aa' }]);
}
export function speedSign(kmh: number, warn = false): Prop {
  return make(`speed|${kmh}|${warn}`, 14, 30, 7, c => {
    f(c, hex('#6a6a72'), 6, 12, 2, 18);
    disc(c, 7, 7, 6, css(warn ? hex('#ffcf3a') : hex('#f3eed8'))); disc(c, 7, 7, 5, css(warn ? hex('#ffe58a') : hex('#f3eed8')));
    c.fillStyle = css(hex('#d4302c')); for (let a = 0; a < 40; a++) { const t = a / 40 * Math.PI * 2; c.fillRect(Math.round(7 + Math.cos(t) * 5.7), Math.round(7 + Math.sin(t) * 5.7), 1, 1); }
    const s = String(kmh); drawText(c, s, 7 - textWidth(s) / 2, 5, '#1c1c22');
  });
}
export function curveSign(): Prop {
  return make('curve', 14, 28, 7, c => { f(c, hex('#6a6a72'), 6, 12, 2, 16); for (let i = 0; i < 6; i++) f(c, '#ffcf3a', 7 - i, 1 + i, 1 + i * 2, 1); for (let i = 0; i < 5; i++) f(c, '#ffcf3a', 2 + i, 7 + i, 10 - i * 2, 1); f(c, '#1c1c22', 6, 6, 2, 4); });
}
export function cone(): Prop { return make('cone', 5, 7, 2, c => { f(c, '#ff7a1a', 1, 1, 3, 5); f(c, '#f3eed8', 1, 3, 3, 1); f(c, '#2c2c32', 0, 6, 5, 1); }); }
export function worker(variant: number): Prop {
  return make(`worker|${variant}`, 7, 14, 3, c => { f(c, '#ffcf3a', 2, 0, 3, 2); f(c, '#e8c4a0', 2, 2, 3, 2); f(c, variant % 2 ? '#ff7a1a' : '#3a6aa8', 1, 4, 5, 5); f(c, '#2c2c32', 2, 9, 1, 5); f(c, '#2c2c32', 4, 9, 1, 5); });
}
export function car(era: number, color: number): Prop {
  const colors = ['#a8322d', '#2c5a8a', '#3a6a3a', '#d9a620', '#4a4a52'];
  const col = hex(colors[color % colors.length]);
  const key = `car|${era < 1950 ? 0 : era < 1990 ? 1 : 2}|${color % 5}`;
  const e = era < 1950 ? 0 : era < 1990 ? 1 : 2;
  return make(key, 24, 16, 12, c => {
    if (e === 0) { f(c, col, 2, 8, 20, 5); f(c, col, 6, 3, 10, 6); f(c, '#9fc3d6', 8, 4, 6, 4); disc(c, 6, 13, 2, '#1c1c22'); disc(c, 18, 13, 2, '#1c1c22'); }
    else { f(c, col, 1, 7, 22, 6); f(c, shade(col, 1.2), 6, 2, 12, 6); f(c, '#9fc3d6', 8, 3, 8, 4); disc(c, 6, 13, 2, '#1c1c22'); disc(c, 18, 13, 2, '#1c1c22'); f(c, '#fff4b0', 22, 8, 2, 2); }
  });
}
export function buffer(): Prop {
  return make('buffer', 14, 22, 7, c => { f(c, hex('#4a3a2a'), 0, 18, 14, 3); f(c, hex('#a8322d'), 8, 6, 5, 12); f(c, hex('#f3eed8'), 8, 10, 5, 2); f(c, hex('#2c2c32'), 6, 8, 3, 3); f(c, hex('#2c2c32'), 6, 14, 3, 3); });
}
export function gate(): Prop {
  return make('gate', 6, 20, 3, c => { f(c, '#2c2c32', 2, 8, 2, 12); f(c, '#d4302c', 2, 4, 2, 4); });
}
export function cloud(variant: number): Prop {
  return make(`cloud|${variant}`, 56, 20, 28, c => {
    const cols = ['rgba(255,255,255,0.92)', 'rgba(228,236,244,0.9)'];
    for (let k = 0; k < 6; k++) { const x = 8 + k * 7 + (variant % 3) * 2, r = 4 + ((k + variant) % 3) * 2; disc(c, x, 13 - (k % 2) * 2, r, cols[(k + variant) % 2]); }
    f(c, 'rgba(210,220,232,0.85)', 4, 14, 48, 3);
  });
}
export function station(city: string, pop: number, season: Season): Prop {
  return make(`station|${city}|${pop > 15}|${season}`, 120, 56, 60, c => {
    // bâtiment voyageurs
    const wall = hex('#d6c79e'), roof = hex('#7a3a2a');
    f(c, wall, 4, 20, 54, 32); f(c, shade(wall, 0.8), 4, 50, 54, 2);
    for (let r = 0; r < 10; r++) f(c, shade(roof, 0.85 + (r % 2) * 0.1), 1 + r, 10 + r, 60 - r * 2, 1);
    if (season === 'hiver') f(c, '#eef3f5', 2, 10, 58, 2);
    for (let x = 10; x < 54; x += 12) { f(c, hex('#8fb7cc'), x, 28, 6, 9); f(c, hex('#5a3a2a'), x + 2, 28, 1, 9); }
    f(c, hex('#5a3a2a'), 28, 38, 7, 14);
    f(c, '#f3eed8', 28, 5, 8, 8); disc(c, 32, 9, 3, '#f3eed8'); f(c, '#2c2c32', 32, 7, 1, 3); f(c, '#2c2c32', 32, 9, 2, 1);
    // auvent de quai
    f(c, hex('#4a4a52'), 62, 24, 56, 3); f(c, '#6a6a72', 62, 24, 56, 1);
    for (let x = 66; x < 116; x += 14) f(c, hex('#4a4a52'), x, 27, 2, 25);
    // panneau du nom
    const name = city.toUpperCase(); const w = Math.min(54, textWidth(name) + 6);
    f(c, '#1f3a5a', 64, 28, w, 9); f(c, '#f3eed8', 64, 28, w, 1); f(c, '#f3eed8', 64, 36, w, 1);
    drawText(c, name.slice(0, 13), 67, 30, '#f3eed8');
  }, [{ x: 12, y: 32, r: 9, col: 'rgba(255,200,110,0.5)' }, { x: 48, y: 32, r: 9, col: 'rgba(255,200,110,0.5)' }, { x: 100, y: 27, r: 10, col: 'rgba(255,230,160,0.55)' }]);
}
export function hashKey(...n: number[]) { return hashInts(...n); }
export { mix };
