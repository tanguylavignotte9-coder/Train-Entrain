import { clamp } from '../core/util';
import { PART_DEFS, LOCOS, WAGONS, UPGRADES, locoAvailable, wagonAvailable, locoById, wagonById, type LocoDef, type WagonDef, goodById } from '../data';
import { repairCostMul, priceMul, yearOf } from '../economy/economy';
import { PARTS, newCond, type Part, type Unit } from '../sim/train';
import { hashInts, hashString } from '../core/rng';
import {
  addLedger, advanceDays, edgeActive, fleetUnit, loanLimit, inflationAt, newUnit, unitBusy, unitDef, yearNow, edgeElectrified, cityConnected,
  type Contract, type Game,
} from './state';
import { clearBoardCache, evaluateContract, loadTrain, PAX_KG, wagonMatches } from './contracts';
import type { World } from '../world/mapgen';

export interface Res { ok: boolean; msg: string }
const ok = (msg: string): Res => ({ ok: true, msg });
const no = (msg: string): Res => ({ ok: false, msg });

export const hasDepot = (g: Game, city = g.state.location) => g.state.depots[city] !== undefined;
export const workshopLevel = (g: Game, city = g.state.location) => g.state.depots[city] ?? 0;

// ---------- Matériel ----------
export function buyLoco(g: Game, defId: string): Res {
  const s = g.state, d = locoById(defId);
  if (!hasDepot(g)) return no('Il faut un dépôt dans cette ville pour recevoir du matériel.');
  if (!locoAvailable(d, yearNow(s))) return no('Ce modèle n’est pas disponible à cette époque.');
  if (s.money < d.price) return no('Fonds insuffisants.');
  addLedger(s, `Achat : ${d.name}`, -d.price);
  const u = newUnit(s, defId, 'loco', 1);
  u.fuel = 1; u.water = 1;
  if (s.locoUid === null) s.locoUid = u.uid;
  return ok(`${d.name} acquise.`);
}
export function buyWagon(g: Game, defId: string): Res {
  const s = g.state, d = wagonById(defId);
  if (!hasDepot(g)) return no('Il faut un dépôt dans cette ville pour recevoir du matériel.');
  if (!wagonAvailable(d, yearNow(s))) return no('Ce modèle n’est pas disponible à cette époque.');
  if (s.money < d.price) return no('Fonds insuffisants.');
  addLedger(s, `Achat : ${d.name}`, -d.price);
  const u = newUnit(s, defId, 'wagon', 1);
  s.consistUids.push(u.uid);
  return ok(`${d.name} ajouté à la flotte.`);
}
export function unitValue(u: Unit): number {
  const d = unitDef(u);
  const avg = Object.values(u.cond).reduce((a, b) => a + b, 0) / 6;
  return Math.round(d.price * (0.25 + 0.45 * avg) / 10) * 10;
}
export function sellUnit(g: Game, uid: number): Res {
  const s = g.state, u = fleetUnit(s, uid);
  if (!u) return no('Matériel introuvable.');
  if (!hasDepot(g)) return no('La vente se fait au dépôt.');
  if (u.kind === 'loco' && s.fleet.filter(x => x.kind === 'loco').length <= 1) return no('Gardez au moins une locomotive.');
  if (unitBusy(s, uid)) return no('Ce matériel est à l’atelier.');
  addLedger(s, `Vente : ${unitDef(u).name}`, unitValue(u));
  s.fleet = s.fleet.filter(x => x.uid !== uid);
  s.consistUids = s.consistUids.filter(x => x !== uid);
  if (s.locoUid === uid) s.locoUid = s.fleet.find(x => x.kind === 'loco')?.uid ?? null;
  return ok('Matériel vendu.');
}
export function selectLoco(g: Game, uid: number): Res {
  const s = g.state, u = fleetUnit(s, uid);
  if (!u || u.kind !== 'loco') return no('Locomotive introuvable.');
  if (!hasDepot(g) && s.locoUid !== uid) return no('On ne change de locomotive qu’à un dépôt.');
  if (unitBusy(s, uid)) return no('Cette locomotive est immobilisée à l’atelier.');
  s.locoUid = uid; return ok('Locomotive sélectionnée.');
}
export function toggleConsist(g: Game, uid: number): Res {
  const s = g.state;
  if (s.consistUids.includes(uid)) { s.consistUids = s.consistUids.filter(x => x !== uid); return ok('Wagon retiré de la rame.'); }
  if (!hasDepot(g)) return no('On ne compose la rame qu’à un dépôt.');
  const u = fleetUnit(s, uid); if (!u || u.kind !== 'wagon') return no('Wagon introuvable.');
  if (unitBusy(s, uid)) return no('Ce wagon est à l’atelier.');
  if (s.consistUids.length >= 23) return no('Rame trop longue.');
  s.consistUids.push(uid); return ok('Wagon ajouté à la rame.');
}

// ---------- Combustible ----------
export const COAL_PRICE = 0.07, WATER_PRICE = 0.003, DIESEL_PRICE = 0.55, POWER_PRICE = 0.06;
export function fuelState(u: Unit): { fuel: number; water: number } { return { fuel: u.fuel ?? 1, water: u.water ?? 1 }; }
export function refuelCost(g: Game, u: Unit): number {
  const d = locoById(u.defId); const f = fuelState(u); const k = inflationAt(yearNow(g.state));
  const cap = 1 + 0.2 * (u.upgrades.capacity ?? 0);
  if (d.steam) return Math.round(((1 - f.fuel) * d.steam.coalKg * cap * COAL_PRICE + (1 - f.water) * d.steam.waterKg * cap * WATER_PRICE) * k);
  if (d.diesel) return Math.round((1 - f.fuel) * d.diesel.fuelL * cap * DIESEL_PRICE * k);
  if (d.electric?.fuelL) return Math.round((1 - f.fuel) * d.electric.fuelL * cap * DIESEL_PRICE * k);
  return 0;
}
export function refuel(g: Game, uid: number): Res {
  const s = g.state, u = fleetUnit(s, uid); if (!u) return no('Locomotive introuvable.');
  const c = refuelCost(g, u);
  if (c === 0 && (u.fuel ?? 1) >= 1 && (u.water ?? 1) >= 1) return no('Les réservoirs sont déjà pleins.');
  if (s.money < c) return no('Fonds insuffisants.');
  addLedger(s, 'Approvisionnement', -c); u.fuel = 1; u.water = 1; return ok('Réservoirs pleins.');
}

// ---------- Atelier ----------
const PART_SHARE = Object.fromEntries(Object.entries(PART_DEFS).map(([k, v]) => [k, v.share])) as Record<Part, number>;
const PART_DAYS = Object.fromEntries(Object.entries(PART_DEFS).map(([k, v]) => [k, v.days])) as Record<Part, number>;
export const PARTS_PRICE = 45;
export const partsPrice = (g: Game) => Math.round(PARTS_PRICE * inflationAt(yearNow(g.state)) * (1 - 0.05 * (workshopLevel(g) - 1)));
export const inspectPrice = (g: Game, kind: 'loco' | 'wagon') => Math.round(INSPECT_PRICE[kind] * inflationAt(yearNow(g.state)) * (1 - 0.1 * (workshopLevel(g) - 1)));

export function repairQuote(g: Game, u: Unit, parts: Part[]): { cost: number; partsNeeded: number; days: number } {
  const d = unitDef(u); const lvl = Math.max(1, workshopLevel(g));
  const mulCost = repairCostMul(g.state.eco) * (1.0 - 0.1 * (lvl - 1));
  let cost = 0, pn = 0, days = 0;
  for (const p of parts) {
    if (p === 'powerplant' && u.kind === 'wagon') continue;
    const dmg = 1 - u.cond[p]; if (dmg < 0.02) continue;
    const share = p === 'powerplant' ? PART_SHARE[p] : PART_SHARE[p] * (u.kind === 'wagon' ? 1.6 : 1);
    cost += d.price * share * dmg * 1.15 * mulCost + 15;
    pn += Math.max(1, Math.ceil(dmg * (p === 'powerplant' ? 6 : 3)));
    days += PART_DAYS[p] * dmg;
  }
  days = Math.max(parts.length ? 2 : 0, Math.ceil(days / (1 + 0.5 * (lvl - 1))));
  return { cost: Math.round(cost), partsNeeded: pn, days };
}
export function buyParts(g: Game, n: number): Res {
  const s = g.state; if (!hasDepot(g)) return no('Les pièces se commandent au dépôt.');
  const price = Math.round(PARTS_PRICE * inflationAt(yearNow(s)) * (1 - 0.05 * (workshopLevel(g) - 1)));
  if (s.money < price * n) return no('Fonds insuffisants.');
  addLedger(s, `Pièces détachées ×${n}`, -price * n); s.parts += n; return ok(`${n} pièces achetées.`);
}
export function startRepair(g: Game, uid: number, parts: Part[]): Res {
  const s = g.state, u = fleetUnit(s, uid); if (!u) return no('Matériel introuvable.');
  if (workshopLevel(g) < 1) return no('Il faut un atelier dans cette ville.');
  if (unitBusy(s, uid)) return no('Déjà à l’atelier.');
  const q = repairQuote(g, u, parts);
  if (q.cost === 0) return no('Rien à réparer.');
  if (s.parts < q.partsNeeded) return no(`Pièces insuffisantes (${q.partsNeeded} nécessaires, ${s.parts} en stock).`);
  if (s.money < q.cost) return no('Fonds insuffisants.');
  addLedger(s, `Réparation : ${unitDef(u).name}`, -q.cost); s.parts -= q.partsNeeded;
  for (const p of parts) u.cond[p] = 1;
  u.inspectedKm = u.km; u.inspectedDay = s.day;
  s.jobs.push({ uid, readyDay: Math.floor(s.day) + q.days, label: `Réparation de ${unitDef(u).name}`, parts, cost: q.cost });
  return ok(`Réparation lancée : ${q.days} jours d’immobilisation.`);
}
export function fullOverhaul(g: Game, uid: number): Res {
  const u = fleetUnit(g.state, uid); if (!u) return no('Matériel introuvable.');
  const parts = PARTS.filter(p => u.cond[p] < 0.85 && !(u.kind === 'wagon' && p === 'powerplant'));
  if (!parts.length) return no('Matériel en bon état.');
  return startRepair(g, uid, parts);
}
export const INSPECT_PRICE = { loco: 45, wagon: 12 };
export function inspect(g: Game, uid: number): Res {
  const s = g.state, u = fleetUnit(s, uid); if (!u) return no('Matériel introuvable.');
  if (workshopLevel(g) < 1) return no('Inspection possible dans un atelier uniquement.');
  const c = Math.round(INSPECT_PRICE[u.kind] * inflationAt(yearNow(s)) * (1 - 0.1 * (workshopLevel(g) - 1)));
  if (s.money < c) return no('Fonds insuffisants.');
  addLedger(s, `Inspection : ${unitDef(u).name}`, -c); u.inspectedKm = u.km; u.inspectedDay = s.day;
  return ok('Inspection terminée : l’état est connu avec précision.');
}
/** Estimation affichée de l'état d'une pièce (précise seulement juste après une inspection). */
export function estimatedCond(g: Game, u: Unit, p: Part): { value: number; err: number } {
  const since = u.inspectedKm === null ? 999 : Math.max(0, u.km - u.inspectedKm);
  const lvl = Math.max(0, workshopLevel(g)) * 0.015;
  const err = clamp(0.02 + since * 0.0016 - lvl, 0.02, 0.28);
  const n = (hashInts(u.uid, hashString(p), Math.floor(u.km / 20)) % 2000) / 1000 - 1;
  return { value: clamp(u.cond[p] + n * err, 0, 1), err };
}
export function upgradeQuote(u: Unit, id: string): { price: number; level: number; max: number; days: number } | null {
  const up = UPGRADES.find(x => x.id === id); if (!up) return null;
  const d = unitDef(u);
  if (up.appliesTo === 'loco' && u.kind !== 'loco') return null;
  if (up.appliesTo === 'coach' && (u.kind !== 'wagon' || (d as WagonDef).type !== 'coach')) return null;
  const lvl = u.upgrades[id] ?? 0;
  if (lvl >= up.maxLevel) return { price: 0, level: lvl, max: up.maxLevel, days: 0 };
  return { price: Math.round(d.price * up.prices[lvl] / 10) * 10, level: lvl, max: up.maxLevel, days: 5 + 6 * lvl };
}
export function applyUpgrade(g: Game, uid: number, id: string): Res {
  const s = g.state, u = fleetUnit(s, uid); if (!u) return no('Matériel introuvable.');
  const q = upgradeQuote(u, id); if (!q) return no('Amélioration non applicable.');
  if (q.level >= q.max) return no('Niveau maximum atteint.');
  if (workshopLevel(g) < 1) return no('Il faut un atelier.');
  if (s.money < q.price) return no('Fonds insuffisants.');
  const up = UPGRADES.find(x => x.id === id)!;
  addLedger(s, `Amélioration : ${up.name}`, -q.price);
  u.upgrades[id] = q.level + 1;
  s.jobs.push({ uid, readyDay: Math.floor(s.day) + q.days, label: `Amélioration de ${unitDef(u).name}`, parts: [], cost: q.price });
  return ok('Amélioration installée.');
}

// ---------- Infrastructure ----------
export function depotCost(w: World, city: number): number { return Math.round((5000 + w.cities[city].pop * 80) / 100) * 100; }
export function buildDepot(g: Game, city: number): Res {
  const s = g.state;
  if (s.depots[city] !== undefined) return no('Un dépôt existe déjà ici.');
  if (!cityConnected(s, g.world, city)) return no('Cette ville n’est pas raccordée au réseau.');
  if (s.reputation < 20) return no('Réputation insuffisante (20 requise).');
  const c = depotCost(g.world, city); if (s.money < c) return no('Fonds insuffisants.');
  addLedger(s, `Construction d’un dépôt à ${g.world.cities[city].name}`, -c); s.depots[city] = 1; s.stats.built++; return ok('Dépôt construit.');
}
export function workshopCost(level: number): number { return 9000 * level; }
export function upgradeWorkshop(g: Game, city: number): Res {
  const s = g.state, lvl = s.depots[city];
  if (lvl === undefined) return no('Pas de dépôt ici.');
  if (lvl >= 3) return no('Atelier au niveau maximum.');
  if (s.reputation < 15 + 12 * lvl) return no(`Réputation insuffisante (${15 + 12 * lvl} requise).`);
  const c = workshopCost(lvl); if (s.money < c) return no('Fonds insuffisants.');
  addLedger(s, `Atelier niveau ${lvl + 1} à ${g.world.cities[city].name}`, -c); s.depots[city] = lvl + 1; s.stats.built++;
  return ok('Atelier amélioré : réparations moins chères et plus rapides, inspections plus précises.');
}
export function warehouseCost(level: number): number { return 5000 * (level + 1); }
export function buildWarehouse(g: Game, city: number): Res {
  const s = g.state, lvl = s.warehouses[city] ?? 0;
  if (lvl >= 3) return no('Entrepôt au niveau maximum.');
  if (!cityConnected(s, g.world, city)) return no('Ville non raccordée.');
  if (s.reputation < 25) return no('Réputation insuffisante (25 requise).');
  const c = warehouseCost(lvl); if (s.money < c) return no('Fonds insuffisants.');
  addLedger(s, `Entrepôt à ${g.world.cities[city].name}`, -c); s.warehouses[city] = lvl + 1; s.stats.built++;
  return ok('Entrepôt construit : primes sur les contrats de cette ville.');
}
export function linkRequirement(kind: string): number { return kind === 'shortcut' ? 35 : 20; }
export function buildLink(g: Game, edgeId: number): Res {
  const s = g.state, e = g.world.edges[edgeId];
  if (edgeActive(s, e)) return no('Ligne déjà construite.');
  if (s.reputation < linkRequirement(e.kind)) return no(`Réputation insuffisante (${linkRequirement(e.kind)} requise).`);
  if (s.money < e.buildCost) return no('Fonds insuffisants.');
  addLedger(s, `Construction de la ligne ${g.world.cities[e.a].name} – ${g.world.cities[e.b].name}`, -e.buildCost);
  s.builtEdges.push(edgeId); s.stats.built++; clearBoardCache();
  return ok('Nouvelle ligne ouverte à la circulation !');
}
export function electrifyCost(g: Game, e: { lengthM: number }): number { return Math.round(e.lengthM / 1000 * 4800 / 100) * 100; }
export function electrifyEdge(g: Game, edgeId: number): Res {
  const s = g.state, e = g.world.edges[edgeId];
  if (!edgeActive(s, e)) return no('Ligne non construite.');
  if (edgeElectrified(s, e)) return no('Déjà électrifiée.');
  if (yearNow(s) < 1920) return no('La technologie n’est pas encore mûre (1920).');
  if (s.reputation < 40) return no('Réputation insuffisante (40 requise).');
  const c = electrifyCost(g, e); if (s.money < c) return no('Fonds insuffisants.');
  addLedger(s, `Électrification ${g.world.cities[e.a].name} – ${g.world.cities[e.b].name}`, -c);
  s.electrified[edgeId] = yearNow(s); s.stats.electrified++; s.stats.built++; return ok('Ligne électrifiée.');
}

// ---------- Finances ----------
export function takeLoan(g: Game, amount: number): Res {
  const s = g.state, room = loanLimit(s) - s.loan;
  if (amount > room) return no(`Plafond de prêt atteint (reste ${room}).`);
  s.loan += amount; addLedger(s, 'Prêt bancaire', amount); return ok('Prêt accordé (6 % par an).');
}
export function repayLoan(g: Game, amount: number): Res {
  const s = g.state; amount = Math.min(amount, s.loan, Math.max(0, s.money));
  if (amount <= 0) return no('Rien à rembourser.');
  s.loan -= amount; addLedger(s, 'Remboursement de prêt', -amount); return ok('Prêt remboursé.');
}
export function waitDays(g: Game, days: number): Res {
  advanceDays(g, days); ensureSolvent(g); return ok(`${days} jour(s) passés.`);
}

/** Pas de game over : le prêt bancaire et une locomotive de secours évitent l'impasse. */
export function ensureSolvent(g: Game): void {
  const s = g.state;
  if (s.money < 0) {
    const room = loanLimit(s) - s.loan;
    const need = Math.min(room, Math.ceil(-s.money / 500) * 500);
    if (need > 0) { s.loan += need; addLedger(s, 'Découvert converti en prêt', need); s.message.push('La banque a converti votre découvert en prêt.'); }
    if (s.money < 0) s.reputation = clamp(s.reputation - 0.02, 0, 100);
  }
  const usable = s.fleet.some(u => u.kind === 'loco' && !unitBusy(s, u.uid));
  const hasAny = s.fleet.some(u => u.kind === 'loco');
  if (!hasAny || (!usable && s.money < 500 && s.jobs.length === 0)) {
    const d = [...LOCOS].filter(l => locoAvailable(l, yearNow(s))).sort((a, b) => a.price - b.price)[0];
    const u = newUnit(s, d.id, 'loco', 0.5); u.fuel = 1; u.water = 1; if (s.locoUid === null || !fleetUnit(s, s.locoUid)) s.locoUid = u.uid;
    s.rescues++; s.money += 1500; s.message.push('La banque vous prête une locomotive d’occasion et 1 500 Cr pour repartir.');
  }
}

// ---------- Contrats ----------
export function acceptContract(g: Game, c: Contract, rent: boolean): Res {
  const s = g.state;
  if (s.contract) return no('Un contrat est déjà en cours.');
  const ev = evaluateContract(g, c, rent);
  if (!ev.ok) return no(ev.errors[0]);
  if (c.kind === 'freight' || c.kind === 'mail') {
    if (c.kind === 'freight') { const st = s.eco.stocks[c.from]; st[c.goodId!] = Math.max(0, (st[c.goodId!] ?? 0) - ev.loaded); }
  }
  s.contract = c; s.takenIds.push(c.id); if (s.takenIds.length > 80) s.takenIds.shift();
  return ok('Contrat accepté.');
}
export function cancelContract(g: Game): Res {
  const s = g.state; const c = s.contract; if (!c) return no('Aucun contrat.');
  if (c.kind === 'freight' && c.tonnes) s.eco.stocks[c.from][c.goodId!] = (s.eco.stocks[c.from][c.goodId!] ?? 0) + c.tonnes;
  s.takenIds = s.takenIds.filter(x => x !== c.id);
  s.contract = null; s.reputation = clamp(s.reputation - 1, 0, 100);
  return ok('Contrat annulé (−1 réputation).');
}

export { evaluateContract, loadTrain, PAX_KG, wagonMatches, newCond, goodById, priceMul, yearOf };
export type { LocoDef };
