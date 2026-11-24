import { Rng, hashInts, hashString } from '../core/rng';
import { clamp } from '../core/util';
import { eraAt, goodById, wagonById, locoById, expectations, type WagonDef } from '../data';
import { TrainSim, defaultControls, type Controls, type Env, type TrackAccess, type Unit } from '../sim/train';
import { weatherAt, daylight, dateOf, type Weather } from '../sim/weather';
import {
  buildRoute, routeCurv, routeElectrified, routeGrade, routeLimit, routeTunnel, routeElev, routeEdgeIndex, type Route, type Feature, type LoopInfo,
} from '../world/track';
import { slowEdges } from '../economy/economy';
import { edgeElectrified, yearNow, inflationAt, type Contract, type Game } from './state';

export interface Toast { id: number; t: number; text: string; kind: 'info' | 'warn' | 'bad' | 'good' }
export interface Fine { label: string; amount: number }
export type TripStatus = 'running' | 'arrived' | 'towed' | 'wrecked';

export interface TripResult {
  status: TripStatus; timeSec: number; targetSec: number; stopError: number; bufferSpeed: number; comfort: number; cargoCondition: number;
  fines: Fine[]; breakdowns: number; accidents: number; energyCost: number; towFee: number; rentCost: number; loaded: number; contract: Contract;
}

export interface CrossingState { f: Feature; car: boolean; cleared: boolean; hit: boolean; }

export class Trip {
  g: Game; contract: Contract; route: Route; sim: TrainSim; ctl: Controls = defaultControls();
  units: Unit[]; rented: Unit[]; rentCost: number; loaded: number;
  weather: Weather; weatherTimer = 0; hour: number; time = 0; status: TripStatus = 'running';
  toasts: Toast[] = []; private toastId = 1;
  fines: Fine[] = []; accidents = 0; breakdowns = 0; spadDone = new Set<number>();
  crossings: CrossingState[] = []; whistleT = -99; whistleHeld = false;
  overspeedT = 0; overspeedFines = 0; stoppedT = 0; paused = false;
  repairProgress = 0; repairing = false; repairFailed = 0; towRequested = false;
  stopError = 0; bufferSpeed = 0; acc = 0; arrivedAt = 0;
  comfortBase: number; rng: Rng; seed: number;
  pnjHit = false; fieldRepairs = 0; wasStopped = false; startedAt: number;
  eraLimit: number; energyKWh0 = 0;
  lat: number; maxSpeedReached = 0; lastWarn: Record<string, number> = {};
  curveWarned = false;

  constructor(g: Game, contract: Contract, units: Unit[], rented: Unit[], rentCost: number, loaded: number) {
    this.g = g; this.contract = contract; this.units = units; this.rented = rented; this.rentCost = rentCost; this.loaded = loaded;
    const s = g.state, w = g.world;
    const year = yearNow(s);
    this.eraLimit = eraAt(year).lineSpeedKmh;
    this.seed = hashInts(hashString(s.seed), Math.floor(s.day), contract.edges.length * 31 + contract.from);
    this.rng = new Rng(this.seed);
    const slow = slowEdges(s.eco);
    const trainLen = units.reduce((a, u) => a + (u.kind === 'loco' ? locoById(u.defId).lengthM : wagonById(u.defId).lengthM) + 0.5, 0);
    this.route = buildRoute(w, contract.cities, contract.edges, { trainLength: trainLen, year, seed: s.seed, day: Math.floor(s.day), electrifiedOf: e => edgeElectrified(s, e), slowKmh: e => slow.get(e.id) }, this.eraLimit);
    const r = this.route;
    const track: TrackAccess = {
      grade: p => routeGrade(r, p), curv: p => routeCurv(r, p), electrified: p => routeElectrified(r, p), tunnel: p => routeTunnel(r, p),
      neutral: p => r.features.some(f => f.kind === 'neutral' && p >= f.s && p <= f.s + (f.len ?? 0)),
    };
    const loco = units[0];
    const d = locoById(loco.defId);
    const cap = 1 + 0.2 * (loco.upgrades.capacity ?? 0);
    this.sim = new TrainSim(units, this.seed ^ 0x5bd1e995, {
      coalKg: d.steam ? (loco.fuel ?? 1) * d.steam.coalKg * cap : undefined, waterKg: d.steam ? (loco.water ?? 1) * d.steam.waterKg * cap : undefined,
      fuelL: d.diesel ? (loco.fuel ?? 1) * d.diesel.fuelL * cap : d.electric?.fuelL ? (loco.fuel ?? 1) * d.electric.fuelL * cap : undefined,
    }, track);
    this.sim.s = r.startFront;
    this.sim.v = 0;
    this.sim.brakeP = 0.35;
    this.hour = this.rng.range(6.5, 16.5);
    this.lat = w.cities[contract.from].y / w.size;
    this.weather = this.computeWeather();
    this.startedAt = s.day;
    this.energyKWh0 = this.sim.electric?.energyKWh ?? 0;
    // passages à niveau
    for (const f of r.features) if (f.kind === 'crossing') this.crossings.push({ f, car: !!f.data?.car, cleared: false, hit: false });
    // coef. de confort des voitures
    const coaches = units.filter(u => u.kind === 'wagon' && wagonById(u.defId).type === 'coach');
    this.comfortBase = coaches.length ? coaches.reduce((a, u) => a + wagonById(u.defId).comfort + 0.08 * (u.upgrades.comfort ?? 0), 0) / coaches.length : 0.5;
    this.toast(`Départ de ${w.cities[contract.from].name}. Desserrez le frein (→) puis ajoutez de la traction (W).`, 'info');
  }

  get elapsed() { return this.time; }
  get gridElev() { return routeElev(this.route, this.sim.s); }
  toast(text: string, kind: Toast['kind'] = 'info') {
    this.toasts.push({ id: this.toastId++, t: this.time, text, kind });
    if (this.toasts.length > 6) this.toasts.shift();
  }

  private computeWeather(): Weather {
    const s = this.g.state;
    const elev = routeElev(this.route, this.sim?.s ?? this.route.startFront);
    const dayNum = Math.floor(s.day);
    return weatherAt(s.seed, dayNum, this.time, this.hour % 24, elev, this.lat);
  }
  get light() { const d = dateOf(this.g.state.startYear, this.g.state.day); return daylight(this.hour % 24, d.doy); }

  env(): Env {
    const w = this.weather;
    return { tempC: w.tempC, headwind: w.headwind(1), grip: w.grip, wet: w.wet, precip: w.precip };
  }

  whistle(on: boolean) {
    if (on && !this.whistleHeld) this.whistleT = this.time;
    this.whistleHeld = on;
  }

  // ---------- signaux et trafic adverse ----------
  loopSignalRed(i: number): boolean {
    const L = this.route.loops[i];
    if (!L.pnj) return false;
    return this.pnjPos(L) > L.entryS - 100;
  }
  pnjPos(L: LoopInfo): number {
    if (this.time < L.spawnT) return L.spawnS + (L.spawnT - this.time) * L.pnjSpeed;
    return L.spawnS - L.pnjSpeed * (this.time - L.spawnT);
  }
  signalAspect(f: Feature): 'green' | 'yellow' | 'red' {
    if (f.kind === 'signal' && f.data?.loop !== undefined) return this.loopSignalRed(f.data.loop as number) ? 'red' : 'green';
    if (f.kind === 'distant' && f.data?.loop !== undefined) return this.loopSignalRed(f.data.loop as number) ? 'yellow' : 'green';
    return 'green';
  }
  /** Prochain signal fermé en vue (m) ou null. */
  nextRedSignal(): number | null {
    const sFront = this.sim.s;
    for (const f of this.route.features) {
      if (f.kind === 'signal' && f.s > sFront - 2 && f.s - sFront < eraAt(yearNow(this.g.state)).signalSight + 200 && this.signalAspect(f) === 'red') return f.s - sFront;
    }
    return null;
  }

  currentLimit(s = this.sim.s): number { return routeLimit(this.route, s); }
  nextLimit(): { v: number; dist: number } | null {
    const r = this.route, s0 = this.sim.s;
    const cur = this.currentLimit(s0);
    for (let d = 30; d < 1800; d += 30) { const v = this.currentLimit(s0 + d); if (v < cur - 0.5) return { v, dist: d }; }
    return null;
  }
  distToStop(): number { return this.route.stopS - this.sim.s; }

  // ---------- boucle ----------
  update(dt: number) {
    if (this.status !== 'running' || this.paused) return;
    dt = Math.min(dt, 0.1);
    this.acc += dt;
    let guard = 0;
    while (this.acc >= 1 / 60 && guard++ < 8) { this.acc -= 1 / 60; this.fixedStep(1 / 60); if (this.status !== 'running') break; }
    this.toasts = this.toasts.filter(t => this.time - t.t < 9);
  }

  private fixedStep(dt: number) {
    const sim = this.sim, r = this.route;
    this.time += dt; this.hour += dt / 45;
    this.weatherTimer += dt;
    if (this.weatherTimer > 2) { this.weatherTimer = 0; this.weather = this.computeWeather(); }
    // réparation sur place
    if (this.repairing) {
      if (sim.v < 0.3) { this.repairProgress += dt / 22; if (this.repairProgress >= 1) { this.repairing = false; this.repairProgress = 0; this.finishFieldRepair(); } }
      else this.repairing = false;
    }
    const ctl = this.ctl;
    if (this.repairing) { ctl.throttle = 0; ctl.brake = 1; }
    sim.step(dt, ctl, this.env());
    for (const ev of sim.events) {
      if (ev.type === 'shovel') continue;
      this.toast(ev.msg, ev.severity === 'bad' ? 'bad' : ev.severity === 'warn' ? 'warn' : 'info');
      if (ev.type === 'failure') { this.breakdowns++; this.g.state.stats.breakdowns++; }
    }
    this.maxSpeedReached = Math.max(this.maxSpeedReached, sim.v);
    this.checkLimits(dt);
    this.checkSignals();
    this.checkCrossings();
    this.checkEnd(dt);
  }

  private fine(label: string, amount: number) { amount = Math.round(amount * inflationAt(yearNow(this.g.state))); this.fines.push({ label, amount }); this.toast(`Amende : ${label} (${amount} Cr)`, 'bad'); }

  private checkLimits(dt: number) {
    const sim = this.sim;
    const v = sim.v, lim = Math.min(this.currentLimit(), sim.maxSpeedAllowed);
    const curvLimit = this.currentLimit(sim.s - sim.length / 2);
    // déraillement : vitesse excessive en courbe
    const kc = Math.abs(routeCurv(this.route, sim.s - sim.length / 4));
    if (kc > 1e-6) {
      const posted = Math.sqrt((0.85 + 0.45 * clamp((yearNow(this.g.state) - 1905) / 115, 0, 1)) / kc);
      if (v > posted * 1.42 && v > 5) {
        this.accidents++; this.fine('Déraillement en courbe', 6000); this.toast('Déraillement ! Le train est sorti des rails.', 'bad'); this.wreck(); return;
      }
      if (v > posted * 1.12 && !this.curveWarned) { this.curveWarned = true; this.toast('Vitesse excessive en courbe : ralentissez !', 'warn'); }
      if (v < posted) this.curveWarned = false;
    }
    void curvLimit;
    if (v > lim * 1.06 + 0.8) {
      this.overspeedT += dt;
      if (this.overspeedT > 6 && this.overspeedFines < 3) { this.overspeedT = 0; this.overspeedFines++; this.fine('Excès de vitesse', 120); }
      else if (this.overspeedT > 0.5 && this.time - (this.lastWarn.over ?? -99) > 8) { this.lastWarn.over = this.time; this.toast(`Limitation à ${Math.round(lim * 3.6)} km/h dépassée.`, 'warn'); }
    } else this.overspeedT = Math.max(0, this.overspeedT - dt);
  }

  private retimed = new Set<number>();
  private checkSignals() {
    const sim = this.sim, r = this.route;
    // le trafic adverse est recalé pour que le croisement ait bien lieu à l'arrivée du joueur
    r.loops.forEach((L, i) => {
      if (this.retimed.has(i) || sim.s < L.distantS) return;
      this.retimed.add(i);
      if (!L.pnj) return;
      const tPlayer = (L.signalS - sim.s) / Math.max(sim.v, 9);
      const tClear = this.time + tPlayer + this.rng.range(-4, 40);
      // le train adverse libère la boucle (position entryS - 100) à l'instant tClear
      L.spawnT = tClear - (L.spawnS - (L.entryS - 100)) / L.pnjSpeed;
      if (L.spawnT < this.time - 1) { L.spawnT = this.time - 1; }
    });
    r.loops.forEach((L, i) => {
      if (this.spadDone.has(i)) return;
      if (sim.s > L.signalS && this.loopSignalRedAt(i)) {
        this.spadDone.add(i);
        this.fine('Signal franchi à l’arrêt', 400);
        this.accidents++;
        this.toast('Vous avez franchi un signal fermé !', 'bad');
      }
    });
    // collision avec le train adverse (seulement si signal franchi)
    r.loops.forEach((L, i) => {
      if (!L.pnj || !this.spadDone.has(i) || this.pnjHit) return;
      const p = this.pnjPos(L);
      if (this.time >= L.spawnT && Math.abs(p - sim.s) < 22 && sim.s > L.signalS + 25) {
        this.pnjHit = true; this.accidents++;
        this.fine('Collision avec un train adverse', 4500);
        this.toast('COLLISION ! Les deux trains se sont percutés.', 'bad');
        this.wreck();
      }
    });
  }
  private redLog = new Map<number, boolean>();
  private loopSignalRedAt(i: number): boolean {
    // l'état du signal est évalué à l'approche : on mémorise s'il était fermé quand le train s'est trouvé à moins de 60 m
    const L = this.route.loops[i];
    const prev = this.redLog.get(i);
    if (this.sim.s > L.signalS - 60 && prev === undefined) this.redLog.set(i, this.loopSignalRed(i));
    return this.redLog.get(i) === true && this.loopSignalRed(i);
  }

  private checkCrossings() {
    const sim = this.sim;
    const hornWindow = (c: CrossingState) => this.whistleT > -50 && this.whistleT > this.time - 40 && c.f.s - sim.s < 750;
    for (const c of this.crossings) {
      if (c.cleared || c.hit) continue;
      const d = c.f.s - sim.s;
      if (c.car && d < 750 && d > -sim.length && (this.whistleHeld || hornWindow(c)) && d > 60) { c.cleared = true; }
      if (c.car && d < 4 && d > -4) {
        if (sim.v > 4) { c.hit = true; this.accidents++; this.fine('Collision à un passage à niveau', 1500); this.toast('Un véhicule engagé sur le passage à niveau a été percuté !', 'bad'); sim.cargoShock += 0.15; this.g.state.reputation = clamp(this.g.state.reputation - 1, 0, 100); }
      }
      if (c.car && !c.cleared && d < 250 && d > 120 && sim.v > 6 && this.time - (this.lastWarn.pn ?? -99) > 12) { this.lastWarn.pn = this.time; this.toast('Un véhicule est sur le passage à niveau : sifflez (H) !', 'warn'); }
    }
  }

  private wreck() { this.status = 'wrecked'; this.sim.v = 0; this.sim.derailed = true; }

  private checkEnd(dt: number) {
    const sim = this.sim, r = this.route;
    // heurtoir
    if (sim.s > r.bufferS - 4) {
      const vi = Math.max(0, sim.v);
      this.bufferSpeed = vi;
      sim.s = r.bufferS - 4; sim.v = 0;
      if (vi > 1.2) { sim.cargoShock += vi * 0.03; for (const veh of sim.vehicles) veh.unit.cond.couplings = Math.max(0, veh.unit.cond.couplings - vi * 0.02); }
      if (vi > 2.5) { this.accidents++; this.fine('Choc contre le heurtoir', Math.round(300 + vi * 150)); }
      if (vi > 6) { this.accidents++; this.toast('Le train a défoncé le heurtoir !', 'bad'); this.fine('Déraillement au terminus', 3500); this.wreck(); return; }
    }
    if (sim.v === 0 || Math.abs(sim.v) < 0.05) this.stoppedT += dt; else this.stoppedT = 0;
    const front = sim.s;
    if (this.stoppedT > 1.8 && front > r.stopS - 55 && !sim.hasFault() ) {
      this.stopError = front - r.stopS;
      this.status = 'arrived'; this.arrivedAt = this.time;
      return;
    }
    if (this.stoppedT > 1.8 && front > r.stopS - 55 && sim.hasFault() && (sim.faults.speedCap > 3 || sim.faults.powerMul >= 0.5)) {
      this.stopError = front - r.stopS; this.status = 'arrived'; this.arrivedAt = this.time; return;
    }
    if (this.time - this.arrivedAt > 0 && this.status === 'running' && sim.v < 0.05 && this.stoppedT > 25 && !this.sim.hasFault() && front < r.stopS - 55 && this.time - (this.lastWarn.hint ?? -99) > 40) {
      this.lastWarn.hint = this.time; this.toast('Avancez jusqu’au quai : le train doit s’arrêter près du repère d’arrêt.', 'info');
    }
  }

  // ---------- pannes ----------
  get disabled(): boolean {
    const sim = this.sim;
    return sim.v < 0.3 && (sim.faults.stalled || sim.faults.couplingBroken || sim.faults.speedCap <= 3.01 || (sim.faults.powerMul === 0));
  }
  startFieldRepair(): string {
    const s = this.g.state;
    if (this.sim.v > 0.3) return 'Arrêtez d’abord le train.';
    if (!this.sim.hasFault()) return 'Rien à réparer.';
    if (s.parts < 1) return 'Aucune pièce de rechange : appelez le dépanneur.';
    s.parts -= 1; this.repairing = true; this.repairProgress = 0; this.fieldRepairs++;
    this.toast('Réparation de fortune en cours…', 'info');
    return '';
  }
  private finishFieldRepair() {
    if (this.sim.fieldRepair()) { this.toast('Réparation de fortune réussie : vous pouvez repartir prudemment.', 'good'); this.repairFailed = 0; }
    else { this.repairFailed++; this.toast('La réparation a échoué. Réessayez ou appelez le dépanneur.', 'bad'); }
  }
  callTow() {
    if (this.status !== 'running') return;
    this.towRequested = true; this.status = 'towed';
    this.toast('Le dépanneur remorque votre train jusqu’à destination.', 'info');
  }
  abandon() { this.callTow(); }

  // ---------- bilan ----------
  result(): TripResult {
    const sim = this.sim;
    const tonnes = this.loaded;
    const c = this.contract;
    // état des marchandises
    let cargo = 1;
    if (c.kind === 'freight' && c.goodId) {
      const gd = goodById(c.goodId);
      const late = Math.max(0, this.time / c.targetSec - 1);
      const reefer = this.units.some(u => u.kind === 'wagon' && wagonById(u.defId).type === 'reefer' && wagonById(u.defId).id.includes('new'));
      cargo = 1 - clamp(gd.fragility * sim.cargoShock * 1.6, 0, 0.8) - clamp(gd.perish * (0.04 + 0.5 * late) * (reefer ? 0.4 : 1), 0, 0.9);
    } else if (c.kind === 'mail') cargo = 1 - clamp(sim.cargoShock * 0.25, 0, 0.5);
    cargo = clamp(cargo, 0.05, 1);
    const ridePenalty = clamp(sim.discomfort / Math.max(60, this.time * 0.05 + 30) * 0.5, 0, 0.5);
    const comfort = clamp(this.comfortBase - ridePenalty, 0, 1);
    const eKWh = (sim.electric?.energyKWh ?? 0) - this.energyKWh0;
    const kind = sim.steam ? 0 : 0;
    void kind;
    return {
      status: this.status, timeSec: this.time, targetSec: c.targetSec, stopError: this.stopError, bufferSpeed: this.bufferSpeed, comfort, cargoCondition: cargo,
      fines: this.fines, breakdowns: this.breakdowns, accidents: this.accidents, energyCost: Math.round(eKWh * 0.06 * inflationAt(yearNow(this.g.state))), towFee: this.towRequested || this.status === 'wrecked' ? Math.round((700 + c.lengthM * 0.06) * inflationAt(yearNow(this.g.state))) : 0,
      rentCost: this.rentCost, loaded: tonnes, contract: c,
    };
  }
}

export function weatherDescription(w: Weather): string {
  const k = { clear: 'Dégagé', cloud: 'Nuageux', rain: 'Pluie', snow: 'Neige', fog: 'Brouillard' }[w.kind];
  return `${k} · ${Math.round(w.tempC)} °C · vent ${Math.round(w.windMs * 3.6)} km/h`;
}
export { expectations };
export type { WagonDef };
