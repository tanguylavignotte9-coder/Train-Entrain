import { describe, it, expect } from 'vitest';
import { generateWorld } from '../src/world/mapgen';
import { shortestPath } from '../src/world/graph';

describe('génération du monde', () => {
  const w = generateWorld('test-seed');
  it('produit 40 à 60 villes et 4 à 6 régions', () => {
    expect(w.cities.length).toBeGreaterThanOrEqual(40);
    expect(w.cities.length).toBeLessThanOrEqual(60);
    expect(w.regions.length).toBeGreaterThanOrEqual(4);
    expect(w.regions.length).toBeLessThanOrEqual(6);
  });
  it('est reproductible à partir de la graine', () => {
    const w2 = generateWorld('test-seed');
    expect(w2.cities.map(c => c.name)).toEqual(w.cities.map(c => c.name));
    expect(w2.edges.length).toBe(w.edges.length);
    expect(Array.from(w2.height.slice(0, 500))).toEqual(Array.from(w.height.slice(0, 500)));
  });
  it('relie toutes les villes connectées', () => {
    const base = w.cities.filter(c => c.connected);
    for (const c of base) {
      const p = shortestPath(w, base[0].id, c.id, e => e.initial);
      expect(p, c.name).not.toBeNull();
    }
  });
  it('génère des industries variées et des raccordements', () => {
    const ids = new Set(w.cities.flatMap(c => c.industries));
    for (const i of ['coal_mine', 'farm', 'factory', 'port', 'forestry']) expect(ids.has(i), i).toBe(true);
    expect(w.cities.some(c => !c.connected)).toBe(true);
    expect(w.edges.some(e => e.kind === 'shortcut')).toBe(true);
  });
  it('plusieurs mondes différents ont des tailles valides', () => {
    for (const s of ['a', 'b', 'c', 'd', 'e']) {
      const x = generateWorld(s);
      expect(x.cities.length).toBeGreaterThanOrEqual(40);
      expect(x.cities.length).toBeLessThanOrEqual(60);
    }
  });
});
