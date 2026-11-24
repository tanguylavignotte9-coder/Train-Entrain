import { Rng } from '../core/rng';

const START = ['Bel', 'Mont', 'Val', 'Saint', 'Port', 'Haut', 'Roc', 'Clair', 'Fer', 'Lac', 'Pont', 'Vert', 'Noir', 'Blanc', 'Ker', 'Tal', 'Gran', 'Vin', 'Alb', 'Mar', 'Dor', 'Esc', 'Lor', 'Brun', 'Fon', 'Cor', 'Sor', 'Tré', 'Vil', 'Ard'];
const MID = ['a', 'e', 'o', 'en', 'on', 'ar', 'el', 'or', 'an', 'in', 'ou', 'ai', 'er', 'al', 'is'];
const END = ['bourg', 'ville', 'mont', 'val', 'bach', 'stein', 'ford', 'dorf', 'ac', 'eux', 'y', 'ières', 'court', 'sur-Lac', 'port', 'hem', 'burg', 'ange', 'ay', 'mar', 'ia', 'ona', 'ez', 'ino'];

export function cityName(rng: Rng, used: Set<string>): string {
  for (let i = 0; i < 50; i++) {
    let n = rng.pick(START) + (rng.chance(0.6) ? rng.pick(MID) : '') + rng.pick(END);
    n = n.charAt(0).toUpperCase() + n.slice(1);
    if (!used.has(n)) { used.add(n); return n; }
  }
  const n = 'Station ' + used.size; used.add(n); return n;
}

const REGION_A = ['Haute', 'Basse', 'Grande', 'Vieille', 'Nouvelle', 'Petite'];
const REGION_B = ['Marche', 'Vallée', 'Plaine', 'Côte', 'Lande', 'Terre', 'Rive', 'Province', 'Crête', 'Campagne'];
const REGION_C = ['du Nord', 'des Aulnes', 'du Levant', 'de l’Ouest', 'des Brumes', 'du Sud', 'des Forges', 'des Cimes', 'de l’Aube', 'des Sources'];

export function regionName(rng: Rng, used: Set<string>): string {
  for (let i = 0; i < 50; i++) {
    const n = rng.chance(0.5) ? `${rng.pick(REGION_A)} ${rng.pick(REGION_B)}` : `${rng.pick(REGION_B)} ${rng.pick(REGION_C)}`;
    const nn = n.replace(/^(\w)/, c => c.toUpperCase());
    if (!used.has(nn)) { used.add(nn); return nn; }
  }
  return 'Région ' + used.size;
}

export function countryName(rng: Rng): string {
  return rng.pick(['Valmarie', 'Norvanie', 'Karelia-Sud', 'Estrelle', 'Brevonie', 'Aldovie', 'Sarmance']);
}
