import { Rng, hashString } from '../core/rng';
import { clamp } from '../core/util';
import { LOCOS, WAGONS, locoAvailable, wagonAvailable, expectations, locoById, wagonById, type LocoDef, type WagonDef } from '../data';
import { generateWorld, type World, type Edge } from '../world/mapgen';
import { createEconomy, stepEconomyDay, yearOf, closedEdges, type EconomyState } from '../economy/economy';
import { newCond, type Unit, type Part } from '../sim/train';
import { dateOf, type DateInfo } from '../sim/weather';

export const SAVE_VERSION = 1;
export const YEAR_SECONDS = 7200; // une année de jeu ≈ 2 h de temps réel

export interface Contract {
  id: string; kind: 'freight' | 'passenger' | 'mail' | 'deadhead'; from: number; to: number; cities: number[]; edges: number[]; lengthM: number;
  goodId?: string; tonnes?: number; pax?: { c1: number; c2: number; c3: number }; reward: number; expiresDay: number;
  targetSec: number; wagonTypes: string[]; label: string; premium?: boolean; destMul?: number;
}
export interface WorkshopJob { uid: number; readyDay: number; label: string; parts: Part[]; cost: number }
export interface LedgerEntry { day: number; label: string; amount: number }
export interface Stats {
  trips: number; deliveries: number; tonnes: number; passengers: number; km: number; regionsServed: number[]; tractions: string[];
  crisesSurvived: number; accidents: number; onTime: number; built: number; earned: number; maxMoney: number; electrified: number; breakdowns: number;
}
export interface Settings { volume: number; music: number; hints: boolean }

export interface GameState {
  version: number; seed: string; startYear: number; company: string;
  day: number; playSeconds: number; money: number; reputation: number; loan: number; parts: number;
  fleet: Unit[]; nextUid: number; hq: number; location: number;
  locoUid: number | null; consistUids: number[];
  depots: Record<string, number>; warehouses: Record<string, number>;
  builtEdges: number[]; electrified: Record<string, number>;
  eco: EconomyState; contract: Contract | null; takenIds: string[]; jobs: WorkshopJob[]; ledger: LedgerEntry[];
  stats: Stats; goalsDone: string[]; settings: Settings; rescues: number; message: string[]; acc: { overhead: number; interest: number }; service: Record<string, number>;
}
export interface Game { state: GameState; world: World }

const worldCache = new Map<string, World>();
export function worldFor(seed: string): World {
  let w = worldCache.get(seed);
  if (!w) { w = generateWorld(seed); worldCache.set(seed, w); if (worldCache.size > 4) worldCache.delete(worldCache.keys().next().value!); }
  return w;
}

/** Inflation : les prix (revenus, frais, amendes) croissent avec les décennies. */
export const inflationAt = (year: number) => 1 + 0.03 * (year - 1905);
export const REVENUE_K = 3.2;
export const serviceOf = (s: GameState, city: number) => s.service[city] ?? 0.5;
export const yearNow = (s: GameState) => yearOf(s.startYear, s.day);
export const dateNow = (s: GameState): DateInfo => dateOf(s.startYear, s.day);
export const edgeActive = (s: GameState, e: Edge) => e.initial || s.builtEdges.includes(e.id);
export function edgeElectrified(s: GameState, e: Edge): boolean {
  const y = yearNow(s);
  const mine = s.electrified[e.id];
  return (mine !== undefined && mine <= y) || (e.electrifiedYear !== null && e.electrifiedYear <= y && e.initial);
}
export function edgeUsable(g: Game, e: Edge): boolean { return edgeActive(g.state, e) && !closedEdges(g.state.eco).has(e.id); }
export function cityConnected(s: GameState, w: World, id: number): boolean {
  return w.edges.some(e => (e.a === id || e.b === id) && edgeActive(s, e));
}

export function fleetUnit(s: GameState, uid: number): Unit | undefined { return s.fleet.find(u => u.uid === uid); }
export function newUnit(s: GameState, defId: string, kind: 'loco' | 'wagon', cond = 1): Unit {
  if (kind === 'loco') locoById(defId); else wagonById(defId);
  const u: Unit = { uid: s.nextUid++, defId, kind, cond: newCond(cond), upgrades: {}, km: 0, inspectedKm: null, inspectedDay: null, loadT: 0 };
  s.fleet.push(u); return u;
}
export const unitDef = (u: Unit): LocoDef | WagonDef => (u.kind === 'loco' ? locoById(u.defId) : wagonById(u.defId));
export const unitName = (u: Unit) => unitDef(u).name;

export function addLedger(s: GameState, label: string, amount: number): void {
  s.money += amount;
  if (amount > 0) s.stats.earned += amount;
  s.stats.maxMoney = Math.max(s.stats.maxMoney, s.money);
  s.ledger.unshift({ day: Math.floor(s.day), label, amount: Math.round(amount) });
  if (s.ledger.length > 300) s.ledger.length = 300;
}

export function operatingOverhead(s: GameState): number {
  return (1.5 + 0.25 * s.fleet.length + 2 * Object.keys(s.depots).length + 2 * Object.keys(s.warehouses).length) * inflationAt(yearNow(s));
}

export function loanLimit(s: GameState): number { return Math.round((8000 + s.reputation * 450 + Math.max(0, s.stats.maxMoney) * 0.05) / 500) * 500; }

export function newGame(opts: { seed?: string; startYear?: number; company?: string }): Game {
  const seed = opts.seed && opts.seed.trim() ? opts.seed.trim() : Math.random().toString(36).slice(2, 9);
  const startYear = clamp(Math.round(opts.startYear ?? 1905), 1905, 2020);
  const world = worldFor(seed);
  const rng = new Rng(hashString('start:' + seed));
  // siège : ville moyenne connectée de la plus grande région
  const regionCount = world.regions.map(r => world.cities.filter(c => c.region === r.id && c.connected).length);
  const bigRegion = regionCount.indexOf(Math.max(...regionCount));
  const cand = world.cities.filter(c => c.region === bigRegion && c.connected && c.pop > 8).sort((a, b) => b.pop - a.pop);
  const hq = cand[Math.min(cand.length - 1, Math.floor(cand.length * 0.25))] ?? world.cities.find(c => c.connected)!;
  const eco = createEconomy(world, seed, startYear);
  const s: GameState = {
    version: SAVE_VERSION, seed, startYear, company: (opts.company || 'Compagnie des Chemins de Fer').slice(0, 40),
    day: 0, playSeconds: 0, money: Math.round(22000 * (1 + (startYear - 1905) / 40)), reputation: 30, loan: 0, parts: 6,
    fleet: [], nextUid: 1, hq: hq.id, location: hq.id, locoUid: null, consistUids: [],
    depots: { [hq.id]: 1 }, warehouses: {}, builtEdges: [], electrified: {}, eco, contract: null, takenIds: [], jobs: [], ledger: [],
    stats: { trips: 0, deliveries: 0, tonnes: 0, passengers: 0, km: 0, regionsServed: [], tractions: [], crisesSurvived: 0, accidents: 0, onTime: 0, built: 0, earned: 0, maxMoney: 0, electrified: 0, breakdowns: 0 },
    goalsDone: [], settings: { volume: 0.7, music: 0.5, hints: true }, rescues: 0, message: [], acc: { overhead: 0, interest: 0 }, service: {},
  };
  // préchauffage de l'économie (dynamique visible dès le départ)
  for (let d = 1; d <= 40; d++) stepEconomyDay(world, eco, seed, startYear, d);
  s.day = 40;
  s.day = 0; s.eco.lastDay = 40;
  // flotte de départ
  const starter = [...LOCOS].filter(l => locoAvailable(l, startYear)).sort((a, b) => a.price - b.price)[0];
  const loco = newUnit(s, starter.id, 'loco', 0.85);
  s.locoUid = loco.uid;
  const best = (type: string, pref?: (w: WagonDef) => boolean) => WAGONS.filter(w => w.type === type && wagonAvailable(w, startYear) && (!pref || pref(w))).sort((a, b) => a.price - b.price)[0];
  const add = (w: WagonDef | undefined, n: number) => { if (w) for (let i = 0; i < n; i++) s.consistUids.push(newUnit(s, w.id, 'wagon', 0.85).uid); };
  add(best('open'), 3); add(best('covered'), 2);
  add(best('coach', w => w.seats.c3 > 0) ?? best('coach'), 2); add(best('coach', w => w.seats.c2 > 0), 1); add(best('mail'), 1);
  void rng;
  s.message.push(`Bienvenue chez ${s.company} ! Votre première locomotive vous attend au dépôt de ${world.cities[hq.id].name}.`);
  return { state: s, world };
}

/** Avance le calendrier (jours entiers) : économie, frais, ateliers. */
export function advanceDays(g: Game, days: number): void {
  const s = g.state;
  const target = s.day + days;
  while (Math.floor(s.day) < Math.floor(target)) {
    s.day = Math.floor(s.day) + 1;
    dailyTick(g);
  }
  s.day = target;
}
export function advanceSeconds(g: Game, sec: number): void {
  const s = g.state;
  s.playSeconds += sec;
  const dd = sec * 365 / YEAR_SECONDS;
  const before = Math.floor(s.day);
  s.day += dd;
  for (let d = before + 1; d <= Math.floor(s.day); d++) dailyTick(g, d);
}

function dailyTick(g: Game, dayOverride?: number): void {
  const s = g.state, w = g.world;
  const day = dayOverride ?? Math.floor(s.day);
  const { started, ended } = stepEconomyDay(w, s.eco, s.seed, s.startYear, day);
  for (const ev of started) s.message.push(ev.text);
  for (const ev of ended) { if (!ev.positive && s.money >= 0) s.stats.crisesSurvived++; }
  // frais
  const oh = operatingOverhead(s); s.money -= oh; s.acc.overhead += oh;
  if (s.loan > 0) { const i = s.loan * 0.06 / 365; s.money -= i; s.acc.interest += i; }
  if (day % 30 === 0) {
    if (s.acc.overhead > 0) { s.ledger.unshift({ day, label: 'Frais de fonctionnement (30 j)', amount: -Math.round(s.acc.overhead) }); s.acc.overhead = 0; }
    if (s.acc.interest > 0) { s.ledger.unshift({ day, label: 'Intérêts du prêt (30 j)', amount: -Math.round(s.acc.interest) }); s.acc.interest = 0; }
    if (s.ledger.length > 300) s.ledger.length = 300;
  }
  // chantiers d'atelier terminés
  const done = s.jobs.filter(j => j.readyDay <= day);
  if (done.length) { s.jobs = s.jobs.filter(j => j.readyDay > day); for (const j of done) s.message.push(`Atelier : ${j.label} terminé.`); }
  // croissance de réputation lente vers le neutre
  if (day % 30 === 0) s.reputation = clamp(s.reputation + (s.reputation > 50 ? -0.3 : 0.2), 0, 100);
  if (s.message.length > 30) s.message.splice(0, s.message.length - 30);
}

export const unitBusy = (s: GameState, uid: number): WorkshopJob | undefined => s.jobs.find(j => j.uid === uid);

export function lineSpeedNow(s: GameState): number { return expectations(yearNow(s)).lineSpeedKmh; }
