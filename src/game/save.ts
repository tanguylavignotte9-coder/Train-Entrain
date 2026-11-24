import { SAVE_VERSION, worldFor, type Game, type GameState } from './state';

export interface SlotInfo { slot: string; company: string; day: number; year: number; money: number; savedAt: number; version: number; seed: string }

interface Envelope { version: number; savedAt: number; meta: Omit<SlotInfo, 'slot'>; state: GameState }

declare global { interface Window { trainAPI?: { save(slot: string, data: string): Promise<void>; load(slot: string): Promise<string | null>; list(): Promise<string[]>; remove(slot: string): Promise<void> } } }

const LS_PREFIX = 'trainentrain:save:';
const backend = {
  async save(slot: string, data: string) {
    if (typeof window !== 'undefined' && window.trainAPI) return window.trainAPI.save(slot, data);
    localStorage.setItem(LS_PREFIX + slot, data);
  },
  async load(slot: string): Promise<string | null> {
    if (typeof window !== 'undefined' && window.trainAPI) return window.trainAPI.load(slot);
    return localStorage.getItem(LS_PREFIX + slot);
  },
  async list(): Promise<string[]> {
    if (typeof window !== 'undefined' && window.trainAPI) return window.trainAPI.list();
    const out: string[] = [];
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i)!; if (k.startsWith(LS_PREFIX)) out.push(k.slice(LS_PREFIX.length)); }
    return out;
  },
  async remove(slot: string) {
    if (typeof window !== 'undefined' && window.trainAPI) return window.trainAPI.remove(slot);
    localStorage.removeItem(LS_PREFIX + slot);
  },
};

export const SLOTS = ['1', '2', '3', '4', '5', 'auto'];

export function serialize(g: Game): string {
  const s = g.state;
  const env: Envelope = {
    version: SAVE_VERSION, savedAt: Date.now(),
    meta: { company: s.company, day: s.day, year: s.startYear + Math.floor(s.day / 365), money: Math.round(s.money), savedAt: Date.now(), version: SAVE_VERSION, seed: s.seed },
    state: s,
  };
  return JSON.stringify(env);
}

/** Migration des anciens formats vers le format courant. */
export function migrate(state: any, from: number): GameState {
  let s = state;
  if (from < 1) throw new Error('Format de sauvegarde inconnu');
  // exemple : if (from < 2) { s.nouveauChamp = ...; from = 2; }
  s.version = SAVE_VERSION;
  s.message = s.message ?? [];
  s.takenIds = s.takenIds ?? [];
  return s as GameState;
}

export function deserialize(json: string): Game {
  const env = JSON.parse(json) as Envelope;
  if (!env || typeof env.version !== 'number') throw new Error('Sauvegarde invalide');
  if (env.version > SAVE_VERSION) throw new Error('Sauvegarde créée avec une version plus récente du jeu');
  const state = migrate(env.state, env.version);
  return { state, world: worldFor(state.seed) };
}

export async function saveGame(g: Game, slot: string): Promise<void> { await backend.save(slot, serialize(g)); }
export async function loadGame(slot: string): Promise<Game | null> {
  const d = await backend.load(slot); if (!d) return null; return deserialize(d);
}
export async function deleteSave(slot: string): Promise<void> { await backend.remove(slot); }
export async function listSaves(): Promise<SlotInfo[]> {
  const slots = await backend.list(); const out: SlotInfo[] = [];
  for (const slot of slots) {
    try { const d = await backend.load(slot); if (!d) continue; const e = JSON.parse(d) as Envelope; out.push({ slot, ...e.meta }); } catch { /* ignore */ }
  }
  return out.sort((a, b) => b.savedAt - a.savedAt);
}
