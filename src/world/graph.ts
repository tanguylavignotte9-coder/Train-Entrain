import type { World, Edge } from './mapgen';

export interface PathResult { cities: number[]; edges: number[]; lengthM: number }

/** Plus court chemin (Dijkstra) sur les arêtes autorisées. */
export function shortestPath(w: World, from: number, to: number, allowed: (e: Edge) => boolean): PathResult | null {
  const n = w.cities.length;
  const dist = new Array(n).fill(Infinity), prev = new Array<number>(n).fill(-1), prevE = new Array<number>(n).fill(-1);
  const adj: { to: number; e: Edge }[][] = w.cities.map(() => []);
  for (const e of w.edges) if (allowed(e)) { adj[e.a].push({ to: e.b, e }); adj[e.b].push({ to: e.a, e }); }
  dist[from] = 0; const done = new Array(n).fill(false);
  for (let it = 0; it < n; it++) {
    let u = -1; for (let i = 0; i < n; i++) if (!done[i] && (u < 0 || dist[i] < dist[u])) u = i;
    if (u < 0 || dist[u] === Infinity) break;
    done[u] = true; if (u === to) break;
    for (const { to: v, e } of adj[u]) if (dist[u] + e.lengthM < dist[v]) { dist[v] = dist[u] + e.lengthM; prev[v] = u; prevE[v] = e.id; }
  }
  if (dist[to] === Infinity) return null;
  const cities = [to], edges: number[] = [];
  for (let c = to; c !== from; c = prev[c]) { edges.unshift(prevE[c]); cities.unshift(prev[c]); }
  return { cities, edges, lengthM: dist[to] };
}

/** Distances (m) de `from` vers toutes les villes, avec chemin. */
export function distancesFrom(w: World, from: number, allowed: (e: Edge) => boolean): { dist: number[]; hops: number[] } {
  const n = w.cities.length;
  const dist = new Array(n).fill(Infinity), hops = new Array(n).fill(0);
  const adj: { to: number; e: Edge }[][] = w.cities.map(() => []);
  for (const e of w.edges) if (allowed(e)) { adj[e.a].push({ to: e.b, e }); adj[e.b].push({ to: e.a, e }); }
  dist[from] = 0; const done = new Array(n).fill(false);
  for (let it = 0; it < n; it++) {
    let u = -1; for (let i = 0; i < n; i++) if (!done[i] && (u < 0 || dist[i] < dist[u])) u = i;
    if (u < 0 || dist[u] === Infinity) break;
    done[u] = true;
    for (const { to: v, e } of adj[u]) if (dist[u] + e.lengthM < dist[v]) { dist[v] = dist[u] + e.lengthM; hops[v] = hops[u] + 1; }
  }
  return { dist, hops };
}
