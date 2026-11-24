import { describe, it, expect } from 'vitest';
import { generateWorld } from '../src/world/mapgen';
import { edgeProfile, buildRoute, DS } from '../src/world/track';
import { newGame, advanceDays, yearNow, edgeElectrified, edgeActive, cityConnected } from '../src/game/state';
import { startGame, getBoard, evaluateContract, pickWagonsAuto, loadTrain, bestRentalWagon } from '../src/game/contracts';
import * as A from '../src/game/actions';
import { Trip } from '../src/game/trip';
import { settleTrip, punctualityFactor } from '../src/game/settle';
import { serialize, deserialize, migrate } from '../src/game/save';
import { LOCOS, WAGONS, locoAvailable, wagonAvailable, eraAt, GOODS, goodAvailable } from '../src/data';
import { GOALS, checkGoals } from '../src/game/goals';
import { drive } from './helpers/bot';
import { dateOf, weatherAt, daylight } from '../src/sim/weather';
import { shortestPath } from '../src/world/graph';
import { makeUnit } from '../src/sim/units';
import { TrainSim, defaultControls } from '../src/sim/train';

describe('profil de voie', () => {
  const w = generateWorld('track-test');
  it('les pentes restent réalistes et les extrémités concordent avec les villes', () => {
    for (const e of w.edges.filter(x => x.initial).slice(0, 25)) {
      const p = edgeProfile(w, e);
      let maxG = 0; for (let i = 0; i < p.n; i++) maxG = Math.max(maxG, Math.abs(p.elev[i + 1] - p.elev[i]) / DS);
      expect(maxG).toBeLessThan(0.045);
      expect(Math.abs(p.elev[0] - w.cities[e.a].elev)).toBeLessThan(1);
      expect(Math.abs(p.elev[p.n] - w.cities[e.b].elev)).toBeLessThan(1);
    }
  });
  it('contient courbes, et parfois tunnels et ponts', () => {
    let curves = 0, tunnels = 0, bridges = 0;
    for (const e of w.edges.filter(x => x.initial)) { const p = edgeProfile(w, e); for (let i = 0; i < p.n; i++) { if (p.curv[i] !== 0) curves++; tunnels += p.tunnel[i]; bridges += p.bridge[i]; } }
    expect(curves).toBeGreaterThan(1000); expect(tunnels + bridges).toBeGreaterThan(0);
  });
  it('construit une route avec limites, signaux et passages à niveau', () => {
    const e = w.edges.find(x => x.initial && x.lengthM > 9000)!;
    const r = buildRoute(w, [e.a, e.b], [e.id], { trainLength: 120, year: 1960, seed: 'x', day: 10, electrifiedOf: () => false }, 120);
    expect(r.features.some(f => f.kind === 'speedsign')).toBe(true);
    expect(r.features.some(f => f.kind === 'crossing')).toBe(true);
    expect(r.loops.length).toBeGreaterThan(0);
    expect(r.stopS).toBeGreaterThan(e.lengthM);
    expect(Math.max(...Array.from(r.limit))).toBeLessThanOrEqual(120 / 3.6 + 0.01);
  });
});

describe('époques et données', () => {
  it('le matériel disponible évolue avec les décennies', () => {
    const at = (y: number) => LOCOS.filter(l => locoAvailable(l, y)).map(l => l.traction);
    expect(at(1905).every(t => t === 'steam')).toBe(true);
    expect(at(1950)).toContain('diesel'); expect(at(1950)).toContain('electric');
    expect(at(2020).some(t => t === 'steam')).toBe(false);
    expect(WAGONS.filter(w => wagonAvailable(w, 1905)).some(w => w.type === 'container')).toBe(false);
    expect(WAGONS.filter(w => wagonAvailable(w, 2000)).some(w => w.type === 'container')).toBe(true);
    expect(goodAvailable(GOODS.find(g => g.id === 'fuel')!, 1905)).toBe(false);
    expect(eraAt(2010).lineSpeedKmh).toBeGreaterThan(eraAt(1910).lineSpeedKmh);
  });
  it('couvre toutes les marchandises du document de conception', () => {
    for (const id of ['coal', 'wood', 'grain', 'cattle', 'materials', 'goods', 'fuel', 'perishables']) expect(GOODS.some(g => g.id === id)).toBe(true);
    for (const t of ['coach', 'open', 'tank', 'reefer', 'covered', 'flat']) expect(WAGONS.some(w => w.type === t)).toBe(true);
    for (const t of ['steam', 'diesel', 'electric']) expect(LOCOS.some(l => l.traction === t)).toBe(true);
  });
  it('le calendrier suit les mois', () => { const d = dateOf(1905, 59); expect(d.month).toBe(2); expect(d.day).toBe(1); });
  it('la météo varie avec la saison et la nuit tombe', () => {
    let winter = 0, summer = 0;
    for (let d = 0; d < 60; d++) { winter += weatherAt('w', d + 10, 0, 12, 100, 0.5).tempC; summer += weatherAt('w', d + 170, 0, 12, 100, 0.5).tempC; }
    expect(summer / 60).toBeGreaterThan(winter / 60 + 8);
    expect(daylight(2, 100).isNight).toBe(true); expect(daylight(12, 100).isNight).toBe(false);
  });
});

describe('économie jouable', () => {
  it('le départ propose des contrats variés', () => {
    const g = startGame({ seed: 'start-a', startYear: 1905 });
    const b = getBoard(g, g.state.location);
    expect(b.some(c => c.kind === 'freight')).toBe(true);
    expect(b.some(c => c.kind === 'passenger')).toBe(true);
  });
  it('un contrat de fret livré réduit le stock à l’origine et le recrée à destination', () => {
    const g = startGame({ seed: 'stock-test', startYear: 1960 });
    const s = g.state;
    s.money = 1e6; A.buyLoco(g, 'd_renard'); A.selectLoco(g, s.fleet.filter(u => u.kind === 'loco').pop()!.uid);
    const c = getBoard(g, s.location).find(x => x.kind === 'freight' && (s.consistUids = pickWagonsAuto(g, x), evaluateContract(g, x, true).ok))!;
    const before = s.eco.stocks[c.from][c.goodId!], destBefore = s.eco.stocks[c.to][c.goodId!] ?? 0;
    s.consistUids = pickWagonsAuto(g, c);
    const ev = evaluateContract(g, c, true);
    expect(A.acceptContract(g, c, true).ok).toBe(true);
    expect(s.eco.stocks[c.from][c.goodId!]).toBeLessThan(before);
    const { units, rented } = loadTrain(g, c, ev, true);
    const trip = new Trip(g, c, units, rented, ev.rentCost, ev.loaded);
    drive(trip); settleTrip(g, trip);
    expect(s.eco.stocks[c.to][c.goodId!]).toBeGreaterThanOrEqual(Math.min(destBefore, 1e9) - 1);
    expect(s.location).toBe(trip.status === 'wrecked' ? s.hq : c.to);
  });
  it('la ponctualité et le confort modulent la paie', () => {
    expect(punctualityFactor(500, 600)).toBeGreaterThan(1);
    expect(punctualityFactor(1500, 600)).toBeLessThan(0.7);
  });
  it('une locomotive électrique refuse un itinéraire non électrifié', () => {
    const g = startGame({ seed: 'elec-test', startYear: 1960 });
    const s = g.state; s.money = 1e7;
    A.buyLoco(g, 'e_foudre'); A.selectLoco(g, s.fleet.filter(u => u.kind === 'loco').pop()!.uid);
    const cs = getBoard(g, s.location);
    const bad = cs.find(c => c.edges.some(id => !edgeElectrified(s, g.world.edges[id])));
    if (bad) { const ev = evaluateContract(g, bad, true); expect(ev.ok).toBe(false); expect(ev.errors.join()).toMatch(/électrifié/); }
  });
  it('le matériel de location existe pour chaque type de contrat', () => {
    const g = startGame({ seed: 'rent', startYear: 1905 });
    for (const c of getBoard(g, g.state.location)) expect(bestRentalWagon(g, c)).toBeTruthy();
  });
});

describe('infrastructure, finances et sauvegarde', () => {
  it('raccordements, dépôts, entrepôts, électrification et prêt', () => {
    const g = startGame({ seed: 'infra', startYear: 1930 }); const s = g.state; s.money = 5e6; s.reputation = 90;
    const branch = g.world.edges.find(e => e.kind === 'branch')!;
    expect(edgeActive(s, branch)).toBe(false);
    expect(A.buildLink(g, branch.id).ok).toBe(true);
    expect(edgeActive(s, branch)).toBe(true);
    const unconn = [branch.a, branch.b].find(id => !g.world.cities[id].connected)!;
    expect(cityConnected(s, g.world, unconn)).toBe(true);
    const city = g.world.cities.find(c => c.connected && s.depots[c.id] === undefined)!;
    expect(A.buildDepot(g, city.id).ok).toBe(true);
    expect(A.upgradeWorkshop(g, city.id).ok).toBe(true);
    expect(A.buildWarehouse(g, city.id).ok).toBe(true);
    const e = g.world.edges.find(x => x.initial && !edgeElectrified(s, x))!;
    expect(A.electrifyEdge(g, e.id).ok).toBe(true); expect(edgeElectrified(s, e)).toBe(true);
    expect(A.takeLoan(g, 5000).ok).toBe(true);
    s.money = 0; s.loan = 0; advanceDays(g, 1); A.ensureSolvent(g);
    expect(s.money).toBeGreaterThanOrEqual(-5000);
  });
  it('un découvert déclenche un prêt et le jeu ne s’arrête jamais', () => {
    const g = startGame({ seed: 'broke' }); const s = g.state; s.money = -4000;
    A.ensureSolvent(g);
    expect(s.loan).toBeGreaterThan(0);
    s.fleet = s.fleet.filter(u => u.kind !== 'loco'); s.locoUid = null; A.ensureSolvent(g);
    expect(s.fleet.some(u => u.kind === 'loco')).toBe(true);
  });
  it('réparations et améliorations passent par l’atelier (argent, pièces, temps)', () => {
    const g = startGame({ seed: 'repair' }); const s = g.state; const loco = s.fleet.find(u => u.kind === 'loco')!;
    loco.cond.wheels = 0.3; s.money = 1e5;
    s.parts = 0;
    expect(A.startRepair(g, loco.uid, ['wheels']).ok).toBe(false);
    A.buyParts(g, 10);
    const day0 = s.day; expect(A.startRepair(g, loco.uid, ['wheels']).ok).toBe(true);
    expect(s.jobs[0].readyDay).toBeGreaterThan(day0);
    expect(A.applyUpgrade(g, loco.uid, 'brakes').ok).toBe(true);
    expect(loco.upgrades.brakes).toBe(1);
  });
  it('la sauvegarde est versionnée et fidèle', () => {
    const g = startGame({ seed: 'save-test', startYear: 1950 });
    advanceDays(g, 45);
    const json = serialize(g);
    expect(JSON.parse(json).version).toBe(1);
    const g2 = deserialize(json);
    expect(JSON.stringify(g2.state)).toBe(JSON.stringify(g.state));
    expect(g2.world.cities.length).toBe(g.world.cities.length);
    expect(() => deserialize(JSON.stringify({ version: 99, state: {} }))).toThrow();
    expect(() => migrate({}, 0)).toThrow();
  });
  it('les objectifs se déclenchent et versent leur récompense', () => {
    const g = startGame({ seed: 'goals' }); const s = g.state; const m = s.money;
    s.stats.deliveries = 12; const got = checkGoals(g);
    expect(got.length).toBeGreaterThanOrEqual(2); expect(s.money).toBeGreaterThan(m);
    expect(GOALS.length).toBeGreaterThanOrEqual(12);
  });
});

describe('simulation : cas limites physiques', () => {
  const flat = { grade: () => 0, curv: () => 0, electrified: () => true, tunnel: () => false, neutral: () => false };
  const env = { tempC: 10, headwind: 0, grip: 1, wet: false, precip: 0 };
  it('la zone neutre sans coupure de traction abîme le pantographe', () => {
    const units = [makeUnit(1, 'e_foudre', 'loco')]; for (let i = 0; i < 3; i++) units.push(makeUnit(2 + i, 'cov_new', 'wagon'));
    const neutral = { ...flat, neutral: () => true };
    const sim = new TrainSim(units, 1, {}, neutral); sim.v = 15;
    const c = defaultControls(); c.brake = 0; c.throttle = 1;
    const before = units[0].cond.powerplant;
    for (let i = 0; i < 60 * 8; i++) sim.step(1 / 60, c, env);
    expect(units[0].cond.powerplant).toBeLessThan(before);
  });
  it('un attelage faible casse sous une grosse traction', () => {
    const units = [makeUnit(1, 's140', 'loco')]; for (let i = 0; i < 14; i++) { const u = makeUnit(2 + i, 'open_old', 'wagon', 0.05); u.loadT = 20; units.push(u); }
    const sim = new TrainSim(units, 3, {}, flat);
    const c = defaultControls(); c.brake = 0; c.throttle = 1; c.cutoff = 0.7;
    let broke = false;
    for (let i = 0; i < 60 * 60 && !broke; i++) { sim.step(1 / 60, c, env); broke = sim.faults.couplingBroken; }
    expect(broke).toBe(true);
  });
  it('frein moteur : moins d’échauffement des freins en descente', () => {
    const down = { ...flat, grade: () => -0.025 };
    const run = (dyn: number) => { const units = [makeUnit(1, 'd_lynx', 'loco')]; for (let i = 0; i < 12; i++) { const u = makeUnit(2 + i, 'open_new', 'wagon'); u.loadT = 40; units.push(u); } const sim = new TrainSim(units, 1, {}, down); sim.v = 16; const c = defaultControls(); c.throttle = 0; for (let i = 0; i < 60 * 150; i++) { c.dyn = dyn; c.brake = sim.v > 16 ? (dyn ? 0.15 : 0.5) : 0; sim.step(1 / 60, c, env); } return sim.brakeTempAvg; };
    expect(run(1)).toBeLessThan(run(0));
  });
  it('l’état du réseau : plus court chemin évite les lignes coupées', () => {
    const w = generateWorld('graph');
    const a = w.cities.find(c => c.connected)!, b = w.cities.filter(c => c.connected).slice(-1)[0];
    const p = shortestPath(w, a.id, b.id, e => e.initial)!;
    const blocked = new Set([p.edges[0]]);
    const q = shortestPath(w, a.id, b.id, e => e.initial && !blocked.has(e.id));
    if (q) expect(q.edges).not.toContain(p.edges[0]);
  });
  void yearNow;
});
