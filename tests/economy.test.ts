import { describe, it, expect } from 'vitest';
import { generateWorld } from '../src/world/mapgen';
import { createEconomy, stepEconomyDay, priceMul, rates, capacity } from '../src/economy/economy';
import { GOODS } from '../src/data';

describe('économie', () => {
  const w = generateWorld('eco-test');
  it('les prix restent bornés sur 10 ans et varient entre villes', () => {
    const eco = createEconomy(w, 'eco-test', 1905);
    for (let d = 1; d <= 3650; d++) stepEconomyDay(w, eco, 'eco-test', 1905, d);
    let lo = 9, hi = 0;
    for (const c of w.cities) for (const g of GOODS) { if (g.id === 'mail') continue; const m = priceMul(w, eco, 1915, c.id, g.id); lo = Math.min(lo, m); hi = Math.max(hi, m); expect(m).toBeGreaterThanOrEqual(0.35); expect(m).toBeLessThanOrEqual(2.4); }
    expect(hi - lo).toBeGreaterThan(1);
    for (const c of w.cities) for (const g of GOODS) { const s = eco.stocks[c.id][g.id] ?? 0; expect(Number.isFinite(s)).toBe(true); expect(s).toBeGreaterThanOrEqual(0); }
  });
  it('un excédent local fait baisser le prix', () => {
    const eco = createEconomy(w, 'eco-test', 1905);
    const c = w.cities.find(x => rates(w, eco, 1905, x.id, 'coal').cons > 0)!;
    eco.stocks[c.id].coal = 0; const high = priceMul(w, eco, 1905, c.id, 'coal');
    eco.stocks[c.id].coal = capacity(w, eco, 1905, c.id, 'coal'); const low = priceMul(w, eco, 1905, c.id, 'coal');
    expect(high).toBeGreaterThan(low * 3);
  });
  it('des événements apparaissent et finissent', () => {
    const eco = createEconomy(w, 'eco-test', 1905);
    let started = 0, ended = 0;
    for (let d = 1; d <= 1500; d++) { const r = stepEconomyDay(w, eco, 'eco-test', 1905, d); started += r.started.length; ended += r.ended.length; }
    expect(started).toBeGreaterThan(20); expect(ended).toBeGreaterThan(10);
  });
  it('est déterministe', () => {
    const run = () => { const eco = createEconomy(w, 'eco-test', 1905); for (let d = 1; d <= 500; d++) stepEconomyDay(w, eco, 'eco-test', 1905, d); return JSON.stringify(eco.stocks.slice(0, 5)); };
    expect(run()).toBe(run());
  });
});
