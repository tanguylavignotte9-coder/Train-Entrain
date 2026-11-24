import { describe, it, expect } from 'vitest';
import { TrainSim, defaultControls, type Env, type TrackAccess, type Unit } from '../src/sim/train';
import { makeUnit } from '../src/sim/units';

const flat: TrackAccess = { grade: () => 0, curv: () => 0, electrified: () => true, tunnel: () => false, neutral: () => false };
const dry: Env = { tempC: 15, headwind: 0, grip: 1, wet: false, precip: 0 };
const hill = (g: number): TrackAccess => ({ ...flat, grade: () => g });

function train(loco: string, nWag: number, wag = 'open_new', load = 30, cond = 1): Unit[] {
  const u = [makeUnit(1, loco, 'loco', cond)];
  for (let i = 0; i < nWag; i++) { const w = makeUnit(10 + i, wag, 'wagon', cond); w.loadT = load; u.push(w); }
  return u;
}
function run(sim: TrainSim, secs: number, ctl = defaultControls(), env = dry, hook?: (t: number) => void) {
  for (let i = 0; i < secs * 60; i++) { hook?.(i / 60); sim.step(1 / 60, ctl, env); }
}
const kmh = (v: number) => v * 3.6;

describe('traction diesel', () => {
  it('accélère puis atteint une vitesse d’équilibre plausible', () => {
    const sim = new TrainSim(train('d_renard', 8), 1, {}, flat);
    const ctl = defaultControls(); ctl.brake = 0; ctl.throttle = 1;
    run(sim, 240, ctl);
    expect(kmh(sim.v)).toBeGreaterThan(60);
    expect(kmh(sim.v)).toBeLessThan(105);
  });
  it('ne démarre pas avec le frein serré', () => {
    const sim = new TrainSim(train('d_renard', 8), 1, {}, flat);
    const ctl = defaultControls(); ctl.brake = 1; ctl.throttle = 0.5;
    run(sim, 30, ctl);
    expect(sim.v).toBeLessThan(0.2);
  });
  it('ralentit dans une côte de 2,5 % avec une rame lourde', () => {
    const light = new TrainSim(train('d_renard', 4), 1, {}, hill(0.025));
    const heavy = new TrainSim(train('d_renard', 14), 1, {}, hill(0.025));
    const ctl = defaultControls(); ctl.brake = 0; ctl.throttle = 1;
    run(light, 200, ctl); run(heavy, 200, ctl);
    expect(heavy.v).toBeLessThan(light.v);
    expect(kmh(heavy.v)).toBeLessThan(30);
  });
  it('freine avec un délai et s’arrête', () => {
    const sim = new TrainSim(train('d_lynx', 10), 1, {}, flat);
    sim.v = 25;
    const ctl = defaultControls(); ctl.brake = 1; ctl.throttle = 0;
    run(sim, 1, ctl);
    expect(sim.brakeP).toBeLessThan(0.7);
    run(sim, 60, ctl);
    expect(sim.v).toBe(0);
    expect(sim.dist).toBeGreaterThan(200);
    expect(sim.dist).toBeLessThan(1500);
  });
  it('patine sur rail glissant, le sable aide', () => {
    const slippery: Env = { ...dry, grip: 0.35, wet: true };
    const a = new TrainSim(train('d_renard', 2), 1, {}, flat); const b = new TrainSim(train('d_renard', 2), 1, {}, flat);
    const ca = defaultControls(); ca.brake = 0; ca.throttle = 1;
    const cb = { ...ca, sand: true };
    let slipA = 0, slipB = 0;
    for (let i = 0; i < 600; i++) { a.step(1 / 60, ca, slippery); b.step(1 / 60, cb, slippery); if (a.slipping) slipA++; if (b.slipping) slipB++; }
    expect(slipA).toBeGreaterThan(slipB);
  });
  it('est déterministe', () => {
    const mk = () => { const s = new TrainSim(train('d_renard', 6, 'open_new', 30, 0.2), 99, {}, flat); const c = defaultControls(); c.brake = 0; c.throttle = 1; run(s, 120, c); return [s.s, s.v, s.vehicles[2].unit.cond.wheels]; };
    expect(mk()).toEqual(mk());
  });
});

describe('vapeur', () => {
  it('démarre avec la pression et consomme charbon et eau', () => {
    const sim = new TrainSim(train('s230', 0), 1, {}, flat);
    const ctl = defaultControls(); ctl.brake = 0; ctl.throttle = 0.7; ctl.cutoff = 0.4; ctl.injector = false;
    const coal0 = sim.steam!.bed;
    run(sim, 30, ctl);
    expect(sim.v).toBeGreaterThan(5);
    expect(sim.steam!.bed).toBeLessThan(coal0);
  });
  it('la pression chute sans enfournement', () => {
    const sim = new TrainSim(train('s140', 6, 'open_old', 18), 1, {}, flat);
    const ctl = defaultControls(); ctl.brake = 0; ctl.throttle = 1; ctl.cutoff = 0.5;
    run(sim, 700, ctl);
    expect(sim.steam!.bed).toBeLessThan(30);
    expect(sim.steam!.pressure).toBeLessThan(14 * 0.6);
  });
  it('un chauffeur attentif tient la pression', () => {
    const sim = new TrainSim(train('s140', 6, 'open_old', 18), 1, {}, flat);
    const ctl = defaultControls(); ctl.brake = 0; ctl.throttle = 0.8; ctl.cutoff = 0.4;
    run(sim, 300, ctl, dry, () => { ctl.shovel = sim.steam!.bed < 110; ctl.injector = sim.steam!.level < 0.55; });
    expect(sim.steam!.pressure).toBeGreaterThan(8);
    expect(sim.v).toBeGreaterThan(8);
  });
});

describe('électrique', () => {
  it('sans caténaire pas de traction', () => {
    const noWire: TrackAccess = { ...flat, electrified: () => false };
    const sim = new TrainSim(train('e_foudre', 6), 1, {}, noWire);
    const ctl = defaultControls(); ctl.brake = 0; ctl.throttle = 1;
    run(sim, 30, ctl);
    expect(sim.v).toBeLessThan(0.2);
  });
  it('avec caténaire elle avance', () => {
    const sim = new TrainSim(train('e_foudre', 6), 1, {}, flat);
    const ctl = defaultControls(); ctl.brake = 0; ctl.throttle = 1;
    run(sim, 60, ctl);
    expect(kmh(sim.v)).toBeGreaterThan(50);
  });
});

describe('usure et pannes', () => {
  it('l’usure augmente avec la distance', () => {
    const sim = new TrainSim(train('d_renard', 4), 1, {}, flat);
    const ctl = defaultControls(); ctl.brake = 0; ctl.throttle = 1;
    run(sim, 120, ctl);
    expect(sim.vehicles[0].unit.cond.wheels).toBeLessThan(1);
    expect(sim.vehicles[0].unit.km).toBeGreaterThan(1);
  });
  it('un matériel très usé tombe en panne en route', () => {
    let failures = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const sim = new TrainSim(train('d_renard', 6, 'open_new', 30, 0.05), seed, {}, flat);
      const ctl = defaultControls(); ctl.brake = 0; ctl.throttle = 1;
      run(sim, 400, ctl);
      if (sim.hasFault()) failures++;
    }
    expect(failures).toBeGreaterThan(6);
  });
  it('un matériel neuf est fiable', () => {
    let failures = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const sim = new TrainSim(train('d_renard', 6, 'open_new', 30, 1), seed, {}, flat);
      const ctl = defaultControls(); ctl.brake = 0; ctl.throttle = 1;
      run(sim, 400, ctl);
      if (sim.hasFault()) failures++;
    }
    expect(failures).toBe(0);
  });
  it('les freins chauffent en longue descente', () => {
    const sim = new TrainSim(train('d_renard', 12), 1, {}, hill(-0.025));
    sim.v = 15;
    const ctl = defaultControls(); ctl.throttle = 0; ctl.brake = 0.35;
    run(sim, 120, ctl, dry, () => { ctl.brake = sim.v > 15 ? 0.45 : 0.0; });
    expect(sim.brakeTempAvg).toBeGreaterThan(90);
  });
});
