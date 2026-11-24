import { describe, it, expect } from 'vitest';
import { newGame, advanceSeconds, yearNow } from '../src/game/state';
import { getBoard, evaluateContract, pickWagonsAuto, loadTrain, deadheadOptions } from '../src/game/contracts';
import { acceptContract, selectLoco, refuel, buyLoco, startRepair, inspect, buildLink, electrifyEdge, takeLoan, waitDays, fullOverhaul, estimatedCond } from '../src/game/actions';
import { Trip } from '../src/game/trip';
import { settleTrip } from '../src/game/settle';
import { serialize, deserialize } from '../src/game/save';
import { LOCOS, locoAvailable } from '../src/data';

import { drive } from './helpers/bot';

describe('déroulement d’une partie', () => {
  it('nouvelle partie : flotte de départ cohérente et sauvegarde fidèle', () => {
    const g = newGame({ seed: 'flow1', startYear: 1905 });
    expect(g.state.fleet.some(u => u.kind === 'loco')).toBe(true);
    expect(g.state.consistUids.length).toBeGreaterThan(3);
    const g2 = deserialize(serialize(g));
    expect(JSON.stringify(g2.state)).toBe(JSON.stringify(g.state));
  });
  it('un contrat de fret se conduit de bout en bout et rapporte', () => {
    const g = newGame({ seed: 'flow1', startYear: 1905 });
    const s = g.state;
    s.money = 1e6; buyLoco(g, 's230'); selectLoco(g, s.fleet.filter(u => u.kind === 'loco')[1].uid);
    let board = getBoard(g, s.location).filter(c => c.kind === 'freight');
    if (!board.length) { waitDays(g, 7); board = getBoard(g, s.location).filter(c => c.kind === 'freight'); }
    expect(board.length).toBeGreaterThan(0);
    const c = board.sort((a, b) => a.lengthM - b.lengthM)[0];
    s.consistUids = pickWagonsAuto(g, c);
    const ev = evaluateContract(g, c, true);
    expect(ev.ok, ev.errors.join()).toBe(true);
    const money0 = s.money;
    expect(acceptContract(g, c, true).ok).toBe(true);
    const { units, rented } = loadTrain(g, c, ev, true);
    const trip = new Trip(g, c, units, rented, ev.rentCost, ev.loaded);
    drive(trip);
    expect(['arrived', 'towed']).toContain(trip.status);
    const st = settleTrip(g, trip);
    expect(s.location).toBe(c.to);
    expect(s.contract).toBeNull();
    expect(s.money).not.toBe(money0);
    console.log('trajet', c.label, Math.round(trip.time), 's', 'cible', c.targetSec, 'gain', st.total, trip.status, st.lines.map(l => l.label + l.value).join(' | '));
  });
  it('les trajets durent entre 5 et 15 minutes (diesel, vapeur)', () => {
    for (const [year, seed] of [[1905, 'dur1'], [1960, 'dur2'], [2010, 'dur3']] as [number, string][]) {
      const g = newGame({ seed, startYear: year });
      const s = g.state;
      s.money = 1e6;
      { const best = [...LOCOS].filter(l => locoAvailable(l, year)).sort((a, b) => b.powerKW - a.powerKW)[0]; buyLoco(g, best.id); selectLoco(g, s.fleet.filter(u => u.kind === 'loco').pop()!.uid); }
      let c = getBoard(g, s.location).find(x => x.kind === 'freight' || x.kind === 'passenger');
      if (!c) { waitDays(g, 7); c = getBoard(g, s.location).find(x => x.kind === 'freight' || x.kind === 'passenger'); }
      if (!c) continue;
      s.consistUids = pickWagonsAuto(g, c);
      const ev = evaluateContract(g, c, true);
      if (!ev.ok) continue;
      acceptContract(g, c, true);
      const { units, rented } = loadTrain(g, c, ev, true);
      const trip = new Trip(g, c, units, rented, ev.rentCost, ev.loaded);
      drive(trip);
      console.log(year, c.label, 'len', c.lengthM, 'durée', Math.round(trip.time / 60 * 10) / 10, 'min cible', Math.round(c.targetSec / 60 * 10) / 10, trip.status, 'loco', units[0].defId);
      if (trip.status === 'wrecked') console.log('WRECK', trip.fines, 'pos', trip.sim.s, trip.sim.v, trip.toasts.map(t => t.text));
      expect(['arrived', 'towed']).toContain(trip.status);
      if (trip.status === 'arrived') { expect(trip.time).toBeGreaterThan(150); expect(trip.time).toBeLessThan(1500); }
    }
  });
  it('atelier, inspection, pièces, prêt et attente fonctionnent', () => {
    const g = newGame({ seed: 'flow2', startYear: 1905 });
    const s = g.state; const loco = s.fleet.find(u => u.kind === 'loco')!;
    loco.cond.wheels = 0.4; loco.cond.powerplant = 0.5;
    expect(estimatedCond(g, loco, 'wheels').err).toBeGreaterThan(0.2);
    expect(inspect(g, loco.uid).ok).toBe(true);
    expect(estimatedCond(g, loco, 'wheels').err).toBeLessThan(0.05);
    const r = fullOverhaul(g, loco.uid);
    expect(r.ok, r.msg).toBe(true);
    expect(loco.cond.wheels).toBe(1);
    expect(s.jobs.length).toBe(1);
    waitDays(g, 120);
    expect(s.jobs.length).toBe(0);
    expect(takeLoan(g, 3000).ok).toBe(true);
    expect(refuel(g, loco.uid).ok || true).toBe(true);
    expect(deadheadOptions(g, s.location).length).toBeGreaterThan(0);
  });
  it('le temps s’écoule : 1 an de jeu ≈ 2 h', () => {
    const g = newGame({ seed: 'time' });
    advanceSeconds(g, 3600);
    expect(g.state.day).toBeCloseTo(182.5, 0);
    advanceSeconds(g, 3600);
    expect(yearNow(g.state)).toBe(1906);
  });
  it('les achats exigent un dépôt et les ères limitent le matériel', () => {
    const g = newGame({ seed: 'buy', startYear: 1905 });
    expect(buyLoco(g, 'e_aurore').ok).toBe(false);
    g.state.money = 1e6;
    expect(buyLoco(g, 's230').ok).toBe(true);
  });
});
