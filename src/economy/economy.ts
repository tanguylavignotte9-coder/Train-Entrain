import { Rng, hashInts, hashString } from '../core/rng';
import { clamp } from '../core/util';
import { EVENTS, GOODS, INDUSTRIES, industryActive, goodAvailable, industryById, type EventDef } from '../data';
import type { World } from '../world/mapgen';

export interface ActiveEvent {
  uid: number; defId: string; name: string; text: string; startDay: number; endDay: number; positive: boolean;
  cityId?: number; regionId?: number; edgeId?: number; applied?: boolean;
}
export interface EconomyState {
  stocks: Record<string, number>[]; // par ville : bien -> tonnes
  popFactor: number[];
  events: ActiveEvent[];
  nextEventUid: number;
  lastDay: number;
  journal: { day: number; text: string; positive: boolean }[];
  history: { day: number; avgMul: number }[];
}

export interface EcoCtx { world: World; seed: string; startYear: number }

export const yearOf = (startYear: number, day: number) => startYear + Math.floor(day / 365);

export function popOf(w: World, eco: EconomyState, year: number, cityId: number): number {
  return w.cities[cityId].pop * (1 + 0.0085 * (year - 1905)) * eco.popFactor[cityId];
}

/** Production/consommation journalières (t/j) d'un bien dans une ville, avec événements. */
export function rates(w: World, eco: EconomyState, year: number, cityId: number, good: string): { prod: number; cons: number } {
  const c = w.cities[cityId];
  const pop = popOf(w, eco, year, cityId);
  const size = clamp(Math.sqrt(c.pop / 12), 0.6, 2.2);
  let prod = 0, cons = 0;
  for (const iid of c.industries) {
    const ind = industryById(iid);
    if (!industryActive(ind, year)) continue;
    let fade = 1;
    if (ind.fadeYear !== undefined && year > ind.fadeYear) fade = Math.max(0.25, 1 - (year - ind.fadeYear) / 60);
    if (ind.produce[good]) prod += ind.produce[good] * size * fade;
    if (ind.consume[good]) cons += ind.consume[good] * size;
  }
  // consommation résidentielle
  const t = year - 1905;
  const res: Record<string, number> = {
    coal: 2.2 * (year < 1960 ? 1 : Math.max(0.12, 1 - (year - 1960) / 45)),
    grain: 2.0, perishables: 0.9, goods: 0.9 * (1 + t / 100),
    fuel: year < 1915 ? 0 : 0.15 + Math.min(1.1, (year - 1915) * 0.012),
    materials: 0.6, wood: 0.7 * Math.max(0.4, 1 - t / 200), cattle: 0.4,
  };
  if (res[good]) cons += res[good] * pop / 1000 * 1.0 * 1;
  const g = GOODS.find(x => x.id === good)!;
  if (!goodAvailable(g, year)) { prod = 0; cons = 0; }
  // événements
  for (const ev of eco.events) {
    if (!applies(w, ev, cityId)) continue;
    const def = EVENTS.find(d => d.id === ev.defId)!;
    for (const ef of def.effects) {
      if ((ef.type === 'produce' && (ef.good === good || ef.good === '*'))) prod *= ef.mul ?? 1;
      if ((ef.type === 'consume' && (ef.good === good || ef.good === '*'))) cons *= ef.mul ?? 1;
    }
  }
  return { prod, cons };
}

function applies(w: World, ev: ActiveEvent, cityId: number): boolean {
  if (ev.cityId !== undefined) return ev.cityId === cityId;
  if (ev.regionId !== undefined) return w.cities[cityId].region === ev.regionId;
  if (ev.edgeId !== undefined) return false;
  return true; // global
}

export function passengerMul(w: World, eco: EconomyState, cityId: number): number {
  let m = 1;
  for (const ev of eco.events) {
    if (!applies(w, ev, cityId)) continue;
    const def = EVENTS.find(d => d.id === ev.defId)!;
    for (const ef of def.effects) if (ef.type === 'passengers') m *= ef.mul ?? 1;
  }
  return m;
}
export function repairCostMul(eco: EconomyState): number {
  let m = 1;
  for (const ev of eco.events) { const def = EVENTS.find(d => d.id === ev.defId)!; for (const ef of def.effects) if (ef.type === 'repairCost') m = Math.max(m, ef.mul ?? 1); }
  return m;
}
export function closedEdges(eco: EconomyState): Set<number> {
  const s = new Set<number>();
  for (const ev of eco.events) if (ev.edgeId !== undefined && EVENTS.find(d => d.id === ev.defId)!.effects.some(e => e.type === 'closeEdge')) s.add(ev.edgeId);
  return s;
}
/** Sections de voie dégradées : limitation de vitesse (km/h) par arête. */
export function slowEdges(eco: EconomyState): Map<number, number> {
  const m = new Map<number, number>();
  for (const ev of eco.events) { if (ev.edgeId === undefined) continue; const ef = EVENTS.find(d => d.id === ev.defId)!.effects.find(e => e.type === 'slowEdge'); if (ef) m.set(ev.edgeId, ef.mul ?? 50); }
  return m;
}

export function capacity(w: World, eco: EconomyState, year: number, cityId: number, good: string): number {
  const { prod, cons } = rates(w, eco, year, cityId, good);
  return 45 * Math.max(prod, cons, 4);
}

export function priceMul(w: World, eco: EconomyState, year: number, cityId: number, good: string): number {
  const cap = capacity(w, eco, year, cityId, good);
  const fill = clamp((eco.stocks[cityId][good] ?? 0) / cap, 0, 1);
  return clamp(2 * (1 - fill), 0.35, 2.4);
}

export function createEconomy(w: World, seed: string, startYear: number): EconomyState {
  const eco: EconomyState = { stocks: w.cities.map(() => ({})), popFactor: w.cities.map(() => 1), events: [], nextEventUid: 1, lastDay: 0, journal: [], history: [] };
  const rng = new Rng(hashString('eco:' + seed));
  for (const c of w.cities) for (const g of GOODS) {
    if (g.id === 'mail') continue;
    const cap = capacity(w, eco, startYear, c.id, g.id);
    eco.stocks[c.id][g.id] = Math.round(cap * rng.range(0.25, 0.65));
  }
  return eco;
}

/** Fournisseur « de fond » le plus proche pour chaque (ville, bien) : modèle simplifié du commerce hors joueur. */
const supplierCache = new Map<string, number[][]>();
function suppliers(w: World, seed: string, year: number, eco: EconomyState): number[][] {
  const key = seed + ':' + Math.floor(year / 5);
  let c = supplierCache.get(key); if (c) return c;
  c = GOODS.map(g => w.cities.map(city => {
    let best = -1, bd = 1e9;
    for (const o of w.cities) {
      if (o.id === city.id) continue;
      if (rates(w, eco, year, o.id, g.id).prod <= 0) continue;
      const d = Math.hypot(o.x - city.x, o.y - city.y);
      if (d < bd) { bd = d; best = o.id; }
    }
    return best;
  }));
  supplierCache.set(key, c);
  return c;
}

export function coverage(seed: string, cityId: number, good: string): number {
  return 0.35 + (hashInts(hashString(seed), cityId, hashString(good)) % 1000) / 1000 * 0.85;
}

/** Un jour d'économie : production, consommation, commerce de fond, événements. */
export function stepEconomyDay(w: World, eco: EconomyState, seed: string, startYear: number, day: number): { started: ActiveEvent[]; ended: ActiveEvent[] } {
  const year = yearOf(startYear, day);
  const sup = suppliers(w, seed, year, eco);
  const started: ActiveEvent[] = [], ended: ActiveEvent[] = [];
  GOODS.forEach((g, gi) => {
    if (g.id === 'mail') return;
    // production
    for (const c of w.cities) {
      const { prod, cons } = rates(w, eco, year, c.id, g.id);
      const cap = capacity(w, eco, year, c.id, g.id);
      let st = eco.stocks[c.id][g.id] ?? 0;
      if (prod > 0) st += st < cap ? prod : 0;
      // commerce de fond : reçoit une part de sa consommation depuis le fournisseur le plus proche
      if (cons > 0) {
        const s = sup[gi][c.id];
        if (s >= 0) {
          const want = cons * coverage(seed, c.id, g.id);
          const avail = Math.max(0, (eco.stocks[s][g.id] ?? 0) - 5);
          const mv = Math.min(want, avail * 0.2, Math.max(0, cap - st));
          st += mv; eco.stocks[s][g.id] = (eco.stocks[s][g.id] ?? 0) - mv;
        }
        st -= cons;
      }
      eco.stocks[c.id][g.id] = clamp(st, 0, cap * 1.2);
    }
  });
  // événements : fin
  eco.events = eco.events.filter(ev => {
    if (ev.endDay <= day) { ended.push(ev); return false; }
    // croissance progressive
    const def = EVENTS.find(d => d.id === ev.defId)!;
    for (const ef of def.effects) if (ef.type === 'growth' && ev.cityId !== undefined) eco.popFactor[ev.cityId] *= 1 + (ef.pct ?? 0) / Math.max(1, ev.endDay - ev.startDay);
    return true;
  });
  // événements : naissance
  const rng = new Rng(hashInts(hashString(seed), day, 4242));
  if (rng.chance(0.05)) {
    const pool = EVENTS.filter(d => (d.startYear ?? 0) <= year && (d.endYear ?? 9999) >= year);
    const total = pool.reduce((a, d) => a + d.weight, 0);
    let r = rng.next() * total, def: EventDef = pool[0];
    for (const d of pool) { r -= d.weight; if (r <= 0) { def = d; break; } }
    const ev = spawnEvent(w, eco, def, day, rng);
    if (ev) { eco.events.push(ev); started.push(ev); eco.journal.unshift({ day, text: ev.text, positive: ev.positive }); eco.journal.length = Math.min(eco.journal.length, 60); }
  }
  for (const ev of ended) eco.journal.unshift({ day, text: `Fin : ${ev.name}.`, positive: true });
  eco.journal.length = Math.min(eco.journal.length, 60);
  eco.lastDay = day;
  if (day % 10 === 0) {
    let s = 0, n = 0;
    for (const c of w.cities) for (const g of GOODS) { if (g.id === 'mail') continue; s += priceMul(w, eco, year, c.id, g.id); n++; }
    eco.history.push({ day, avgMul: s / n }); if (eco.history.length > 400) eco.history.shift();
  }
  return { started, ended };
}

function spawnEvent(w: World, eco: EconomyState, def: EventDef, day: number, rng: Rng): ActiveEvent | null {
  const dur = rng.int(def.minDays, def.maxDays);
  const ev: ActiveEvent = { uid: eco.nextEventUid++, defId: def.id, name: def.name, text: def.text, startDay: day, endDay: day + dur, positive: !!def.positive };
  const city = rng.pick(w.cities);
  switch (def.scope) {
    case 'city': ev.cityId = city.id; ev.text = def.text.replace('{city}', city.name); break;
    case 'region': { const r = w.regions[city.region]; ev.regionId = r.id; ev.text = def.text.replace('{region}', r.name); break; }
    case 'edge': {
      const edges = w.edges.filter(e => e.initial);
      const e = rng.pick(edges); ev.edgeId = e.id;
      ev.text = def.text.replace('{city}', w.cities[e.a].name + ' – ' + w.cities[e.b].name); break;
    }
    default: break;
  }
  if (def.scope === 'city' && def.effects.some(e => e.type === 'growth') && false) return null;
  return ev;
}

export const industriesList = INDUSTRIES;
