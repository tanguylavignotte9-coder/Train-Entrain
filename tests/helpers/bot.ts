import type { Trip } from '../../src/game/trip';

/** Pilote de test : régulation de vitesse simple (anticipation des limites, signaux, arrêt en gare). */
export function drive(trip: Trip, maxSec = 2400) {
  const sim = trip.sim, ctl = trip.ctl; let stuck = 0; 
  for (let i = 0; i < maxSec * 20 && trip.status === 'running'; i++) {
    let lim = trip.currentLimit() - 1.5;
    for (let d = 40; d <= 2600; d += 40) lim = Math.min(lim, Math.sqrt((trip.currentLimit(sim.s + d) - 1.5) ** 2 + 2 * 0.4 * d));
    trip.whistle(trip.route.features.some(f => f.kind === 'crossing' && f.s - sim.s > 80 && f.s - sim.s < 600));
    const dStop = trip.distToStop();
    const vStop = Math.sqrt(Math.max(0, 2 * 0.35 * (dStop - 4)));
    let target = Math.min(lim, vStop, sim.maxSpeedAllowed - 1);
    const red = trip.nextRedSignal();
    if (red !== null) target = Math.min(target, Math.sqrt(Math.max(0, 2 * 0.22 * (red - 25))));
    if (dStop < 60) target = Math.min(target, Math.max(0.0, dStop * 0.12));
    ctl.cutoff = sim.v < 14 ? 0.65 : 0.4; ctl.blower = false;
    const err = target - sim.v;
    if (err > 0.5 && !(red !== null && red < 30)) { ctl.brake = 0; ctl.throttle = Math.min(1, err * 0.3 + 0.2); }
    else if (err < -0.6) { ctl.throttle = 0; ctl.brake = Math.min(1, -err * 0.3 + 0.15); }
    else { ctl.throttle = Math.max(0, 0.15 + err * 0.1); ctl.brake = 0; }
    if (target < 0.4 && dStop < 8) { ctl.throttle = 0; ctl.brake = 0.9; }
    if (target < 0.6 && sim.v < 0.3 && dStop > 50 && red === null) { ctl.brake = 0; ctl.throttle = 0.3; }
    if (red !== null && red < 80 && sim.v < 4) { ctl.throttle = 0; ctl.brake = 0.8; }
    if (sim.steam) { ctl.shovel = sim.steam.bed < 100; ctl.injector = sim.steam.level < 0.5; }
    ctl.sand = sim.slipping || sim.v < 9; if (sim.slipping && sim.v < 9) ctl.throttle *= 0.7;
    if (sim.diesel || sim.electric) { ctl.dyn = sim.brakeP < 0.1 && err < -1 ? 0.8 : 0; }
    if (Math.abs(sim.v) < 0.3 && dStop > 100 && !(red !== null)) stuck += 0.05; else stuck = Math.max(0, stuck - 0.05);
    if (stuck > 45 || sim.v < -8) trip.callTow();
    trip.update(0.05);
    if (trip.disabled) { if (trip.startFieldRepair() !== '') trip.callTow(); }
  }
}
