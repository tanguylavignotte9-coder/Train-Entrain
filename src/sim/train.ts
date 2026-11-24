import { Rng } from '../core/rng';
import { clamp, G, lerp } from '../core/util';
import { locoById, wagonById, PART_DEFS, type LocoDef, type WagonDef } from '../data';

export const PARTS = ['wheels', 'axles', 'brakes', 'powerplant', 'lubrication', 'couplings'] as const;
export type Part = typeof PARTS[number];
export type Cond = Record<Part, number>;
export const PART_NAMES = Object.fromEntries(PARTS.map(p => [p, PART_DEFS[p].name])) as Record<Part, string>;
export function partName(p: Part, traction?: string): string {
  return (traction && PART_DEFS[p].names?.[traction]) || PART_DEFS[p].name;
}
export const newCond = (v = 1): Cond => ({ wheels: v, axles: v, brakes: v, powerplant: v, lubrication: v, couplings: v });

/** Matériel de la flotte (état persistant). */
export interface Unit {
  uid: number; defId: string; kind: 'loco' | 'wagon'; cond: Cond; upgrades: Record<string, number>;
  km: number; inspectedKm: number | null; inspectedDay: number | null; loadT: number; cargo?: string;
  rented?: boolean; fuel?: number; water?: number;
}

export interface Controls {
  throttle: number; brake: number; emergency: boolean; dyn: number; cutoff: number;
  injector: boolean; blower: boolean; sand: boolean; pantograph: boolean; shovel: boolean;
}
export const defaultControls = (): Controls => ({ throttle: 0, brake: 0.35, emergency: false, dyn: 0, cutoff: 0.45, injector: false, blower: false, sand: false, pantograph: true, shovel: false });

export interface Env { tempC: number; headwind: number; grip: number; wet: boolean; precip: number }
export interface TrackAccess {
  grade(s: number): number; curv(s: number): number; electrified(s: number): boolean; tunnel(s: number): boolean; neutral(s: number): boolean;
}
export interface SimEvent { t: number; type: string; msg: string; severity: 'info' | 'warn' | 'bad'; part?: Part; vehicle?: number }

export interface SimVehicle {
  unit: Unit; def: LocoDef | WagonDef; isLoco: boolean; massT: number; lengthM: number; offset: number; // m depuis l'avant de la rame
  brakeNpt: number; couplingKN: number; maxSpeed: number;
  brakeFault: number; wheelFault: boolean; hotbox: boolean; brakeTemp: number;
}

export interface SteamState { pressure: number; level: number; bed: number; coal: number; water: number; venting: boolean; shovelCd: number; injFlow: number; steamUse: number; steamGen: number; coalTotal: number; waterTotal: number }
export interface DieselState { pf: number; temp: number; fuel: number; fuelCap: number; stalled: boolean }
export interface ElectricState { pf: number; temp: number; voltage: number; pantoUp: boolean; fuel: number; energyKWh: number; regenKWh: number; powered: boolean; arc: number }

const STEAM_PER_COAL = 6.5;
const ETA = 0.88;

export class TrainSim {
  vehicles: SimVehicle[] = [];
  loco: SimVehicle; locoDef: LocoDef;
  s = 0; v = 0; t = 0; dist = 0; a = 0; jerk = 0;
  brakeP = 0; brakeTempAvg = 20;
  slipping = false; skidding = false; slipTimer = 0;
  sand = 1;
  steam?: SteamState; diesel?: DieselState; electric?: ElectricState;
  events: SimEvent[] = [];
  faults = { powerMul: 1, speedCap: Infinity as number, stalled: false, couplingBroken: false, coupling: -1, brakeLoss: false };
  discomfort = 0; cargoShock = 0; brakeEnergy = 0; hardBrakes = 0; energyUsed = 0;
  powerNow = 0; tractionN = 0; brakeN = 0; speedCapReason = '';
  private rng: Rng;
  private failTimer = 0;
  private prevA = 0;
  private lengthTotal = 0;
  private massKg = 0;
  repairing = 0; derailed = false;

  constructor(units: Unit[], seed: number, init: { coalKg?: number; waterKg?: number; fuelL?: number } = {}, public track: TrackAccess) {
    this.rng = new Rng(seed);
    let off = 0;
    for (const u of units) {
      const isLoco = u.kind === 'loco';
      const def = isLoco ? locoById(u.defId) : wagonById(u.defId);
      const massT = isLoco ? (def as LocoDef).massT : (def as WagonDef).tareT + u.loadT;
      const sv: SimVehicle = {
        unit: u, def, isLoco, massT, lengthM: def.lengthM, offset: off, brakeNpt: def.brakeNpt, couplingKN: isLoco ? (def as LocoDef).coupling : (def as WagonDef).coupling,
        maxSpeed: (isLoco ? (def as LocoDef).maxSpeedKmh : (def as WagonDef).maxSpeedKmh) / 3.6, brakeFault: 1, wheelFault: false, hotbox: false, brakeTemp: 20,
      };
      off += def.lengthM + 0.5; this.vehicles.push(sv);
    }
    this.lengthTotal = off;
    this.loco = this.vehicles[0];
    this.locoDef = this.loco.def as LocoDef;
    this.massKg = this.vehicles.reduce((a, v) => a + v.massT, 0) * 1000;
    const L = this.locoDef;
    const capUp = 1 + 0.2 * (this.loco.unit.upgrades.capacity ?? 0);
    if (L.traction === 'steam' && L.steam) {
      const st = L.steam;
      this.steam = {
        pressure: st.pBar * 0.88, level: 0.6, bed: st.bedOptKg * 0.9, coal: Math.min(init.coalKg ?? st.coalKg * capUp, st.coalKg * capUp), water: Math.min(init.waterKg ?? st.waterKg * capUp, st.waterKg * capUp),
        venting: false, shovelCd: 0, injFlow: 0, steamUse: 0, steamGen: 0, coalTotal: st.coalKg * capUp, waterTotal: st.waterKg * capUp,
      };
    } else if (L.traction === 'diesel' && L.diesel) {
      const cap = L.diesel.fuelL * capUp;
      this.diesel = { pf: 0, temp: 70, fuel: Math.min(init.fuelL ?? cap, cap), fuelCap: cap, stalled: false };
    } else {
      const cap = (L.electric?.fuelL ?? 0) * capUp;
      this.electric = { pf: 0, temp: 40, voltage: L.electric?.voltage ?? 1500, pantoUp: true, fuel: Math.min(init.fuelL ?? cap, cap), energyKWh: 0, regenKWh: 0, powered: true, arc: 0 };
    }
  }

  get length(): number { return this.lengthTotal; }
  get totalMassT(): number { return this.massKg / 1000; }
  get fuelFraction(): number {
    if (this.steam) return Math.min(this.steam.coal / this.steam.coalTotal, this.steam.water / this.steam.waterTotal);
    if (this.diesel) return this.diesel.fuel / this.diesel.fuelCap;
    return 1;
  }
  private emit(type: string, msg: string, severity: SimEvent['severity'], part?: Part, vehicle?: number) {
    this.events.push({ t: this.t, type, msg, severity, part, vehicle });
  }
  private upg(name: string): number { return this.loco.unit.upgrades[name] ?? 0; }

  /** Facteur de performance du groupe motopropulseur selon l'usure. */
  powerPerf(): number {
    const c = this.loco.unit.cond.powerplant;
    return (0.55 + 0.45 * clamp(c / 0.7, 0, 1)) * (1 + 0.08 * this.upg('engine')) * this.faults.powerMul;
  }

  step(dt: number, ctl: Controls, env: Env): void {
    this.events.length = 0;
    this.t += dt;
    const L = this.locoDef, trk = this.track;
    const v = this.v;
    const absV = Math.abs(v);
    const nVeh = this.vehicles.length;
    const locoS = this.s;
    const throttle = this.faults.stalled || this.faults.couplingBroken ? 0 : ctl.throttle;

    // ---------- Traction ----------
    let F = 0; // N, positif = vers l'avant
    let adhesionBase = L.traction === 'steam' ? 0.27 : 0.31;
    const wd = L.drivingMassT * 1000 * G; // poids adhérent
    const sandingOn = ctl.sand && this.sand > 0;
    if (sandingOn) this.sand = Math.max(0, this.sand - dt * 0.004);
    const mu = adhesionBase * env.grip + (sandingOn ? 0.09 * (0.5 + 0.5 * (1 - env.grip + 0.4)) : 0);
    const perf = this.powerPerf();
    let tractionDemand = 0;
    let powerW = 0;

    if (this.steam) {
      F = this.stepSteam(dt, ctl, env, throttle, absV, perf);
      tractionDemand = F;
    } else if (this.diesel) {
      const d = this.diesel;
      const target = (d.fuel > 0 && !d.stalled) ? throttle : 0;
      const tau = target > d.pf ? 2.6 : 0.8;
      d.pf += (target - d.pf) * Math.min(1, dt / tau);
      const derate = d.temp > 105 ? clamp(1 - (d.temp - 105) / 18, 0.2, 1) : 1;
      const P = L.powerKW * 1000 * perf * derate;
      const taper = clamp((L.maxSpeedKmh / 3.6 * 1.03 - absV) / (L.maxSpeedKmh / 3.6 * 0.1), 0, 1);
      F = Math.min(L.maxTEkN * 1000 * d.pf * perf * derate, ETA * P * d.pf / Math.max(absV, 0.4)) * taper;
      powerW = F * absV;
      d.fuel = Math.max(0, d.fuel - (P * d.pf / 1000) * 0.26 / 3600 * dt - 0.0008 * dt);
      if (d.fuel <= 0 && !d.stalled) { d.stalled = true; this.emit('fuel', 'Panne sèche : le moteur s’arrête.', 'bad'); }
      const loadF = d.pf * (L.powerKW > 0 ? 1 : 0);
      const wearPen = (1 - this.loco.unit.cond.powerplant) * 18 + (1 - this.loco.unit.cond.lubrication) * 8;
      const amb = env.tempC;
      const eq = amb + 52 + 46 * loadF * (1 - 0.5 * Math.min(1, absV / 15)) + wearPen;
      d.temp += (eq - d.temp) * Math.min(1, dt / 55);
      if (d.temp > 118) this.wear('powerplant', 0.0006 * dt, 'Surchauffe du moteur');
      if (d.temp > 128 && !d.stalled) { d.stalled = true; this.emit('overheat', 'Le moteur surchauffe et cale !', 'bad', 'powerplant'); }
      if (d.stalled && d.temp < 100 && d.fuel > 0) { d.stalled = false; this.emit('info', 'Moteur redémarré.', 'info'); }
      tractionDemand = F;
    } else if (this.electric) {
      const e = this.electric;
      const el = trk.electrified(locoS), neutral = trk.neutral(locoS);
      const bimode = L.electric?.bimodeKW ?? 0;
      e.pantoUp = ctl.pantograph;
      const live = e.pantoUp && el && !neutral;
      // tension : chute entre sous-stations
      const Vn = L.electric?.voltage ?? 1500;
      const sag = 0.10 * Math.pow(Math.sin(Math.PI * ((locoS % 9000) / 9000)), 2) + 0.12 * e.pf * (Vn < 3000 ? 1 : 0.4);
      e.voltage = live ? Vn * (1 - sag) * (env.wet && env.tempC < -3 ? 0.97 : 1) : 0;
      const vf = clamp((e.voltage / Vn - 0.62) / 0.3, 0, 1);
      let Pmax = 0;
      if (live) Pmax = L.powerKW * 1000 * perf * vf;
      else if (bimode > 0 && e.fuel > 0) Pmax = bimode * 1000 * perf;
      e.powered = live || (bimode > 0 && e.fuel > 0);
      if (!live && neutral && throttle > 0.1) { e.arc += dt; if (e.arc > 1.5) { this.wear('powerplant', 0.002, 'Arc électrique'); this.emit('arc', 'Arc au pantographe : coupez la traction en zone neutre !', 'warn'); e.arc = 0; } }
      const target = Pmax > 0 ? throttle : 0;
      e.pf += (target - e.pf) * Math.min(1, dt / (target > e.pf ? 0.9 : 0.4));
      const taper = clamp((L.maxSpeedKmh / 3.6 * 1.03 - absV) / (L.maxSpeedKmh / 3.6 * 0.1), 0, 1);
      const TEmax = L.maxTEkN * 1000 * (Pmax / (L.powerKW * 1000 || 1)) ** 0.5;
      F = Math.min((live ? L.maxTEkN * 1000 : TEmax * 0.6) * e.pf * perf, ETA * Pmax * e.pf / Math.max(absV, 0.4)) * taper;
      powerW = F * absV;
      if (live) e.energyKWh += powerW / 3.6e6 * dt;
      else if (e.powered && bimode > 0) e.fuel = Math.max(0, e.fuel - powerW / 1000 * 0.27 / 3600 * dt);
      const eq = env.tempC + 38 + 52 * e.pf * (1 - 0.5 * Math.min(1, absV / 15)) + (1 - this.loco.unit.cond.powerplant) * 20;
      e.temp += (eq - e.temp) * Math.min(1, dt / 70);
      if (e.temp > 125) this.wear('powerplant', 0.0005 * dt, 'Moteurs de traction en surchauffe');
      tractionDemand = F;
    }
    // adhérence
    const limit = mu * wd * (this.faults.stalled ? 0 : 1);
    if (F > limit) {
      if (!this.slipping) { this.slipping = true; if (absV < 8) this.emit('slip', 'Patinage ! Réduisez l’effort ou sablez.', 'warn'); }
      this.slipTimer = 0.6;
      F = limit * 0.72;
    } else if (this.slipping) {
      this.slipTimer -= dt;
      if (this.slipTimer <= 0 && F < limit * 0.85) this.slipping = false;
      else F = Math.min(F, limit * 0.8);
    }
    this.tractionN = F; this.powerNow = F * absV;
    if (this.slipping) this.wearAll('wheels', 0.0009 * dt, true, 0.5);

    // ---------- Résistances ----------
    let R = 0; let Rgrade = 0, Rcurve = 0;
    const wFactor = env.precip > 0.2 ? 1.18 : 1;
    const inTunnel = trk.tunnel(locoS);
    const vrel = v + env.headwind * 0.7;
    let Rwag = 0, Gwag = 0;
    this.vehicles.forEach((veh, i) => {
      const m = veh.massT, mid = locoS - veh.offset - veh.lengthM / 2;
      const lub = 1 + 0.7 * (1 - veh.unit.cond.lubrication) + (veh.hotbox ? 2.5 : 0);
      const whl = 1 + 0.5 * (1 - veh.unit.cond.wheels) + (veh.wheelFault ? 0.6 : 0);
      const A = 20 * m * lub * whl * wFactor * (absV < 0.5 ? 2.2 : 1);
      const B = 0.6 * m * lub * absV;
      const C = (i === 0 ? 6.0 : 1.2) * (inTunnel ? 1.6 : 1) * vrel * Math.abs(vrel);
      const dir = absV < 0.02 ? 0 : Math.sign(v);
      const grade = trk.grade(mid);
      const kc = trk.curv(mid), Rr = Math.abs(kc) > 1e-6 ? 1 / Math.abs(kc) : Infinity;
      const wc = Rr === Infinity ? 0 : (Rr >= 300 ? 650 / (Rr - 55) : 500 / (Rr - 30));
      const fc = m * G * wc / 1000 * (veh.hotbox ? 1 : 1);
      const fg = m * 1000 * G * grade / 1000 * 1000 / 1000; // m(t)*1000 kg * g * grade
      const gf = m * 1000 * G * grade;
      void fg;
      R += dir * (A + B) + C + dir * fc * 1;
      Rgrade += gf; Rcurve += dir * fc;
      if (i > 0) { Rwag += dir * (A + B) + C * 0 + dir * fc; Gwag += gf; }
    });

    // ---------- Freinage ----------
    const brakeTarget = ctl.emergency || this.faults.couplingBroken ? 1.25 : ctl.brake;
    const tauApply = (ctl.emergency || this.faults.couplingBroken ? 0.6 + 0.035 * nVeh : 1.1 + 0.11 * nVeh) / (1 + 0.1 * this.upg('brakes'));
    const tauRel = (2.6 + 0.2 * nVeh) / (1 + 0.1 * this.upg('brakes'));
    this.brakeP += (brakeTarget - this.brakeP) * Math.min(1, dt / (brakeTarget > this.brakeP ? tauApply : tauRel));
    let Fb = 0; this.skidding = false;
    const muB = 0.3 * env.grip * 0.95;
    let heat = 0;
    for (const veh of this.vehicles) {
      const fade = 1 - clamp((veh.brakeTemp - 230) / 260, 0, 0.75);
      const eff = lerp(0.35, 1, veh.unit.cond.brakes) * veh.brakeFault * (1 + 0.08 * (veh.unit.upgrades.brakes ?? this.upg('brakes') * (veh.isLoco ? 1 : 0))) * fade;
      let fb = veh.brakeNpt * veh.massT * this.brakeP * eff;
      const lim = muB * veh.massT * 1000 * G;
      if (fb > lim && absV > 1) { fb = lim * 0.8; this.skidding = true; }
      Fb += fb;
      const h = fb * absV;
      heat += h;
      // thermique par véhicule
      const Cth = 3000 * veh.massT;
      const kc = veh.massT * (5 + 0.4 * absV);
      veh.brakeTemp += ((h / (Cth)) - kc * (veh.brakeTemp - env.tempC) / Cth) * dt;
      veh.brakeTemp = Math.max(env.tempC, veh.brakeTemp);
      if (veh.brakeTemp > 430) veh.unit.cond.brakes = Math.max(0, veh.unit.cond.brakes - 0.0007 * dt);
    }
    this.brakeEnergy += heat * dt;
    if (heat > 0) { const per = heat * dt * 8e-12; for (const veh of this.vehicles) veh.unit.cond.brakes = Math.max(0, veh.unit.cond.brakes - per * veh.massT / (this.massKg / 1000)); }
    this.brakeTempAvg = this.vehicles.reduce((a, x) => a + x.brakeTemp, 0) / nVeh;
    if (this.skidding) { this.wearAll('wheels', 0.0018 * dt, true, 0.6); if (!this.events.some(e => e.type === 'skid')) this.emit('skid', 'Enrayage des roues : freinage trop brutal sur rail glissant.', 'warn'); }
    // frein dynamique
    let Fdyn = 0;
    if (L.dynBrakeKN > 0 && ctl.dyn > 0 && !this.faults.stalled) {
      const cap = L.dynBrakeKN * 1000 * ctl.dyn * clamp(absV / 4, 0, 1) * (absV > 30 ? 0.8 : 1);
      Fdyn = Math.min(cap, muB * wd * 1.1);
      if (this.electric && this.electric.pantoUp && trk.electrified(locoS) && (L.electric?.regen ?? 0) > 0) {
        this.electric.regenKWh += Fdyn * absV * (L.electric?.regen ?? 0) / 3.6e6 * dt;
      }
      this.wear('powerplant', 0.00004 * dt * ctl.dyn);
    }
    this.brakeN = Fb + Fdyn;

    // ---------- Intégration ----------
    const dir = absV < 0.02 ? 0 : Math.sign(v);
    const rot = 1.05;
    const inertia = this.massKg * rot;
    // résistance statique : à l'arrêt, ne bouge que si la force motrice/gravité dépasse la résistance
    let Fnet: number;
    const brakeOpp = (Fb + Fdyn);
    if (absV < 0.02) {
      const drive = F - Rgrade - Rcurve * 0;
      const stat = (R === 0 ? this.staticResist() : Math.abs(R));
      const avail = Math.abs(drive) - stat - brakeOpp;
      if (avail <= 0) { Fnet = 0; this.v = 0; }
      else Fnet = Math.sign(drive) * avail;
    } else {
      Fnet = F - R - Rgrade - dir * brakeOpp;
    }
    const aNew = Fnet / inertia;
    let vNew = this.v + aNew * dt;
    // le frein ne peut pas inverser la marche
    if (dir !== 0 && Math.sign(vNew) !== dir && (F - R * 0 - Rgrade) * dir <= brakeOpp + Math.abs(R)) vNew = 0;
    if (Math.abs(vNew) < 0.004 && F < 1) vNew = 0;
    this.jerk = (aNew - this.prevA) / dt; this.prevA = aNew; this.a = aNew;
    this.v = vNew; this.s += vNew * dt; this.dist += Math.abs(vNew * dt);

    // ---------- Attelages ----------
    const Fdraw = this.massKg - this.loco.massT * 1000 > 0 ? Math.max(0, (this.massKg - this.loco.massT * 1000) * rot * aNew + Rwag + Gwag) : 0;
    const snatch = absV < 2 && F > 0.6 * L.maxTEkN * 1000 ? 1.3 : 1;
    const wagons = this.vehicles.filter(x => !x.isLoco);
    if (wagons.length) {
      const weakest = wagons.reduce((m, x) => Math.min(m, x.couplingKN * (0.55 + 0.45 * x.unit.cond.couplings)), Infinity) * (1 + 0.1 * this.upg('capacity'));
      if (Fdraw * snatch / 1000 > weakest * 0.85) { this.wearAll('couplings', 0.0006 * dt, true, 0.3); }
      if (Fdraw * snatch / 1000 > weakest && !this.faults.couplingBroken) {
        this.faults.couplingBroken = true; this.faults.coupling = 1;
        this.emit('failure', 'Rupture d’attelage ! Freinage d’urgence automatique.', 'bad', 'couplings', 1);
      }
    }

    // ---------- Usure et confort ----------
    const dKm = Math.abs(vNew * dt) / 1000;
    this.wearDistance(dKm, env);
    this.updateComfort(dt, vNew);
    this.failTimer += dt;
    if (this.failTimer >= 1) { this.failTimer = 0; this.checkFailures(env); }
    if (this.repairing > 0) this.repairing = 0;
  }

  private staticResist(): number {
    let R = 0;
    for (const veh of this.vehicles) R += 20 * veh.massT * 2.2;
    return R;
  }

  private stepSteam(dt: number, ctl: Controls, env: Env, throttle: number, absV: number, perf: number): number {
    const L = this.locoDef, st = L.steam!, s = this.steam!;
    const cond = this.loco.unit.cond;
    const reg = s.water <= 0 && s.level < 0.02 ? 0 : throttle;
    const c = clamp(ctl.cutoff, 0.12, 0.75);
    const Tmax = L.maxTEkN * 1000;
    const vcrit = (L.powerKW * 1000) / (0.3 * Tmax);
    const vk = vcrit * (1.5 - 1.2 * c);
    const pr = clamp((s.pressure - 2) / (st.pBar - 2), 0, 1.05);
    const lowWater = s.level < 0.08 ? 0.4 : 1;
    let TE = Tmax * reg * pr * Math.min(1, c / 0.65) / (1 + (absV / vk) ** 2) * perf * lowWater;
    const taper = clamp((L.maxSpeedKmh / 3.6 * 1.05 - absV) / (L.maxSpeedKmh / 3.6 * 0.1), 0, 1);
    TE *= taper;
    const vEff = Math.max(absV, 0.8);
    const sr = 9 + 12 * c * c;
    const useCyl = TE * vEff / 1000 * sr / 3600 + (reg > 0 ? 0.03 * reg : 0);
    const maxSteam = L.powerKW * 10 / 3600 * 1.1;
    // injecteur
    const injOn = ctl.injector && s.water > 0;
    const injMax = maxSteam * 1.5;
    const inj = injOn ? injMax : 0;
    s.injFlow = inj;
    const injSteam = inj * 0.05;
    const blowerSteam = ctl.blower ? 0.06 * maxSteam : 0;
    const use = useCyl + injSteam + blowerSteam;
    // foyer
    if (ctl.shovel && s.shovelCd <= 0 && s.coal > 0) { s.bed += 6; s.coal -= 6; s.shovelCd = 0.9; this.emit('shovel', '', 'info'); }
    s.shovelCd -= dt;
    const bedOpt = st.bedOptKg;
    const bedF = Math.pow(clamp(s.bed / bedOpt, 0, 1), 0.8) * (s.bed > 1.45 * bedOpt ? 0.88 : 1);
    const draft = 0.22 + 0.78 * clamp((use / maxSteam) * 1.2 + (ctl.blower ? 0.5 : 0), 0, 1);
    const maxCoal = maxSteam / STEAM_PER_COAL;
    const burn = maxCoal * bedF * draft;
    s.bed = Math.max(0, s.bed - burn * dt);
    const boilerEff = 0.7 + 0.3 * cond.powerplant;
    let gen = burn * STEAM_PER_COAL * boilerEff * (0.92 + 0.08 * clamp(s.level / 0.5, 0, 1)) * (1 + 0.06 * this.upg('engine'));
    if (s.level < 0.06) gen *= 0.5;
    s.steamGen = gen; s.steamUse = use;
    const Ms = st.boilerWaterKg * 0.06;
    s.pressure += (gen - use) / Ms * st.pBar * dt;
    s.venting = false;
    if (s.pressure > st.pBar * 1.02) { s.pressure = st.pBar * 1.02; s.venting = true; }
    s.pressure = Math.max(0, s.pressure);
    // eau
    const evap = Math.min(gen, gen);
    s.level += (inj - evap) / (st.boilerWaterKg * 0.35) * dt;
    s.water = Math.max(0, s.water - inj * dt);
    if (s.venting) s.level -= 0.0 * dt;
    if (s.level > 1) { s.level = 1; if (injOn) { this.wear('powerplant', 0.0004 * dt, 'Entraînement d’eau'); } }
    s.level = Math.max(0, s.level);
    if (s.level < 0.12 && s.bed > 30) {
      this.wear('powerplant', 0.0025 * dt, 'Niveau d’eau trop bas');
      if (!this.events.some(e => e.type === 'water')) this.emit('water', 'Niveau d’eau dangereusement bas !', 'bad', 'powerplant');
    }
    if (s.level < 0.03 && s.bed > 30 && !this.faults.stalled) { this.faults.stalled = true; this.faults.powerMul = 0; this.emit('failure', 'Le fusible de sûreté a fondu : chaudière hors service !', 'bad', 'powerplant', 0); this.loco.unit.cond.powerplant = Math.min(this.loco.unit.cond.powerplant, 0.15); }
    if (s.coal <= 0 && s.bed < 3 && !this.faults.stalled && s.pressure < 2.5) { this.faults.stalled = true; this.emit('fuel', 'Plus de charbon, plus de pression : la machine s’arrête.', 'bad'); }
    if (s.venting) this.wear('powerplant', 0);
    return TE;
  }

  // ---------- Usure ----------
  private wear(p: Part, amt: number, reason?: string, veh = 0) {
    if (amt <= 0) return;
    const u = this.vehicles[veh].unit;
    const mul = p === 'powerplant' ? 1 - 0.06 * (u.upgrades.engine ?? 0) : 1;
    u.cond[p] = Math.max(0, u.cond[p] - amt * mul);
    void reason;
  }
  private wearAll(p: Part, amt: number, wagonsToo: boolean, locoShare = 1) {
    this.vehicles.forEach((v, i) => {
      if (i > 0 && !wagonsToo) return;
      v.unit.cond[p] = Math.max(0, v.unit.cond[p] - amt * (i === 0 ? 1 : locoShare));
    });
  }
  private wearDistance(dKm: number, env: Env) {
    if (dKm <= 0) return;
    const weather = env.precip > 0.2 ? (env.tempC < 1 ? 1.25 : 1.1) : 1;
    const loadF = clamp(this.massKg / 1000 / Math.max(60, this.locoDef.maxTEkN * 2.5), 0.4, 1.8);
    const steam = this.locoDef.traction === 'steam' ? 1.4 : 1;
    this.vehicles.forEach((v, i) => {
      const u = v.unit; const heavy = i === 0 ? loadF : 1 + v.unit.loadT / 80;
      u.km += dKm;
      const up = (k: string) => 1 - 0.0 * (u.upgrades[k] ?? 0);
      const W = (p: Part) => PART_DEFS[p].wearPerKm * dKm;
      u.cond.wheels = Math.max(0, u.cond.wheels - W('wheels') * heavy * weather * up('x'));
      u.cond.axles = Math.max(0, u.cond.axles - W('axles') * heavy * (1 + 1.5 * (1 - u.cond.lubrication)));
      u.cond.lubrication = Math.max(0, u.cond.lubrication - W('lubrication'));
      u.cond.couplings = Math.max(0, u.cond.couplings - W('couplings') * heavy);
      if (i === 0) u.cond.powerplant = Math.max(0, u.cond.powerplant - W('powerplant') * loadF * steam * (1 - 0.06 * (u.upgrades.engine ?? 0)));
    });
  }

  private updateComfort(dt: number, v: number) {
    const aLong = Math.abs(this.a);
    const k = Math.abs(this.track.curv(this.s - this.lengthTotal / 2));
    const aLat = Math.max(0, v * v * k - 0.65);
    const wheelsAvg = this.vehicles.reduce((a, x) => a + x.unit.cond.wheels, 0) / this.vehicles.length;
    const vib = (1 - wheelsAvg) * clamp(Math.abs(v) / 30, 0, 1) * 0.12;
    const pen = Math.max(0, aLong - 0.55) * 0.5 + Math.max(0, Math.abs(this.jerk) - 0.9) * 0.05 + aLat * 0.9 + vib;
    this.discomfort += pen * dt;
    if (this.a < -1.15 && Math.abs(v) > 3) { this.cargoShock += 0.01 * dt * 60 / 60; this.hardBrakes += dt; }
    if (aLong > 1.2 && v > 0) this.cargoShock += 0.004 * dt;
    if (aLat > 0.5) this.cargoShock += 0.003 * dt;
  }

  // ---------- Pannes ----------
  private hazard(c: number): number {
    if (c >= 0.4) return 0;
    return Math.pow((0.4 - c) / 0.4, 1.6);
  }
  private checkFailures(env: Env) {
    if (this.faults.stalled && !this.faults.couplingBroken && this.speedCapActive()) return;
    const rel = this.locoDef.reliability;
    const stress = clamp(this.massKg / 1000 / 400, 0.6, 1.6) * (env.precip > 0.3 ? 1.15 : 1) * (2 - rel);
    const base = 1 / 520;
    this.vehicles.forEach((v, i) => {
      for (const p of PARTS) {
        if (p === 'powerplant' && i > 0) continue;
        const h = this.hazard(v.unit.cond[p]) * base * stress * (p === 'axles' && v.unit.cond.lubrication < 0.3 ? 3 : 1) * PART_DEFS[p].hazard;
        if (h > 0 && this.rng.next() < h) { this.applyFailure(p, i); return; }
      }
    });
  }
  private speedCapActive() { return this.faults.speedCap < Infinity; }
  applyFailure(p: Part, i: number) {
    const v = this.vehicles[i];
    const nm = i === 0 ? 'la locomotive' : `le wagon ${i}`;
    switch (p) {
      case 'wheels': v.wheelFault = true; this.faults.speedCap = Math.min(this.faults.speedCap, 15); this.speedCapReason = 'Roue endommagée'; this.emit('failure', `Roue fendue sur ${nm} : vitesse limitée à 55 km/h.`, 'bad', p, i); break;
      case 'axles': v.hotbox = true; this.faults.speedCap = Math.min(this.faults.speedCap, 3); this.speedCapReason = 'Boîte chaude'; this.emit('failure', `Boîte chaude sur ${nm} : arrêt nécessaire !`, 'bad', p, i); break;
      case 'brakes': v.brakeFault = 0.3; this.emit('failure', `Frein défaillant sur ${nm} : freinage réduit.`, 'bad', p, i); break;
      case 'lubrication': v.unit.cond.axles = Math.max(0, v.unit.cond.axles - 0.08); this.emit('failure', `Graissage défaillant sur ${nm} : frottements accrus.`, 'warn', p, i); break;
      case 'couplings': if (!this.faults.couplingBroken && i > 0) { this.faults.couplingBroken = true; this.faults.coupling = i; this.emit('failure', `Attelage rompu devant le wagon ${i} !`, 'bad', p, i); } break;
      case 'powerplant': {
        const tr = this.locoDef.traction;
        if (tr === 'steam') { this.faults.powerMul = Math.min(this.faults.powerMul, 0.5); this.emit('failure', 'Fuite de vapeur : puissance réduite de moitié.', 'bad', p, 0); }
        else if (tr === 'diesel') {
          if (this.rng.chance(0.45)) { this.faults.stalled = true; if (this.diesel) this.diesel.stalled = true; this.emit('failure', 'Avarie moteur : la locomotive cale.', 'bad', p, 0); }
          else { this.faults.powerMul = Math.min(this.faults.powerMul, 0.45); this.emit('failure', 'Injection défaillante : puissance très réduite.', 'bad', p, 0); }
        } else { this.faults.powerMul = Math.min(this.faults.powerMul, 0.5); this.emit('failure', 'Moteur de traction en défaut : puissance réduite.', 'bad', p, 0); }
        break;
      }
    }
  }
  /** Réparation de fortune sur la voie : renvoie vrai si la panne principale est résorbée. */
  fieldRepair(): boolean {
    const f = this.faults;
    const ok = this.rng.chance(0.85);
    if (!ok) return false;
    for (const v of this.vehicles) { v.wheelFault = false; v.hotbox = false; v.brakeFault = Math.max(v.brakeFault, 0.7); if (v.unit.cond.axles < 0.3) v.unit.cond.axles = 0.3; if (v.unit.cond.brakes < 0.3) v.unit.cond.brakes = 0.3; }
    f.speedCap = Infinity; f.couplingBroken = false; f.coupling = -1; f.powerMul = Math.max(f.powerMul, 0.75);
    if (f.stalled) { f.stalled = false; if (this.diesel) { this.diesel.stalled = false; this.diesel.temp = Math.min(this.diesel.temp, 90); } if (this.steam) { this.steam.level = Math.max(this.steam.level, 0.4); } this.loco.unit.cond.powerplant = Math.max(this.loco.unit.cond.powerplant, 0.3); }
    for (const veh of this.vehicles) { veh.unit.cond.couplings = Math.max(veh.unit.cond.couplings, 0.35); }
    return true;
  }
  hasFault(): boolean {
    const f = this.faults;
    return f.stalled || f.couplingBroken || f.speedCap < Infinity || f.powerMul < 1 || this.vehicles.some(v => v.brakeFault < 1 || v.hotbox || v.wheelFault);
  }
  /** Vitesse maximale autorisée par le matériel. */
  get maxSpeedAllowed(): number {
    return Math.min(this.faults.speedCap, ...this.vehicles.map(v => v.maxSpeed));
  }
  position(vehIndex: number): number { return this.s - this.vehicles[vehIndex].offset; }
}
