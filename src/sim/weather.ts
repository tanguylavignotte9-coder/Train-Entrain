import { makeNoise2D } from '../core/noise';
import { hashString } from '../core/rng';
import { clamp, smooth } from '../core/util';

export interface Weather {
  tempC: number; precip: number; kind: 'clear' | 'cloud' | 'rain' | 'snow' | 'fog';
  cloud: number; fog: number; windMs: number; windDir: number; headwind: (heading: 1 | -1) => number;
  grip: number; // multiplicateur d'adhérence
  wet: boolean; frost: boolean;
}

const noiseCache = new Map<string, (x: number, y: number) => number>();
function noiseFor(seed: string) {
  let n = noiseCache.get(seed);
  if (!n) { n = makeNoise2D(hashString('weather:' + seed)); noiseCache.set(seed, n); }
  return n;
}

export const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const MLEN = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
export interface DateInfo { year: number; month: number; day: number; doy: number }
export function dateOf(startYear: number, dayNum: number): DateInfo {
  const d = Math.floor(dayNum);
  const year = startYear + Math.floor(d / 365);
  const doy = ((d % 365) + 365) % 365;
  let m = 0, rest = doy;
  while (rest >= MLEN[m]) { rest -= MLEN[m]; m++; }
  return { year, month: m, day: rest + 1, doy };
}
export const fmtDate = (di: DateInfo) => `${di.day} ${MONTHS[di.month]} ${di.year}`;
export function seasonOf(doy: number): 'hiver' | 'printemps' | 'été' | 'automne' {
  if (doy < 59 || doy >= 334) return 'hiver';
  if (doy < 151) return 'printemps';
  if (doy < 243) return 'été';
  return 'automne';
}

/** Météo pour un jour, un moment du trajet (s), l'altitude et la latitude relative (0 nord – 1 sud). */
export function weatherAt(seed: string, dayNum: number, tripSec: number, hourOfDay: number, elev: number, lat: number): Weather {
  const n = noiseFor(seed);
  const doy = ((Math.floor(dayNum) % 365) + 365) % 365;
  const seasonal = 11 - 11.5 * Math.cos(2 * Math.PI * (doy - 12) / 365);
  const diurnal = 3.5 * Math.sin(2 * Math.PI * (hourOfDay - 9) / 24);
  const base = n(dayNum * 0.31, 3.7) * 4.5;
  const tempC = seasonal + diurnal + base - elev * 0.0065 + (0.5 - lat) * 3;
  const wetSeason = 0.5 + 0.28 * Math.cos(2 * Math.PI * (doy - 330) / 365);
  const regime = n(dayNum * 0.23, 11.1 + tripSec / 700) * 0.5 + 0.5; // 0..1
  const precip = clamp((regime - (1 - wetSeason * 0.75)) * 3.2, 0, 1);
  const cloud = clamp(regime * 1.2 + 0.1 - 0.2 + n(dayNum * 0.5, tripSec / 400) * 0.25, 0, 1);
  const fogN = n(dayNum * 0.9 + 100, 7.7);
  const fog = clamp((fogN - 0.45) * 2.5, 0, 1) * (hourOfDay < 10 || hourOfDay > 19 ? 1 : 0.2) * (tempC < 14 ? 1 : 0.3);
  const windMs = clamp(Math.abs(n(dayNum * 0.41, 5.5 + tripSec / 500)) * 16, 0, 16);
  const windDir = n(dayNum * 0.17, 21.3) * Math.PI;
  const snow = precip > 0.12 && tempC < 1.5;
  const kind: Weather['kind'] = precip > 0.22 ? (snow ? 'snow' : 'rain') : fog > 0.55 ? 'fog' : cloud > 0.55 ? 'cloud' : 'clear';
  const wet = precip > 0.15 || (fog > 0.5 && tempC < 12);
  const frost = tempC < -1.5 && (wet || precip > 0.05 || fog > 0.3);
  let grip = 1;
  if (snow && precip > 0.2) grip = 0.45; else if (frost) grip = 0.4; else if (wet) grip = 0.62 + 0.2 * (1 - precip);
  if (doy >= 270 && doy < 320 && kind !== 'clear') grip *= 0.93; // feuilles mortes
  return { tempC, precip, kind, cloud, fog, windMs, windDir, headwind: h => windMs * Math.cos(windDir) * h, grip, wet, frost };
}

/** Heure de la journée → luminosité (0 nuit, 1 plein jour) et position du soleil. */
export function daylight(hour: number, doy: number): { light: number; sunAngle: number; isNight: boolean; dawn: number } {
  const half = 6.6 + 2.2 * Math.sin(2 * Math.PI * (doy - 80) / 365); // demi-journée d'ensoleillement
  const sunrise = 12 - half, sunset = 12 + half;
  const x = (hour - sunrise) / (sunset - sunrise); // 0..1 pendant le jour
  const edge = 0.9;
  let light = 0;
  if (hour >= sunrise - edge && hour <= sunset + edge) {
    const a = smooth(clamp((hour - (sunrise - edge)) / (edge * 2), 0, 1)), b = smooth(clamp(((sunset + edge) - hour) / (edge * 2), 0, 1));
    light = Math.min(a, b);
  }
  const dawn = Math.max(0, 1 - Math.abs(hour - sunrise) / 1.4) + Math.max(0, 1 - Math.abs(hour - sunset) / 1.4);
  return { light, sunAngle: x * Math.PI, isNight: light < 0.25, dawn: clamp(dawn, 0, 1) };
}
