import { Rng, hashInts, hashString } from '../core/rng';
import { clamp } from '../core/util';
import { GOODS, WAGONS, goodById, goodAvailable, wagonAvailable, wagonById, locoById, eraAt, type WagonDef } from '../data';
import { rates, priceMul, passengerMul, popOf, yearOf } from '../economy/economy';
import { distancesFrom, shortestPath } from '../world/graph';
import { edgeUsable, edgeElectrified, yearNow, type Contract, type Game, fleetUnit, unitBusy } from './state';
import type { Unit } from '../sim/train';

export const MAX_VEHICLES = 24;
export const PAX_KG = 0.08; // tonnes par voyageur (avec bagages)
export const PAX_RATE = { c1: 1.4, c2: 0.8, c3: 0.5 };

export function paxShares(year: number): { c1: number; c2: number; c3: number } {
  const c3 = clamp(0.65 - 0.012 * (year - 1905), 0, 0.65);
  const c1 = 0.07 + Math.min(0.06, (year - 1905) / 1500);
  return { c1, c3, c2: 1 - c1 - c3 };
}

export function lineLimitKmh(g: Game, edges: number[]): number {
  const era = eraAt(yearNow(g.state)).lineSpeedKmh;
  return Math.min(era, ...edges.map(id => g.world.edges[id].maxSpeedKmh));
}
export function targetSeconds(g: Game, edges: number[], lengthM: number): number {
  const v = lineLimitKmh(g, edges) * 0.72 / 3.6;
  return Math.round(lengthM / v + 90);
}

export function quoteFreight(g: Game, from: number, to: number, goodId: string, tonnes: number, lengthM: number, destMul: number): number {
  const good = goodById(goodId); const s = g.state;
  const wh = 1 + 0.08 * ((s.warehouses[from] ?? 0) + (s.warehouses[to] ?? 0));
  const rep = 0.9 + 0.2 * s.reputation / 100;
  return Math.round(tonnes * good.rate * (lengthM / 1000) * (0.5 + 0.5 * destMul) * rep * wh);
}
export function quotePax(g: Game, from: number, to: number, pax: { c1: number; c2: number; c3: number }, lengthM: number): number {
  const s = g.state; const km = lengthM / 1000;
  const wh = 1 + 0.08 * ((s.warehouses[from] ?? 0) + (s.warehouses[to] ?? 0));
  const rep = 0.9 + 0.2 * s.reputation / 100;
  return Math.round((pax.c1 * PAX_RATE.c1 + pax.c2 * PAX_RATE.c2 + pax.c3 * PAX_RATE.c3) * km * rep * wh);
}

const boardCache = new Map<string, Contract[]>();

export function getBoard(g: Game, cityId: number): Contract[] {
  const s = g.state, w = g.world;
  const week = Math.floor(s.day / 7);
  const key = `${s.seed}:${cityId}:${week}`;
  let b = boardCache.get(key);
  if (!b) { b = generateBoard(g, cityId, week); boardCache.set(key, b); if (boardCache.size > 200) boardCache.delete(boardCache.keys().next().value!); }
  void w;
  return b.filter(c => !s.takenIds.includes(c.id) && c.expiresDay > s.day);
}
export function clearBoardCache() { boardCache.clear(); }

function generateBoard(g: Game, cityId: number, week: number): Contract[] {
  const s = g.state, w = g.world;
  const year = yearNow(s);
  const rng = new Rng(hashInts(hashString(s.seed), cityId, week, 991));
  const { dist, hops } = distancesFrom(w, cityId, e => edgeUsable(g, e));
  const vT = eraAt(year).lineSpeedKmh * 0.72 / 3.6;
  const minD = Math.max(5500, vT * 60 * 4.5), maxD = Math.max(12500, vT * 60 * 10);
  const dests = w.cities.filter(c => c.id !== cityId && dist[c.id] >= minD && dist[c.id] <= maxD && hops[c.id] <= 3);
  const out: Contract[] = [];
  if (!dests.length) return out;
  const mk = (to: number) => {
    const p = shortestPath(w, cityId, to, e => edgeUsable(g, e))!;
    return p;
  };
  const expires = (week + 2) * 7;
  // fret
  const goods = GOODS.filter(gd => gd.id !== 'mail' && goodAvailable(gd, year));
  const tries = rng.shuffle([...goods]);
  for (const gd of tries) {
    if (out.length >= 7) break;
    const { prod } = rates(w, s.eco, year, cityId, gd.id);
    const stock = s.eco.stocks[cityId][gd.id] ?? 0;
    if (prod <= 0 || stock < 30) continue;
    const consumers = dests.filter(d => rates(w, s.eco, year, d.id, gd.id).cons > 0);
    if (!consumers.length) continue;
    consumers.sort((a, b) => priceMul(w, s.eco, year, b.id, gd.id) - priceMul(w, s.eco, year, a.id, gd.id));
    const top = consumers.slice(0, Math.max(2, Math.ceil(consumers.length / 2)));
    const n = stock > 150 && rng.chance(0.5) ? 2 : 1;
    for (let k = 0; k < n; k++) {
      const d = rng.pick(top);
      const tonnes = clamp(Math.round(stock * rng.range(0.2, 0.65) / 10) * 10, 20, 300);
      const p = mk(d.id);
      const mul = priceMul(w, s.eco, year, d.id, gd.id);
      const premium = rng.chance(0.12);
      out.push({
        id: `f${cityId}-${week}-${gd.id}-${d.id}-${k}`, kind: 'freight', from: cityId, to: d.id, cities: p.cities, edges: p.edges, lengthM: p.lengthM,
        goodId: gd.id, tonnes, reward: Math.round(quoteFreight(g, cityId, d.id, gd.id, tonnes, p.lengthM, mul) * (premium ? 1.35 : 1)),
        expiresDay: expires + rng.int(0, 10), targetSec: Math.round(targetSeconds(g, p.edges, p.lengthM) * (premium ? 0.85 : 1)), wagonTypes: gd.wagons,
        label: `${gd.name} → ${d.name}`, premium, destMul: mul,
      });
    }
  }
  // voyageurs
  const pops = dests.map(d => ({ d, pop: popOf(w, s.eco, year, d.id) })).sort((a, b) => b.pop - a.pop).slice(0, 8);
  const here = popOf(w, s.eco, year, cityId);
  for (const { d, pop } of rng.shuffle(pops).slice(0, 3)) {
    const fest = passengerMul(w, s.eco, cityId) * passengerMul(w, s.eco, d.id);
    const total = clamp(Math.round(Math.sqrt(here * pop) * 7 * (0.6 + 0.8 * s.reputation / 100) * fest * rng.range(0.7, 1.3) / 5) * 5, 30, 700);
    const sh = paxShares(year);
    const pax = { c1: Math.round(total * sh.c1), c3: Math.round(total * sh.c3), c2: 0 };
    (pax as any).c2 = total - pax.c1 - pax.c3;
    const p = mk(d.id);
    out.push({
      id: `p${cityId}-${week}-${d.id}`, kind: 'passenger', from: cityId, to: d.id, cities: p.cities, edges: p.edges, lengthM: p.lengthM, pax: pax as Contract['pax'],
      reward: quotePax(g, cityId, d.id, pax as any, p.lengthM), expiresDay: expires + rng.int(0, 7), targetSec: targetSeconds(g, p.edges, p.lengthM) - 30,
      wagonTypes: ['coach'], label: `${total} voyageurs → ${d.name}`,
    });
  }
  // courrier
  {
    const d = rng.pick(dests); const p = mk(d.id);
    const t = clamp(Math.round(Math.sqrt(here) * 1.2), 3, 16);
    out.push({
      id: `m${cityId}-${week}-${d.id}`, kind: 'mail', from: cityId, to: d.id, cities: p.cities, edges: p.edges, lengthM: p.lengthM, goodId: 'mail', tonnes: t,
      reward: Math.round(t * goodById('mail').rate * (p.lengthM / 1000) * 1.6 * (0.9 + 0.2 * s.reputation / 100)), expiresDay: expires + 5, targetSec: targetSeconds(g, p.edges, p.lengthM) - 30,
      wagonTypes: ['mail'], label: `Courrier et bagages → ${d.name}`, premium: true,
    });
  }
  return out;
}

export function deadheadOptions(g: Game, cityId: number): Contract[] {
  const w = g.world, s = g.state;
  const out: Contract[] = [];
  for (const e of w.edges) {
    if (!edgeUsable(g, e) || (e.a !== cityId && e.b !== cityId)) continue;
    const to = e.a === cityId ? e.b : e.a;
    out.push({
      id: `dh-${cityId}-${to}`, kind: 'deadhead', from: cityId, to, cities: [cityId, to], edges: [e.id], lengthM: e.lengthM, reward: 0, expiresDay: s.day + 999,
      targetSec: targetSeconds(g, [e.id], e.lengthM) + 60, wagonTypes: [], label: `Marche à vide → ${w.cities[to].name}`,
    });
  }
  return out;
}

// ---------- Composition du train ----------
export interface Compat {
  ok: boolean; errors: string[]; warnings: string[];
  capacity: number; loaded: number; paxLoaded?: { c1: number; c2: number; c3: number }; reward: number;
  rentNeeded: string[]; rentCost: number; lengthM: number; massT: number; vehicles: number;
}

export function wagonMatches(w: WagonDef, c: Contract): boolean {
  if (c.kind === 'passenger') return w.type === 'coach';
  if (c.kind === 'mail') return w.type === 'mail';
  return c.wagonTypes.includes(w.type);
}

export function consistUnits(g: Game): Unit[] {
  const s = g.state;
  return s.consistUids.map(id => fleetUnit(s, id)).filter((u): u is Unit => !!u && !unitBusy(s, u.uid));
}

export function bestRentalWagon(g: Game, c: Contract): WagonDef | undefined {
  const year = yearNow(g.state);
  return WAGONS.filter(w => wagonMatches(w, c) && wagonAvailable(w, year) && (c.kind !== 'passenger' || w.seats.c1 + w.seats.c2 + w.seats.c3 > 0))
    .sort((a, b) => (b.capacityT || (b.seats.c1 + b.seats.c2 + b.seats.c3) * PAX_KG) / b.price - (a.capacityT || (a.seats.c1 + a.seats.c2 + a.seats.c3) * PAX_KG) / a.price)[0];
}

export function evaluateContract(g: Game, c: Contract, rent: boolean): Compat {
  const s = g.state, w = g.world;
  const errors: string[] = [], warnings: string[] = [];
  const loco = s.locoUid !== null ? fleetUnit(s, s.locoUid) : undefined;
  const res: Compat = { ok: false, errors, warnings, capacity: 0, loaded: 0, reward: c.reward, rentNeeded: [], rentCost: 0, lengthM: 0, massT: 0, vehicles: 0 };
  if (!loco) { errors.push('Aucune locomotive sélectionnée.'); return res; }
  if (unitBusy(s, loco.uid)) errors.push('La locomotive est immobilisée à l’atelier.');
  if (c.from !== s.location) errors.push('Le train n’est pas en gare de départ.');
  const ld = locoById(loco.defId);
  if (ld.traction === 'electric' && !ld.electric?.bimodeKW) {
    const bad = c.edges.filter(id => !edgeElectrified(s, w.edges[id]));
    if (bad.length) errors.push('Itinéraire non électrifié : cette locomotive électrique ne peut pas l’emprunter.');
  } else if (ld.traction === 'electric') {
    if (c.edges.some(id => !edgeElectrified(s, w.edges[id]))) warnings.push('Parties non électrifiées : le groupe auxiliaire limitera la puissance.');
  }
  const own = consistUnits(g).filter(u => wagonMatches(wagonById(u.defId), c));
  const others = consistUnits(g).filter(u => !wagonMatches(wagonById(u.defId), c));
  const capOf = (u: Unit) => { const d = wagonById(u.defId); return c.kind === 'passenger' ? d.seats.c1 + d.seats.c2 + d.seats.c3 : d.capacityT; };
  let capacity = own.reduce((a, u) => a + capOf(u), 0);
  const need = c.kind === 'passenger' ? (c.pax!.c1 + c.pax!.c2 + c.pax!.c3) : c.tonnes ?? 0;
  let vehicles = 1 + own.length + others.length;
  if (rent && c.kind !== 'deadhead') {
    const rw = bestRentalWagon(g, c);
    if (rw) {
      const per = c.kind === 'passenger' ? rw.seats.c1 + rw.seats.c2 + rw.seats.c3 : rw.capacityT;
      const unitMass = c.kind === 'passenger' ? per * PAX_KG : per;
      const maxM = maxTrainMassT(ld.maxTEkN, ld.drivingMassT, ld.powerKW) * 1.05;
      let massEst = ld.massT + [...own, ...others].reduce((a, u) => a + wagonById(u.defId).tareT, 0) + Math.min(need, capacity) * (c.kind === 'passenger' ? PAX_KG : 1);
      while (capacity < need && vehicles < Math.min(MAX_VEHICLES, 16) && per > 0 && massEst + rw.tareT + Math.min(unitMass, (need - capacity) * (c.kind === 'passenger' ? PAX_KG : 1)) <= maxM) {
        massEst += rw.tareT + Math.min(unitMass, (need - capacity) * (c.kind === 'passenger' ? PAX_KG : 1));
        capacity += per; vehicles++; res.rentNeeded.push(rw.id); res.rentCost += Math.round(rw.price * 0.05);
      }
    }
  }
  res.capacity = capacity; res.vehicles = vehicles;
  if (c.kind === 'deadhead') { res.ok = errors.length === 0; res.loaded = 0; res.reward = 0; }
  else {
    if (capacity <= 0) errors.push(c.kind === 'passenger' ? 'Aucune voiture voyageurs dans le train.' : 'Aucun wagon adapté dans le train.');
    res.loaded = Math.min(need, capacity);
    if (res.loaded < need) warnings.push(`Capacité insuffisante : ${Math.round(res.loaded)} sur ${Math.round(need)} ${c.kind === 'passenger' ? 'voyageurs' : 't'} seront transportés.`);
    res.reward = need > 0 ? Math.round(c.reward * res.loaded / need) : c.reward;
    if (c.kind === 'passenger') {
      const k = res.loaded / need;
      res.paxLoaded = { c1: Math.round(c.pax!.c1 * k), c2: Math.round(c.pax!.c2 * k), c3: Math.round(c.pax!.c3 * k) };
    }
  }
  if (vehicles > MAX_VEHICLES) errors.push(`Rame trop longue (maximum ${MAX_VEHICLES} véhicules).`);
  const ws = [...own, ...others].map(u => wagonById(u.defId));
  res.massT = ld.massT + ws.reduce((a, d) => a + d.tareT + (c.kind === 'passenger' ? 0 : d.capacityT * 0.0), 0) + (c.kind === 'passenger' ? res.loaded * PAX_KG : res.loaded);
  res.lengthM = ld.lengthM + ws.reduce((a, d) => a + d.lengthM, 0) + res.rentNeeded.reduce((a, id) => a + wagonById(id).lengthM, 0);
  const maxM = maxTrainMassT(ld.maxTEkN, ld.drivingMassT, ld.powerKW);
  if (res.massT > maxM * 1.1) warnings.push(`Rame très lourde (${Math.round(res.massT)} t) pour cette locomotive (≈ ${Math.round(maxM)} t conseillées).`);
  const vmaxTrain = Math.min(ld.maxSpeedKmh, ...ws.map(d => d.maxSpeedKmh));
  const lim = lineLimitKmh(g, c.edges);
  if (vmaxTrain < lim * 0.8 && c.kind !== 'deadhead') warnings.push(`Matériel limité à ${vmaxTrain} km/h : ponctualité difficile.`);
  if (money(s) < res.rentCost) errors.push('Fonds insuffisants pour louer les wagons.');
  res.ok = errors.length === 0;
  return res;
}
const money = (s: { money: number }) => s.money;

/** Masse conseillée (t) : démarrage en rampe de 2,8 % et maintien de 60 km/h sur 1,5 %. */
export function maxTrainMassT(teKN: number, drivingT: number, powerKW: number): number {
  const startTE = Math.min(teKN * 1000, 0.27 * drivingT * 9810);
  const byStart = startTE / (9810 * 0.028 + 40);
  const byPower = 0.85 * powerKW * 1000 / 16.7 / (9810 * 0.015 + 30);
  return Math.max(30, Math.min(byStart, byPower));
}

export function pickWagonsAuto(g: Game, c: Contract): number[] {
  const s = g.state;
  const cands = s.fleet.filter(u => u.kind === 'wagon' && !unitBusy(s, u.uid) && wagonMatches(wagonById(u.defId), c) && !u.rented);
  const capOf = (u: Unit) => { const d = wagonById(u.defId); return c.kind === 'passenger' ? d.seats.c1 + d.seats.c2 + d.seats.c3 : d.capacityT; };
  cands.sort((a, b) => capOf(b) - capOf(a) || b.cond.wheels - a.cond.wheels);
  const need = c.kind === 'passenger' ? (c.pax!.c1 + c.pax!.c2 + c.pax!.c3) : (c.tonnes ?? 0);
  const out: number[] = []; let cap = 0;
  const loco = s.locoUid !== null ? fleetUnit(s, s.locoUid) : undefined;
  const ld = loco ? locoById(loco.defId) : undefined;
  const maxM = ld ? maxTrainMassT(ld.maxTEkN, ld.drivingMassT, ld.powerKW) * 1.05 : 9999;
  let mass = ld?.massT ?? 0;
  for (const u of cands) {
    if (cap >= need || out.length >= MAX_VEHICLES - 1) break;
    const d = wagonById(u.defId); const add = d.tareT + Math.min(capOf(u), need - cap) * (c.kind === 'passenger' ? PAX_KG : 1);
    if (mass + add > maxM && out.length > 0) continue;
    out.push(u.uid); cap += capOf(u); mass += add;
  }
  // voitures de 1ʳᵉ classe : s'assurer qu'il y a des places adaptées
  return out;
}

/** Charge les wagons clonés et renvoie les unités pour la simulation. */
export function loadTrain(g: Game, c: Contract, compat: Compat, rent: boolean): { units: Unit[]; rented: Unit[] } {
  const s = g.state;
  const loco = structuredClone(fleetUnit(s, s.locoUid!)!);
  const wag = consistUnits(g).map(u => structuredClone(u));
  const rented: Unit[] = [];
  let nextUid = 100000 + Math.floor(s.day);
  if (rent) for (const id of compat.rentNeeded) { const u: Unit = { uid: nextUid++, defId: id, kind: 'wagon', cond: { wheels: 0.9, axles: 0.9, brakes: 0.9, powerplant: 1, lubrication: 0.9, couplings: 0.9 }, upgrades: {}, km: 0, inspectedKm: null, inspectedDay: null, loadT: 0, rented: true }; rented.push(u); }
  const all = [...wag, ...rented];
  for (const u of all) u.loadT = 0;
  if (c.kind === 'freight' || c.kind === 'mail') {
    let left = compat.loaded;
    for (const u of all.filter(u => wagonMatches(wagonById(u.defId), c))) { const d = wagonById(u.defId); const t = Math.min(left, d.capacityT); u.loadT = t; u.cargo = c.goodId; left -= t; }
  } else if (c.kind === 'passenger' && compat.paxLoaded) {
    const left = { ...compat.paxLoaded };
    for (const u of all.filter(u => wagonMatches(wagonById(u.defId), c))) {
      const d = wagonById(u.defId); let n = 0;
      for (const k of ['c1', 'c2', 'c3'] as const) { const t = Math.min(left[k], d.seats[k]); left[k] -= t; n += t; }
      u.loadT = n * PAX_KG;
    }
  }
  // ordre : voitures voyageurs derrière la loco ; wagons de marchandises à la suite
  all.sort((a, b) => (wagonById(a.defId).type === 'coach' ? 0 : 1) - (wagonById(b.defId).type === 'coach' ? 0 : 1));
  return { units: [loco, ...all], rented };
}
export { yearOf };
