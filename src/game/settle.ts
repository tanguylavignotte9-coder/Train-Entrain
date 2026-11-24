import { clamp } from '../core/util';
import { expectations, locoById, goodById } from '../data';
import { yearOf } from '../economy/economy';
import { addLedger, fleetUnit, yearNow, type Game } from './state';
import { PAX_KG, evaluateContract, clearBoardCache } from './contracts';
import { ensureSolvent } from './actions';
import { checkGoals } from './goals';
import type { Trip, TripResult } from './trip';

export interface Settlement {
  lines: { label: string; value: string; kind?: 'good' | 'bad' }[]; total: number; reputationDelta: number; summary: string;
}

export function punctualityFactor(time: number, target: number): number {
  const r = time / target;
  if (r <= 1) return 1.1;
  if (r <= 1.25) return 1.0;
  if (r <= 2) return 1.0 - (r - 1.25) / 0.75 * 0.4;
  return 0.6;
}

/** Calcule la rémunération sans modifier l'état. */
export function computePayout(g: Game, res: TripResult): { base: number; punctual: number; cargo: number; stop: number; comfortF: number; total: number } {
  const c = res.contract;
  const failed = res.status === 'wrecked';
  const towed = res.status === 'towed';
  let base = c.kind === 'deadhead' ? 0 : c.reward * (c.tonnes || c.pax ? res.loaded / (c.kind === 'passenger' ? (c.pax!.c1 + c.pax!.c2 + c.pax!.c3) : c.tonnes!) : 1);
  if (!isFinite(base)) base = 0;
  const punctual = punctualityFactor(res.timeSec, res.contract.targetSec);
  const stopAbs = Math.abs(res.stopError);
  const stop = res.status !== 'arrived' ? 1 : res.stopError > 30 ? 0.94 : stopAbs <= 8 ? 1.05 : stopAbs <= 25 ? 1 : 0.97;
  const exp = expectations(yearNow(g.state));
  let comfortF = 1;
  if (c.kind === 'passenger') comfortF = clamp(0.7 + (res.comfort - exp.comfort * 0.85) * 1.4, 0.55, 1.18);
  const cargo = c.kind === 'passenger' ? 1 : res.cargoCondition;
  let total = base * punctual * stop * comfortF * (c.kind === 'passenger' ? 1 : Math.pow(cargo, 1.4));
  if (towed) total *= 0.35;
  if (failed) total = 0;
  return { base, punctual, cargo, stop, comfortF, total: Math.round(total) };
}

export function settleTrip(g: Game, trip: Trip): Settlement {
  const s = g.state, res = trip.result(), c = res.contract;
  const lines: Settlement['lines'] = [];
  const pay = computePayout(g, res);
  const sim = trip.sim;
  // matériel : on reporte l'usure de la simulation dans la flotte
  for (const u of trip.units) {
    const f = fleetUnit(s, u.uid);
    if (f && !u.rented) { f.cond = { ...u.cond }; f.km = u.km; f.loadT = 0; f.upgrades = { ...u.upgrades }; f.cargo = undefined; }
  }
  const lu = trip.units[0], lf = fleetUnit(s, lu.uid);
  if (lf) {
    const d = locoById(lf.defId);
    const cap = 1 + 0.2 * (lf.upgrades.capacity ?? 0);
    if (sim.steam) { lf.fuel = clamp(sim.steam.coal / (d.steam!.coalKg * cap), 0, 1); lf.water = clamp(sim.steam.water / (d.steam!.waterKg * cap), 0, 1); }
    if (sim.diesel) lf.fuel = clamp(sim.diesel.fuel / sim.diesel.fuelCap, 0, 1);
    if (sim.electric && d.electric?.fuelL) lf.fuel = clamp(sim.electric.fuel / (d.electric.fuelL * cap), 0, 1);
    if (!s.stats.tractions.includes(d.traction)) s.stats.tractions.push(d.traction);
  }
  // coûts d'exploitation de la traction
  let energyCost = res.energyCost;
  if (energyCost > 0) lines.push({ label: 'Électricité consommée', value: `−${energyCost} Cr`, kind: 'bad' });
  if (energyCost) addLedger(s, 'Électricité', -energyCost);
  if (res.rentCost) { addLedger(s, 'Location de wagons', -res.rentCost); lines.push({ label: 'Location de wagons', value: `−${res.rentCost} Cr`, kind: 'bad' }); }
  let reputationDelta = 0;
  const km = c.lengthM / 1000;
  if (res.status === 'arrived' || res.status === 'towed') {
    if (c.kind !== 'deadhead') {
      lines.push({ label: 'Tarif du contrat', value: `${Math.round(pay.base)} Cr` });
      lines.push({ label: `Ponctualité (${Math.round(res.timeSec / 60 * 10) / 10} min pour ${Math.round(c.targetSec / 60 * 10) / 10} min visées)`, value: `×${pay.punctual.toFixed(2)}`, kind: pay.punctual >= 1 ? 'good' : 'bad' });
      if (c.kind === 'passenger') lines.push({ label: `Confort des voyageurs (${Math.round(res.comfort * 100)} %)`, value: `×${pay.comfortF.toFixed(2)}`, kind: pay.comfortF >= 1 ? 'good' : 'bad' });
      else lines.push({ label: `État de la marchandise (${Math.round(res.cargoCondition * 100)} %)`, value: `×${Math.pow(pay.cargo, 1.4).toFixed(2)}`, kind: pay.cargo > 0.9 ? 'good' : 'bad' });
      if (res.status === 'arrived') lines.push({ label: `Précision d’arrêt (${res.stopError >= 0 ? '+' : ''}${res.stopError.toFixed(0)} m)`, value: `×${pay.stop.toFixed(2)}`, kind: pay.stop >= 1 ? 'good' : 'bad' });
      if (res.status === 'towed') lines.push({ label: 'Train remorqué : paiement réduit', value: '×0,35', kind: 'bad' });
    } else lines.push({ label: 'Marche à vide', value: '0 Cr' });
    if (pay.total > 0) addLedger(s, `Livraison : ${c.label}`, pay.total);
    if (res.towFee) { addLedger(s, 'Dépannage / remorquage', -res.towFee); lines.push({ label: 'Remorquage', value: `−${res.towFee} Cr`, kind: 'bad' }); }
  } else {
    lines.push({ label: 'Accident : trajet interrompu, train dégagé par les services de secours', value: '', kind: 'bad' });
    if (res.towFee) { addLedger(s, 'Dégagement et remorquage', -res.towFee); lines.push({ label: 'Dégagement', value: `−${res.towFee} Cr`, kind: 'bad' }); }
  }
  for (const f of res.fines) { addLedger(s, `Amende : ${f.label}`, -f.amount); lines.push({ label: `Amende : ${f.label}`, value: `−${f.amount} Cr`, kind: 'bad' }); }
  // dégâts d'accident
  if (res.status === 'wrecked') {
    for (const u of trip.units) { const f = fleetUnit(s, u.uid); if (f) for (const k of ['wheels', 'axles', 'brakes', 'couplings'] as const) f.cond[k] = Math.max(0.05, f.cond[k] - 0.45); }
    if (lf) lf.cond.powerplant = Math.max(0.1, lf.cond.powerplant - 0.4);
  }
  // marchandises livrées
  if (res.status === 'arrived' || res.status === 'towed') {
    if (c.kind === 'freight' && c.goodId) { const arrived = res.loaded * res.cargoCondition; s.eco.stocks[c.to][c.goodId] = (s.eco.stocks[c.to][c.goodId] ?? 0) + arrived; s.stats.tonnes += res.loaded; }
    if (c.kind === 'mail') s.stats.tonnes += res.loaded;
    if (c.kind === 'passenger') s.stats.passengers += Math.round(res.loaded);
    if (c.kind !== 'deadhead') { s.stats.deliveries++; const reg = g.world.cities[c.to].region; if (!s.stats.regionsServed.includes(reg)) s.stats.regionsServed.push(reg); const reg0 = g.world.cities[c.from].region; if (!s.stats.regionsServed.includes(reg0)) s.stats.regionsServed.push(reg0); }
    s.location = c.to; s.stats.km += km; s.stats.trips++;
    if (res.timeSec <= c.targetSec * 1.25 && res.status === 'arrived') s.stats.onTime++;
  } else {
    // accident : le train est remorqué jusqu'au dépôt le plus proche (ici, le siège)
    s.location = s.hq; s.stats.trips++;
    if (c.kind === 'freight' && c.goodId) s.eco.stocks[c.from][c.goodId] = (s.eco.stocks[c.from][c.goodId] ?? 0) + (c.tonnes ?? 0) * 0.5;
  }
  s.stats.accidents += res.accidents;
  // réputation
  if (c.kind !== 'deadhead') {
    const quality = res.status === 'arrived' ? clamp(0.55 * Math.min(1, pay.punctual) + 0.45 * (c.kind === 'passenger' ? res.comfort : res.cargoCondition), 0, 1) : 0.2;
    reputationDelta += (quality - 0.7) * 6 + (pay.punctual >= 1.05 ? 0.5 : 0);
    for (const id of [c.from, c.to]) s.service[id] = Math.round((0.7 * (s.service[id] ?? 0.5) + 0.3 * quality) * 1000) / 1000;
  }
  reputationDelta -= res.accidents * 2.5; if (res.status === 'towed') reputationDelta -= 3; if (res.status === 'wrecked') reputationDelta -= 5;
  reputationDelta = clamp(reputationDelta, -10, 5);
  s.reputation = clamp(s.reputation + reputationDelta, 0, 100);
  s.contract = null;
  clearBoardCache();
  ensureSolvent(g);
  const goalsGot = checkGoals(g);
  for (const gl of goalsGot) lines.push({ label: `Objectif atteint : ${gl.name} (+${gl.reward} Cr)`, value: '', kind: 'good' });
  const net = pay.total - res.fines.reduce((a, f) => a + f.amount, 0) - res.towFee - res.rentCost - energyCost;
  void net; void yearOf; void PAX_KG; void evaluateContract; void goodById;
  const summary = res.status === 'arrived' ? `Livraison à ${g.world.cities[c.to].name} terminée.` : res.status === 'towed' ? `Train remorqué jusqu’à ${g.world.cities[c.to].name}.` : 'Accident : trajet interrompu.';
  return { lines, total: pay.total, reputationDelta, summary };
}
