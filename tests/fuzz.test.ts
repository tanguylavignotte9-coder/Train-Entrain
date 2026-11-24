import { describe, it, expect } from 'vitest';
import { LOCOS } from '../src/data';
import { TrainSim, defaultControls, type TrackAccess } from '../src/sim/train';
import { makeUnit } from '../src/sim/units';
import { Rng } from '../src/core/rng';

/** Commandes aléatoires sur toutes les locomotives : aucune valeur non finie, bornes respectées. */
describe('robustesse numérique', () => {
  for (const l of LOCOS) {
    it(`commandes aléatoires — ${l.id}`, () => {
      const rng = new Rng(l.id);
      const track: TrackAccess = {
        grade: s => 0.02 * Math.sin(s / 700), curv: s => (Math.sin(s / 300) > 0.7 ? 1 / 400 : 0), electrified: s => s % 5000 < 3500, tunnel: s => s % 3000 < 200, neutral: s => s % 5000 > 3400 && s % 5000 < 3550,
      };
      const units = [makeUnit(1, l.id, 'loco', rng.range(0.1, 1))];
      for (let i = 0; i < 8; i++) { const w = makeUnit(2 + i, i % 2 ? 'cov_new' : 'c2_acier', 'wagon', rng.range(0.1, 1)); w.loadT = 10; units.push(w); }
      const sim = new TrainSim(units, 7, {}, track);
      const c = defaultControls();
      const envs = [{ tempC: 15, headwind: 0, grip: 1, wet: false, precip: 0 }, { tempC: -5, headwind: 8, grip: 0.4, wet: true, precip: 0.8 }];
      for (let i = 0; i < 60 * 300; i++) {
        if (i % 120 === 0) { c.throttle = rng.next(); c.brake = rng.chance(0.4) ? rng.next() : 0; c.emergency = rng.chance(0.03); c.dyn = rng.next(); c.cutoff = rng.range(0.12, 0.75); c.injector = rng.chance(0.5); c.blower = rng.chance(0.2); c.sand = rng.chance(0.3); c.shovel = rng.chance(0.5); c.pantograph = rng.chance(0.85); }
        sim.step(1 / 60, c, envs[(i / 3600 | 0) % 2]);
        if (i % 600 === 0) {
          for (const v of [sim.s, sim.v, sim.a, sim.brakeP, sim.brakeTempAvg, sim.tractionN]) expect(Number.isFinite(v)).toBe(true);
          for (const u of units) for (const k of Object.values(u.cond)) { expect(k).toBeGreaterThanOrEqual(0); expect(k).toBeLessThanOrEqual(1); }
          if (sim.steam) { expect(sim.steam.pressure).toBeGreaterThanOrEqual(0); expect(sim.steam.level).toBeLessThanOrEqual(1); }
          expect(Math.abs(sim.v)).toBeLessThan(120);
        }
      }
    });
  }
});
