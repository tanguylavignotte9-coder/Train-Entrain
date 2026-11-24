import goodsJson from './goods.json';
import industriesJson from './industries.json';
import locomotivesJson from './locomotives.json';
import wagonsJson from './wagons.json';
import upgradesJson from './upgrades.json';
import erasJson from './eras.json';
import eventsJson from './events.json';
import partsJson from './parts.json';

export type Traction = 'steam' | 'diesel' | 'electric';
export type WagonType = 'coach' | 'mail' | 'open' | 'flat' | 'covered' | 'cattle' | 'tank' | 'reefer' | 'container';

export interface GoodDef { id: string; name: string; category: 'freight' | 'mail'; wagons: string[]; base: number; rate: number; fragility: number; perish: number; intro: number; color: string }
export interface IndustryDef { id: string; name: string; terrain: string[]; produce: Record<string, number>; consume: Record<string, number>; introYear: number; fadeYear?: number }
export interface LocoDef {
  id: string; name: string; traction: Traction; introYear: number; retireYear?: number; price: number;
  massT: number; drivingMassT: number; lengthM: number; powerKW: number; maxTEkN: number; maxSpeedKmh: number;
  brakeNpt: number; reliability: number; dynBrakeKN: number; coupling: number; desc: string;
  steam?: { pBar: number; coalKg: number; waterKg: number; bedOptKg: number; boilerWaterKg: number };
  diesel?: { fuelL: number };
  electric?: { voltage: number; regen: number; bimodeKW?: number; fuelL?: number };
}
export interface WagonDef {
  id: string; name: string; type: WagonType; introYear: number; retireYear?: number; price: number; tareT: number; capacityT: number;
  seats: { c1: number; c2: number; c3: number }; lengthM: number; brakeNpt: number; comfort: number; maxSpeedKmh: number; coupling: number;
}
export interface UpgradeDef { id: string; name: string; appliesTo: 'loco' | 'coach' | 'any'; maxLevel: number; prices: number[]; minYear: number; effect: string }
export interface EraDef { from: number; name: string; lineSpeedKmh: number; expectedSpeedKmh: number; expectedComfort: number; signalSight: number; blurb: string }
export interface EventEffect { type: string; good?: string; mul?: number; pct?: number }
export interface EventDef { id: string; name: string; text: string; weight: number; scope: 'city' | 'region' | 'global' | 'edge'; minDays: number; maxDays: number; effects: EventEffect[]; positive?: boolean; startYear?: number; endYear?: number }

export interface PartDef { name: string; share: number; days: number; wearPerKm: number; hazard: number; desc: string; names?: Record<string, string> }
export const PART_DEFS = partsJson as unknown as Record<'wheels' | 'axles' | 'brakes' | 'powerplant' | 'lubrication' | 'couplings', PartDef>;
export const GOODS = goodsJson as unknown as GoodDef[];
export const INDUSTRIES = industriesJson as unknown as IndustryDef[];
export const LOCOS = locomotivesJson as unknown as LocoDef[];
export const WAGONS = wagonsJson as unknown as WagonDef[];
export const UPGRADES = upgradesJson as UpgradeDef[];
export const ERAS = erasJson as EraDef[];
export const EVENTS = eventsJson as unknown as EventDef[];

export const goodById = (id: string): GoodDef => { const g = GOODS.find(x => x.id === id); if (!g) throw new Error('bien inconnu ' + id); return g; };
export const locoById = (id: string): LocoDef => { const g = LOCOS.find(x => x.id === id); if (!g) throw new Error('loco inconnue ' + id); return g; };
export const wagonById = (id: string): WagonDef => { const g = WAGONS.find(x => x.id === id); if (!g) throw new Error('wagon inconnu ' + id); return g; };
export const industryById = (id: string): IndustryDef => { const g = INDUSTRIES.find(x => x.id === id); if (!g) throw new Error('industrie inconnue ' + id); return g; };

export function eraAt(year: number): EraDef {
  let e = ERAS[0];
  for (const x of ERAS) if (year >= x.from) e = x;
  return e;
}
export function eraIndex(year: number): number { return ERAS.indexOf(eraAt(year)); }
/** Vitesses/ confort attendus interpolés au fil des années. */
export function expectations(year: number): { speedKmh: number; comfort: number; lineSpeedKmh: number } {
  const t = Math.min(1, Math.max(0, (year - 1905) / 115));
  return { speedKmh: 40 + t * 62, comfort: 0.4 + t * 0.45, lineSpeedKmh: eraAt(year).lineSpeedKmh };
}
export const locoAvailable = (d: LocoDef, year: number) => year >= d.introYear && (d.retireYear === undefined || year <= d.retireYear);
export const wagonAvailable = (d: WagonDef, year: number) => year >= d.introYear && (d.retireYear === undefined || year <= d.retireYear);
export const goodAvailable = (g: GoodDef, year: number) => year >= g.intro;
export const industryActive = (d: IndustryDef, year: number) => year >= d.introYear && (d.fadeYear === undefined || year < d.fadeYear + 60);
